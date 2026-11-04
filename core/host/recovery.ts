import { check, nextU64, orderedU64, textBytes, u64, utf8 } from '../src/bytes.ts';
import { verifyAction, plotBindingBytes } from '../src/authority.ts';
import { receiptForAction } from '../src/receipt.ts';
import { formatReference, parseReference } from '../src/references.ts';
import { State, type Accepted, type Control, type Entry, type Source } from './state.ts';
import type { Policy } from './policy.ts';
import { at, bodyValue, collection } from './placement.ts';
import { loadSource, putSource } from './objects.ts';
import { advance, canonical, complete, cutHeader, digest, end, initial, PAGE_SIZE,
  parseLine, TABLES, validateHeader, validateRecord,
  type Cut, type End, type Header, type Progress, type Record, type Suppression, type Table } from './archive.ts';

type Session = { phase: 'starting' | 'importing' | 'restored' | 'released'; header: Header; footer: End;
  progress: Progress; lastHash: string | null; matchedEntries: string; witnessedSources: string };
export class Recovery {
  constructor(private ctx: DurableObjectState, private db: State, private bucket: R2Bucket, private p: Policy) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_sources (address TEXT PRIMARY KEY)`);
  }
  session(): Session | null {
    const row = this.db.sql.exec<{ value: string }>('SELECT value FROM recovery WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  locked() { const s = this.session(); return s !== null && s.phase !== 'released'; }
  private save(s: Session) { this.db.sql.exec('INSERT OR REPLACE INTO recovery VALUES(1, ?)', JSON.stringify(s)); }
  private table(table: string): asserts table is Table { check(TABLES.includes(table as Table), 'archive_table'); }
  private cut(epoch: string): Cut {
    const row = this.db.sql.exec<Cut>('SELECT * FROM cuts WHERE epoch=?', orderedU64(epoch)).toArray()[0];
    check(row, 'snapshot_unavailable'); return row;
  }
  header(epoch: string): string { return canonical(cutHeader(this.cut(epoch))); }

  /** Bound rows EXAMINED, even if most belong to later epochs. No payload reads. */
  page(epoch: string, table: string, after: string) {
    this.cut(epoch); this.table(table);
    check(typeof after === 'string' && after.length <= 1024, 'archive_cursor');
    let rows: { key: string; epoch: string }[];
    if (table === 'suppressions') {
      const [path, revision] = after === '' ? ['', ''] : after.split('!');
      check(path !== undefined && revision !== undefined && after.split('!').length <= 2, 'archive_cursor');
      rows = this.db.sql.exec<{ key: string; epoch: string }>(`SELECT path || '!' || revision AS key, epoch
        FROM suppressions WHERE (path, revision) > (?, ?) ORDER BY path, revision LIMIT ?`, path, revision, PAGE_SIZE).toArray();
    } else {
      const key = { sources: 'address', entries: 'path', accepted: 'id', cuts: 'epoch' }[table];
      const time = table === 'sources' ? 'reserved_epoch' : 'epoch';
      rows = this.db.sql.exec<{ key: string; epoch: string }>(
        `SELECT ${key} AS key, ${time} AS epoch FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`, after, PAGE_SIZE).toArray();
    }
    return { keys: rows.filter(r => r.epoch <= orderedU64(epoch)).map(r => r.key),
      after: rows.at(-1)?.key ?? after, done: rows.length < PAGE_SIZE };
  }
  /** Metadata only: no speculative R2 GET when the reply budget fills. */
  async batch(epoch: string, table: string, after: string) {
    this.table(table); check(table !== 'sources', 'snapshot_sources_individual');
    const page = this.page(epoch, table, after), records: string[] = [];
    let bytes = 0, cursor = after;
    for (const key of page.keys) {
      const line = await this.record(epoch, table, key);
      const size = textBytes(JSON.stringify(line)).length + 1;
      // Always allow one bounded archive record, even if it exceeds the soft batch budget.
      if (records.length && bytes + size > 512 * 1024)
        return { records, after: cursor, done: false };
      records.push(line); bytes += size; cursor = key;
    }
    return { records, after: page.after, done: page.done };
  }
  async record(epoch: string, table: string, key: string): Promise<string> {
    const h = cutHeader(this.cut(epoch)); this.table(table);
    check(typeof key === 'string' && key.length <= 1024, 'archive_cursor');
    let record: Record;
    if (table === 'sources') {
      const source = this.db.source(key); check(source, 'snapshot_record_unavailable');
      const row = { ...source };
      if (row.published_epoch !== null && row.published_epoch > orderedU64(epoch)) {
        row.published_epoch = null; row.submitted_at_ms = null;
      }
      check(row.reserved_epoch <= orderedU64(epoch), 'archive_future_fact');
      record = { type: 'sources', row, body: row.published_epoch === null ? null : utf8(await loadSource(this.bucket, key)) };
    } else if (table === 'entries') {
      const row = this.db.entry(key); check(row, 'snapshot_record_unavailable'); record = { type: table, row };
    } else if (table === 'accepted') {
      const row = this.db.accepted(key); check(row, 'snapshot_record_unavailable'); record = { type: table, row };
    } else if (table === 'suppressions') {
      const parts = key.split('!'); check(parts.length === 2, 'archive_cursor');
      const row = this.db.sql.exec<Suppression>('SELECT * FROM suppressions WHERE path=? AND revision=?', parts[0]!, parts[1]!).toArray()[0];
      check(row, 'snapshot_record_unavailable'); record = { type: table, row };
    } else record = { type: table, row: this.cut(String(BigInt(key))) };
    await validateRecord(record, h);
    return canonical(record);
  }

  async begin(headerLine: string, footerLine: string) {
    const header = validateHeader(parseLine(headerLine)), footer = end(parseLine(footerLine));
    check(header.control.origin === this.db.control().origin, 'archive_origin');
    check(canonical(header.policy) === canonical(this.p), 'restore_policy_mismatch');
    let s = this.session();
    if (s) check(canonical(s.header) === headerLine && canonical(s.footer) === footerLine, 'different_restore_active');
    else {
      const progress = await initial(header);
      this.ctx.storage.transactionSync(() => {
        const c = this.db.control();
        check(c.epoch === '0' && c.accepted === '0' && c.reservedBytes === '0' && c.acceptedDebit === '0', 'restore_requires_empty_target');
        for (const table of [...TABLES, 'heads', 'recovery_sources'])
          check(this.db.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length === 0, 'restore_requires_empty_target');
        s = { phase: 'starting', header, footer, progress, lastHash: null, matchedEntries: '0', witnessedSources: '0' };
        c.paused = true; this.db.save(c); this.save(s);
      });
      await this.ctx.storage.sync();
    }
    check(s !== null, 'restore_not_active');
    if (s.phase === 'starting') {
      check((await this.bucket.list({ limit: 1 })).objects.length === 0, 'restore_requires_empty_bucket');
      s.phase = 'importing'; this.save(s); await this.ctx.storage.sync();
    }
    return this.status();
  }
  status() {
    const s = this.session();
    return s === null ? null : { phase: s.phase, count: s.progress.count, chain: s.progress.chain, expected: s.footer.chain };
  }
  private existing(path: string, epoch: string): Entry | null {
    const ref = parseReference(path);
    if (ref.kind === 'sea') {
      const source = this.db.source(ref.address);
      check(source?.published_epoch != null && source.published_epoch <= epoch, 'archive_missing_source'); return null;
    }
    check(ref.kind !== 'step' && ref.kind !== 'chat', 'archive_reference');
    const entry = this.db.entry(path);
    check(entry && entry.epoch <= epoch, 'archive_missing_entry'); return entry;
  }
  private async accepted(a: Accepted, h: Header): Promise<{ entry: boolean; witness: string | null }> {
    const body = a.source === null ? textBytes(a.body!) : await loadSource(this.bucket, a.source);
    const bytes = textBytes(a.header + utf8(body));
    const { action, receipt } = await receiptForAction(bytes, textBytes(a.receipt), h.control.origin);
    check(utf8(action.body) === utf8(body) && receipt.action === a.id && receipt.result === h.control.origin + a.result
      && receipt.acceptedAtMs === a.accepted_at_ms, 'archive_action_receipt');
    let key: string | null = null;
    if (action.author === null) {
      check(a.signature === null && a.key_record === null && a.author_binding === null, 'archive_authority');
    } else {
      check(a.signature !== null && a.key_record !== null, 'archive_authority');
      const verified = await verifyAction(bytes, a.signature, { keyRecord: textBytes(a.key_record),
        ...(a.author_binding === null ? {} : { plotBinding: textBytes(a.author_binding) }) }, h.control.origin);
      key = verified.key;
      check(receipt.key === key && receipt.binding === verified.binding, 'archive_authority');
      this.existing(key, a.epoch);
      const author = this.existing(action.author, a.epoch);
      if (author) check(author.controller === key && author.binding === a.author_binding, 'archive_plot_authority');
    }
    const t = action.target, value = bodyValue(action);
    if (t.kind === 'sea') {
      check(a.source !== null && a.result === '/sea/' + a.source && a.body === null, 'archive_source_action');
      this.existing(a.result, a.epoch);
      const s = this.db.source(a.source)!;
      return { entry: false, witness: s.published_epoch === a.epoch && s.submitted_at_ms === a.accepted_at_ms ? a.source : null };
    }
    check(a.source === null, 'archive_inline_action');
    const e = this.existing(a.result, a.epoch);
    check(e && e.action === a.id && e.epoch === a.epoch && e.submitted_at_ms === a.accepted_at_ms
      && e.value === value, 'archive_entry_action');
    if (value !== null) this.existing(value, a.epoch);
    if (t.kind === 'plot') check(key !== null && e.controller === key
      && e.binding === utf8(plotBindingBytes({ origin: h.control.origin, plot: e.path, key })), 'archive_plot_authority');
    if (t.kind === 'publication') check(key !== null && this.existing(formatReference(t.plot), a.epoch)?.controller === key, 'archive_plot_authority');
    if (t.kind === 'chat') this.existing(formatReference(t.subject), a.epoch);
    if (t.anchor !== null) this.existing(at(collection(t), t.kind, t.anchor), a.epoch);
    return { entry: true, witness: null };
  }
  async importRecord(index: string, line: string) {
    u64(index);
    const s = this.session(); check(s?.phase === 'importing', 'restore_not_importing');
    const lineHash = await digest(line);
    if (index === s.progress.count && s.lastHash === lineHash) {
      await this.ctx.storage.sync(); return this.status();
    }
    check(index === nextU64(s.progress.count) && u64(index) <= u64(s.footer.count), 'restore_record_order');
    const record = await validateRecord(parseLine(line), s.header);
    const next = await advance(s.progress, record, line);
    let match = { entry: false, witness: null as string | null };
    if (record.type === 'sources' && record.body !== null)
      await putSource(this.bucket, record.row.address, textBytes(record.body));
    if (record.type === 'accepted') match = await this.accepted(record.row, s.header);
    this.ctx.storage.transactionSync(() => {
      const r = record.row;
      if (record.type === 'suppressions') {
        const v = record.row, previous = this.db.suppression(v.path);
        check(v.revision === orderedU64(previous ? nextU64(String(BigInt(previous.revision))) : '0'), 'archive_suppression_gap');
        check(!previous || previous.suppressed !== v.suppressed, 'archive_repeated_suppression');
        if (parseReference(v.path).kind !== 'sea') this.existing(v.path, v.epoch);
      }
      if (record.type === 'cuts' && r.epoch === orderedU64(s.header.epoch))
        check(canonical(cutHeader(record.row)) === canonical(s.header), 'archive_cut_mismatch');
      // Column names come from the exact validated schema, never untrusted SQL.
      const columns = Object.keys(r), values = columns.map(k => (r as { [key: string]: SqlStorageValue })[k]!);
      this.db.sql.exec(`INSERT INTO ${record.type} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...values);
      if (record.type === 'entries') {
        const e = record.row;
        this.db.sql.exec(`INSERT INTO heads VALUES (?, ?) ON CONFLICT(collection) DO UPDATE SET number=MAX(heads.number, excluded.number)`, e.collection, e.number);
      }
      if (match.entry) s.matchedEntries = nextU64(s.matchedEntries);
      if (match.witness && this.db.sql.exec('SELECT 1 FROM recovery_sources WHERE address=?', match.witness).toArray().length === 0) {
        this.db.sql.exec('INSERT INTO recovery_sources VALUES (?)', match.witness);
        s.witnessedSources = nextU64(s.witnessedSources);
      }
      s.progress = next; s.lastHash = lineHash; this.save(s);
    });
    await this.ctx.storage.sync(); return this.status();
  }
  async finish() {
    const s = this.session(); check(s && s.phase !== 'starting', 'restore_not_importing');
    if (s.phase === 'restored' || s.phase === 'released') {
      await this.ctx.storage.sync(); return this.status();
    }
    complete(s.header, s.progress, s.footer);
    check(s.matchedEntries === s.progress.entries && s.witnessedSources === s.progress.published, 'archive_missing_acceptance');
    this.ctx.storage.transactionSync(() => {
      const c: Control = structuredClone(s.header.control), now = Date.now();
      c.epoch = nextU64(s.header.epoch); c.paused = true;
      // Retain historical quota facts in the cut; never revive old spendable credit.
      for (const key of ['growth', 'burst', 'attempts'] as const) c[key] = { tokens: 0, atMs: now, remainder: 0 };
      this.db.save(c); s.phase = 'restored'; this.save(s);
      this.db.sql.exec('DELETE FROM recovery_sources');
    });
    await this.ctx.storage.sync(); return this.status();
  }
  async release(chain: string, confirmation: string) {
    const s = this.session(); check(s && ['restored', 'released'].includes(s.phase), 'restore_not_complete');
    check(chain === s.footer.chain && confirmation === 'history-reconciled', 'restore_history_confirmation');
    s.phase = 'released'; this.save(s); await this.ctx.storage.sync(); return this.status();
  }
}

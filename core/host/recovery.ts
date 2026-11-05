import { check, nextU64, orderedU64, textBytes, u64, utf8 } from '../src/bytes.ts';
import { verifyAction, plotBindingBytes } from '../src/authority.ts';
import { receiptForAction } from '../src/receipt.ts';
import { formatReference, parseReference } from '../src/references.ts';
import { State, type Control, type Result, type ChangeIndex } from './state.ts';
import { Moderation, type PolicyChange } from './moderation.ts';
import type { Policy } from './policy.ts';
import { at, bodyValue, collection } from './placement.ts';
import { loadSource, putSource } from './objects.ts';
import { advance, canonical, complete, cutHeader, cutFromHeader, digest, end, hash, initial, PAGE_SIZE,
  parseLine, TABLES, validateHeader, validateRecord, recordKey,
  type Cut, type End, type Header, type Progress, type Record } from './archive.ts';

type Session = { phase: 'starting' | 'importing' | 'awaiting_delta' | 'restored' | 'released';
  header: Header; footer: End; target: string; progress: Progress; lastHash: string | null };
export class Recovery {
  constructor(private ctx: DurableObjectState, private db: State, private bucket: R2Bucket, private p: Policy) {
    db.sql.exec('CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  }
  session(): Session | null {
    const row = this.db.sql.exec<{ value: string }>('SELECT value FROM recovery WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  locked() { const s = this.session(); return s !== null && s.phase !== 'released'; }
  private save(s: Session) { this.db.sql.exec('INSERT OR REPLACE INTO recovery VALUES(1, ?)', JSON.stringify(s)); }
  private cut(epoch: string): Cut {
    const row = this.db.sql.exec<Cut>('SELECT * FROM cuts WHERE epoch=?', orderedU64(epoch)).toArray()[0];
    check(row, 'snapshot_unavailable'); return row;
  }
  header(epoch: string, baseEpoch: string | null = null, chain: string | null = null): string {
    const h = cutHeader(this.cut(epoch));
    check((baseEpoch === null) === (chain === null), 'archive_base_required');
    if (baseEpoch !== null) h.base = { chain: chain!, cut: this.cut(baseEpoch) };
    return canonical(validateHeader(h));
  }
  /** A closed position bounds keys examined; later writes cannot lengthen the scan. */
  page(epoch: string, after: string) {
    const h = cutHeader(this.cut(epoch)); u64(after);
    check(u64(after) <= u64(h.control.position), 'archive_cursor');
    const rows = this.db.sql.exec<ChangeIndex>(
      'SELECT * FROM journal WHERE position>? AND position<=? ORDER BY position LIMIT ?',
      orderedU64(after), orderedU64(h.control.position), PAGE_SIZE).toArray();
    const cursor = rows.length ? String(BigInt(rows.at(-1)!.position)) : after;
    return { keys: rows.map(r => String(BigInt(r.position))), after: cursor, done: cursor === h.control.position };
  }
  private index(epoch: string, position: string) {
    u64(position);
    const h = cutHeader(this.cut(epoch));
    check(u64(position) > 0n && u64(position) <= u64(h.control.position), 'archive_position');
    const i = this.db.sql.exec<ChangeIndex>('SELECT * FROM journal WHERE position=?', orderedU64(position)).toArray()[0];
    check(i, 'snapshot_record_unavailable'); return { h, i };
  }
  private async expanded(h: Header, i: ChangeIndex): Promise<Record> {
    const position = i.position;
    let r: Record;
    if (i.kind === 'pause') {
      check(i.key === '0' || i.key === '1', 'archive_pause');
      r = { type: 'pause', position, paused: i.key === '1' };
    }
    else if (i.kind === 'sources') {
      const row = this.db.source(i.key); check(row, 'snapshot_record_unavailable');
      r = { type: 'sources', position, row };
    } else if (i.kind === 'results') {
      const row = this.db.result(i.key); check(row, 'snapshot_record_unavailable');
      r = { type: 'results', position, row, body: row.source === null ? null : utf8(await loadSource(this.bucket, row.source)) };
    } else if (i.kind === 'moderation') {
      const row = this.db.sql.exec<PolicyChange>('SELECT * FROM moderation WHERE position=?', i.key).toArray()[0];
      check(row, 'snapshot_record_unavailable'); r = { type: 'moderation', position, row };
    } else {
      check(i.kind === 'cuts', 'archive_record');
      r = { type: 'cuts', position, row: this.cut(String(BigInt(i.key))) };
    }
    await validateRecord(r, h); return r;
  }
  async record(epoch: string, position: string): Promise<string> {
    const { h, i } = this.index(epoch, position); return canonical(await this.expanded(h, i));
  }
  async batch(epoch: string, after: string) {
    const page = this.page(epoch, after), records: string[] = [];
    let bytes = 0, cursor = after;
    for (const position of page.keys) {
      const { h, i } = this.index(epoch, position);
      // Estimate escaped source bytes before paid R2 work; never prefetch the next source.
      const result = i.kind === 'results' ? this.db.result(i.key) : null;
      const source = result?.source === null || result?.source === undefined ? null : this.db.source(result.source);
      if (records.length && source && bytes + source.bytes * 7 + 32768 > 512 * 1024) break;
      const line = canonical(await this.expanded(h, i)), size = textBytes(JSON.stringify(line)).length + 1;
      if (records.length && bytes + size > 512 * 1024) break;
      records.push(line); bytes += size; cursor = position;
    }
    return { records, after: cursor, done: page.done && cursor === page.after };
  }
  async begin(headerLine: string, footerLine: string, target?: string) {
    const header = validateHeader(parseLine(headerLine)), footer = end(parseLine(footerLine));
    target ??= footer.chain; hash(target);
    check(header.control.origin === this.db.control().origin, 'archive_origin');
    check(canonical(header.policy) === canonical(this.p), 'restore_policy_mismatch');
    let s = this.session();
    const identical = s && canonical(s.header) === headerLine && canonical(s.footer) === footerLine;
    if (identical) check(s!.target === target, 'different_restore_target');
    else {
      const progress = await initial(header);
      this.ctx.storage.transactionSync(() => {
        if (s) {
          check(s.phase === 'awaiting_delta' && s.target === target, 'different_restore_active');
          check(header.base !== null && header.base.chain === s.footer.chain
            && canonical(header.base.cut) === canonical(cutFromHeader(s.header)), 'restore_base_mismatch');
        } else {
          check(header.base === null, 'restore_requires_snapshot');
          const c = this.db.control();
          check(c.position === '0' && c.epoch === '0' && c.moderation === '0'
            && c.accepted === '0' && c.reservedBytes === '0' && c.acceptedDebit === '0', 'restore_requires_empty_target');
          for (const table of [...TABLES, 'journal', 'heads'])
            check(this.db.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length === 0, 'restore_requires_empty_target');
          c.paused = true; this.db.save(c);
        }
        s = { phase: header.base === null ? 'starting' : 'importing', header, footer, target: target!, progress, lastHash: null };
        this.save(s);
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
    return s === null ? null : { phase: s.phase, count: s.progress.count, chain: s.progress.chain,
      expected: s.footer.chain, target: s.target, position: s.progress.position };
  }
  private existing(path: string, epoch: string): Result {
    const result = this.db.result(path);
    check(result && result.epoch <= epoch, 'archive_missing_result');
    return result;
  }
  private async verifyResult(a: Result, body: Uint8Array<ArrayBuffer>, h: Header): Promise<void> {
    if (a.source !== null) {
      const source = this.db.source(a.source);
      check(source && source.reserved_epoch <= a.epoch, 'archive_missing_source');
    }
    const bytes = textBytes(a.header + utf8(body));
    const { action, receipt } = await receiptForAction(bytes, textBytes(a.receipt), h.control.origin);
    check(utf8(action.body) === utf8(body) && receipt.action === a.action && receipt.result === h.control.origin + a.path
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
      if (author.kind !== 'sea') check(author.controller === key && author.binding === a.author_binding, 'archive_plot_authority');
    }
    const t = action.target, value = bodyValue(action);
    check(a.kind === t.kind && a.value === value, 'archive_result_action');
    if (t.kind === 'sea') {
      check(a.source !== null && a.path === '/sea/' + a.source && a.body === null, 'archive_source_action');
      return;
    }
    check(a.source === null, 'archive_inline_action');
    if (value !== null) this.existing(value, a.epoch);
    if (t.kind === 'plot') check(key !== null && a.controller === key
      && a.binding === utf8(plotBindingBytes({ origin: h.control.origin, plot: a.path, key })), 'archive_plot_authority');
    if (t.kind === 'publication') check(key !== null && this.existing(formatReference(t.plot), a.epoch).controller === key, 'archive_plot_authority');
    if (t.kind === 'chat') this.existing(formatReference(t.subject), a.epoch);
    if (t.anchor !== null) this.existing(at(collection(t), t.kind, t.anchor), a.epoch);
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
    if (record.type === 'results') {
      const a = record.row, body = textBytes(a.source === null ? a.body! : record.body!);
      await this.verifyResult(a, body, s.header);
      if (a.source !== null) await putSource(this.bucket, a.source, body);
    }
    this.ctx.storage.transactionSync(() => {
      if (record.type === 'moderation') {
        const v = record.row, previous = new Moderation(this.db).decision(v.effect, v.path);
        check(!previous || (previous.active !== v.active && previous.epoch <= v.epoch), 'archive_policy_repeated_or_rewound');
        const last = this.db.sql.exec<{ epoch: string }>('SELECT epoch FROM moderation ORDER BY position DESC LIMIT 1').toArray()[0];
        check(!last || last.epoch <= v.epoch, 'archive_policy_epoch_rewound');
        if (parseReference(v.path).kind !== 'sea') this.existing(v.path, orderedU64(s.progress.epoch));
      }
      if (record.type !== 'pause') {
        const r = record.row, columns = Object.keys(r), values = columns.map(k => (r as { [key: string]: SqlStorageValue })[k]!);
        this.db.sql.exec(`INSERT INTO ${record.type} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...values);
      }
      this.db.sql.exec('INSERT INTO journal VALUES (?, ?, ?)', record.position, record.type, recordKey(record));
      if (record.type === 'results' && record.row.collection !== null) {
        const e = record.row;
        const prior = this.db.sql.exec<{ number: string }>('SELECT number FROM heads WHERE collection=?', e.collection).toArray()[0];
        check(!prior || prior.number < e.number!, 'archive_number_reused');
        this.db.sql.exec('INSERT INTO heads VALUES (?, ?) ON CONFLICT(collection) DO UPDATE SET number=excluded.number', e.collection, e.number);
      }
      s.progress = next; s.lastHash = lineHash; this.save(s);
    });
    await this.ctx.storage.sync(); return this.status();
  }
  async finish() {
    const s = this.session(); check(s && s.phase !== 'starting', 'restore_not_importing');
    if (s.phase !== 'importing') { await this.ctx.storage.sync(); return this.status(); }
    complete(s.header, s.progress, s.footer);
    this.ctx.storage.transactionSync(() => {
      const c: Control = structuredClone(s.header.control), now = Date.now();
      c.epoch = nextU64(s.header.epoch); c.paused = true;
      for (const key of ['growth', 'burst', 'attempts'] as const) c[key] = { tokens: 0, atMs: now, remainder: 0 };
      this.db.save(c); s.phase = s.footer.chain === s.target ? 'restored' : 'awaiting_delta'; this.save(s);
    });
    await this.ctx.storage.sync(); return this.status();
  }
  async release(chain: string, confirmation: string) {
    const s = this.session(); check(s && ['restored', 'released'].includes(s.phase), 'restore_not_complete');
    check(chain === s.target && s.footer.chain === s.target && confirmation === 'history-reconciled', 'restore_history_confirmation');
    if (s.phase !== 'released') this.ctx.storage.transactionSync(() => {
      // Forced recovery pause is a new local control fact, only after the trusted suffix ends.
      const c = this.db.control();
      if (!s.header.control.paused) { this.db.record(c, 'pause', '1'); this.db.save(c); }
      s.phase = 'released'; this.save(s);
    });
    await this.ctx.storage.sync(); return this.status();
  }
}

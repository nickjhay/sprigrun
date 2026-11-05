import { DurableObject } from 'cloudflare:workers';
import { refill, waitSeconds } from '../../shared/bucket.ts';
import { actionBytes, parseAction, type Action } from '../src/action.ts';
import { plotBindingBytes, verifyAction } from '../src/authority.ts';
import { check, contentAddress, copyBytes, LIMITS, nextU64, orderedU64, parseAddress,
  textBytes, u64, utf8 } from '../src/bytes.ts';
import { assertChatFits, canonicalOrigin, formatReference, parsePostTarget, parseReference } from '../src/references.ts';
import { parseReceipt, receiptBytes } from '../src/receipt.ts';
import { METADATA_ALLOWANCE, policy, type Policy } from './policy.ts';
import { State, type Control, type Result } from './state.ts';
import { collection, at, bodyValue } from './placement.ts';
import { loadSource, putSource } from './objects.ts';
import { canonical } from './archive.ts';
import { Recovery } from './recovery.ts';
import { Inspection, type Browse } from './inspection.ts';
import { Moderation, POLICY_BATCH, POLICY_REFRESH_MS } from './moderation.ts';
import { AlreadyStored } from './errors.ts';
import { handleHttp } from '../http/routes.ts';
import { body, httpPolicy, ReadGate, HttpError, uploadHeaders, urlFor, query, type HttpPolicy } from '../http/transport.ts';

export interface Env {
  SOURCES: R2Bucket; CORE_ORIGIN: string; CORE_POLICY?: Policy; CORE_RESTORE_MODE?: string;
  CORE_HTTP_POLICY?: HttpPolicy; ADMIN_TOKEN?: string; BACKUP_TOKEN?: string; CORE_LOCAL_OPERATOR?: string; ABUSE_EMAIL?: string;
}
type Verified = { action: Action; id: string; key: string | null; binding: string | null;
  keyRecord: string | null; authorBinding: string | null; source: string | null;
  value: string | null; signature: string | null; header: string };

/** Trusted RPC only. No public router or admin credential handling in this slice.
 * R2 is private; presence of an object is never proof of accepted publication.
 */
export class NativeCoordinator extends DurableObject<Env> {
  protected readonly db: State;
  private readonly p: Policy;
  protected readonly moderation: Moderation;
  private readonly origin: string;
  private active = 0;
  private readonly recovery: Recovery;
  private recovering = false;
  private exporting = 0;
  private readonly inspection: Inspection;
  private readonly http: HttpPolicy;
  private readonly reads: ReadGate;
  private operatorActive = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.origin = canonicalOrigin(env.CORE_ORIGIN);
    this.p = policy(env.CORE_POLICY);
    this.db = new State(ctx.storage.sql, this.origin, this.p, Date.now());
    this.moderation = new Moderation(this.db);
    this.recovery = new Recovery(ctx, this.db, env.SOURCES, this.p);
    this.inspection = new Inspection(this.db, p => this.readable(p), id => this.actionRecord(id), this.origin);
    this.http = httpPolicy(env.CORE_HTTP_POLICY); this.reads = new ReadGate(this.http);
  }
  private normal() { check(this.env.CORE_RESTORE_MODE !== '1' && !this.recovery.locked(), 'recovery_mode'); }
  private transaction<T>(f: () => T): T { return this.ctx.storage.transactionSync(f); }
  private refresh(c: Control) {
    const now = Date.now();
    c.growth = refill(c.growth, this.p.growth, now);
    c.burst = refill(c.burst, this.p.burst, now);
    c.attempts = refill(c.attempts, this.p.attempts, now);
  }
  private debit(c: Control, bytes: number) {
    this.refresh(c);
    check(!waitSeconds(c.growth, this.p.growth, bytes)
      && !waitSeconds(c.burst, this.p.burst, bytes), 'growth_limit');
    c.growth.tokens -= bytes; c.burst.tokens -= bytes;
  }
  private visible(path: string) { check(!this.moderation.active('hide', path), 'suppressed'); }

  /** Accepted immutable facts are trusted even when their public view is hidden. */
  private retained(path: string): Result | null {
    const ref = parseReference(path);
    check(ref.kind !== 'step' && ref.kind !== 'chat', 'unsupported_read');
    const row = this.db.result(path);
    check(row, ref.kind === 'sea' ? 'source_unavailable' : 'entry_unavailable');
    return ref.kind === 'sea' ? null : row;
  }
  private authorAllowed(v: Verified) {
    if (v.key !== null) check(!this.moderation.active('block', v.key), 'author_blocked');
  }
  /** Bounded dependency checks: publication -> source and optional plot. */
  private readable(path: string): Result | null {
    this.visible(path);
    const ref = parseReference(path);
    if (ref.kind === 'sea') {
      check(this.db.result(path)?.kind === 'sea', 'source_unavailable');
      return null;
    }
    check(ref.kind !== 'step' && ref.kind !== 'chat', 'unsupported_read');
    const entry = this.db.result(path);
    check(entry, 'entry_unavailable');
    if (ref.kind === 'publication') this.readable(formatReference(ref.plot));
    if (ref.kind === 'message') this.readable(formatReference(ref.subject));
    if (entry.value !== null) this.readable(entry.value);
    return entry;
  }
  private conditions(v: Verified) {
    this.normal();
    const a = v.action, t = a.target;
    if (a.author !== null) this.retained(a.author);
    if (v.key !== null) this.retained(v.key);
    if (v.value !== null) this.readable(v.value);
    if (t.kind === 'sea') { this.visible('/sea/' + v.source); return; }
    if (t.kind === 'plot') check(v.key !== null, 'author_required');
    if (t.kind === 'publication') {
      const owner = this.readable(formatReference(t.plot));
      check(v.key !== null && owner?.controller === v.key, 'wrong_controller');
    }
    if (t.kind === 'chat') this.readable(formatReference(t.subject));
    if (t.anchor !== null)
      check(this.db.result(at(collection(t), t.kind, t.anchor)), 'anchor_unavailable');
  }
  private async loadSource(address: string): Promise<Uint8Array<ArrayBuffer>> {
    return loadSource(this.env.SOURCES, address);
  }
  private async verify(bytes: Uint8Array, signature: string | null): Promise<Verified> {
    const action = parseAction(bytes, this.origin);
    const target = action.target, value = bodyValue(action);
    let keyRecord: string | null = null, authorBinding: string | null = null;
    let key: string | null = null, binding: string | null = null;
    let id: string;
    if (action.author === null) {
      check(signature === null, 'unexpected_signature');
      id = await contentAddress(bytes);
    } else {
      check(typeof signature === 'string', 'signature_required');
      const author = this.retained(action.author);
      key = author === null ? action.author : author.controller;
      check(key !== null, 'invalid_author');
      const keyRef = parseReference(key);
      check(keyRef.kind === 'sea', 'invalid_key_reference');
      check(parseAddress(keyRef.address).length <= LIMITS.recordBytes, 'key_record_limit');
      this.retained(key);
      const keyBytes = await this.loadSource(keyRef.address);
      keyRecord = utf8(keyBytes);
      authorBinding = author?.binding ?? null;
      const result = await verifyAction(bytes, signature, {
        keyRecord: keyBytes,
        ...(authorBinding === null ? {} : { plotBinding: textBytes(authorBinding) }),
      }, this.origin);
      id = result.id; binding = result.binding;
    }
    const v: Verified = { action, id, key, binding, keyRecord, authorBinding, value, signature,
      source: target.kind === 'sea' ? await contentAddress(action.body) : null,
      header: utf8(bytes.subarray(0, bytes.length - action.body.length)) };
    this.conditions(v);
    return v;
  }

  private freshSource(address: string) {
    const path = '/sea/' + address;
    if (this.db.result(path)) {
      // A hidden value is not advertised through the duplicate response.
      this.readable(path);
      throw new AlreadyStored(path);
    }
  }

  /** Pay for a unique private source BEFORE paid R2 work. An abandoned write
   * keeps its reservation; a retry reuses it. This is separate from the atomic
   * action debit. No R2 intents/receipts: a new source normally costs one PUT.
   */
  private async prepareSource(v: Verified) {
    const address = v.source!;
    this.transaction(() => {
      const c = this.db.control(); check(!c.paused, 'writes_paused');
      this.conditions(v); this.authorAllowed(v);
      if (this.db.source(address)) return;
      // Check room for acceptance too, but reserve only private bytes here.
      this.refresh(c);
      const bytes = Math.max(v.action.body.length, this.p.minimumDebit);
      const metadata = Math.max(this.p.minimumDebit, METADATA_ALLOWANCE);
      check(c.growth.tokens >= bytes + metadata
        && c.burst.tokens >= bytes + metadata, 'growth_limit');
      this.debit(c, bytes);
      this.db.sql.exec(`INSERT INTO sources VALUES (?, ?, ?, ?, ?)`,
        address, v.action.body.length, bytes, orderedU64(c.epoch), String(Date.now()));
      c.reservedBytes = String(BigInt(c.reservedBytes) + BigInt(bytes)); this.db.save(c);
    });
    await this.ctx.storage.sync();
    if (this.db.result('/sea/' + address)) return;
    await putSource(this.env.SOURCES, address, v.action.body);
  }

  /** Test subclasses can pause preparation or throw within the real transaction. */
  protected async prepared(): Promise<void> {}
  protected committing(): void {}

  async submit(input: Uint8Array, signature: string | null = null): Promise<string> {
    this.normal();
    check(input.byteLength <= LIMITS.actionBytes, 'bytes_limit');
    check(signature === null || (typeof signature === 'string' && signature.length === 86), 'invalid_signature');
    const bytes = copyBytes(input); // Copy caller-owned buffers before any await.
    return this.accept(async () => ({ bytes, signature }));
  }
  /** Both RPC and HTTP use this one acceptance path. HTTP is admitted before body reception. */
  private async accept(receive: () => Promise<{ bytes: Uint8Array; signature: string | null }>): Promise<string> {
    this.normal(); check(this.active < 8, 'preparation_busy');
    this.active++;
    try {
      this.transaction(() => {
        const c = this.db.control(); check(!c.paused, 'writes_paused'); this.refresh(c);
        check(c.attempts.tokens >= 1, 'attempt_limit'); c.attempts.tokens--; this.db.save(c);
      });
      await this.ctx.storage.sync(); // No hashing, verification or R2 before admission is durable.
      const { bytes, signature } = await receive();
      const v = await this.verify(bytes, signature);
      const existing = this.db.accepted(v.id);
      if (existing) { this.actionRecord(existing.path); return existing.receipt; }
      this.authorAllowed(v);
      if (v.source !== null) this.freshSource(v.source);
      // Changed admission limits do not invalidate already accepted retries.
      if (v.action.target.kind === 'chat') check(v.action.body.length <= this.p.chatBytes, 'chat_size_limit');
      if (v.action.target.kind === 'sea') check(v.action.body.length <= this.p.sourceBytes, 'source_size_limit');
      if (v.source !== null) await this.prepareSource(v);
      await this.prepared();
      const receipt = this.transaction(() => {
        const c = this.db.control(); check(!c.paused, 'writes_paused');
        this.conditions(v); // Recheck every mutable condition after all awaits.
        const prior = this.db.accepted(v.id);
        if (prior) { this.actionRecord(prior.path); return prior.receipt; }
        this.authorAllowed(v);
        const t = v.action.target, now = String(Date.now()), epoch = orderedU64(c.epoch);
        if (v.source !== null) this.freshSource(v.source);
        const debit = Math.max(this.p.minimumDebit,
          METADATA_ALLOWANCE + (t.kind === 'sea' ? 0 : v.action.body.length));
        this.debit(c, debit);
        let path: string, name: string | null = null, number: string | null = null, binding: string | null = null;
        if (t.kind === 'sea') {
          path = '/sea/' + v.source;
        } else {
          name = collection(t);
          const head = this.db.sql.exec<{ number: string }>('SELECT number FROM heads WHERE collection=?', name).toArray()[0];
          const n = head ? nextU64(String(BigInt(head.number))) : '0';
          check(t.anchor === null || u64(n) > u64(t.anchor), 'allocation_state_invalid');
          path = at(name, t.kind, n);
          parseReference(path);
          if (t.kind !== 'chat') assertChatFits(path);
          this.visible(path); // A moderator may suppress an as-yet unallocated address.
          binding = t.kind === 'plot'
            ? utf8(plotBindingBytes({ origin: this.origin, plot: path, key: v.key! })) : null;
          number = orderedU64(n);
          this.db.sql.exec(`INSERT INTO heads VALUES (?, ?) ON CONFLICT(collection) DO UPDATE SET number=excluded.number`, name, orderedU64(n));
        }
        const receipt = utf8(receiptBytes({ action: v.id, result: this.origin + path,
          acceptedAtMs: now, key: v.key, binding: v.binding }, this.origin));
        this.db.sql.exec('INSERT INTO results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          path, name, number, t.kind, v.value, t.kind === 'plot' ? v.key : null, binding,
          v.id, epoch, now, debit, v.header, t.kind === 'sea' ? null : utf8(v.action.body),
          v.source, v.signature, v.keyRecord, v.authorBinding, receipt);
        c.accepted = nextU64(c.accepted);
        c.acceptedDebit = String(BigInt(c.acceptedDebit) + BigInt(debit)); this.db.save(c);
        this.committing(); // A thrown fault rolls back allocation, debit AND identity.
        return receipt;
      });
      await this.ctx.storage.sync();
      return receipt;
    } finally { this.active--; }
  }

  async submitHttp(request: Request): Promise<string> {
    const url = urlFor(request, this.origin); query(url, []);
    check(request.method === 'POST', 'post_required');
    parsePostTarget(url.pathname); const signature = request.headers.get('Sprig-Signature');
    if (request.headers.has('Authorization') || request.headers.has('Sprig-Occurrence'))
      throw new HttpError(400, 'unsupported_authorization');
    if (signature !== null && !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw new HttpError(403, 'invalid_signature');
    if (request.headers.get('Content-Type')?.toLowerCase().startsWith('multipart/'))
      throw new HttpError(415, 'send_raw_bytes');
    // Use protocol caps here so lowering admission limits never invalidates an accepted retry.
    const cap = signature !== null ? LIMITS.actionBytes : LIMITS.sourceBytes;
    uploadHeaders(request, cap);
    return this.accept(async () => {
      const payload = await body(request, cap, this.http.uploadTimeoutMs);
      const bytes = signature === null ? actionBytes({ destination: this.origin + url.pathname, body: payload }, this.origin) : payload;
      const action = parseAction(bytes, this.origin);
      if (action.destination !== this.origin + url.pathname) throw new HttpError(400, 'wrong_destination');
      if (signature !== null && action.author === null) throw new HttpError(400, 'author_required');
      return { bytes, signature };
    });
  }
  override async fetch(request: Request): Promise<Response> {
    return handleHttp(request, this.env, this, this.reads, async run => {
      if (this.operatorActive >= 2) throw new HttpError(429, 'operator_busy', 1);
      this.operatorActive++;
      try { return await run(); } finally { this.operatorActive--; }
    });
  }
  private actionRecord(path: string) {
    parseReference(path);
    const row = this.db.result(path); check(row, 'action_unavailable');
    this.readable(row.path);
    const author = parseAction(textBytes(row.header), this.origin).author;
    if (author !== null) this.readable(author);
    const key = parseReceipt(textBytes(row.receipt), this.origin).key;
    if (key !== null) this.readable(key);
    return row;
  }
  describe(path: string) { this.normal(); return this.inspection.describe(path); }
  describeAction(path: string) { this.normal(); return this.inspection.describeAction(path); }
  browse(q: Browse) { this.normal(); return this.inspection.browse(q); }
  operatorInspect(table: string, after: string) { return this.inspection.operator(table, after); }
  operatorRecord(path: string) { parseReference(path); const row=this.db.result(path); check(row,'action_unavailable'); return row; }
  publicStats() {
    this.normal(); const c = this.db.control(); this.refresh(c); // Projection only: no durable view counter.
    return { origin: c.origin, epoch: c.epoch, writes_paused: c.paused, accepted_actions: c.accepted,
      journal_bytes: this.db.sql.databaseSize,
      reserved_source_bytes: c.reservedBytes, accepted_debit_bytes: c.acceptedDebit,
      growth_credit: c.growth.tokens, burst_credit: c.burst.tokens, attempt_credit: c.attempts.tokens,
      source_limit: this.p.sourceBytes, chat_limit: this.p.chatBytes, active_uploads: this.active,
      proof_of_work: 'not enabled' };
  }

  /** Trusted adapter reads. Public HTTP must still apply inert MIME/cache policy. */
  async read(path: string): Promise<Uint8Array<ArrayBuffer>> {
    this.normal();
    const entry = this.readable(path), ref = parseReference(path);
    if (ref.kind === 'sea') {
      const bytes = await this.loadSource(ref.address); this.readable(path); return bytes;
    }
    check(entry, 'entry_unavailable');
    if (entry.binding !== null) return textBytes(entry.binding);
    return textBytes(entry.body!);
  }
  latest(path: string): string {
    this.normal();
    const target = parsePostTarget(path);
    check(target.kind !== 'sea' && target.anchor === null, 'collection_required');
    const head = this.db.sql.exec<{ number: string }>('SELECT number FROM heads WHERE collection=?', collection(target)).toArray()[0];
    check(head, 'entry_unavailable');
    const result = at(collection(target), target.kind, String(BigInt(head.number)));
    this.readable(result); return result; // Never fall back behind a suppressed head.
  }
  async evidence(path: string) {
    this.normal();
    parseReference(path);
    const row = this.db.result(path); check(row, 'action_unavailable');
    this.readable(row.path);
    // Retained verification evidence must not provide an alternate route to a suppressed source.
    const action = parseAction(textBytes(row.header), this.origin);
    if (action.author !== null) this.readable(action.author);
    const keyPath = row.key_record === null ? null : '/sea/' + await contentAddress(textBytes(row.key_record));
    if (keyPath !== null) this.readable(keyPath);
    const body = row.source === null ? textBytes(row.body!) : await this.loadSource(row.source);
    this.readable(row.path);
    if (action.author !== null) this.readable(action.author);
    if (keyPath !== null) this.readable(keyPath);
    return { action: row.header + utf8(body), signature: row.signature,
      keyRecord: row.key_record, plotBinding: row.author_binding, receipt: row.receipt };
  }
  stats(): Control { return this.db.control(); }

  /** Operator methods: never forward these directly from unauthenticated HTTP. */
  async suppress(path: string, suppressed: boolean): Promise<void> {
    this.normal();
    const ref = parseReference(path); check(typeof suppressed === 'boolean', 'invalid_suppression');
    check(ref.kind === 'sea' || this.db.result(path), 'entry_unavailable');
    await this.changePolicy('hide', path, suppressed);
  }
  async blockAuthor(key: string, blocked: boolean): Promise<void> {
    this.normal();
    check(typeof blocked === 'boolean', 'invalid_author_block');
    check(parseReference(key).kind === 'sea', 'key_reference_required');
    // Allow a preemptive block by canonical key-record address. It cannot grant authority.
    await this.changePolicy('block', key, blocked);
  }
  private async changePolicy(effect: 'hide' | 'block', path: string, active: boolean) {
    this.transaction(() => {
      if (this.moderation.decision(effect, path)?.active === Number(active)) return;
      const c = this.db.control();
      this.moderation.apply([{ position: orderedU64(nextU64(c.moderation)), effect, path,
        active: Number(active), epoch: orderedU64(c.epoch), at_ms: String(Date.now()) }]);
    });
    await this.ctx.storage.sync();
  }
  policyPage(after: string) { this.normal(); return this.moderation.page(after); }
  policyStatus() { this.normal(); return { applied: this.moderation.position(),
    mode: 'local-authority', refreshTargetMs: POLICY_REFRESH_MS, batchLimit: POLICY_BATCH }; }
  async pause(paused: boolean): Promise<void> {
    this.normal();
    check(typeof paused === 'boolean', 'invalid_pause');
    this.transaction(() => { const c = this.db.control(); c.paused = paused; this.db.save(c); });
    await this.ctx.storage.sync();
  }
  /** The cut is constant-size. Pending R2 work will publish in the next epoch. */
  async cut(): Promise<string> {
    this.normal();
    const epoch = this.transaction(() => {
      const c = this.db.control(), old = c.epoch;
      this.db.sql.exec('INSERT INTO cuts VALUES (?, ?, ?)', orderedU64(old), canonical({ ...c, _policy: this.p }), String(Date.now()));
      c.epoch = nextU64(c.epoch); this.db.save(c); return old;
    });
    await this.ctx.storage.sync(); return epoch;
  }
  snapshotHeader(epoch: string) { this.normal(); return this.recovery.header(epoch); }
  snapshotPage(epoch: string, table: string, after: string) { this.normal(); return this.recovery.page(epoch, table, after); }
  async snapshotBatch(epoch: string, table: string, after: string) {
    this.normal(); check(this.exporting < 2, 'snapshot_busy'); this.exporting++;
    try { return await this.recovery.batch(epoch, table, after); }
    finally { this.exporting--; }
  }
  async snapshotRecord(epoch: string, table: string, key: string) {
    this.normal(); check(this.exporting < 2, 'snapshot_busy'); this.exporting++;
    try { return await this.recovery.record(epoch, table, key); } finally { this.exporting--; }
  }
  private async restoring<T>(operation: () => Promise<T>): Promise<T> {
    check(this.env.CORE_RESTORE_MODE === '1', 'restore_mode_required');
    check(!this.recovering && this.active === 0, 'restore_busy');
    this.recovering = true;
    try { return await operation(); } finally { this.recovering = false; }
  }
  restoreStatus() { return this.recovery.status(); }
  restoreBegin(header: string, footer: string) { return this.restoring(() => this.recovery.begin(header, footer)); }
  restoreRecord(index: string, line: string) { return this.restoring(() => this.recovery.importRecord(index, line)); }
  restoreFinish() { return this.restoring(() => this.recovery.finish()); }
  restoreRelease(chain: string, confirmation: string) { return this.restoring(() => this.recovery.release(chain, confirmation)); }
}

import { DurableObject } from 'cloudflare:workers';
import { config, type Config } from './config.ts';
import { full, refill, waitSeconds } from '../../shared/bucket.ts';
import { objectKey, sha256, validate, verifiedBody } from './bytes.ts';
import { NONCE, PROTOCOL, TICKET_ID, parseAddress, proofDigest, proofPrefix, workTarget, type Challenge } from './proof.ts';
import { failure, HttpError, type Env, type Published, type Result } from './types.ts';
import { status, readControl, saveControl, readReceipt, insertReceipt, emptyTotals, type Control, type Receipt } from './state.ts';
import { recovery, recoveryLocked, snapshotPins, clearRestored, type RecoveryValue } from './recovery-store.ts';

interface TicketRow extends Record<string, SqlStorageValue> { id: string; expires: number; value: string }

/** One authority for short metadata commits. R2 preparation never holds its queue. */
export class StoreCoordinator extends DurableObject<Env> {
  private readonly policy: Config;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private preparing = new Map<string, Promise<void>>();
  private preparations = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.policy = config(env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
    const old = ctx.storage.sql.exec<{ value: string }>('SELECT value FROM control WHERE id = 1').toArray()[0];
    // Undeployed schema replacement: reset/reseed disposable local storage.
    if (old && JSON.parse(old.value).schema !== 3) throw new Error('reset_local_store_for_schema_3');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      address TEXT PRIMARY KEY, bytes INTEGER NOT NULL, debit INTEGER NOT NULL,
      reserved_epoch INTEGER, reserved_at_ms INTEGER, published_epoch INTEGER,
      submitted_at_ms INTEGER, blocked_epoch INTEGER, blocked_at_ms INTEGER
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL
    )`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS ticket_expiry ON tickets(expires)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
    const now = Date.now();
    const initial: Control = {
      schema: 3, epoch: 0, receipts: 0, paused: false,
      long: full(this.policy.long, now), burst: full(this.policy.burst, now),
      attempts: full(this.policy.attempts, now), challenges: full(this.policy.challenges, now),
      ...emptyTotals(),
    };
    ctx.storage.sql.exec('INSERT OR IGNORE INTO control (id, value) VALUES (1, ?)', JSON.stringify(initial));
  }

  private read(): Control { return readControl(this.ctx.storage.sql); }
  private save(state: Control): void { saveControl(this.ctx.storage.sql, state); }
  private receipt(address: string): Receipt | undefined { return readReceipt(this.ctx.storage.sql, address); }
  private refresh(state: Control): void {
    const now = Date.now();
    state.long = refill(state.long, this.policy.long, now);
    state.burst = refill(state.burst, this.policy.burst, now);
    state.attempts = refill(state.attempts, this.policy.attempts, now);
    state.challenges = refill(state.challenges, this.policy.challenges, now);
  }
  private prune(): void {
    this.ctx.storage.sql.exec('DELETE FROM tickets WHERE expires <= ?', Date.now());
  }
  private ticketCount(): number {
    return this.ctx.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM tickets').one().n;
  }

  // Only bounded metadata/CPU work and durable flushes belong on this queue.
  // In particular: no client bodies, R2 preparation, duplicate GET or export GET.
  private async exclusive<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.queued >= 32) return failure(503, 'write_queue_full', 2);
    this.queued++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    catch (error) {
      if (error instanceof HttpError) return failure(error.status, error.code, error.retryAfter);
      console.error('coordinator_operation_failed');
      return failure(503, 'storage_unavailable', 5);
    } finally { this.queued--; release(); }
  }

  async challenge(address: string): Promise<Result<Challenge>> {
    const parsed = parseAddress(address);
    if (!parsed) return failure(400, 'invalid_address');
    if (parsed.bytes > this.policy.maxBytes) return failure(413, 'blob_too_large');
    return this.exclusive(async () => {
      const result = this.ctx.storage.transactionSync((): Result<Challenge> => {
        const state = this.read();
        this.refresh(state);
        if (state.paused) return failure(503, 'uploads_paused', 60);
        if (state.challenges.tokens < 1) return failure(429, 'challenge_rate_limit', waitSeconds(state.challenges, this.policy.challenges, 1));
        state.challenges.tokens--;
        this.save(state);
        // This is only an early refusal. Publication checks the receipt again.
        const receipt = this.receipt(address);
        if (receipt && status(receipt) === 'blocked') return failure(410, 'blob_blocked');
        if (receipt && status(receipt) === 'stored') return failure(409, 'already_written');
        this.prune();
        if (this.ticketCount() >= this.policy.challengeCapacity) return failure(429, 'challenge_table_full', 1);
        const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
        const ticket: Challenge = {
          protocol: PROTOCOL, id, address,
          expires_at_ms: Date.now() + this.policy.challengeTtlMs,
          target: workTarget(state.proofOfWorkBits ?? this.policy.proofOfWorkBits,
            state.proofOfWorkPerByte ?? this.policy.proofOfWorkPerByte, parsed.bytes),
        };
        this.ctx.storage.sql.exec('INSERT INTO tickets (id, expires, value) VALUES (?, ?, ?)', id, ticket.expires_at_ms, JSON.stringify(ticket));
        return { ok: true, value: ticket };
      });
      await this.ctx.storage.sync();
      return result;
    });
  }

  /** One proof buys ONE attempt, including invalid/stalled bodies and failures. */
  async redeem(address: string, id: string, nonce: string): Promise<Result<null>> {
    if (!parseAddress(address) || !TICKET_ID.test(id) || !NONCE.test(nonce)) return failure(400, 'invalid_proof_fields');
    return this.exclusive(async () => {
      const state = this.read();
      this.refresh(state);
      if (state.paused) return failure(503, 'uploads_paused', 60);
      if (state.attempts.tokens < 1) return failure(429, 'attempt_limit', waitSeconds(state.attempts, this.policy.attempts, 1));
      state.attempts.tokens--;
      this.save(state);
      const row = this.ctx.storage.sql.exec<TicketRow>('SELECT * FROM tickets WHERE id = ?', id).toArray()[0];
      if (!row || row.expires <= Date.now()) return {
        ...failure(409, 'challenge_unavailable'),
        message: 'This challenge is expired, already used, or unknown. Request a fresh challenge for this address and solve it locally. Each valid proof permits one upload attempt, even if that upload fails.',
      };
      const ticket = JSON.parse(row.value) as Challenge;
      if (ticket.address !== address) return failure(400, 'challenge_address_mismatch');
      if (await proofDigest(ticket, nonce) > ticket.target) return {
        ...failure(422, 'insufficient_proof_of_work'),
        message: 'Hash the UTF-8 message_prefix followed by a 16-digit lowercase hexadecimal nonce and one newline. Vary the nonce locally until SHA-256, interpreted as an unsigned big-endian integer, is at most target. Send Blob-Ticket and Blob-Nonce headers with PUT to the challenged path. Do not submit each trial; rejected proofs consume upload-attempt credit. Do not change the source bytes.',
        proof_of_work: { protocol: PROTOCOL, target: ticket.target, message_prefix: proofPrefix(ticket) },
      };
      // Recheck expiry after asynchronous verification. No other ticket operation
      // can interleave because it uses the same bounded FIFO mutex.
      if (ticket.expires_at_ms <= Date.now()) return failure(409, 'challenge_unavailable');
      this.ctx.storage.sql.exec('DELETE FROM tickets WHERE id = ?', id);
      // Must be durable BEFORE the Worker gets permission to read the body.
      await this.ctx.storage.sync();
      const receipt = this.receipt(address);
      if (receipt && status(receipt) === 'blocked') return failure(410, 'blob_blocked');
      if (receipt && status(receipt) === 'stored') return failure(409, 'already_written');
      return { ok: true, value: null };
    });
  }

  private workRequired(state: Control) {
    if ((state.proofOfWorkBits ?? this.policy.proofOfWorkBits) === 0 &&
        (state.proofOfWorkPerByte ?? this.policy.proofOfWorkPerByte) === 0) return null;
    return {
      ...failure(428, 'proof_required'),
      message: 'Proof of work is enabled. Compute SHA-256 (lowercase hex) and the byte length of your exact file. POST /challenge/b/<hash>_<length> with no body. Hash the returned message_prefix followed by a 16-digit lowercase hex nonce and a newline until the digest is at most target. PUT the unchanged file to /b/<hash>_<length> with Blob-Ticket: <id> and Blob-Nonce: <nonce>. Solve locally; do not send trial nonces to the server.',
    };
  }

  /** No ticket when work is off. Still debit the global body-attempt allowance. */
  async admitOpenUpload(): Promise<Result<null>> {
    return this.exclusive(async () => {
      const state = this.read();
      this.refresh(state);
      if (state.paused) return failure(503, 'uploads_paused', 60);
      if (state.attempts.tokens < 1) return failure(429, 'attempt_limit', waitSeconds(state.attempts, this.policy.attempts, 1));
      state.attempts.tokens--;
      this.save(state);
      await this.ctx.storage.sync();
      return this.workRequired(state) ?? { ok: true, value: null };
    });
  }

  // Trusted internal RPC after admission and bounded body reception.
  async publish(address: string | null, input: Uint8Array): Promise<Result<Published>> {
    const openUpload = address === null;
    if (input.byteLength > this.policy.maxBytes) return failure(413, 'blob_too_large');
    if (address !== null && !parseAddress(address)) return failure(400, 'invalid_address');
    const digest = await sha256(input);
    address ??= `${digest}_${input.byteLength}`;
    const parsed = parseAddress(address)!;
    if (input.byteLength !== parsed.bytes) return failure(422, 'length_mismatch');
    if (digest !== parsed.digest) return failure(422, 'digest_mismatch');
    // A separate bound, never a semaphore that snapshot/block commits must acquire.
    if (this.preparations >= 8) return failure(503, 'preparation_busy', 1);
    this.preparations++;
    const previous = this.preparing.get(address);
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    this.preparing.set(address, done);
    await previous; // Same-address retries serialize, without holding the commit queue.
    try {
      const admitted = await this.exclusive<Receipt>(async () => {
        const state = this.read();
        if (state.paused || recoveryLocked(this.ctx.storage.sql)) return failure(503, 'uploads_paused', 60);
        const required = openUpload && this.workRequired(state);
        if (required) return required;
        const prior = this.receipt(address);
        if (prior && status(prior) === 'blocked') return failure(410, 'blob_blocked');
        if (prior && status(prior) === 'stored') {
          return openUpload ? { ok: true, value: prior } : failure(409, 'already_written');
        }
        validate(input, this.policy.validationPolicy);
        if (prior) return { ok: true, value: prior };
        this.refresh(state);
        const debit = Math.max(input.length, this.policy.minimumDebit);
        const retry = Math.max(waitSeconds(state.long, this.policy.long, debit), waitSeconds(state.burst, this.policy.burst, debit));
        if (retry) return failure(429, 'growth_limit', retry);
        const receipt: Receipt = { address, bytes: input.length, debit,
          reserved_epoch: state.epoch, reserved_at_ms: Date.now(),
          published_epoch: null, submitted_at_ms: null, blocked_epoch: null, blocked_at_ms: null };
        this.ctx.storage.transactionSync(() => {
          state.long.tokens -= debit; state.burst.tokens -= debit;
          state.reservedBlobs++; state.reservedBytes += debit; state.receipts++;
          this.save(state); insertReceipt(this.ctx.storage.sql, receipt);
        });
        await this.ctx.storage.sync(); // Debit precedes paid storage work.
        return { ok: true, value: receipt };
      });
      if (!admitted.ok) return admitted;
      const prior = admitted.value, key = objectKey(address);
      if (prior.published_epoch !== null) {
        const object = await this.env.BLOBS.get(key);
        if (!object) throw new Error('stored_blob_missing');
        await verifiedBody(object, parsed.digest, parsed.bytes);
      } else {
        const written = await this.env.BLOBS.put(key, input, {
          onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: parsed.digest,
          customMetadata: { kind: 'blob', sha256: parsed.digest, validation_policy: this.policy.validationPolicy },
        });
        if (!written) {
          const object = await this.env.BLOBS.get(key);
          if (!object) throw new Error('conditional_write_lost');
          await verifiedBody(object, parsed.digest, parsed.bytes);
        }
      }
      // Visibility and epoch are assigned together, AFTER remote preparation.
      return await this.exclusive<Published>(async () => {
        const state = this.read(), receipt = this.receipt(address)!;
        if (status(receipt) === 'blocked') return failure(410, 'blob_blocked');
        if (state.paused || recoveryLocked(this.ctx.storage.sql)) return failure(503, 'uploads_paused', 60);
        const required = openUpload && this.workRequired(state);
        if (required) return required;
        const created = receipt.published_epoch === null;
        const submittedAt = receipt.submitted_at_ms ?? Date.now();
        if (created) this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('UPDATE receipts SET published_epoch=?, submitted_at_ms=? WHERE address=?', state.epoch, submittedAt, address);
          state.confirmedBlobs++; state.confirmedBytes += input.length; this.save(state);
        });
        await this.ctx.storage.sync();
        return { ok: true, value: { digest, bytes: input.length, created, submitted_at_ms: submittedAt } };
      });
    } catch (error) {
      if (error instanceof HttpError) return failure(error.status, error.code, error.retryAfter);
      console.error('preparation_failed'); return failure(503, 'storage_unavailable', 5);
    } finally {
      this.preparations--; if (this.preparing.get(address) === done) this.preparing.delete(address); release();
    }
  }

  readable(address: string): Result<null> {
    if (recoveryLocked(this.ctx.storage.sql)) return failure(503, 'recovery_mode', 60);
    const receipt = this.receipt(address);
    if (receipt && status(receipt) === 'blocked') return failure(410, 'blob_blocked');
    return receipt && status(receipt) === 'stored' ? { ok: true, value: null } : failure(404, 'blob_not_found');
  }

  async recover(action: string, input: Uint8Array, origin: string): Promise<Result<RecoveryValue>> {
    // Export bodies can stall without delaying any metadata commit or barrier.
    if (action === 'snapshot/object') {
      try { return await recovery(this.ctx, this.env, this.policy, action, input, origin); }
      catch (error) {
        return error instanceof HttpError ? failure(error.status, error.code, error.retryAfter) : failure(503, 'storage_unavailable', 5);
      }
    }
    // Restore has an isolated, non-serving target and may serialize its R2 writes.
    return this.exclusive(() => recovery(this.ctx, this.env, this.policy, action, input, origin));
  }

  async block(address: string): Promise<Result<null>> {
    const parsed = parseAddress(address);
    if (!parsed) return failure(400, 'invalid_address');
    return this.exclusive(async () => {
      if (recoveryLocked(this.ctx.storage.sql)) return failure(409, 'maintenance_locked');
      this.ctx.storage.transactionSync(() => {
        const existing = this.receipt(address);
        if (existing && status(existing) === 'blocked') return;
        const state = this.read();
        if (existing && status(existing) === 'stored') { state.confirmedBlobs--; state.confirmedBytes -= existing.bytes; }
        state.blockedAddresses++;
        if (existing) this.ctx.storage.sql.exec('UPDATE receipts SET blocked_epoch=?, blocked_at_ms=? WHERE address=?', state.epoch, Date.now(), address);
        else {
          state.receipts++;
          insertReceipt(this.ctx.storage.sql, { address, bytes: parsed.bytes, debit: 0,
            reserved_epoch: null, reserved_at_ms: null, published_epoch: null, submitted_at_ms: null,
            blocked_epoch: state.epoch, blocked_at_ms: Date.now() });
        }
        this.save(state);
      });
      await this.ctx.storage.sync();
      return { ok: true, value: null };
    });
  }

  // Explicit physical reclamation. Blocking itself is a metadata-only commit.
  async reclaim(address: string): Promise<Result<null>> {
    if (!parseAddress(address)) return failure(400, 'invalid_address');
    const allowed = await this.exclusive<null>(async () => {
      if (recoveryLocked(this.ctx.storage.sql)) return failure(409, 'maintenance_locked');
      const receipt = this.receipt(address);
      if (!receipt || status(receipt) !== 'blocked') return failure(409, 'reclamation_requires_block');
      if (snapshotPins(this.ctx.storage.sql, receipt)) return failure(409, 'snapshot_pins_payload');
      return { ok: true, value: null };
    });
    if (!allowed.ok) return allowed;
    // A future cut cannot need this already-blocked source. A late preparation
    // may leave private bytes again, but can never undo the permanent block.
    try { await this.env.BLOBS.delete(objectKey(address)); return allowed; }
    catch { return failure(503, 'storage_unavailable', 5); }
  }

  async setPaused(paused: boolean): Promise<Result<null>> {
    return this.exclusive(async () => {
      if (recoveryLocked(this.ctx.storage.sql) || (!paused && this.env.RESTORE_MODE !== undefined)) return failure(409, 'maintenance_locked');
      const state = this.read(); state.paused = paused;
      this.ctx.storage.transactionSync(() => {
        this.save(state);
        // Once activated, this is no longer an idempotent restore target.
        if (!paused) clearRestored(this.ctx.storage.sql);
      });
      await this.ctx.storage.sync(); return { ok: true, value: null };
    });
  }

  async setProofOfWork(bits: number | null, perByte?: number): Promise<Result<{ proof_of_work_bits: number; proof_of_work_per_byte: number; override: boolean }>> {
    return this.exclusive(async () => {
      if (recoveryLocked(this.ctx.storage.sql)) return failure(409, 'maintenance_locked');
      const state = this.read();
      if (bits === null) { delete state.proofOfWorkBits; delete state.proofOfWorkPerByte; }
      else {
        try { workTarget(bits, perByte ?? state.proofOfWorkPerByte ?? this.policy.proofOfWorkPerByte, this.policy.maxBytes); }
        catch { return failure(400, 'invalid_proof_of_work_parameters'); }
        state.proofOfWorkBits = bits;
        if (perByte !== undefined) state.proofOfWorkPerByte = perByte;
      }
      this.save(state); await this.ctx.storage.sync();
      return { ok: true, value: { proof_of_work_bits: state.proofOfWorkBits ?? this.policy.proofOfWorkBits,
        proof_of_work_per_byte: state.proofOfWorkPerByte ?? this.policy.proofOfWorkPerByte, override: bits !== null } };
    });
  }

  stats() {
    const state = this.read(); this.refresh(state);
    const live = this.ctx.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM tickets WHERE expires > ?', Date.now()).one().n;
    return {
      snapshot_epoch: state.epoch,
      service: 'bounded-blob-store', protocol: PROTOCOL, hash: 'sha256', address_format: 'hash_length',
      validation: this.policy.validationPolicy, uploads_paused: state.paused, maintenance_locked: recoveryLocked(this.ctx.storage.sql),
      proof_of_work_bits: state.proofOfWorkBits ?? this.policy.proofOfWorkBits,
      proof_of_work_per_byte: state.proofOfWorkPerByte ?? this.policy.proofOfWorkPerByte,
      proof_of_work_default_bits: this.policy.proofOfWorkBits,
      proof_of_work_default_per_byte: this.policy.proofOfWorkPerByte,
      proof_of_work_override: state.proofOfWorkBits !== undefined || state.proofOfWorkPerByte !== undefined,
      challenge_ttl_seconds: this.policy.challengeTtlMs / 1000,
      challenge_capacity: this.policy.challengeCapacity, outstanding_challenges: live,
      challenge_burst: this.policy.challenges.capacity, challenges_per_minute: this.policy.challenges.refill,
      challenge_available: state.challenges.tokens,
      max_blob_bytes: this.policy.maxBytes, minimum_debit_bytes: this.policy.minimumDebit,
      long_capacity_bytes: this.policy.long.capacity, long_refill_bytes_per_day: this.policy.long.refill,
      long_available_bytes: state.long.tokens, burst_capacity_bytes: this.policy.burst.capacity,
      burst_refill_bytes_per_hour: this.policy.burst.refill, burst_available_bytes: state.burst.tokens,
      attempt_capacity: this.policy.attempts.capacity, attempts_per_minute: this.policy.attempts.refill,
      reserved_blobs_total: state.reservedBlobs, reserved_debit_bytes_total: state.reservedBytes,
      confirmed_unblocked_blobs: state.confirmedBlobs, confirmed_unblocked_bytes: state.confirmedBytes,
      blocked_addresses: state.blockedAddresses, browser_cache_seconds: this.policy.browserCacheSeconds,
    };
  }
}

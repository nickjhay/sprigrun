import { DurableObject } from 'cloudflare:workers';
import { config, type Config } from './config.ts';
import { full, refill, waitSeconds, type BucketState } from './bucket.ts';
import { objectKey, sha256, validate, verifiedBody } from './bytes.ts';
import { NONCE, PROTOCOL, TICKET_ID, parseAddress, proofDigest, proofPrefix, workTarget, type Challenge } from './proof.ts';
import { failure, HttpError, type Env, type Published, type Result } from './types.ts';

interface Control {
  schema: 2;
  paused: boolean;
  proofOfWorkBits?: number;
  proofOfWorkPerByte?: number;
  long: BucketState;
  burst: BucketState;
  attempts: BucketState;
  challenges: BucketState;
  reservedBlobs: number;
  reservedBytes: number;
  confirmedBlobs: number;
  confirmedBytes: number;
  blockedAddresses: number;
}
interface Receipt extends Record<string, SqlStorageValue> {
  address: string;
  status: 'pending' | 'stored' | 'blocked';
  bytes: number;
  debit: number;
}
interface TicketRow extends Record<string, SqlStorageValue> { id: string; expires: number; value: string }

/** One named object coordinates admission/writes. Public reads bypass it. */
export class StoreCoordinator extends DurableObject<Env> {
  private readonly policy: Config;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.policy = config(env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
    const old = ctx.storage.sql.exec<{ value: string }>('SELECT value FROM control WHERE id = 1').toArray()[0];
    // v0.5 changes object/receipt keys. Never silently discard earlier quotas or
    // tombstones; an existing v0.4 deployment needs an explicit offline migration.
    if (old && JSON.parse(old.value).schema !== 2) throw new Error('address_schema_changed_use_fresh_v05_instance');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      address TEXT PRIMARY KEY, status TEXT NOT NULL, bytes INTEGER NOT NULL, debit INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL
    )`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS ticket_expiry ON tickets(expires)');
    const now = Date.now();
    const initial: Control = {
      schema: 2, paused: false,
      long: full(this.policy.long, now), burst: full(this.policy.burst, now),
      attempts: full(this.policy.attempts, now), challenges: full(this.policy.challenges, now),
      reservedBlobs: 0, reservedBytes: 0, confirmedBlobs: 0, confirmedBytes: 0, blockedAddresses: 0,
    };
    ctx.storage.sql.exec('INSERT OR IGNORE INTO control (id, value) VALUES (1, ?)', JSON.stringify(initial));
  }

  private read(): Control {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM control WHERE id = 1').one();
    const state = JSON.parse(row.value) as Control;
    if (state.schema !== 2) throw new Error('unknown_control_schema');
    return state;
  }
  private save(state: Control): void {
    this.ctx.storage.sql.exec('UPDATE control SET value = ? WHERE id = 1', JSON.stringify(state));
  }
  private receipt(address: string): Receipt | undefined {
    return this.ctx.storage.sql.exec<Receipt>('SELECT * FROM receipts WHERE address = ?', address).toArray()[0];
  }
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

  // SQL transactions cannot span R2 awaits. Serialize publication and blocking
  // too, so a block cannot race a publication and resurrect content.
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
        if (receipt?.status === 'blocked') return failure(410, 'blob_blocked');
        if (receipt?.status === 'stored') return failure(409, 'already_written');
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
      if (receipt?.status === 'blocked') return failure(410, 'blob_blocked');
      if (receipt?.status === 'stored') return failure(409, 'already_written');
      return { ok: true, value: null };
    });
  }

  // Trusted internal RPC: the HTTP Worker calls this only after redeem succeeds.
  async publish(address: string, input: Uint8Array): Promise<Result<Published>> {
    const parsed = parseAddress(address);
    if (!parsed) return failure(400, 'invalid_address');
    if (input.byteLength > this.policy.maxBytes) return failure(413, 'blob_too_large');
    if (input.byteLength !== parsed.bytes) return failure(422, 'length_mismatch');
    if (await sha256(input) !== parsed.digest) return failure(422, 'digest_mismatch');
    try { validate(input, this.policy.validationPolicy); }
    catch (error) {
      if (error instanceof HttpError) return failure(error.status, error.code);
      throw error;
    }
    return this.exclusive(async () => {
      const reservation = this.ctx.storage.transactionSync((): Result<null> => {
        const state = this.read();
        if (state.paused) return failure(503, 'uploads_paused', 60);
        const existing = this.receipt(address);
        if (existing?.status === 'blocked') return failure(410, 'blob_blocked');
        if (existing?.status === 'stored') return failure(409, 'already_written');
        if (existing) {
          if (existing.bytes !== input.length) throw new Error('receipt_integrity_failure');
          return { ok: true, value: null }; // Retry ambiguous R2 write, with fresh PoW.
        }
        this.refresh(state);
        const debit = Math.max(input.length, this.policy.minimumDebit);
        const retry = Math.max(waitSeconds(state.long, this.policy.long, debit), waitSeconds(state.burst, this.policy.burst, debit));
        if (retry) return failure(429, 'growth_limit', retry);
        state.long.tokens -= debit; state.burst.tokens -= debit;
        state.reservedBlobs++; state.reservedBytes += debit;
        this.save(state);
        this.ctx.storage.sql.exec('INSERT INTO receipts (address, status, bytes, debit) VALUES (?, ?, ?, ?)', address, 'pending', input.length, debit);
        return { ok: true, value: null };
      });
      if (!reservation.ok) return reservation;
      await this.ctx.storage.sync();
      const key = objectKey(address);
      const existing = await this.env.BLOBS.get(key);
      if (existing) await verifiedBody(existing, parsed.digest, parsed.bytes);
      else {
        const written = await this.env.BLOBS.put(key, input, {
          onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: parsed.digest,
          httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          customMetadata: { kind: 'blob', sha256: parsed.digest, validation_policy: this.policy.validationPolicy },
        });
        if (!written) {
          const raced = await this.env.BLOBS.get(key);
          if (!raced) throw new Error('conditional_write_lost');
          await verifiedBody(raced, parsed.digest, parsed.bytes);
        }
      }
      this.ctx.storage.transactionSync(() => {
        if (this.receipt(address)!.status === 'pending') {
          const state = this.read(); state.confirmedBlobs++; state.confirmedBytes += input.length;
          this.save(state);
          this.ctx.storage.sql.exec('UPDATE receipts SET status = ? WHERE address = ?', 'stored', address);
        }
      });
      return { ok: true, value: { digest: parsed.digest, bytes: input.length, created: true } };
    });
  }

  async block(address: string): Promise<Result<null>> {
    if (!parseAddress(address)) return failure(400, 'invalid_address');
    return this.exclusive(async () => {
      this.ctx.storage.transactionSync(() => {
        const existing = this.receipt(address);
        if (existing?.status === 'blocked') return;
        const state = this.read();
        if (existing?.status === 'stored') { state.confirmedBlobs--; state.confirmedBytes -= existing.bytes; }
        state.blockedAddresses++; this.save(state);
        this.ctx.storage.sql.exec(`INSERT INTO receipts (address, status, bytes, debit) VALUES (?, 'blocked', 0, 0)
          ON CONFLICT(address) DO UPDATE SET status = 'blocked'`, address);
      });
      await this.ctx.storage.sync();
      await this.env.BLOBS.put(objectKey(address), crypto.getRandomValues(new Uint8Array(32)), { customMetadata: { kind: 'blocked' } });
      return { ok: true, value: null };
    });
  }

  async setPaused(paused: boolean): Promise<Result<null>> {
    return this.exclusive(async () => {
      const state = this.read(); state.paused = paused; this.save(state);
      await this.ctx.storage.sync(); return { ok: true, value: null };
    });
  }

  async setProofOfWork(bits: number | null, perByte?: number): Promise<Result<{ proof_of_work_bits: number; proof_of_work_per_byte: number; override: boolean }>> {
    return this.exclusive(async () => {
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
      service: 'bounded-blob-store', protocol: PROTOCOL, hash: 'sha256', address_format: 'hash_length',
      validation: this.policy.validationPolicy, uploads_paused: state.paused,
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

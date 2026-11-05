import { check, nextU64, orderedU64, u64 } from '../src/bytes.ts';
import { parseReference } from '../src/references.ts';
import type { State } from './state.ts';

export const POLICY_BATCH = 32;
export const POLICY_REFRESH_MS = 60_000;
export type Effect = 'hide' | 'block';
export interface PolicyChange extends Record<string, SqlStorageValue> {
  position: string; effect: Effect; path: string; active: number; epoch: string; at_ms: string;
}

export function validateChange(value: unknown): asserts value is PolicyChange {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_policy_change');
  const r = value as PolicyChange;
  const fields = ['position', 'effect', 'path', 'active', 'epoch', 'at_ms'];
  check(Object.keys(r).length === fields.length && fields.every(k => Object.hasOwn(r, k)), 'invalid_policy_change');
  check(r.effect === 'hide' || r.effect === 'block', 'invalid_policy_effect');
  check(r.active === 0 || r.active === 1, 'invalid_policy_change');
  for (const n of [r.position, r.epoch])
    check(typeof n === 'string' && /^[0-9]{20}$/.test(n) && orderedU64(String(BigInt(n))) === n, 'invalid_policy_position');
  check(BigInt(r.position) > 0n, 'invalid_policy_position'); u64(r.at_ms);
  const ref = parseReference(r.path);
  check(ref.kind !== 'chat' && ref.kind !== 'step', 'invalid_policy_target');
  check(r.effect !== 'block' || ref.kind === 'sea', 'key_reference_required');
}

/** Ordered facts are also the durable local projection. Indexed latest-by-target
 * queries avoid a second table of mutable decisions. No per-read durable writes.
 */
export class Moderation {
  private db: State;
  constructor(db: State) { this.db = db; }
  position() { return this.db.control().moderation; }
  decision(effect: Effect, path: string) {
    return this.db.sql.exec<PolicyChange>(
      'SELECT * FROM moderation WHERE effect=? AND path=? ORDER BY position DESC LIMIT 1', effect, path).toArray()[0];
  }
  active(effect: Effect, path: string) { return this.decision(effect, path)?.active === 1; }
  page(after: string) {
    u64(after);
    const through = this.position();
    check(u64(after) <= u64(through), 'policy_cursor_ahead');
    const changes = this.db.sql.exec<PolicyChange>(
      'SELECT * FROM moderation WHERE position>? ORDER BY position LIMIT ?', orderedU64(after), POLICY_BATCH).toArray();
    const next = changes.length ? String(BigInt(changes.at(-1)!.position)) : after;
    return { changes, after: next, through, more: u64(next) < u64(through) };
  }
  /** Caller holds the journal transaction, then syncs before acknowledging.
   * Used by local policy writes and the future trusted inter-shard follower.
   */
  apply(changes: readonly PolicyChange[]) {
    check(Array.isArray(changes) && changes.length <= POLICY_BATCH, 'policy_batch_limit');
    const c = this.db.control(), before = c.moderation;
    check(c.barrier?.phase !== 'held', 'barrier_held');
    for (const change of changes) {
      validateChange(change);
      if (change.position <= orderedU64(c.moderation)) {
        const old = this.db.sql.exec<PolicyChange>('SELECT * FROM moderation WHERE position=?', change.position).toArray()[0];
        check(old && Object.keys(change).every(k => old[k] === change[k]), 'policy_history_conflict');
        continue; // Delayed identical delivery can never rewind the decision.
      }
      check(change.position === orderedU64(nextU64(c.moderation)), 'policy_gap');
      check(change.epoch <= orderedU64(c.epoch), 'policy_future_epoch');
      const last = this.db.sql.exec<{ epoch: string }>('SELECT epoch FROM moderation ORDER BY position DESC LIMIT 1').toArray()[0];
      check(!last || last.epoch <= change.epoch, 'policy_epoch_rewound');
      const previous = this.decision(change.effect, change.path);
      check(!previous || (previous.active !== change.active && previous.epoch <= change.epoch), 'policy_repeated_or_rewound');
      this.db.sql.exec('INSERT INTO moderation VALUES (?, ?, ?, ?, ?, ?)',
        change.position, change.effect, change.path, change.active, change.epoch, change.at_ms);
      c.moderation = String(BigInt(change.position));
      this.db.record(c, 'moderation', change.position);
    }
    if (c.moderation !== before) this.db.save(c);
  }
}

/** One bounded pull, with no timer or waiting queue. A future shard calls tick
 * on an alarm/request; the single authoritative coordinator needs no polling.
 * Apply must atomically persist the batch and cursor before resolving.
 */
export class PolicyFollower {
  private due = 0;
  private busy = false;
  private lastAttemptMs: number | null = null;
  private lastSuccessMs: number | null = null;
  private lastError: 'pull_failed' | 'invalid_page' | 'apply_failed' | null = null;
  private through: string | null = null;
  private local: { position(): string; apply(changes: PolicyChange[]): Promise<void> };
  private pull: (after: string) => Promise<ReturnType<Moderation['page']>>;
  constructor(local: { position(): string; apply(changes: PolicyChange[]): Promise<void> },
    pull: (after: string) => Promise<ReturnType<Moderation['page']>>) { this.local = local; this.pull = pull; }
  /** Ephemeral diagnostics, not proof of freshness. Durable truth is the applied cursor. */
  status() {
    return { busy: this.busy, lastAttemptMs: this.lastAttemptMs, lastSuccessMs: this.lastSuccessMs,
      lastError: this.lastError, observedThrough: this.through, nextAttemptMs: this.due };
  }
  async tick(now: number): Promise<void> {
    if (this.busy || now < this.due) return;
    this.busy = true;
    this.lastAttemptMs = now;
    this.due = now + POLICY_REFRESH_MS; // Outages back off, retaining the last applied policy.
    let stage: NonNullable<PolicyFollower['lastError']> = 'pull_failed';
    try {
      const after = this.local.position(), page = await this.pull(after);
      stage = 'invalid_page';
      check(Array.isArray(page.changes) && page.changes.length <= POLICY_BATCH, 'policy_batch_limit');
      u64(page.after); u64(page.through);
      let cursor = after;
      for (const change of page.changes) {
        validateChange(change);
        check(change.position === orderedU64(nextU64(cursor)), 'policy_gap');
        cursor = String(BigInt(change.position));
      }
      check(cursor === page.after && u64(cursor) <= u64(page.through)
        && page.more === (u64(cursor) < u64(page.through))
        && (!page.more || page.changes.length > 0), 'invalid_policy_page');
      stage = 'apply_failed';
      await this.local.apply(page.changes);
      this.through = page.through; this.lastSuccessMs = Date.now(); this.lastError = null;
      if (page.more) this.due = now; // Next tick continues; never loop over the whole backlog.
    } catch (error) {
      this.lastError = stage; // Fixed codes only; never retain provider errors or credentials.
      throw error;
    } finally { this.busy = false; }
  }
}

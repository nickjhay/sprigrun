import { check, nextU64, orderedU64, u64 } from '../src/bytes.ts';
import { parseReference } from '../src/references.ts';
import type { State } from './state.ts';

export const POLICY_BATCH = 32;
export type Effect = 'hide' | 'block';
export interface PolicyChange extends Record<string, SqlStorageValue> {
  position: string; effect: Effect; path: string; active: number; at_ms: string;
}

export function validateChange(value: unknown): asserts value is PolicyChange {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_policy_change');
  const r = value as PolicyChange;
  const fields = ['position', 'effect', 'path', 'active', 'at_ms'];
  check(Object.keys(r).length === fields.length && fields.every(k => Object.hasOwn(r, k)), 'invalid_policy_change');
  check(r.effect === 'hide' || r.effect === 'block', 'invalid_policy_effect');
  check(r.active === 0 || r.active === 1, 'invalid_policy_change');
  check(typeof r.position === 'string' && /^[0-9]{20}$/.test(r.position)
    && orderedU64(String(BigInt(r.position))) === r.position, 'invalid_policy_position');
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
   */
  apply(changes: readonly PolicyChange[]) {
    check(Array.isArray(changes) && changes.length <= POLICY_BATCH, 'policy_batch_limit');
    const c = this.db.control(), before = c.moderation;
    for (const change of changes) {
      validateChange(change);
      if (change.position <= orderedU64(c.moderation)) {
        const old = this.db.sql.exec<PolicyChange>('SELECT * FROM moderation WHERE position=?', change.position).toArray()[0];
        check(old && Object.keys(change).every(k => old[k] === change[k]), 'policy_history_conflict');
        continue; // Delayed identical delivery can never rewind the decision.
      }
      check(change.position === orderedU64(nextU64(c.moderation)), 'policy_gap');
      const previous = this.decision(change.effect, change.path);
      check(!previous || previous.active !== change.active, 'policy_repeated');
      this.db.sql.exec('INSERT INTO moderation VALUES (?, ?, ?, ?, ?)',
        change.position, change.effect, change.path, change.active, change.at_ms);
      c.moderation = String(BigInt(change.position));
      this.db.record(c, 'moderation', change.position);
    }
    if (c.moderation !== before) this.db.save(c);
  }
}

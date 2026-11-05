import { owner } from './placement.ts';
import { check, nextU64, textBytes, u64 } from '../src/bytes.ts';
import { canonicalOrigin } from '../src/references.ts';
import { policy, type Policy } from './policy.ts';
import { canonical, fields } from './shape.ts';

export type Topology = { format: 'sprig-topology/2'; id: string; revision: string;
  origin: string; shards: Record<string, true>; budget: Policy };
export type Partition = { topology: Topology; shard: string };
export type BarrierState = { id: string; epoch: string; phase: 'held' | 'released'; manifest: string | null };
export function identifier(value: unknown): asserts value is string {
  check(typeof value === 'string' && /^[0-9a-f]{32}$/.test(value), 'barrier_id');
}
export function topology(value: unknown): Topology {
  fields(value, ['format', 'id', 'revision', 'origin', 'shards', 'budget']);
  check(value.format === 'sprig-topology/2', 'topology_version');
  identifier(value.id); u64(value.revision); canonicalOrigin(value.origin);
  check(value.shards !== null && typeof value.shards === 'object' && !Array.isArray(value.shards), 'topology_shards');
  const names = Object.keys(value.shards);
  check(names.length > 0 && names.length <= 16 && names.every(n => /^[a-z][a-z0-9_]{0,31}$/.test(n) && value.shards[n] === true), 'topology_shards');
  fields(value.budget, ['sourceBytes', 'chatBytes', 'minimumDebit', 'growth', 'burst', 'attempts']);
  for (const k of ['growth', 'burst', 'attempts']) fields(value.budget[k], ['capacity', 'refill', 'periodMs']);
  policy(value.budget as Policy);
  const t = structuredClone(value) as Topology;
  for (const name of names) dividedPolicy(t, name);
  return t;
}
/** Canonical name order gets each remainder unit exactly once; no rounded-up budgets. */
export function dividedPolicy(t: Topology, shard: string): Policy {
  const names = Object.keys(t.shards).sort(), index = names.indexOf(shard);
  check(index >= 0, 'unknown_shard');
  const p = structuredClone(t.budget);
  for (const k of ['growth', 'burst', 'attempts'] as const)
    for (const f of ['capacity', 'refill'] as const) {
      const n = p[k][f]; p[k][f] = Math.floor(n / names.length) + (index < n % names.length ? 1 : 0);
    }
  return policy(p);
}
export function partition(value: unknown): Partition | null {
  if (value === null) return null;
  fields(value, ['topology', 'shard']);
  const t = topology(value.topology);
  check(typeof value.shard === 'string' && Object.hasOwn(t.shards, value.shard), 'unknown_shard');
  return { topology: t, shard: value.shard };
}
export function barrierState(value: unknown): BarrierState | null {
  if (value === null) return null;
  fields(value, ['id', 'epoch', 'phase', 'manifest']); identifier(value.id); nextU64(value.epoch);
  check(value.phase === 'held' || value.phase === 'released', 'barrier_phase');
  check(value.phase === 'held' ? value.manifest === null : typeof value.manifest === 'string' && /^[0-9a-f]{64}$/.test(value.manifest), 'barrier_manifest');
  return value as BarrierState;
}
export function barrierTransition(previous: BarrierState | null, next: BarrierState, epoch: string) {
  if (next.phase === 'held') check((previous === null || previous.phase === 'released')
    && previous?.id !== next.id && next.epoch === epoch, 'barrier_transition');
  else check(previous?.phase === 'held' && previous.id === next.id && previous.epoch === next.epoch
    && nextU64(next.epoch) === epoch, 'barrier_transition');
}
export function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }

/** Fixed placement v2: SHA-256 of the canonical logical owner, big-endian modulo roster size. */
export async function shardFor(t: Topology, path: string): Promise<string> {
  const names = Object.keys(t.shards).sort();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', textBytes(owner(path))));
  let index = 0; for (const byte of bytes) index = (index * 256 + byte) % names.length;
  return names[index]!;
}

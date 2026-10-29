// Offline executable model, not an archive format or a production storage adapter.
// Each function returns the whole next state: the caller models one atomic commit.
// Real SQL would update only the affected rows, never clone or scan the whole DB.
import type { Receipt } from '../src/state.ts';

type Row = { born: number; receipt: Receipt };
type Failure = 'expired' | 'shadow_limit' | 'suppression';
type Checkpoint = {
  kind: 'active'; generation: number; capturedAtMs: number; expiresAtMs: number;
  maxShadowRows: number; shadows: Receipt[]; count: number;
  // Representative small configuration. Actual archive fields need a v2 spec.
  settings: Record<string, string | number | boolean>;
} | { kind: 'invalid'; generation: number; reason: Failure };
export interface Model {
  generation: number;
  rows: Row[];
  checkpoint: Checkpoint | null;
}

export function initial(receipts: Receipt[] = []): Model {
  if (new Set(receipts.map(r => r.address)).size !== receipts.length) throw new Error('duplicate_address');
  return { generation: 0, rows: structuredClone(receipts).map(receipt => ({ born: 0, receipt })), checkpoint: null };
}

function invalidate(state: Model, reason: Failure): void {
  if (state.checkpoint?.kind === 'active')
    state.checkpoint = { kind: 'invalid', generation: state.checkpoint.generation, reason };
}
function expire(state: Model, nowMs: number): void {
  if (state.checkpoint?.kind === 'active' && nowMs >= state.checkpoint.expiresAtMs)
    invalidate(state, 'expired');
}

export function seal(state: Model, settings: Record<string, string | number | boolean>, options: {
  nowMs: number; ttlMs: number; maxShadowRows: number;
}): Model {
  const { nowMs, ttlMs, maxShadowRows } = options;
  if (![nowMs, ttlMs, maxShadowRows, nowMs + ttlMs, state.generation + 1].every(Number.isSafeInteger)
      || nowMs < 0 || ttlMs <= 0 || maxShadowRows < 0) throw new Error('invalid_limits');
  const next = structuredClone(state);
  expire(next, nowMs);
  if (next.checkpoint?.kind === 'active') throw new Error('checkpoint_already_active');
  next.checkpoint = {
    kind: 'active', generation: next.generation++, capturedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs, maxShadowRows, shadows: [], count: next.rows.length,
    settings: structuredClone(settings),
  };
  return next;
}

// Receipt validity, quota accounting and transition authorization belong to the
// existing coordinator. This models only preservation of its already-valid writes.
export function write(state: Model, receipt: Receipt, nowMs: number): Model {
  const next = structuredClone(state);
  expire(next, nowMs);
  const old = next.rows.find(row => row.receipt.address === receipt.address);
  // Conservative prototype policy: suppression wins, even for post-cut addresses.
  // No source pin/copy can delay a block. This does NOT erase completed backups.
  if (receipt.status === 'blocked') invalidate(next, 'suppression');
  if (old && Object.keys(old.receipt).length === Object.keys(receipt).length
      && Object.keys(receipt).every(key => old.receipt[key] === receipt[key])) return next;
  const cut = next.checkpoint;
  if (cut?.kind === 'active' && old && old.born <= cut.generation
      && !cut.shadows.some(r => r.address === receipt.address)) {
    if (cut.shadows.length >= cut.maxShadowRows) invalidate(next, 'shadow_limit');
    else cut.shadows.push(structuredClone(old.receipt));
  }
  if (old) old.receipt = structuredClone(receipt);
  else next.rows.push({ born: next.generation, receipt: structuredClone(receipt) });
  return next;
}

export function view(state: Model, generation: number, nowMs: number): {
  generation: number; settings: Record<string, string | number | boolean>; receipts: Receipt[];
} {
  const cut = state.checkpoint;
  if (!cut || cut.generation !== generation) throw new Error('checkpoint_unknown');
  if (cut.kind === 'invalid') throw new Error('checkpoint_' + cut.reason);
  if (nowMs >= cut.expiresAtMs) throw new Error('checkpoint_expired');
  const shadows = new Map(cut.shadows.map(r => [r.address, r]));
  const receipts = state.rows.filter(row => row.born <= cut.generation)
    .map(row => shadows.get(row.receipt.address) ?? row.receipt)
    .sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  if (receipts.length !== cut.count) throw new Error('checkpoint_membership_changed');
  return structuredClone({ generation, settings: cut.settings, receipts });
}

// Release is cleanup, NOT an assertion that an independently durable backup exists.
export function release(state: Model, generation: number): Model {
  if (state.checkpoint?.generation !== generation) throw new Error('checkpoint_unknown');
  return { ...structuredClone(state), checkpoint: null };
}

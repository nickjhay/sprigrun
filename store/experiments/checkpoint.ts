// Offline commit-boundary model. Production must put the short metadata operations
// in durable SQL transactions; private R2 preparation runs outside that boundary.
// `available` models verified private payloads, not a public serving index.
interface Stamp { epoch: number; atMs: number }
interface Reservation extends Stamp { bytes: number; debit: number }
export interface Facts {
  address: string;
  reservation: Reservation | null;
  publication: Stamp | null;
  block: Stamp | null;
}
interface Cut {
  epoch: number; expiresAtMs: number;
  settings: Record<string, string | number | boolean>;
}
export interface Model {
  epoch: number;
  rows: Facts[];
  available: string[];
  cut: Cut | null;
}
export interface SnapshotRow extends Facts { body: string | null }
export const initial = (): Model => ({ epoch: 0, rows: [], available: [], cut: null });
const row = (state: Model, address: string): Facts | undefined => state.rows.find(r => r.address === address);
const blank = (address: string): Facts => ({ address, reservation: null, publication: null, block: null });
const stamp = (state: Model, atMs: number): Stamp => ({ epoch: state.epoch, atMs });
const update = (state: Model, facts: Facts): Model => ({ ...state,
  rows: [...state.rows.filter(r => r.address !== facts.address), facts],
});
const at = <T extends Stamp>(fact: T | null, epoch: number): T | null => fact && fact.epoch <= epoch ? fact : null;
function project(facts: Facts, epoch: number): Facts {
  return { address: facts.address, reservation: at(facts.reservation, epoch),
    publication: at(facts.publication, epoch), block: at(facts.block, epoch) };
}

// Admission/authorization and bounded quota checks precede this trusted operation.
// Reservation is its own atomic accounting fact, not a published blob.
export function reserve(state: Model, address: string, bytes: number, debit: number, nowMs: number): Model {
  const old = row(state, address) ?? blank(address);
  if (old.block) throw new Error('blob_blocked');
  if (old.reservation) return state;
  return update(state, { ...old, reservation: { ...stamp(state, nowMs), bytes, debit } });
}

// Represents completion of a conditional R2 PUT after exact-byte verification.
// A late remote write may finish after a block; it still cannot publish itself.
export function prepared(state: Model, address: string): Model {
  if (!row(state, address)?.reservation) throw new Error('reservation_required');
  return state.available.includes(address) ? state : { ...state, available: [...state.available, address] };
}

export function publish(state: Model, address: string, nowMs: number): Model {
  const old = row(state, address);
  if (old?.block) throw new Error('blob_blocked');
  if (!old?.reservation || !state.available.includes(address)) throw new Error('payload_not_prepared');
  if (old.publication) return state; // Lost-ACK retry retains first publication epoch/time.
  return update(state, { ...old, publication: stamp(state, nowMs) });
}
export function block(state: Model, address: string, nowMs: number): Model {
  const old = row(state, address) ?? blank(address);
  return old.block ? state : update(state, { ...old, block: stamp(state, nowMs) });
}

// No payload work, scan, per-row clone, or generation broadcast in this barrier.
// A production transaction captures bounded control facts and flushes before ACK.
export function seal(state: Model, settings: Record<string, string | number | boolean>, nowMs: number, ttlMs: number): Model {
  if (![nowMs, ttlMs, nowMs + ttlMs, state.epoch + 1].every(Number.isSafeInteger)
      || nowMs < 0 || ttlMs <= 0) throw new Error('invalid_limits');
  if (state.cut && nowMs < state.cut.expiresAtMs) throw new Error('checkpoint_already_active');
  return { ...state, epoch: state.epoch + 1,
    cut: { epoch: state.epoch, expiresAtMs: nowMs + ttlMs, settings: structuredClone(settings) } };
}
function cut(state: Model, epoch: number, nowMs: number): Cut {
  if (!state.cut || state.cut.epoch !== epoch) throw new Error('checkpoint_unknown');
  if (nowMs >= state.cut.expiresAtMs) throw new Error('checkpoint_expired');
  return state.cut;
}
export function snapshot(state: Model, epoch: number, nowMs: number): { settings: Cut['settings']; rows: SnapshotRow[] } {
  const selected = cut(state, epoch, nowMs);
  const rows = state.rows.map(r => project(r, epoch)).filter(r => r.reservation || r.publication || r.block)
    .map(r => {
      const body = r.publication && !r.block ? r.address : null;
      if (body && !state.available.includes(body)) throw new Error('snapshot_payload_missing');
      return { ...r, body };
    }).sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  return structuredClone({ settings: selected.settings, rows });
}

// The public Worker must consult this authority BEFORE GET/HEAD/304, rather than
// serving any bytes that happen to exist at a private R2 key.
export function readable(state: Model, address: string): boolean {
  const facts = row(state, address);
  return !!facts?.publication && !facts.block;
}

// A block suppresses immediately; physical reclamation respects the snapshot pin.
// Pending preparations need their own reconciler; this model reclaims only blocks.
export function reclaim(state: Model, address: string, nowMs: number): Model {
  const facts = row(state, address);
  if (!facts?.block) throw new Error('reclamation_requires_block');
  const old = state.cut && nowMs < state.cut.expiresAtMs ? project(facts, state.cut.epoch) : null;
  if (old?.publication && !old.block) throw new Error('snapshot_pins_payload');
  return { ...state, available: state.available.filter(a => a !== address) };
}

// Cleanup only, not a claim that an independently durable archive was completed.
export function release(state: Model, epoch: number): Model {
  if (state.cut?.epoch !== epoch) throw new Error('checkpoint_unknown');
  return { ...state, cut: null };
}

import assert from 'node:assert/strict';
import { initial, seal, write, view } from '../store/experiments/checkpoint.ts';
import { addressOf } from '../src/document.ts';

// Offline metadata experiment. No source bytes are uploaded or backed up here.
async function receipt(source, status, submittedAtMs) {
  const bytes = new TextEncoder().encode(source);
  return { address: await addressOf(bytes), status, bytes: bytes.length, debit: 8192, submitted_at_ms: submittedAtMs };
}
const fern = await receipt('print "a fern uncurls"\n', 'pending', 100);
const moss = await receipt('print "moss arrives"\n', 'stored', 210);
let state = seal(initial([fern]), { proofOfWorkBits: 0 }, { nowMs: 200, ttlMs: 1000, maxShadowRows: 10 });
const cut = view(state, 0, 201);
state = write(state, { ...fern, status: 'stored' }, 202);
state = write(state, moss, 210);
state = JSON.parse(JSON.stringify(state)); // Restart from the simulated committed state.
assert.deepEqual(view(state, 0, 211), cut);
console.log('Seal generation 0; new writes use generation 1.\n');
console.table([
  { view: 'sealed', fern: view(state, 0, 211).receipts[0].status, moss: 'absent' },
  { view: 'live', fern: state.rows[0].receipt.status, moss: state.rows[1].receipt.status },
]);
console.log('One small receipt preimage preserves the cut across confirmation and restart.');
state = write(state, { ...fern, status: 'blocked' }, 212);
assert.throws(() => view(state, 0, 213), /checkpoint_suppression/);
console.log('A later block succeeds immediately and invalidates the unfinished snapshot.');
console.log('This models the metadata boundary only. A sealed cut is not yet a backup.');

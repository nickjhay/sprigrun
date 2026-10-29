import assert from 'node:assert/strict';
import { initial, reserve, prepared, publish, block, seal, snapshot, readable, reclaim } from '../store/experiments/checkpoint.ts';
import { addressOf } from '../src/document.ts';

// Offline commit/visibility experiment. No bytes are uploaded or backed up here.
async function source(text) {
  const bytes = new TextEncoder().encode(text);
  return { address: await addressOf(bytes), bytes: bytes.length };
}
const fern = await source('print "a fern uncurls"\n');
const moss = await source('print "moss arrives"\n');
let state = reserve(initial(), fern.address, fern.bytes, 8192, 100);
state = publish(prepared(state, fern.address), fern.address, 110);
state = reserve(state, moss.address, moss.bytes, 8192, 120);
state = seal(state, { proofOfWorkBits: 0 }, 200, 1000);
const cut = snapshot(state, 0, 201);
state = publish(prepared(state, moss.address), moss.address, 210);
state = block(state, fern.address, 220);
state = JSON.parse(JSON.stringify(state)); // Simulated restart from committed facts.
assert.deepEqual(snapshot(state, 0, 221), cut);
assert.throws(() => reclaim(state, fern.address, 221), /snapshot_pins_payload/);
console.log('Seal epoch 0; subsequent publications and blocks commit in epoch 1.\n');
console.table([
  { view: 'sealed', fern: 'published', moss: 'reserved, not published' },
  { view: 'live', fern: readable(state, fern.address) ? 'published' : 'blocked', moss: readable(state, moss.address) ? 'published' : 'absent' },
]);
console.log('Preparation crossed the barrier; publication used the new epoch.');
console.log('Blocking changed live visibility immediately; the old snapshot still has its fern.');
console.log('The fern payload stays private and pinned until copying finishes or expires.');
console.log('No general undo log: retain the reservation, publication and block facts.');
console.log('This is an offline model. A sealed cut is not yet a durable backup.');

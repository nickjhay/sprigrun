import assert from 'node:assert/strict';
import test from 'node:test';
import { initial, reserve, prepared, publish, block, seal, snapshot, readable, reclaim, release } from '../experiments/checkpoint.ts';

const addr = n => n.toString(16).padStart(64, '0') + '_4';
const a = addr(1), b = addr(2), fern = addr(3);
const reserveAt = (state, address, now = 100) => reserve(state, address, 4, 8192, now);
const store = (state, address, now = 100) => publish(prepared(reserveAt(state, address, now), address), address, now + 1);
const reopen = state => JSON.parse(JSON.stringify(state)); // Simulated persistence, not a disk durability test.
const begin = state => seal(state, { proofOfWorkBits: 0 }, 200, 100);

function* permutations(xs) {
  if (!xs.length) { yield []; return; }
  for (let i = 0; i < xs.length; i++)
    for (const tail of permutations(xs.filter((_, j) => i !== j))) yield [xs[i], ...tail];
}

test('an unfinished prepare does not hold the barrier and publication takes the current epoch', async () => {
  let state = store(initial(), fern), finishPrepare;
  const pending = new Promise(resolve => { finishPrepare = resolve; });
  const upload = (async () => {
    state = reserveAt(state, a);
    await pending; // Slow remote I/O, deliberately outstanding across seal.
    state = publish(prepared(state, a), a, 210);
  })();
  state = begin(state);
  const expected = snapshot(state, 0, 201);
  assert.equal(readable(state, a), false);
  assert.equal(expected.rows.find(r => r.address === a).body, null);
  assert.equal(state.epoch, 1);
  finishPrepare(); await upload;
  assert.equal(readable(state, a), true);
  assert.deepEqual(state.rows.find(r => r.address === a).publication, { epoch: 1, atMs: 210 });
  assert.deepEqual(snapshot(reopen(state), 0, 211), expected);
});

test('private bytes ready before the barrier still publish after it; unpublished bytes stay invisible', () => {
  let state = prepared(reserveAt(initial(), a), a);
  assert.equal(state.available.includes(a), true);
  assert.equal(readable(state, a), false);
  state = begin(state);
  const expected = snapshot(state, 0, 201);
  state = publish(state, a, 210);
  assert.deepEqual(snapshot(state, 0, 211), expected);
  assert.equal(state.rows[0].publication.epoch, 1);
});

test('all 24 orders of later publications, a block and a new reservation preserve the cut across restart', () => {
  let start = store(initial(), fern);
  start = prepared(reserveAt(start, a), a);
  start = prepared(reserveAt(start, b), b);
  start = begin(start);
  const expected = snapshot(start, 0, 201);
  const ops = [s => publish(s, a, 210), s => publish(s, b, 210),
    s => block(s, fern, 210), s => reserveAt(s, addr(0), 210)];
  for (const order of permutations(ops)) {
    let state = start;
    for (const operation of order) {
      state = reopen(operation(state));
      assert.deepEqual(snapshot(state, 0, 211), expected);
    }
    assert.equal(readable(state, fern), false);
    assert.equal(snapshot(state, 0, 211).rows.find(r => r.address === fern).body, fern);
  }
});

test('blocks before and after the barrier are ordered facts; late R2 success cannot resurrect a block', () => {
  let state = prepared(reserveAt(initial(), a), a);
  state = block(state, a, 150);
  state = begin(state);
  assert.equal(snapshot(state, 0, 201).rows[0].block.epoch, 0);
  assert.equal(snapshot(state, 0, 201).rows[0].body, null);
  state = reclaim(state, a, 202);
  state = prepared(state, a); // A remote operation can finish late, even after cleanup.
  assert.equal(readable(state, a), false);
  assert.throws(() => publish(state, a, 203), /blob_blocked/);
  assert.throws(() => reserveAt(state, a, 203), /blob_blocked/);
  state = block(state, b, 204); // Even a new-address block leaves the cut intact.
  assert.equal(snapshot(state, 0, 205).rows.length, 1);
  assert.deepEqual(state.rows.find(r => r.address === b).block, { epoch: 1, atMs: 204 });
});

test('blocking immediately changes live visibility while snapshot pins survive serialized restart', () => {
  let state = begin(store(initial(), a));
  state = reopen(block(state, a, 210));
  assert.equal(readable(state, a), false);
  assert.throws(() => reclaim(state, a, 211), /snapshot_pins_payload/);
  assert.equal(snapshot(state, 0, 211).rows[0].body, a);
  state = release(state, 0);
  state = reclaim(state, a, 212);
  assert.equal(state.available.length, 0);
  assert.equal(readable(state, a), false);
});

test('lost-ACK retries keep original epochs/times; independent cut settings do not alias callers', () => {
  let state = store(initial(), a);
  const original = structuredClone(state.rows[0]), settings = { proofOfWorkBits: 0 };
  state = seal(state, settings, 200, 100);
  settings.proofOfWorkBits = 20;
  state = publish(reopen(state), a, 210);
  assert.deepEqual(state.rows[0], original);
  const result = snapshot(state, 0, 211);
  result.rows[0].reservation.debit = 0;
  assert.equal(snapshot(state, 0, 212).rows[0].reservation.debit, 8192);
  assert.equal(snapshot(state, 0, 212).settings.proofOfWorkBits, 0);
  state = block(state, a, 213);
  state = block(state, a, 214);
  assert.deepEqual(state.rows[0].block, { epoch: 1, atMs: 213 });
});

test('expiry ends the pin, a later cut sees the block, and stale handles cannot release it', () => {
  let state = block(begin(store(initial(), a)), a, 210);
  assert.equal(snapshot(state, 0, 299).rows[0].body, a);
  assert.throws(() => seal(state, {}, 299, 100), /already_active/);
  assert.throws(() => snapshot(state, 0, 300), /expired/);
  state = reclaim(state, a, 300);
  state = seal(state, {}, 301, 100);
  assert.equal(snapshot(state, 1, 302).rows[0].body, null);
  assert.equal(snapshot(state, 1, 302).rows[0].block.epoch, 1);
  assert.throws(() => snapshot(state, 0, 302), /unknown/);
  assert.throws(() => release(state, 0), /unknown/);
});

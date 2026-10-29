import assert from 'node:assert/strict';
import test from 'node:test';
import { initial, seal, write, view, release } from '../experiments/checkpoint.ts';

const receipt = (n, status = 'pending') => ({
  address: n.toString(16).padStart(64, '0') + '_4', status,
  bytes: 4, debit: 8192, submitted_at_ms: 100 + n,
});
const options = { nowMs: 200, ttlMs: 100, maxShadowRows: 20 };
const begin = (rows, overrides = {}) => seal(initial(rows), { proofOfWorkBits: 0 }, { ...options, ...overrides });
const reopen = state => JSON.parse(JSON.stringify(state)); // Simulated committed state, not a disk durability test.

test('a cut survives new admissions, confirmation, serialized restart and caller mutation', () => {
  const a = receipt(1), b = receipt(2, 'stored'), settings = { proofOfWorkBits: 0 };
  let state = seal(initial([b, a]), settings, options);
  const expected = view(state, 0, 201);
  settings.proofOfWorkBits = 24;
  state = write(state, receipt(0, 'stored'), 202); // New address sorts before the cursor.
  state = reopen(write(state, { ...a, status: 'stored' }, 203));
  assert.deepEqual(view(state, 0, 204), expected);
  assert.equal(state.rows.find(r => r.receipt.address === a.address).receipt.status, 'stored');
  const detached = view(state, 0, 205);
  detached.receipts[0].status = 'blocked';
  assert.deepEqual(view(state, 0, 206), expected);
  assert.equal(state.checkpoint.shadows.length, 1);
});

test('cut contents remain fixed across every ordering of independent writes and intervening restarts', () => {
  function* permutations(xs) {
    if (!xs.length) { yield []; return; }
    for (let i = 0; i < xs.length; i++)
      for (const tail of permutations(xs.filter((_, j) => i !== j))) yield [xs[i], ...tail];
  }
  const start = begin([receipt(1), receipt(2)]), expected = view(start, 0, 201);
  const writes = [receipt(1, 'stored'), receipt(2, 'stored'), receipt(0), receipt(3)];
  for (const order of permutations(writes)) {
    let state = start;
    for (const next of order) {
      state = reopen(write(state, next, 210));
      assert.deepEqual(view(state, 0, 211), expected);
    }
    assert.equal(state.checkpoint.shadows.length, 2);
  }
});

test('the first preimage is kept once; bounds abort the snapshot without refusing a live write', () => {
  let state = begin([receipt(1), receipt(2)], { maxShadowRows: 1 });
  state = write(state, receipt(1, 'stored'), 210);
  state = write(state, receipt(1, 'stored'), 211);
  assert.equal(state.checkpoint.shadows.length, 1);
  assert.equal(view(state, 0, 212).receipts[0].status, 'pending');
  state = reopen(write(state, receipt(2, 'stored'), 213));
  assert.throws(() => view(state, 0, 214), /checkpoint_shadow_limit/);
  assert.ok(state.rows.every(row => row.receipt.status === 'stored'));
  assert.equal('shadows' in state.checkpoint, false);
  const zero = write(begin([receipt(1)], { maxShadowRows: 0 }), receipt(1, 'stored'), 210);
  assert.throws(() => view(zero, 0, 211), /checkpoint_shadow_limit/);
  const unchanged = write(begin([receipt(1, 'stored')], { maxShadowRows: 0 }), receipt(1, 'stored'), 210);
  assert.equal(view(unchanged, 0, 211).receipts[0].status, 'stored');
});

test('suppression aborts a cut, including for a new address, and a later cut sees the block', () => {
  for (const n of [1, 2]) {
    const before = begin([receipt(1, 'stored')]);
    const blocked = reopen(write(before, receipt(n, 'blocked'), 210));
    assert.throws(() => view(blocked, 0, 211), /checkpoint_suppression/);
    const next = seal(blocked, {}, { ...options, nowMs: 220 });
    assert.equal(view(next, 1, 221).receipts.find(r => r.address === receipt(n).address).status, 'blocked');
    assert.throws(() => view(next, 0, 221), /checkpoint_unknown/);
    assert.throws(() => release(next, 0), /checkpoint_unknown/);
  }
});

test('expiry is checked on reads and writes, and release cannot finish a later generation', () => {
  let state = begin([receipt(1)]);
  assert.equal(view(state, 0, 299).receipts.length, 1);
  assert.throws(() => view(state, 0, 300), /checkpoint_expired/);
  state = write(state, receipt(1, 'stored'), 300);
  assert.equal(state.checkpoint.reason, 'expired');
  state = seal(state, {}, { ...options, nowMs: 310 });
  assert.equal(view(state, 1, 311).receipts[0].status, 'stored');
  assert.throws(() => seal(state, {}, { ...options, nowMs: 312 }), /already_active/);
  state = release(state, 1);
  assert.throws(() => view(state, 1, 313), /unknown/);
  assert.equal(state.rows[0].receipt.status, 'stored');
  const expiredWithoutWrite = seal(begin([]), {}, { ...options, nowMs: 300 });
  assert.equal(expiredWithoutWrite.checkpoint.generation, 1);
});

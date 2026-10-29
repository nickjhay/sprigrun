import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { genesisBytes, publicKeyHex, signUpdate } from '../src/names/model.ts';
import { NameReplay, NAME_REPLAY_POLICY } from '../src/names/replay.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex') + '_' + bytes.length;
const target = text => hash(Buffer.from(text));
const admit = (replay, item, sequence, acceptedAtMs) =>
  replay.admit(item.bytes, item.address, { sequence: String(sequence), acceptedAtMs });
async function key() {
  const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  return { ...pair, id: await publicKeyHex(pair.publicKey) };
}
async function fixture() {
  const [keeper, daily, fresh] = await Promise.all([key(), key(), key()]);
  const keys = [keeper.id, daily.id];
  const bytes = genesisBytes(keys, 'ab'.repeat(16));
  const genesis = hash(bytes);
  const make = async (parent, signer = daily, label = 'fern', nextKeys = keys) => {
    const bytes = await signUpdate({ genesis, parent, target: target(label), signer: signer.id, keys: nextKeys }, signer.privateKey);
    return { bytes, address: hash(bytes) };
  };
  const open = (options = {}) => NameReplay.open(bytes, genesis, {
    genesisAdmission: { sequence: '1', acceptedAtMs: 0 }, recoveryWindowMs: 100, ...options,
  });
  return { keeper, daily, fresh, keys, bytes, genesis, make, open };
}

test('service arrival order chooses equal-priority forks and exact replay reproduces history', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis, f.daily, 'A');
  const b = await f.make(f.genesis, f.daily, 'B');
  for (const [first, second] of [[a, b], [b, a]]) {
    const s = await f.open();
    assert.equal((await admit(s, first, 2, 10)).decision, 'advance');
    assert.equal((await admit(s, second, 3, 10)).decision, 'not_stronger');
    assert.equal(s.view().head, first.address);
    const copy = await f.open();
    const blobs = new Map([a, b].map(item => [item.address, item]));
    for (const entry of s.history().slice(1)) await admit(copy, blobs.get(entry.record), entry.sequence, entry.acceptedAtMs);
    assert.deepEqual(copy.history(), s.history());
    assert.deepEqual(copy.view(), s.view());
  }
});

test('recovery deadline is inclusive and measured from the first displaced operation', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis);
  const b = await f.make(a.address, f.keeper, 'strong signature below weak edge');
  const r = await f.make(f.genesis, f.keeper, 'recovery');
  for (const [time, decision] of [[1100, 'recovery'], [1101, 'recovery_expired']]) {
    const s = await f.open();
    await admit(s, a, 2, 1000); // Genesis being old must not prevent recovery.
    await admit(s, b, 3, 1099); // A new descendant must not refresh A's window.
    assert.equal((await admit(s, r, 4, time)).decision, decision);
    assert.equal(s.view().head, decision === 'recovery' ? r.address : b.address);
    assert.equal(s.history()[2].head, b.address); // Historical selection is fixed.
  }
});

test('a finite window settles an earlier choice without forbidding normal later updates', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis);
  const r = await f.make(f.genesis, f.keeper, 'late recovery');
  const next = await f.make(a.address, f.daily, 'normal late update');
  const s = await f.open();
  await admit(s, a, 2, 1);
  assert.equal((await admit(s, r, 3, 10000)).decision, 'recovery_expired');
  assert.equal((await admit(s, next, 4, 10001)).decision, 'advance');
  assert.equal(s.view().head, next.address);
});

test('superseded and losing branches cannot revive through late descendants or duplicate submissions', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis, f.daily, 'A');
  const b = await f.make(f.genesis, f.daily, 'losing B');
  const bChild = await f.make(b.address, f.keeper, 'strong child of losing B');
  const r = await f.make(f.genesis, f.keeper, 'recovery');
  const aChild = await f.make(a.address, f.keeper, 'late child of superseded A');
  const s = await f.open();
  await admit(s, a, 2, 10);
  const lost = await admit(s, b, 3, 20);
  assert.equal((await admit(s, bChild, 4, 30)).decision, 'off_branch');
  await admit(s, r, 5, 40);
  assert.equal((await admit(s, aChild, 6, 50)).decision, 'off_branch');
  assert.deepEqual(await admit(s, b, 100, 5000), lost);
  assert.equal(s.view().head, r.address);
  assert.equal(s.view().sequence, '6');
});

test('recovery rotates working keys; an old root cannot overturn its equal-rank replacement', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis);
  const newKeys = [f.keeper.id, f.fresh.id];
  const r = await f.make(f.genesis, f.keeper, 'recovery', newKeys);
  const s = await f.open();
  await admit(s, a, 2, 10); await admit(s, r, 3, 20);
  const old = await f.make(r.address, f.daily, 'old working key', newKeys);
  await assert.rejects(admit(s, old, 4, 30), /unauthorized_name_key/);
  const next = await f.make(r.address, f.fresh, 'new working key', newKeys);
  await admit(s, next, 4, 30);
  // Rotation by the strongest key settles a rank-zero edge immediately.
  const rotateRoot = await f.make(next.address, f.keeper, 'new root', [f.fresh.id]);
  await admit(s, rotateRoot, 5, 40);
  const oldRoot = await f.make(next.address, f.keeper, 'old root sibling', [f.keeper.id]);
  assert.equal((await admit(s, oldRoot, 6, 41)).decision, 'not_stronger');
  assert.equal(s.view().head, rotateRoot.address);
});

test('priority comparison uses the fork parent and permits recovery at an interior ancestor', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis, f.keeper, 'preserved prefix', [f.fresh.id, f.daily.id]);
  const b = await f.make(a.address, f.daily, 'B', [f.fresh.id, f.daily.id]);
  const r = await f.make(a.address, f.fresh, 'recover B', [f.fresh.id]);
  const s = await f.open();
  await admit(s, a, 2, 10); await admit(s, b, 3, 1000);
  assert.equal((await admit(s, r, 4, 1100)).decision, 'recovery');
  assert.deepEqual(s.view().chain, [f.genesis, a.address, r.address]);
});

test('retiring a root does not close recovery windows on earlier weak edges', async () => {
  const f = await fixture();
  const weak = await f.make(f.genesis);
  const rotation = await f.make(weak.address, f.keeper, 'new root', [f.fresh.id]);
  const historical = await f.make(f.genesis, f.keeper, 'old root returns');
  for (const [time, decision] of [[110, 'recovery'], [111, 'recovery_expired']]) {
    const s = await f.open();
    await admit(s, weak, 2, 10);
    await admit(s, rotation, 3, 20);
    assert.equal((await admit(s, historical, 4, time)).decision, decision);
    assert.equal(s.view().head, decision === 'recovery' ? historical.address : rotation.address);
  }
});

test('duplicate hashes retain their first stamp, including at capacity and for genesis', async () => {
  const f = await fixture();
  const s = await f.open({ capacity: 2 });
  const a = await f.make(f.genesis);
  const first = await admit(s, a, 2, 10);
  assert.deepEqual(await admit(s, a, 99, 999), first);
  assert.deepEqual(await s.admit(f.bytes, f.genesis, { sequence: '0', acceptedAtMs: -1 }), s.history()[0]);
  assert.equal(s.history().length, 2);
  assert.equal(s.view().acceptedAtMs, 10);
  const tampered = new Uint8Array(a.bytes); tampered[0] ^= 1;
  await assert.rejects(s.admit(tampered, a.address, { sequence: '3', acceptedAtMs: 20 }), /name_hash_mismatch/);
});

test('sequence uses exact u64 strings, allows global gaps, and refuses wraparound', async () => {
  const f = await fixture();
  const s = await f.open({ genesisAdmission: { sequence: '9007199254740993', acceptedAtMs: 0 } });
  const a = await f.make(f.genesis);
  const b = await f.make(a.address);
  await admit(s, a, '9007199254740995', 1);
  await admit(s, b, '18446744073709551615', 2);
  const c = await f.make(b.address);
  await assert.rejects(admit(s, c, '18446744073709551616', 3), /invalid_name_sequence/);
  await assert.rejects(admit(s, c, '1', 3), /name_sequence_not_increasing/);
  assert.equal(s.view().sequence, '18446744073709551615');
  for (const sequence of ['0', '01', '-1', '1.0', '1e2', ' 1', 1, '9'.repeat(100)])
    await assert.rejects(f.open({ genesisAdmission: { sequence, acceptedAtMs: 0 } }), /invalid_name_sequence/);
});

test('invalid stamps and malformed records leave history and graph capacity untouched', async () => {
  const f = await fixture();
  const s = await f.open({ capacity: 2 });
  const a = await f.make(f.genesis);
  for (const time of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(admit(s, a, 2, time), /invalid_name_time/);
  await assert.rejects(admit(s, a, 1, 0), /name_sequence_not_increasing/);
  const bad = { bytes: Buffer.from('not a record\n'), address: target('not a record\n') };
  await assert.rejects(admit(s, bad, 2, 10));
  const missing = await f.make(target('missing parent'));
  await assert.rejects(admit(s, missing, 2, 10), /name_parent_missing/);
  const outsider = await f.make(f.genesis, f.fresh);
  await assert.rejects(admit(s, outsider, 2, 10), /unauthorized_name_key/);
  assert.equal(s.history().length, 1);
  assert.equal((await admit(s, a, 2, 10)).decision, 'advance');
  const b = await f.make(a.address);
  await assert.rejects(admit(s, b, 3, 9), /name_time_went_backwards/);
  assert.equal(s.view().sequence, '2');
});

test('missing parents reserve no order or state; retry is a new admission after the parent', async () => {
  const f = await fixture();
  const s = await f.open();
  const a = await f.make(f.genesis);
  const child = await f.make(a.address);
  await assert.rejects(admit(s, child, 2, 10), /name_parent_missing/);
  await admit(s, a, 2, 20);
  const result = await admit(s, child, 3, 30);
  assert.equal(result.decision, 'advance');
  assert.equal(result.acceptedAtMs, 30);
});

test('an in-flight replay refuses concurrency, snapshots inputs, and releases its guard on failure', async () => {
  const f = await fixture();
  const s = await f.open();
  const a = await f.make(f.genesis, f.daily, 'A');
  const b = await f.make(f.genesis, f.daily, 'B');
  const supplied = { sequence: '2', acceptedAtMs: 10 };
  const bytes = new Uint8Array(a.bytes);
  const pending = s.admit(bytes, a.address, supplied);
  supplied.sequence = '900'; supplied.acceptedAtMs = 999; bytes.fill(0);
  await assert.rejects(admit(s, b, 3, 20), /name_replay_busy/);
  assert.equal((await pending).sequence, '2');
  assert.equal(s.view().acceptedAtMs, 10);
  await assert.rejects(s.admit(Buffer.from('bad'), b.address, { sequence: '3', acceptedAtMs: 20 }), /name_hash_mismatch/);
  assert.equal((await admit(s, b, 3, 20)).decision, 'not_stronger');
  const view = s.view(); view.chain.length = 0; view.head = 'changed';
  const history = s.history(); history[0].head = 'changed'; history.length = 0;
  assert.equal(s.view().head, a.address); assert.equal(s.history().length, 3);
});

test('policy is fixed at open and full candidate capacity also refuses recovery', async () => {
  const f = await fixture();
  const options = { genesisAdmission: { sequence: '1', acceptedAtMs: 0 }, recoveryWindowMs: 100, capacity: 3 };
  const opening = NameReplay.open(f.bytes, f.genesis, options);
  options.recoveryWindowMs = 999; options.genesisAdmission.sequence = '9';
  const s = await opening;
  assert.equal(s.view().policy, NAME_REPLAY_POLICY);
  assert.equal(s.view().recoveryWindowMs, 100); assert.equal(s.view().sequence, '1');
  const a = await f.make(f.genesis, f.daily, 'A');
  const losing = await f.make(f.genesis, f.daily, 'B');
  const r = await f.make(f.genesis, f.keeper, 'recovery');
  await admit(s, a, 2, 10); await admit(s, losing, 3, 20);
  await assert.rejects(admit(s, r, 4, 30), /name_graph_full/);
  assert.equal(s.history().length, 3); assert.equal(s.view().head, a.address);
  for (const recoveryWindowMs of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.open({ recoveryWindowMs }), /invalid_name_recovery_window/);
});

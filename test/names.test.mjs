import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { NAME_PROTOCOL, NAME_LIMITS, NameGraph, genesisBytes, publicKeyHex, recordAddress, signUpdate } from '../src/names/model.ts';

const text = value => new TextEncoder().encode(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex') + '_' + bytes.length;
const target = label => hash(text(label));
const source = bytes => new TextDecoder().decode(bytes);
async function key() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  return { ...pair, id: await publicKeyHex(pair.publicKey) };
}
async function fixture(capacity) {
  const [recovery, daily, replacement] = await Promise.all([key(), key(), key()]);
  const keys = [recovery.id, daily.id];
  const bytes = genesisBytes(keys, 'ab'.repeat(16));
  const genesis = hash(bytes);
  const graph = await NameGraph.open(bytes, genesis, capacity);
  const make = async (parent, signer = daily, label = 'fern', nextKeys = keys, extra = {}) => {
    const bytes = await signUpdate({ genesis, parent, target: target(label), signer: signer.id, keys: nextKeys, ...extra }, signer.privateKey);
    return { bytes, address: hash(bytes) };
  };
  const add = item => graph.add(item.bytes, item.address);
  return { recovery, daily, replacement, keys, bytes, genesis, graph, make, add };
}

test('name records use exact content addresses and independently verifiable Ed25519 signatures', async () => {
  const f = await fixture();
  assert.equal(source(f.bytes), `protocol ${NAME_PROTOCOL}\nkind genesis\nnonce ${'ab'.repeat(16)}\nkey ${f.recovery.id}\nkey ${f.daily.id}\n`);
  assert.equal(await recordAddress(f.bytes), f.genesis);
  assert.deepEqual(f.graph.resolve(), { kind: 'head', head: f.genesis, target: null, depth: 0, chain: [f.genesis], relation: 'same' });
  const first = await f.make(f.genesis);
  const full = source(first.bytes);
  const signatureLine = full.match(/^signature ([0-9a-f]{128})\n$/m);
  const signature = signatureLine[1];
  const publicKey = createPublicKey({ key: await crypto.subtle.exportKey('jwk', f.daily.publicKey), format: 'jwk' });
  const payload = Buffer.from(NAME_PROTOCOL + '/update\n' + full.slice(0, signatureLine.index));
  assert(verify(null, payload, publicKey, Buffer.from(signature, 'hex')));
  await f.add(first);
  assert.equal(f.graph.resolve().target, target('fern'));
  const inspected = f.graph.get(first.address);
  assert.equal(inspected.rank, 1);
  inspected.record.keys.reverse(); inspected.record.target = target('changed');
  assert.equal(f.graph.get(first.address).record.target, target('fern'));
  assert.deepEqual(f.graph.get(first.address).record.keys, f.keys);
  assert.throws(() => f.graph.get(target('unknown')), /name_record_missing/);
  assert.throws(() => { f.graph.genesis = 'changed'; }, TypeError);
});

test('forward history counts updates even when content returns to an older value', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis, f.daily, 'A'); await f.add(a);
  const b = await f.make(a.address, f.daily, 'B'); await f.add(b);
  const c = await f.make(b.address, f.daily, 'A'); await f.add(c);
  const result = f.graph.resolve(a.address);
  assert.equal(result.relation, 'forward'); assert.equal(result.depth, 3); assert.equal(result.target, target('A'));
  assert.equal(f.graph.ancestorAtDepth(c.address, 1), a.address);
  assert.equal(f.graph.ancestorAtDepth(c.address, 0), f.genesis);
  assert.throws(() => f.graph.ancestorAtDepth(c.address, 4), /invalid_name_ancestor/);
  assert.throws(() => f.graph.ancestorAtDepth(c.address, 1.5), /invalid_name_ancestor/);
  result.chain.length = 0;
  assert.equal(f.graph.resolve().chain.length, 4);
});

test('a stronger sibling supersedes an entire weaker branch, independent of arrival order', async () => {
  const f = await fixture();
  const weak = await f.make(f.genesis); await f.add(weak);
  // Even a strong signature BELOW the weak edge cannot undo precedence at genesis.
  const long = await f.make(weak.address, f.recovery, 'old branch'); await f.add(long);
  const recovery = await f.make(f.genesis, f.recovery, 'recovered', [f.recovery.id, f.replacement.id]);
  await f.add(recovery);
  const result = f.graph.resolve(long.address);
  assert.equal(result.head, recovery.address); assert.equal(result.relation, 'recovery');
  assert.equal(result.depth, 1); assert.equal(result.target, target('recovered'));
  assert.equal(f.graph.ancestorAtDepth(long.address, 1), weak.address);
  const reversed = await NameGraph.open(f.bytes, f.genesis);
  for (const item of [recovery, weak, long]) await reversed.add(item.bytes, item.address);
  assert.deepEqual(reversed.resolve(long.address), result);
  const late = await f.make(long.address, f.daily, 'late weak continuation'); await f.add(late);
  assert.equal(f.graph.resolve().head, recovery.address);
});

test('equal-priority forks are explicit conflicts; a stronger sibling can resolve them', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis, f.daily, 'A');
  const b = await f.make(f.genesis, f.daily, 'B');
  await f.add(b); await f.add(a);
  const more = await f.make(a.address, f.daily, 'longer'); await f.add(more);
  assert.deepEqual(f.graph.resolve(), { kind: 'conflict', at: f.genesis, chain: [f.genesis], candidates: [a.address, b.address].sort() });
  const reversed = await NameGraph.open(f.bytes, f.genesis);
  for (const item of [a, b, more]) await reversed.add(item.bytes, item.address);
  assert.deepEqual(reversed.resolve(), f.graph.resolve());
  const recovery = await f.make(f.genesis, f.recovery); await f.add(recovery);
  assert.equal(f.graph.resolve().head, recovery.address);
});

test('a working key can rotate itself while keeping its recovery key', async () => {
  const f = await fixture();
  const rotatedKeys = [f.recovery.id, f.replacement.id];
  const rotated = await f.make(f.genesis, f.daily, 'rotated', rotatedKeys); await f.add(rotated);
  const revoked = await f.make(rotated.address, f.daily, 'old key', rotatedKeys);
  await assert.rejects(f.add(revoked), /unauthorized_name_key/);
  const next = await f.make(rotated.address, f.replacement, 'new key', rotatedKeys); await f.add(next);
  assert.equal(f.graph.resolve().target, target('new key'));
  const recovered = await f.make(rotated.address, f.recovery, 'recovered', [f.recovery.id]); await f.add(recovered);
  assert.equal(f.graph.resolve(next.address).relation, 'recovery');
});

test('weaker keys cannot delete, reorder or replace stronger authorities', async () => {
  const f = await fixture();
  for (const keys of [[f.daily.id], [f.daily.id, f.recovery.id], [f.replacement.id, f.daily.id]]) {
    const escalation = await f.make(f.genesis, f.daily, 'escalation', keys);
    await assert.rejects(f.add(escalation), /cannot_change_stronger_name_keys/);
  }
  assert.equal(f.graph.size, 1);
});

test('root rotation revokes branch extensions but does not erase historical signing authority', async () => {
  const f = await fixture();
  const rotated = await f.make(f.genesis, f.recovery, 'new root', [f.replacement.id]); await f.add(rotated);
  const forbidden = await f.make(rotated.address, f.recovery, 'old root', [f.replacement.id]);
  await assert.rejects(f.add(forbidden), /unauthorized_name_key/);
  const valid = await f.make(rotated.address, f.replacement, 'new root working', [f.replacement.id]); await f.add(valid);
  // A historical sibling cannot be dated from its signature. Do not pretend
  // branch-local rotation solves global retirement/finality of recovery keys.
  const historical = await f.make(f.genesis, f.recovery, 'historical fork'); await f.add(historical);
  assert.equal(f.graph.resolve().kind, 'conflict');
});

test('genesis binding, parent availability, claimed address and signature are all checked', async () => {
  const f = await fixture();
  const a = await f.make(f.genesis);
  await assert.rejects(f.graph.add(f.bytes, f.genesis), /expected_name_update/);
  await assert.rejects(NameGraph.open(f.bytes, target('wrong genesis')), /name_hash_mismatch/);
  await assert.rejects(f.graph.add(a.bytes, target('wrong update')), /name_hash_mismatch/);
  const missing = await f.make(target('unknown parent'));
  await assert.rejects(f.add(missing), /name_parent_missing/);
  const crossName = await f.make(f.genesis, f.daily, 'cross name', f.keys, { genesis: target('other genesis') });
  await assert.rejects(f.add(crossName), /wrong_name_genesis/);
  const outsider = await f.make(f.genesis, f.replacement);
  await assert.rejects(f.add(outsider), /unauthorized_name_key/);
  const forged = await f.make(f.genesis, f.replacement, 'forged', f.keys, { signer: f.daily.id });
  await assert.rejects(f.add(forged), /invalid_name_signature/);
  const tampered = text(source(a.bytes).replace(/^target .*$/m, 'target ' + target('tampered')));
  await assert.rejects(f.graph.add(tampered, hash(tampered)), /invalid_name_signature/);
  assert.equal(f.graph.size, 1);
});

test('strict record encoding rejects alternate bytes, ambiguous keys and malformed input', async () => {
  const f = await fixture();
  const original = source(f.bytes);
  const cases = [
    original.trimEnd(), '\ufeff' + original, original.replace('\n', '\r\n'),
    original + '\n', original + 'extra true\n', original + 'keys ignored\n',
    original.replace('kind genesis\n', 'kind genesis\nkind genesis\n'),
    original.replace('kind genesis', 'kind: genesis'),
    original.replace('kind genesis', 'kind  genesis'),
    original.replace('kind genesis', 'kind\tgenesis'),
    original.replace('kind genesis\n', '') + 'kind genesis\n',
    original.replace('kind genesis\n', 'kind genesis # comment\n'),
    original.replace('kind genesis\n', 'kind genesis\n---\n'),
  ];
  for (const source of cases) await assert.rejects(NameGraph.open(text(source), hash(text(source))), /noncanonical_name_record/);
  for (const raw of [text('null'), text('[]'), text('{'), new Uint8Array([255])])
    await assert.rejects(NameGraph.open(raw, hash(raw)));
  assert.throws(() => genesisBytes([f.daily.id, f.daily.id], 'ab'.repeat(16)), /duplicate_name_key/);
  assert.throws(() => genesisBytes([], 'ab'.repeat(16)), /invalid_name_keys/);
  assert.throws(() => genesisBytes(new Array(1), 'ab'.repeat(16)), /invalid_name_key/);
  assert.throws(() => genesisBytes(Array(9).fill(f.daily.id), 'ab'.repeat(16)), /invalid_name_keys/);
  assert.throws(() => genesisBytes([f.daily.id.toUpperCase()], 'ab'.repeat(16)), /invalid_name_key/);
  assert.throws(() => genesisBytes(f.keys, 'not a nonce'), /invalid_name_nonce/);
  await assert.rejects(recordAddress(new Uint8Array(NAME_LIMITS.recordBytes + 1)), /name_record_too_large/);
  for (const capacity of [0, -1, 1.5, NAME_LIMITS.nodes + 1])
    await assert.rejects(NameGraph.open(f.bytes, f.genesis, capacity), /invalid_name_capacity/);
});

test('record references and protocol versions reject noncanonical or unsupported values', async () => {
  const f = await fixture();
  for (const bad of ['a'.repeat(64) + '_01', 'a'.repeat(64) + '_1048577', 'A'.repeat(64) + '_1', 'not a reference'])
    await assert.rejects(f.make(f.genesis, f.daily, 'bad', f.keys, { target: bad }), /invalid_name_reference/);
  const other = text(source(f.bytes).replace(NAME_PROTOCOL, 'sprig-name-future'));
  await assert.rejects(NameGraph.open(other, hash(other)), /unsupported_name_protocol/);
});

test('async signing and verification capture caller-owned buffers and key arrays', async () => {
  const f = await fixture();
  const keys = [...f.keys];
  const fields = { genesis: f.genesis, parent: f.genesis, signer: f.daily.id, target: target('original'), keys };
  const signing = signUpdate(fields, f.daily.privateKey);
  fields.target = target('changed'); keys.reverse();
  const bytes = await signing;
  const expected = hash(bytes);
  const adding = f.graph.add(bytes, expected);
  bytes.fill(0);
  await adding;
  assert.equal(f.graph.resolve().target, target('original'));
});

test('retained-node limit holds under concurrent admission and duplicates remain idempotent', async () => {
  const f = await fixture(2);
  const a = await f.make(f.genesis, f.daily, 'A');
  const b = await f.make(f.genesis, f.daily, 'B');
  const results = await Promise.allSettled([f.add(a), f.add(b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /name_graph_full/);
  assert.equal(f.graph.size, 2);
  const accepted = results[0].status === 'fulfilled' ? a : b;
  await f.add(accepted); assert.equal(f.graph.size, 2);
  assert.throws(() => f.graph.resolve(target('missing anchor')), /name_anchor_missing/);
  const g = await fixture(2);
  const item = await g.make(g.genesis);
  await Promise.all([g.add(item), g.add(item)]);
  assert.equal(g.graph.size, 2); assert.equal(g.graph.resolve().kind, 'head');
});

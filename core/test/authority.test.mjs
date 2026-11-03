import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { base64url, contentAddress, textBytes, unbase64url } from '../src/bytes.ts';
import { keyRecordBytes, parseKeyRecord, parsePlotBinding, plotBindingBytes, signAction, verifyAction } from '../src/authority.ts';

const origin = 'https://sprig.run';
const v = JSON.parse(readFileSync(new URL('./vectors/ed25519.json', import.meta.url), 'utf8'));
const direct = v.cases[0], plotted = v.cases[1];
const evidence = () => ({ keyRecord: textBytes(v.key_record), plotBinding: textBytes(v.plot_binding) });
const signingKey = () => crypto.subtle.importKey('jwk', {
  kty: 'OKP', crv: 'Ed25519', x: v.public_key,
  d: base64url(Buffer.from(v.private_seed_hex, 'hex')), key_ops: ['sign'],
}, 'Ed25519', false, ['sign']);

test('frozen independent vectors agree across Python, Web Crypto and Node crypto', async () => {
  const key = await signingKey();
  const nodePublic = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: v.public_key }, format: 'jwk' });
  assert.deepEqual(keyRecordBytes(unbase64url(v.public_key, 32)), textBytes(v.key_record));
  assert.equal('/sea/' + await contentAddress(textBytes(v.key_record)), v.key_reference);
  assert.equal(await contentAddress(textBytes(v.plot_binding)), v.plot_binding_id);
  for (const c of v.cases) {
    const ev = c === direct ? { keyRecord: textBytes(v.key_record) } : evidence();
    const bytes = textBytes(c.action);
    const checked = await verifyAction(bytes, c.signature, ev, origin);
    assert.equal(checked.id, c.id);
    assert.equal(checked.key, v.key_reference);
    assert.equal(checked.binding, c === direct ? null : v.plot_binding_id);
    assert.equal(await signAction(bytes, key, origin), c.signature);
    assert(verify(null, bytes, nodePublic, unbase64url(c.signature, 64)));
  }
});

test('signatures bind body, chosen handle, target, anchor and service origin', async () => {
  for (const action of [
    plotted.action.replace('fern.7/12', 'fern.7/13'),
    plotted.action.replace('fern.7/12', 'fern.8/12'),
    plotted.action.replace('Hello', 'Goodbye'),
    plotted.action + '\n',
    plotted.action.replace('/plot/vector.0', '/plot/vector.1'),
    plotted.action.replace('https://sprig.run', 'https://other.test'),
  ]) {
    const ev = evidence();
    // Even an otherwise valid binding for the new label cannot change signed intent.
    if (action.includes('/plot/vector.1'))
      ev.plotBinding = textBytes(v.plot_binding.replace('/plot/vector.0', '/plot/vector.1'));
    await assert.rejects(verifyAction(textBytes(action), plotted.signature, ev, origin),
      /invalid_signature|wrong_origin/);
  }
  await assert.rejects(verifyAction(textBytes(plotted.action), plotted.signature, evidence(), 'http://localhost:8787'), /wrong_origin/);
});

test('a plot author requires its retained binding, and a direct author requires its exact key hash', async () => {
  await assert.rejects(verifyAction(textBytes(plotted.action), plotted.signature, { keyRecord: textBytes(v.key_record) }, origin), /binding_required/);
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const otherRecord = keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  await assert.rejects(verifyAction(textBytes(direct.action), direct.signature, { keyRecord: otherRecord }, origin), /wrong_author_key/);
  await assert.rejects(verifyAction(textBytes(plotted.action), plotted.signature, { ...evidence(), keyRecord: otherRecord }, origin), /wrong_plot_binding/);
  await assert.rejects(verifyAction(textBytes(plotted.action), plotted.signature, {
    ...evidence(), plotBinding: textBytes(v.plot_binding.replace('https://sprig.run', 'https://other.test')),
  }, origin), /wrong_origin/);
  await assert.rejects(verifyAction(textBytes(direct.action), direct.signature, evidence(), origin), /wrong_author_key/);
});

test('fixed key/binding versions and canonical base64 encodings reject aliases', () => {
  for (const record of [
    v.key_record.replace('key/1', 'key/2'), v.key_record.replace('ed25519', 'rsa'),
    v.key_record.replace(v.public_key, v.public_key + '='),
    v.key_record.replace('algorithm:', 'algorithm :'),
    v.key_record.replace(/\n/g, '\r\n'), v.key_record.trimEnd(), v.key_record + '\n',
  ]) assert.throws(() => parseKeyRecord(textBytes(record)));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bad = v.public_key.slice(0, -1) + alphabet[alphabet.indexOf(v.public_key.at(-1)) + 1];
  assert.throws(() => unbase64url(bad, 32), /invalid_base64url/);
  assert.throws(() => unbase64url(v.public_key + '\n', 32), /invalid_base64url/);
  assert.throws(() => keyRecordBytes(new Uint8Array(31)), /invalid_key_size/);
  const b = parsePlotBinding(textBytes(v.plot_binding), origin);
  assert.deepEqual(plotBindingBytes(b), textBytes(v.plot_binding));
  assert.throws(() => plotBindingBytes({ ...b, plot: '/plot/vector.0/profile.0' }), /invalid_plot/);
});

test('malformed or corrupted detached signatures reject without changing action identity', async () => {
  for (const signature of [plotted.signature + '=', plotted.signature + '\n',
    plotted.signature.slice(1), base64url(new Uint8Array(64))])
    await assert.rejects(verifyAction(textBytes(plotted.action), signature, evidence(), origin));
  const anonymous = textBytes(plotted.action.replace('author: /plot/vector.0\n', ''));
  await assert.rejects(verifyAction(anonymous, plotted.signature, evidence(), origin), /author_required/);
  await assert.rejects(signAction(anonymous, await signingKey(), origin), /author_required/);
});

test('verification and signing snapshot caller-owned buffers before awaiting crypto', async () => {
  const bytes = Buffer.from(plotted.action);
  const ev = { keyRecord: Buffer.from(v.key_record), plotBinding: Buffer.from(v.plot_binding) };
  const pending = verifyAction(bytes, plotted.signature, ev, origin);
  bytes.fill(0); ev.keyRecord.fill(0); ev.plotBinding.fill(0);
  assert.equal((await pending).id, plotted.id);
  const toSign = Buffer.from(plotted.action);
  const signed = signAction(toSign, await signingKey(), origin);
  toSign.fill(0);
  assert.equal(await signed, plotted.signature);
});

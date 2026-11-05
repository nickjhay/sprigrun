import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { probe, origin } from './probe.mjs';
import { plant } from '../scripts/plant.mjs';
import { plantLocal } from '../scripts/plant-local.mjs';
import { actionBytes } from '../src/action.ts';
import { keyRecordBytes, signAction } from '../src/authority.ts';
import { textBytes } from '../src/bytes.ts';
async function fixture(t) {
  const h = await probe(), directory = await mkdtemp(join(tmpdir(), 'sprig-plant-'));
  t.after(async () => { await h.close(); await rm(directory, { force: true, recursive: true }); });
  return { ...h, directory, journal: join(directory, 'planting-journal.json') };
}
test('a lost response after every acceptance resumes from durable requests without duplicates', async t => {
  const h = await fixture(t), seen = new Set();
  const lossy = { ...h.client, async publish(...args) {
    const journal = JSON.parse(await readFile(h.journal, 'utf8'));
    const pending = journal.steps.at(-1);
    assert.equal(pending.path, args[0]); assert.equal(pending.outcome, undefined);
    const accepted = await h.client.publish(...args);
    if (!seen.has(accepted.result)) { seen.add(accepted.result); throw Error('response_lost'); }
    return accepted;
  } };
  for (let i = 0; i < 10; i++) await assert.rejects(plant(lossy, h), /response_lost/);
  const result = await plant(lossy, h);
  assert.equal(seen.size, 10);
  const before = await h.client.inspect('results');
  assert.deepEqual(await plant({ ...h.client, publish() { throw Error('completed_installation_sent_http'); } }, h), result);
  assert.deepEqual(await h.client.inspect('results'), before);
  const journal = JSON.parse(await readFile(h.journal, 'utf8'));
  assert.equal(journal.steps.length, 10);
  assert.ok(journal.steps.every(s => s.outcome.status === 'accepted'));
  for (const file of ['identity.pem', 'planting-journal.json'])
    assert.equal((await stat(join(h.directory, file))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(journal).includes('PRIVATE KEY'));
});
test('planting uses allocated numbers and verified existing seed values without claiming their authorship', async t => {
  const h = await fixture(t);
  const earlier = await h.client.publish('/sea', textBytes('another small sum'));
  await h.client.publish('/grove/small_sum', textBytes(earlier.result + '\n'));
  // Preallocate the same handles with another key. One value is first published with a signature.
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const key = (await h.client.publish('/sea', keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))))).result;
  const bytes = await readFile(new URL('../seed/content/moss_profile.md', import.meta.url));
  const action = actionBytes({ destination: origin + '/sea', author: key, body: bytes }, origin);
  const first = await h.client.publish('/sea', action, await signAction(action, pair.privateKey, origin));
  const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  // Omit the prepublished profile in the helper by returning its existing reference.
  await plantLocal({ ...h.client, publish: (path, b, signature) =>
    path === '/sea' && Buffer.from(b).equals(bytes) ? Promise.resolve(first) : h.client.publish(path, b, signature) }, pem);
  const result = await plant(h.client, h);
  assert.equal(result.plots.moss, '/plot/moss.1');
  // Anonymous publication has the identical action, so it deliberately reuses its receipt.
  assert.equal(result.publications.sum, '/grove/small_sum.1');
  assert.equal(result.publications.morning, '/plot/moss.1/notes/first_morning.0');
  const journal = JSON.parse(await readFile(h.journal, 'utf8'));
  const existing = journal.steps.find(s => s.outcome.status === 'existing');
  assert.equal(existing.outcome.receipt, first.receipt);
  assert.equal(existing.outcome.result, first.result);
});
test('origin/key drift, missing keys, corrupt journal and simultaneous installers stop before HTTP', async t => {
  const h = await fixture(t);
  await plant(h.client, h);
  const client = { ...h.client, publish() { throw Error('must_not_send'); } };
  await assert.rejects(plant({ ...client, origin: 'https://staging.sprig.run' }, h), /planting_identity_changed/);
  const pemFile = join(h.directory, 'identity.pem'), pem = await readFile(pemFile);
  await writeFile(pemFile, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await assert.rejects(plant(client, h), /planting_identity_changed/);
  await rm(pemFile); await assert.rejects(plant(client, h), /planting_key_missing/);
  await writeFile(pemFile, pem);
  await writeFile(join(h.directory, 'planting.lock'), 'other installer');
  await assert.rejects(plant(client, h), /planting_locked/);
  await rm(join(h.directory, 'planting.lock'));
  await writeFile(h.journal, '{truncated');
  await assert.rejects(plant(client, h), SyntaxError);
});
test('wrong existing bytes and receipts are never saved as successful steps', async t => {
  const h = await fixture(t);
  const duplicate = Object.assign(Error('duplicate'), { status: 409, code: 'already_stored' });
  await assert.rejects(plant({ ...h.client, publish() { throw duplicate; }, read: async () => 'wrong bytes' }, h), /planting_wrong_existing_bytes/);
  assert.equal(JSON.parse(await readFile(h.journal, 'utf8')).steps[0].outcome, undefined);
  await assert.rejects(plant({ ...h.client, async publish(path, bytes, signature) {
    const reply = await h.client.publish(path, bytes, signature);
    return { ...reply, result: '/grove/not_the_result.0' };
  } }, h), /planting_wrong_result/);
  assert.equal(JSON.parse(await readFile(h.journal, 'utf8')).steps[0].outcome, undefined);
  await plant(h.client, h);
});

import '../../scripts/check-node.mjs';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionBytes } from '../src/action.ts';
import { contentAddress, textBytes, utf8 } from '../src/bytes.ts';
import { keyRecordBytes } from '../src/authority.ts';
import { parseReceipt, receiptForAction } from '../src/receipt.ts';
import { canonicalOrigin } from '../src/references.ts';
import { seedInventory } from './seeds.mjs';
import { plantLocal } from './plant-local.mjs';
import { nativeClient } from './http-client.mjs';

async function syncDirectory(directory) {
  const fd = await open(directory, 'r');
  try { await fd.sync(); } finally { await fd.close(); }
}
async function durableFile(path, contents, exclusive = false) {
  const target = exclusive ? path : path + '.tmp';
  const fd = await open(target, exclusive ? 'wx' : 'w', 0o600);
  try { await fd.writeFile(contents); await fd.sync(); } finally { await fd.close(); }
  if (!exclusive) await rename(target, path);
  await syncDirectory(dirname(path));
}
async function maybeRead(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

/** Each request is durable before HTTP; each verified receipt is durable before the next request. */
export async function plant(client, { directory, keyFile = join(directory, 'identity.pem') }) {
  canonicalOrigin(client.origin);
  const inventory = await seedInventory();
  if (inventory !== await readFile(new URL('../seed/inventory.txt', import.meta.url), 'utf8'))
    throw Error('seed_inventory_changed');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(resolve(directory)));
  const lockPath = join(directory, 'planting.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw Error('planting_locked: stop the other installer before removing planting.lock'); throw error; }
  try {
    await lock.writeFile(String(process.pid) + '\n'); await lock.sync();
    const journalFile = join(directory, 'planting-journal.json');
    const previous = await maybeRead(journalFile);
    let pem = await maybeRead(keyFile);
    if (pem === null) {
      if (previous !== null) throw Error('planting_key_missing: restore the original private key');
      pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
      await durableFile(keyFile, pem, true);
    }
    const jwk = createPublicKey(pem).export({ format: 'jwk' });
    if (jwk.crv !== 'Ed25519') throw Error('planting_requires_ed25519');
    const key = '/sea/' + await contentAddress(keyRecordBytes(Buffer.from(jwk.x, 'base64url')));
    const identity = { format: 'sprig-planting/1', origin: client.origin, inventory: await contentAddress(textBytes(inventory)), key };
    const journal = previous === null ? { ...identity, steps: [] } : JSON.parse(previous);
    if (Object.keys(identity).some(k => journal[k] !== identity[k]) || !Array.isArray(journal.steps))
      throw Error('planting_identity_changed: keep origin, inventory and signing key fixed');
    const save = () => durableFile(journalFile, JSON.stringify(journal, null, 2) + '\n');
    let index = 0;
    const publishing = { origin: client.origin, async publish(path, bytes, signature = null) {
      const action = signature === null ? actionBytes({ destination: client.origin + path, body: bytes }, client.origin) : bytes;
      const request = { path, action: utf8(action), signature };
      let step = journal.steps[index++];
      if (step) {
        if (Object.keys(request).some(k => step[k] !== request[k])) throw Error('planting_request_changed');
      } else {
        step = request; journal.steps.push(step); await save();
      }
      async function validate(outcome) {
        const receipt = parseReceipt(textBytes(outcome.receipt), client.origin);
        if (receipt.result !== client.origin + outcome.result) throw Error('planting_wrong_result');
        if (outcome.status === 'accepted') await receiptForAction(action, textBytes(outcome.receipt), client.origin);
        else if (outcome.status !== 'existing' || signature !== null || path !== '/sea'
          || outcome.result !== '/sea/' + await contentAddress(bytes)) throw Error('planting_wrong_existing_value');
      }
      if (!step.outcome) {
        let outcome;
        try { outcome = { status: 'accepted', ...await client.publish(path, bytes, signature) }; }
        catch (error) {
          if (error.status !== 409 || error.code !== 'already_stored' || path !== '/sea' || signature !== null) throw error;
          const result = '/sea/' + await contentAddress(bytes);
          // Another author may already have stored a seed value. Verify its bytes;
          // retain their receipt without attributing that acceptance to our action.
          if (await client.read(result) !== utf8(bytes)) throw Error('planting_wrong_existing_bytes');
          outcome = { status: 'existing', result, receipt: await client.read('/receipt' + result) };
        }
        await validate(outcome); step.outcome = outcome; await save();
      } else await validate(step.outcome);
      return step.outcome;
    } };
    const result = await plantLocal(publishing, pem);
    if (index !== journal.steps.length) throw Error('planting_unexpected_steps');
    return result;
  } finally {
    await lock.close(); await unlink(lockPath);
  }
}

export async function main(args) {
  if (args.length !== 2) throw Error('usage: npm run plant:core -- ORIGIN STATE_DIRECTORY');
  const [origin, directory] = args;
  const result = await plant(nativeClient(origin), { directory: resolve(directory) });
  console.log(JSON.stringify(result, null, 2));
  console.log('Retain identity.pem and planting-journal.json securely. Reuse this directory to resume.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

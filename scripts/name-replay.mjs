import assert from 'node:assert/strict';
import { genesisBytes, publicKeyHex, recordAddress, signUpdate } from '../src/names/model.ts';
import { NameReplay } from '../src/names/replay.ts';
import { addressOf } from '../src/document.ts';
import { FERN_SOURCE } from '../src/examples.ts';

// Fresh in-memory keys and a simulated clock. Nothing is uploaded or saved.
async function key() {
  const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  return { ...pair, id: await publicKeyHex(pair.publicKey) };
}
const [keeper, working] = await Promise.all([key(), key()]);
const keys = [keeper.id, working.id];
const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const bytes = genesisBytes(keys, nonce);
const name = await recordAddress(bytes);
const labels = new Map([[name, 'genesis']]);
const records = new Map();
async function make(label, parent, signer = working) {
  const source = new TextEncoder().encode(FERN_SOURCE + '\n# ' + label + '\n');
  const bytes = await signUpdate({ genesis: name, parent, signer: signer.id, target: await addressOf(source), keys }, signer.privateKey);
  const address = await recordAddress(bytes);
  labels.set(address, label); records.set(address, bytes);
  return address;
}
const a = await make('fern A', name);
const b = await make('fern B', name);
const leaf = await make('later frond', a);
const recovery = await make('keeper recovery', name, keeper);
const HOUR = 3600000;
const options = { genesisAdmission: { sequence: '1', acceptedAtMs: 0 }, recoveryWindowMs: 72 * HOUR };

console.log('One name, several service histories\n');
console.log('The genesis is ordinary readable text:\n');
console.log(new TextDecoder().decode(bytes));
console.log('Its name: ' + name);
console.log('Updates use the same field-per-line format, ending with a signature.');
console.log('This demo uses a 72-hour recovery window and a simulated clock.\n');

async function scenario(title, arrivals) {
  const replay = await NameReplay.open(bytes, name, options);
  for (const [record, hour] of arrivals) await replay.admit(records.get(record), record, {
    sequence: String(replay.history().length + 1), acceptedAtMs: Math.round(hour * HOUR),
  });
  console.log(title);
  console.table(replay.history().map(entry => ({
    sequence: entry.sequence, hour: entry.acceptedAtMs / HOUR,
    record: labels.get(entry.record), decision: entry.decision, head: labels.get(entry.head),
  })));
  // Replay the actual stamps, rather than assigning a fresh arrival order.
  const copy = await NameReplay.open(bytes, name, options);
  for (const entry of replay.history().slice(1))
    await copy.admit(records.get(entry.record), entry.record, entry);
  assert.deepEqual(copy.history(), replay.history());
  assert.deepEqual(copy.view(), replay.view());
  return replay;
}
await scenario('A arrives first', [[a, 1], [b, 2]]);
await scenario('B arrives first', [[b, 1], [a, 2]]);
const onTime = await scenario('Recovery at the deadline', [[a, 1], [leaf, 72], [recovery, 73]]);
const late = await scenario('Recovery one millisecond too late', [[a, 1], [leaf, 72], [recovery, 73 + 1 / HOUR]]);
assert.equal(onTime.view().head, recovery);
assert.equal(late.view().head, leaf);
assert.equal(onTime.history()[2].head, leaf);
console.log('Each history reproduced exactly when replayed. Earlier selections remain intact.');
console.log('The newer frond did not extend the first frond\'s recovery deadline.');
console.log('No workerd or server needed. These are local experiments, not signed service receipts.');

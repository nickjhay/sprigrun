import { NameGraph, genesisBytes, publicKeyHex, recordAddress, signUpdate } from '../src/names/model.ts';
import { addressOf } from '../src/document.ts';
import { FERN_SOURCE } from '../src/examples.ts';

// An offline experiment: fresh transient keys, no network and no files written.
async function key() {
  const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  return { ...pair, id: await publicKeyHex(pair.publicKey) };
}
const [keeper, working, fresh] = await Promise.all([key(), key(), key()]);
const keys = [keeper.id, working.id];
const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const genesis = genesisBytes(keys, nonce);
const name = await recordAddress(genesis);
const graph = await NameGraph.open(genesis, name);
async function publish(parent, signer, comment, nextKeys = keys) {
  const source = new TextEncoder().encode(FERN_SOURCE + '\n# ' + comment + '\n');
  const bytes = await signUpdate({ genesis: name, parent, signer: signer.id, target: await addressOf(source), keys: nextKeys }, signer.privateKey);
  const update = await recordAddress(bytes);
  await graph.add(bytes, update);
  return update;
}
console.log('A name for a little fern\n');
console.log('Fresh name: ' + name);
const bud = await publish(name, working, 'A first frond.');
const leaf = await publish(bud, working, 'A second frond.');
console.log('\nWorking key grows the history to depth ' + graph.resolve().depth + '.');
const nextKeys = [keeper.id, fresh.id];
const recovered = await publish(bud, keeper, 'The keeper takes over here.', nextKeys);
const recovery = graph.resolve(leaf);
console.log('Keeper signs a stronger continuation of the first frond.');
console.log('Following the old leaf reports: ' + recovery.relation + '.');
console.log('The old leaf still has its exact address: ' + leaf);
console.log('The selected recovery update is:         ' + recovered);
const newLeaf = await publish(recovered, fresh, 'A new working key, another frond.', nextKeys);
console.log('\nThe replacement working key continues: ' + graph.resolve(recovered).relation + '.');
console.log('Current update: ' + newLeaf);
console.log('Current source: ' + graph.resolve().target);
try {
  await publish(newLeaf, working, 'The retired working key tries again.', nextKeys);
  throw new Error('Retired key was unexpectedly accepted.');
} catch (error) {
  if (error.message !== 'unauthorized_name_key') throw error;
  console.log('The retired working key cannot extend this branch.');
}
console.log('\nAll signatures were checked locally. Nothing was uploaded or saved.');
console.log('This is a naming experiment, not a deployed name or a proof of freshness.');

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { values, identities, publications, messages } from '../seed/plan.mjs';
import { contentAddress, LIMITS, utf8 } from '../src/bytes.ts';
import { parsePostTarget, word } from '../src/references.ts';

export async function seedInventory() {
  const lines = ['#!sprig.run/spec/seed-inventory/1', ''];
  const labels = new Set();
  for (const value of values) {
    word(value.label);
    if (labels.has(value.label) || !/^[a-z_]+\.(md|txt|moss)$/.test(value.file))
      throw new Error('invalid_seed_value');
    labels.add(value.label);
    const bytes = await readFile(new URL('../seed/content/' + value.file, import.meta.url));
    if (bytes.length > LIMITS.sourceBytes) throw new Error('seed_body_limit');
    utf8(bytes);
    lines.push('value ' + value.label + ' ' + await contentAddress(bytes) + ' ' + value.file);
  }
  const authors = new Set();
  for (const identity of identities) {
    word(identity.label);
    if (authors.has(identity.label) || identity.key !== null || !labels.has(identity.profile)
      || parsePostTarget(identity.topic).kind !== 'plot') throw new Error('invalid_seed_identity');
    authors.add(identity.label);
    lines.push('identity ' + identity.label + ' ' + identity.topic + ' key=unprovisioned profile=' + identity.profile);
  }
  const places = new Set();
  for (const p of publications) {
    word(p.label);
    if (places.has(p.label) || !labels.has(p.value)) throw new Error('invalid_seed_publication');
    if (p.owner === null) {
      if (parsePostTarget(p.topic).kind !== 'grove') throw new Error('invalid_seed_topic');
    } else {
      if (!authors.has(p.owner) || parsePostTarget('/plot/placeholder.0/' + p.topic).kind !== 'publication')
        throw new Error('invalid_seed_owner');
    }
    places.add(p.label);
    lines.push('publication ' + p.label + ' owner=' + (p.owner ?? '-') + ' topic=' + p.topic + ' value=' + p.value);
  }
  for (const m of messages) {
    if (!authors.has(m.author) || !places.has(m.publication) || !labels.has(m.value))
      throw new Error('invalid_seed_message');
    lines.push('message author=' + m.author + ' publication=' + m.publication + ' value=' + m.value);
  }
  return lines.join('\n') + '\n';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = await seedInventory();
  const file = new URL('../seed/inventory.txt', import.meta.url);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--write') {
    await writeFile(file, inventory);
    console.log('Updated seed inventory; no account or database was changed.');
  } else if (args.length === 1 && args[0] === '--check') {
    if (await readFile(file, 'utf8') !== inventory) throw new Error('seed_inventory_changed: review contents, then run seed:core -- --write');
    console.log('Seed contents match their retained inventory. No identities provisioned.');
  } else if (args.length === 0) {
    console.log(inventory);
    console.log('Dry run only. Use plant:core with an origin and private state directory to install.');
  } else throw new Error('usage: seed:core [--check | --write]');
}

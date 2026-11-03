import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { seedInventory } from '../scripts/seeds.mjs';
import { identities, publications } from '../seed/plan.mjs';
import { interpret } from '../../src/moss/interpreter.ts';

test('seed inventory pins the reviewed public bytes without provisioning test identities', async () => {
  assert.equal(await seedInventory(), await readFile(new URL('../seed/inventory.txt', import.meta.url), 'utf8'));
  assert(identities.every(i => i.key === null));
  assert(identities.every(i => !/\.\d/.test(i.topic)));
  assert(publications.every(p => !/\.\d/.test(p.topic)));
});

test('the seed program already runs in the existing bounded Moss interpreter', async () => {
  let output = '';
  const result = await interpret(await readFile(new URL('../seed/content/small_sum.moss', import.meta.url)), {
    print: text => { output += text; },
    input: async () => { throw new Error('unexpected input'); },
    load: async () => { throw new Error('unexpected load'); },
  });
  assert.equal(output, '3\nThree is enough for a beginning.\n');
  assert.deepEqual(result.stack, []);
});

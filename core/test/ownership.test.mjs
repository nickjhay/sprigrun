import test from 'node:test';
import assert from 'node:assert/strict';
import { owner } from '../host/placement.ts';

test('results, anchored writes and mirrored evidence have the same logical owner', () => {
  const source = '/sea/' + 'a'.repeat(64) + '_42';
  assert.equal(owner(source), source);
  for (const [root, separator] of [
    ['/grove/chess', '.'], ['/grove/fern/library', '.'], ['/plot/nick', '.'],
    ['/plot/nick.0/library', '.'], ['/chat/grove/chess.7', '/'],
    ['/chat/plot/nick.0/library.17', '/'], ['/chat' + source, '/'],
  ]) {
    assert.equal(owner(root), root);
    for (const n of ['0', '9', '17', '18446744073709551615']) {
      const result = root + separator + n;
      assert.equal(owner(result), root);
      for (const view of ['receipt', 'action', 'evidence']) assert.equal(owner('/' + view + result), root);
    }
  }
  for (const view of ['receipt', 'action', 'evidence']) assert.equal(owner('/' + view + source), source);
  assert.notEqual(owner('/grove/chess.7'), owner('/chat/grove/chess.7/0'));
  assert.notEqual(owner('/plot/nick.0'), owner('/plot/nick.0/library.0'));
});
test('placement rejects aliases, malformed mirrors and unhashed source intake', () => {
  for (const path of ['/sea', '/grove/a/1', '/grove/a.01', '/receipt/grove/a',
    '/receipt/chat/grove/a.0', '/evidence/receipt/grove/a.0', '/grove/a.0/step/1',
    '/grove/a.0?select=latest', 'https://sprig.run/grove/a.0', '/grove/%61.0'])
    assert.throws(() => owner(path), undefined, path);
});

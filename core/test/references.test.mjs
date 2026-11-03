import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, nextU64, orderedU64, parseAddress, u64 } from '../src/bytes.ts';
import { assertChatFits, canonicalOrigin, chatPath, formatReference, fromCompact,
  parseAuthor, parsePostTarget, parseReference, toCompact } from '../src/references.ts';
const H = 'ab'.repeat(32) + '_12';

test('references preserve the distinctions that make the separator grammar injective', () => {
  for (const [path, compact] of [
    ['/sea/' + H, 'sea.' + H], ['/grove/nz/fern.2', 'grove.nz.fern.2'],
    ['/plot/nick.0', 'plot.nick.0'], ['/plot/nick.0/step.12', 'plot.nick.0.step.12'],
    ['/plot/nick.0/chess.7/step/12', 'plot.nick.0.chess.7.step.12'],
    ['/chat/grove/chess.7/12', 'chat.grove.chess.7.12'],
    ['/chat/grove/chess.7/step/12', 'chat.grove.chess.7.step.12'],
    ['/chat/grove/chess.7/step/12/3', 'chat.grove.chess.7.step.12.3'],
    ['/chat/plot/nick.0/12', 'chat.plot.nick.0.12'],
  ]) {
    assert.equal(toCompact(path), compact);
    assert.equal(fromCompact(compact), path);
    assert.equal(formatReference(parseReference(path)), path);
  }
});

test('generated paths have a left inverse, including step as an ordinary word', () => {
  const words = ['a', '_x', 'step'];
  const nums = ['0', '12', '18446744073709551615'];
  const topics = words.map(w => [w]);
  for (const a of words) for (const b of words) {
    topics.push([a, b]);
    for (const c of words) topics.push([a, b, c]);
  }
  const plots = words.flatMap(handle => nums.map(number => ({ kind: 'plot', handle, number })));
  const publications = topics.flatMap(topic => nums.flatMap(number => [
    { kind: 'grove', topic, number },
    ...plots.map(plot => ({ kind: 'publication', plot, topic, number })),
  ]));
  const subjects = [...plots, { kind: 'sea', address: H }, ...publications,
    ...publications.flatMap(publication => nums.map(number => ({ kind: 'step', publication, number })))];
  const seen = new Map();
  for (const subject of subjects) for (const ref of [subject, { kind: 'chat', subject },
    ...nums.map(number => ({ kind: 'message', subject, number }))]) {
    const path = formatReference(ref);
    const compact = toCompact(path);
    assert.equal(fromCompact(compact), path);
    assert.equal(toCompact(fromCompact(compact)), compact);
    if (seen.has(compact)) assert.equal(seen.get(compact), path);
    seen.set(compact, path);
  }
  assert(seen.size > 20_000);
});

test('ambiguous or noncanonical spellings are rejected, not rewritten', () => {
  for (const path of ['', '/', '/grove/a', '/grove/7.1', '/grove/a/7.1', '/grove/A.0',
    '/plot/nick.0/step/12', '/grove/a.0/b.1', '/chat/chat/grove/a.0',
    '/chat/grove/a.0/1/2', '/grove/a.00', '/grove/a.18446744073709551616',
    '/grove/a.0/', '/grove//a.0', '/grove/../a.0', '/grove/a%2e0',
    '/grove/a.0?select=latest', '/grove/a.0#latest', '/grove/a.0\n', '/grove/a.0\r',
    '/grove/a-b.0', '/grove/a\\b.0', '/grove/fërn.0',
    '/sea/' + 'AB'.repeat(32) + '_12', '/sea/' + 'ab'.repeat(32) + '_01',
    '/sea/' + 'ab'.repeat(32) + '_' + (LIMITS.sourceBytes + 1),
    '/grove/' + 'a'.repeat(LIMITS.word + 1) + '.0',
    '/grove/' + Array(LIMITS.topicWords + 1).fill('a').join('/') + '.0'])
    assert.throws(() => parseReference(path), undefined, path);
  for (const s of ['grove.a..0', 'grove.a.0.', 'grove.a.0\n', 'grove.7.1', '/grove.a.0'])
    assert.throws(() => fromCompact(s), undefined, s);
});

test('u64 values never travel through Number; SQL text order and overflow are explicit', () => {
  const values = ['0', '9', '10', '9007199254740993', '18446744073709551615'];
  assert.deepEqual(values.map(orderedU64).sort(), values.map(orderedU64));
  assert.equal(nextU64('9007199254740992'), '9007199254740993');
  for (const n of ['-1', '00', '+1', '1e2', '1.0', '1\n', ' 1', '18446744073709551616'])
    assert.throws(() => u64(n), undefined, n);
  assert.throws(() => nextU64(values.at(-1)), /overflow/);
  assert.throws(() => parseAddress('ab'.repeat(32) + '_18446744073709551615'), /limit/);
});

test('POST targets distinguish allocation topics from existing read resources', () => {
  assert.equal(parsePostTarget('/sea').kind, 'sea');
  assert.equal(parsePostTarget('/grove/nz/fern').kind, 'grove');
  assert.equal(parsePostTarget('/plot/nick').kind, 'plot');
  assert.equal(parsePostTarget('/plot/nick.0/chess').kind, 'publication');
  assert.equal(parsePostTarget('/grove/chess.7').anchor, '7');
  assert.equal(parsePostTarget('/plot/nick.0').anchor, '0');
  assert.equal(parsePostTarget('/plot/nick.0/chess.7').anchor, '7');
  assert.equal(parsePostTarget('/chat/grove/chess.7').anchor, null);
  assert.equal(parsePostTarget('/chat/grove/chess.7/12').anchor, '12');
  for (const path of ['/sea/' + H, '/grove', '/grove/chess.7/step/12',
    '/plot/nick.0/chess.7/step/12', '/plot/nick/child', '/plot/nick.0/step/12',
    '/chat/grove/chess', '/chat/grove/chess.7/12\n'])
    assert.throws(() => parsePostTarget(path), undefined, path);
});

test('authors are direct key records or fixed plot roots; composition is bounded', () => {
  assert.equal(parseAuthor('/plot/nick.0').kind, 'plot');
  assert.equal(parseAuthor('/sea/' + H).kind, 'sea');
  for (const path of ['/grove/nick.0', '/plot/nick.0/profile.0', '/chat/plot/nick.0'])
    assert.throws(() => parseAuthor(path), /invalid_author/);
  assert.equal(chatPath('/plot/nick.0'), '/chat/plot/nick.0');
  const p = '/plot/' + 'n'.repeat(32) + '.18446744073709551615/'
    + Array(8).fill('w'.repeat(32)).join('/') + '.18446744073709551615/step/18446744073709551615';
  assertChatFits(p);
  assert.throws(() => chatPath('/chat/plot/nick.0'), /invalid_subject/);
});

test('canonical origins bind deployment audience and restrict HTTP to loopback', () => {
  for (const o of ['https://sprig.run', 'https://example.org:8443', 'http://localhost:8787',
    'http://127.0.0.1:8787', 'http://[::1]:8787']) assert.equal(canonicalOrigin(o), o);
  for (const o of ['https://sprig.run/', 'HTTPS://sprig.run', 'https://SPRIG.RUN',
    'https://sprig.run:443', 'https://x@sprig.run', 'http://sprig.run',
    'https://sprig.run\n', 'https://sprig.run/path', 'https://sprig.run?x',
    'https://sprig.run#x', 'https://sprig.run\\x'])
    assert.throws(() => canonicalOrigin(o), undefined, o);
});

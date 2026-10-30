import test from 'node:test';
import assert from 'node:assert/strict';
import { PathHost, PATH_LIMITS, parsePath } from '../src/experiments/paths.ts';

const publisher = () => ({ id: 'publisher', appendUnder: ['/grove'], advance: [], enqueue: ['review'], finish: [] });
const append = (body = 'a fern', enqueue = []) => ({ publication: { kind: 'append', topic: '/grove/fern', body, enqueue } });
const advance = (expected, body = 'a larger fern') => ({ publication: {
  kind: 'advance', entry: '/grove/fern.0', expected, body,
} });
const gardener = () => ({ ...publisher(), advance: ['/grove/fern.0'], finish: ['review'] });

test('path syntax distinguishes topic, allocated entry, revision and stored count', () => {
  assert.deepEqual(parsePath('/grove/nz/fern.0@12'), {
    kind: 'entry', topic: '/grove/nz/fern', entry: '/grove/nz/fern.0', revision: '12',
  });
  assert.deepEqual(parsePath('/fern.0@0'), { kind: 'entry', topic: '/fern', entry: '/fern.0', revision: '0' });
  assert.deepEqual(parsePath('/grove/123.count'), { kind: 'count', topic: '/grove/123' });
  assert.equal(parsePath('/grove/3_ferns').kind, 'topic');
  assert.notEqual(parsePath('/grove/Fern').topic, parsePath('/grove/fern').topic);
  assert.equal(parsePath('/fern.18446744073709551615@18446744073709551615').revision, '18446744073709551615');
});

test('alternate spellings, ambiguous separators, URL escapes and oversized paths are rejected', () => {
  for (const path of ['', '/', 'fern.0', '/fern.00', '/fern.0@01', '/fern.0@', '/fern@0',
    '/fern.count@0', '/fern.18446744073709551616', '/fern.0@18446744073709551616',
    '/fern.x', '/fern.0.0', '/fern-wood.0', '/fern%2e0', '/fern%2Fwood', '/fern?x=1',
    '/fern#x', '/fern\\wood', '/fern//wood', '/fern/', '/fern/../wood', '/fërn',
    '/fern.0\n', '/fern\n', '/fern.0@0\r\n',
    '/' + 'a'.repeat(65), '/' + Array(5).fill('a'.repeat(60)).join('/')])
    assert.throws(() => parsePath(path), undefined, path);
});

test('control characters cannot enter request IDs, grants, queue names or revision preconditions', () => {
  const h = new PathHost();
  assert.throws(() => h.commit(publisher(), 'request\n', append(), 1), /invalid_token/);
  assert.throws(() => h.commit({ ...publisher(), id: 'publisher\n' }, 'r', append(), 1), /invalid_token/);
  assert.throws(() => h.commit(publisher(), 'r', append('fern', ['review\n']), 1), /invalid_token/);
  assert.throws(() => h.commit(gardener(), 'r', advance('0\n'), 1), /noncanonical_number/);
  assert.equal(h.stats().commits, 0);
});

test('append allocates independently, publishes count and pins in the same turn', async () => {
  const h = new PathHost();
  const receipts = await Promise.all(['first', 'second'].map(id => Promise.resolve().then(() =>
    h.commit(publisher(), id, append(id), 100))));
  assert.deepEqual(receipts.map(r => r.pinned), ['/grove/fern.0@0', '/grove/fern.1@0']);
  assert.equal(h.get('/grove/fern.count').value.body, '2\n');
  assert.equal(h.get('/grove/fern.0').value.body, 'first');
  assert.equal(h.get('/grove/fern.1@0').value.body, 'second');
});

test('lost-response retry preserves allocation, metadata and task identity', () => {
  const h = new PathHost();
  const plan = append('fern', ['review']);
  const receipt = h.commit(publisher(), 'request', plan, 10);
  assert.deepEqual(h.commit(publisher(), 'request', plan, 99), receipt);
  assert.equal(h.get('/grove/fern.count').value.body, '1\n');
  assert.equal(h.pending('review').length, 1);
  assert.equal(h.stats().attempts, 2);
  assert.throws(() => h.commit(publisher(), 'request', append('changed'), 100), /request_id_reused/);
  assert.equal(h.stats().commits, 1);
});

test('first successful advance wins; historical revisions retain bytes and timestamps', () => {
  for (const order of [['moss', 'fern'], ['fern', 'moss']]) {
    const h = new PathHost();
    h.commit(publisher(), 'create', append('original'), 1);
    const receipt = h.commit(gardener(), order[0], advance('0', order[0]), 2);
    assert.throws(() => h.commit(gardener(), order[1], advance('0', order[1]), 3), /revision_conflict/);
    assert.equal(h.get('/grove/fern.0').value.body, order[0]);
    assert.equal(h.get('/grove/fern.0@0').value.body, 'original');
    assert.equal(h.get('/grove/fern.0@0').value.submittedAtMs, 1);
    assert.equal(h.get('/grove/fern.0@1').value.submittedAtMs, 2);
    assert.equal(h.get('/grove/fern.count').value.body, '1\n');
    assert.deepEqual(h.commit(gardener(), order[0], advance('0', order[0]), 9), receipt);
  }
});

test('GET only returns stored representations and cannot trigger work', () => {
  const h = new PathHost();
  h.commit(publisher(), 'create', append('fern', ['review']), 1);
  const before = h.stats();
  for (let i = 0; i < 20; i++) {
    assert.equal(h.get('/grove/fern.0').status, 200);
    assert.equal(h.get('/grove/fern.0@0').status, 200);
    assert.equal(h.get('/grove/fern.count').status, 200);
    assert.equal(h.get('/grove/fern').status, 404); // no synthesized listing
    assert.equal(h.get('/grove/missing.count').status, 404); // no on-read initialization
  }
  assert.deepEqual(h.stats(), before);
});

test('queue overload rejects the whole publication without consuming a number', () => {
  const h = new PathHost();
  for (let i = 0; i < PATH_LIMITS.pendingTasks; i++)
    h.commit(publisher(), `r${i}`, append('fern', ['review']), i);
  const count = h.get('/grove/fern.count');
  assert.throws(() => h.commit(publisher(), 'full', append('fern', ['review']), 100), /queue_full/);
  assert.deepEqual(h.get('/grove/fern.count'), count);
  assert.equal(h.get(`/grove/fern.${PATH_LIMITS.pendingTasks}`).status, 404);
  assert.equal(h.stats().commits, PATH_LIMITS.pendingTasks);
  // Services can instead submit without a review task, if their policy allows.
  h.commit(publisher(), 'no_task', append('unreviewed'), 101);
  assert.equal(h.get('/grove/fern.count').value.body, `${PATH_LIMITS.pendingTasks + 1}\n`);
});

test('publication and task acknowledgement either both happen or neither happens', () => {
  const h = new PathHost();
  const source = h.commit(publisher(), 'create', append('fern', ['review']), 1);
  const task = source.tasks[0];
  assert.equal(h.pending('review')[0].source, '/grove/fern.0@0');
  h.commit(gardener(), 'advance', advance('0'), 2);
  assert.throws(() => h.commit(gardener(), 'review', { ...advance('0'), finish: task }, 3), /revision_conflict/);
  assert.equal(h.pending('review').length, 1);
  const result = h.commit(gardener(), 'review', { ...advance('1', 'reviewed'), finish: task }, 4);
  assert.equal(h.pending('review').length, 0);
  assert.equal(h.get('/grove/fern.0@2').value.body, 'reviewed');
  assert.deepEqual(h.commit(gardener(), 'review', { ...advance('1', 'reviewed'), finish: task }, 5), result);
  assert.throws(() => h.commit(gardener(), 'another_review', { finish: task }, 5), /task_already_finished/);
});

test('finishing one task can atomically make room for its replacement', () => {
  const h = new PathHost();
  for (let i = 0; i < PATH_LIMITS.pendingTasks; i++) h.commit(publisher(), `r${i}`, append('fern', ['review']), i);
  const task = h.pending('review')[0];
  h.commit(gardener(), 'replace', { ...append('new', ['review']), finish: task.id }, 100);
  assert.equal(h.stats().pending, PATH_LIMITS.pendingTasks);
  assert.equal(h.pending('review', PATH_LIMITS.pendingTasks).some(t => t.id === task.id), false);
});

test('append, advance, enqueue and finish require distinct host grants', () => {
  const h = new PathHost();
  const first = h.commit(publisher(), 'create', append('fern', ['review']), 1);
  assert.throws(() => h.commit(publisher(), 'bad', advance('0'), 2), /advance_denied/);
  assert.throws(() => h.commit(publisher(), 'bad', { finish: first.tasks[0] }, 2), /finish_denied/);
  assert.throws(() => h.commit(publisher(), 'bad', append('fern', ['paid_model']), 2), /enqueue_denied/);
  const elsewhere = append(); elsewhere.publication.topic = '/grove2/fern';
  assert.throws(() => h.commit(publisher(), 'bad', elsewhere, 2), /append_denied/);
  const revoked = { ...publisher(), appendUnder: [] };
  assert.throws(() => h.commit(revoked, 'create', append('fern', ['review']), 2), /append_denied/);
  assert.equal(h.stats().commits, 1);
});

test('suppression covers historical URLs, prevents advances, and never recycles numbers', () => {
  const h = new PathHost();
  h.commit(publisher(), 'create', append(), 1);
  h.commit(gardener(), 'advance', advance('0'), 2);
  h.block('/grove/fern.0');
  for (const path of ['/grove/fern.0', '/grove/fern.0@0', '/grove/fern.0@1'])
    assert.equal(h.get(path).status, 410);
  assert.throws(() => h.commit(gardener(), 'blocked', advance('1'), 3), /entry_blocked/);
  const next = h.commit(publisher(), 'next', append(), 3);
  assert.equal(next.entry, '/grove/fern.1');
  assert.equal(h.get('/grove/fern.count').value.body, '2\n');
});

test('bounded text preserves exact valid Unicode, BOM, NUL and CRLF', () => {
  const h = new PathHost();
  const body = '\uFEFFa fern 🌿\r\n\u0000';
  h.commit(publisher(), 'valid', append(body), 1);
  assert.equal(h.get('/grove/fern.0').value.body, body);
  for (const body of ['\uD800', 'a'.repeat(PATH_LIMITS.bodyBytes + 1), '🌿'.repeat(PATH_LIMITS.bodyBytes / 2)])
    assert.throws(() => h.commit(publisher(), 'bad', append(body), 2), /invalid_body/);
  assert.equal(h.stats().commits, 1);
});

test('returned records and caller-owned plans cannot mutate committed state', () => {
  const h = new PathHost();
  const plan = append('fern', ['review']);
  const receipt = h.commit(publisher(), 'create', plan, 1);
  const task = h.pending('review')[0];
  plan.publication.body = 'changed'; plan.publication.enqueue.length = 0;
  receipt.tasks.length = 0; task.done = true;
  h.get('/grove/fern.0').value.body = 'changed again';
  assert.equal(h.get('/grove/fern.0').value.body, 'fern');
  assert.equal(h.pending('review').length, 1);
});

test('invalid time or generated path cannot partially create an entry', () => {
  const h = new PathHost();
  h.commit(publisher(), 'create', append(), 10);
  for (const time of [-1, 9, NaN, Infinity, 1.5])
    assert.throws(() => h.commit(publisher(), 'bad', append(), time), /invalid_time/);
  const topic = '/grove/' + Array(4).fill('a'.repeat(60)).join('/');
  assert.equal(topic.length, 250);
  // Both generated paths must fit, including the longer .count suffix.
  h.commit(publisher(), 'fits', { publication: { kind: 'append', topic, body: 'x' } }, 11);
  const tooLong = topic + 'b';
  assert.throws(() => h.commit(publisher(), 'long', { publication: { kind: 'append', topic: tooLong, body: 'x' } }, 12), /invalid_path/);
  assert.equal(h.stats().commits, 2);
});

test('retained receipt and attempt bounds include otherwise cheap tiny writes', () => {
  const h = new PathHost();
  for (let i = 0; i < PATH_LIMITS.commits; i++) h.commit(publisher(), `r${i}`, append(''), i);
  assert.throws(() => h.commit(publisher(), 'extra', append(''), 1000), /commit_limit/);
  // Earlier successful requests remain retryable without allocating more state.
  assert.equal(h.commit(publisher(), 'r0', append(''), 1000).pinned, '/grove/fern.0@0');
  while (h.stats().attempts < PATH_LIMITS.attempts)
    assert.throws(() => h.commit(publisher(), 'extra', append(''), 1000), /commit_limit/);
  assert.throws(() => h.commit(publisher(), 'r0', append(''), 1000), /attempt_limit/);
  assert.equal(h.get('/grove/fern.count').value.body, `${PATH_LIMITS.commits}\n`);
});

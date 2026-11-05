import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { State } from '../host/state.ts';
import { DEFAULT_POLICY } from '../host/policy.ts';
import { Moderation, PolicyFollower, POLICY_REFRESH_MS, POLICY_BATCH } from '../host/moderation.ts';
import { orderedU64 } from '../src/bytes.ts';

function journal(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const db = new State({ exec(query, ...args) {
    let rows;
    if (query.trim().split(';').filter(s => s.trim()).length > 1) { sql.exec(query); rows = []; }
    else rows = sql.prepare(query).all(...args);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } }, 'https://sprig.run', DEFAULT_POLICY, 0);
  const log = new Moderation(db);
  const apply = changes => {
    sql.exec('BEGIN');
    try { log.apply(changes); sql.exec('COMMIT'); }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  };
  return { log, db, apply };
}
const path = '/sea/' + 'a'.repeat(64) + '_100';
const change = (n, active, extra = {}) => ({ position: orderedU64(String(n)),
  effect: 'block', path, active, epoch: orderedU64('0'), at_ms: String(n), ...extra });

test('policy delivery is durable, contiguous and idempotent; delayed duplicates cannot rewind it', t => {
  const { log, db, apply } = journal(t);
  apply([change(1, 1), change(2, 0)]);
  apply([change(1, 1)]);
  assert.equal(log.active('block', path), false);
  assert.equal(new Moderation(db).position(), '2');
  assert.throws(() => apply([change(1, 0)]), /policy_history_conflict/);
  assert.throws(() => apply([change(4, 1)]), /policy_gap/);
  assert.throws(() => apply([change(3, 0)]), /policy_repeated_or_rewound/);
  // The first row in this failed batch must roll back too.
  assert.throws(() => apply([change(3, 1), change(5, 0)]), /policy_gap/);
  assert.equal(log.position(), '2'); assert.equal(log.page('2').changes.length, 0);
  apply([change(3, 1, { effect: 'hide' })]);
  assert.equal(log.active('hide', path), true); assert.equal(log.active('block', path), false);
  assert.throws(() => log.page('4'), /policy_cursor_ahead/);
});
test('policy validation rejects invalid targets, overlarge batches and epochs from the future', t => {
  const { apply } = journal(t);
  for (const row of [change(1, 2), change(1, 1, { path: '/plot/moss.0' }),
    change(1, 1, { effect: 'hide', path: '/chat/grove/moss.0' }), change(1, 1, { extra: 'field' }),
    change(1, 1, { epoch: orderedU64('1') })]) assert.throws(() => apply([row]));
  assert.throws(() => apply(Array.from({ length: POLICY_BATCH + 1 }, (_, i) => change(i + 1, 1))), /policy_batch_limit/);
});
test('a follower bounds each catch-up, backs off failures, and resumes from its durable cursor', async t => {
  const authority = journal(t), replica = journal(t);
  for (let n = 1; n <= 70; n++) authority.apply([change(n, n % 2)]);
  let calls = 0, unavailable = false;
  const local = { position: () => replica.log.position(), apply: async c => replica.apply(c) };
  const pull = async after => { calls++; if (unavailable) throw Error('offline'); return authority.log.page(after); };
  let follower = new PolicyFollower(local, pull);
  await follower.tick(0); assert.equal(replica.log.position(), '32');
  await follower.tick(0); assert.equal(replica.log.position(), '64');
  await follower.tick(0); assert.equal(replica.log.position(), '70');
  await follower.tick(1); assert.equal(calls, 3);
  authority.apply([change(71, 1)]); unavailable = true;
  await assert.rejects(follower.tick(POLICY_REFRESH_MS), /offline/);
  await follower.tick(POLICY_REFRESH_MS + 1); assert.equal(calls, 4);
  assert.equal(replica.log.active('block', path), false); // Explicitly stale, not a global admission fence.
  unavailable = false; follower = new PolicyFollower(local, pull);
  await follower.tick(POLICY_REFRESH_MS + 2);
  assert.equal(replica.log.position(), '71'); assert.equal(replica.log.active('block', path), true);
});
test('concurrent refreshes coalesce; malformed and reordered pages cannot advance the cursor', async t => {
  const replica = journal(t), local = { position: () => replica.log.position(), apply: async c => replica.apply(c) };
  let release, calls = 0;
  const follower = new PolicyFollower(local, async () => {
    calls++; await new Promise(r => { release = r; });
    return { changes: [change(1, 1)], after: '1', through: '1', more: false };
  });
  const pending = follower.tick(0); await follower.tick(0); assert.equal(calls, 1);
  release(); await pending;
  for (const page of [
    { changes: [change(3, 0)], after: '3', through: '3', more: false },
    { changes: [], after: '1', through: '2', more: true },
    { changes: [change(2, 0)], after: '2', through: '3', more: false },
  ]) {
    await assert.rejects(new PolicyFollower(local, async () => page).tick(0));
    assert.equal(replica.log.position(), '1');
  }
});

test('follower diagnostics distinguish unknown, partial catch-up, failed refresh and recovery without durable writes', async t => {
  const authority = journal(t), replica = journal(t);
  for (let n = 1; n <= 33; n++) authority.apply([change(n, n % 2)]);
  let unavailable = false, badPage = false, failApply = false;
  const local = { position: () => replica.log.position(), apply: async c => { if (failApply) throw Error('private storage details'); replica.apply(c); } };
  const follower = new PolicyFollower(local, async after => {
    if (unavailable) throw Error('private credentials');
    return badPage ? { ...authority.log.page(after), after: '999' } : authority.log.page(after);
  });
  assert.equal(follower.status().lastSuccessMs, null);
  await follower.tick(0);
  assert.equal(replica.log.position(), '32'); assert.equal(follower.status().observedThrough, '33');
  assert.equal(follower.status().nextAttemptMs, 0); assert.ok(follower.status().lastSuccessMs > 0);
  const success = follower.status().lastSuccessMs, position = replica.db.control().position;
  unavailable = true; await assert.rejects(follower.tick(1));
  assert.equal(follower.status().lastError, 'pull_failed'); assert.equal(follower.status().lastSuccessMs, success);
  assert.equal(replica.db.control().position, position); assert.equal(follower.status().busy, false);
  unavailable = false; badPage = true; await assert.rejects(follower.tick(60001));
  assert.equal(follower.status().lastError, 'invalid_page');
  badPage = false; failApply = true; await assert.rejects(follower.tick(120001));
  assert.equal(follower.status().lastError, 'apply_failed'); assert.equal(replica.log.position(), '32');
  failApply = false; await follower.tick(180001);
  assert.equal(follower.status().lastError, null); assert.equal(replica.log.position(), '33');
  assert.equal(new PolicyFollower(local, async after => authority.log.page(after)).status().lastSuccessMs, null);
});

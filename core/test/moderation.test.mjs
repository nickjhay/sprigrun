import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { State } from '../host/state.ts';
import { DEFAULT_POLICY } from '../host/policy.ts';
import { Moderation, POLICY_BATCH } from '../host/moderation.ts';
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
  effect: 'block', path, active, at_ms: String(n), ...extra });

test('policy delivery is durable, contiguous and idempotent; delayed duplicates cannot rewind it', t => {
  const { log, db, apply } = journal(t);
  apply([change(1, 1), change(2, 0)]);
  apply([change(1, 1)]);
  assert.equal(log.active('block', path), false);
  assert.equal(new Moderation(db).position(), '2');
  assert.throws(() => apply([change(1, 0)]), /policy_history_conflict/);
  assert.throws(() => apply([change(4, 1)]), /policy_gap/);
  assert.throws(() => apply([change(3, 0)]), /policy_repeated/);
  // The first row in this failed batch must roll back too.
  assert.throws(() => apply([change(3, 1), change(5, 0)]), /policy_gap/);
  assert.equal(log.position(), '2'); assert.equal(log.page('2').changes.length, 0);
  apply([change(3, 1, { effect: 'hide' })]);
  assert.equal(log.active('hide', path), true); assert.equal(log.active('block', path), false);
  assert.throws(() => log.page('4'), /policy_cursor_ahead/);
});
test('policy validation rejects invalid targets, overlarge batches and extra fields', t => {
  const { apply } = journal(t);
  for (const row of [change(1, 2), change(1, 1, { path: '/plot/moss.0' }),
    change(1, 1, { effect: 'hide', path: '/chat/grove/moss.0' }), change(1, 1, { extra: 'field' }),
    change(1, 1, { epoch: orderedU64('1') })]) assert.throws(() => apply([row]));
  assert.throws(() => apply(Array.from({ length: POLICY_BATCH + 1 }, (_, i) => change(i + 1, 1))), /policy_batch_limit/);
});

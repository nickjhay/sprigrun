import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { State } from '../host/state.ts';
import { DEFAULT_POLICY } from '../host/policy.ts';
import { validateHeader } from '../host/archive.ts';

function localSql(t) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  return {
    exec(query, ...bindings) {
      let rows;
      if (query.trim().split(';').filter(s => s.trim()).length > 1) { database.exec(query); rows = []; }
      else rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    },
  };
}
test('schema 1 and wrong-origin databases are rejected without altering tables or control', t => {
  const sql = localSql(t);
  const old = { schema: 1, origin: 'https://sprig.run', epoch: '4', accepted: '19' };
  sql.exec('CREATE TABLE control(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE accepted(id TEXT PRIMARY KEY, receipt TEXT);');
  sql.exec('INSERT INTO control VALUES(1, ?)', JSON.stringify(old));
  sql.exec('INSERT INTO accepted VALUES(?, ?)', 'saved action', 'saved receipt');
  const schema = sql.exec('SELECT * FROM sqlite_master ORDER BY name').toArray();
  assert.throws(() => new State(sql, old.origin, DEFAULT_POLICY, 0), /incompatible_native_database/);
  assert.deepEqual(sql.exec('SELECT * FROM sqlite_master ORDER BY name').toArray(), schema);
  assert.equal(sql.exec('SELECT value FROM control').one().value, JSON.stringify(old));
  assert.equal(sql.exec('SELECT receipt FROM accepted').one().receipt, 'saved receipt');
  sql.exec('UPDATE control SET value=?', JSON.stringify({ ...old, schema: 2 }));
  assert.throws(() => new State(sql, 'https://elsewhere.invalid', DEFAULT_POLICY, 0), /incompatible_native_database/);
  assert.deepEqual(sql.exec('SELECT * FROM sqlite_master ORDER BY name').toArray(), schema);
});
test('old archive format is refused explicitly; new databases declare schema 2', t => {
  const state = new State(localSql(t), 'https://sprig.run', DEFAULT_POLICY, 0);
  assert.equal(state.control().schema, 2);
  assert.throws(() => validateHeader({ type: 'header', format: 'sprig-native-snapshot/1', epoch: '0',
    capturedAtMs: '0', control: { ...state.control(), schema: 1 }, policy: DEFAULT_POLICY }), /archive_version/);
});

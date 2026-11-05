import { full, type BucketState } from '../../shared/bucket.ts';
import { check } from '../src/bytes.ts';
import type { Policy } from './policy.ts';

export type Control = {
  schema: 3; origin: string; epoch: string; paused: boolean;
  growth: BucketState; burst: BucketState; attempts: BucketState;
  moderation: string; accepted: string; reservedBytes: string; acceptedDebit: string;
};
export interface Source extends Record<string, SqlStorageValue> {
  address: string; bytes: number; debit: number; reserved_epoch: string;
  reserved_at_ms: string;
}
export interface Result extends Record<string, SqlStorageValue> {
  path: string; collection: string | null; number: string | null; kind: string;
  value: string | null; controller: string | null; binding: string | null;
  action: string; epoch: string; accepted_at_ms: string; debit: number;
  header: string; body: string | null; source: string | null; signature: string | null;
  key_record: string | null; author_binding: string | null; receipt: string;
}
export class State {
  readonly sql: SqlStorage;
  constructor(sql: SqlStorage, origin: string, p: Policy, now: number) {
    this.sql = sql;
    // Refuse old state before any schema mutation; the operator chooses a fresh directory.
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control'").toArray().length) {
      const c = this.control();
      check(c.schema === 3 && c.origin === origin, 'incompatible_native_database');
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        address TEXT PRIMARY KEY, bytes INTEGER NOT NULL, debit INTEGER NOT NULL,
        reserved_epoch TEXT NOT NULL, reserved_at_ms TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS heads (collection TEXT PRIMARY KEY, number TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results (
        path TEXT PRIMARY KEY, collection TEXT, number TEXT, kind TEXT NOT NULL,
        value TEXT, controller TEXT, binding TEXT, action TEXT NOT NULL UNIQUE,
        epoch TEXT NOT NULL,
        accepted_at_ms TEXT NOT NULL, debit INTEGER NOT NULL,
        header TEXT NOT NULL, body TEXT, source TEXT, signature TEXT,
        key_record TEXT, author_binding TEXT, receipt TEXT NOT NULL, UNIQUE(collection, number));
      CREATE TABLE IF NOT EXISTS moderation (
        position TEXT PRIMARY KEY, effect TEXT NOT NULL, path TEXT NOT NULL,
        active INTEGER NOT NULL, epoch TEXT NOT NULL, at_ms TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS moderation_target ON moderation(effect, path, position DESC);
      CREATE TABLE IF NOT EXISTS cuts (epoch TEXT PRIMARY KEY, control TEXT NOT NULL, at_ms TEXT NOT NULL);`);
    const initial: Control = { schema: 3, origin, epoch: '0', paused: false,
      growth: full(p.growth, now), burst: full(p.burst, now), attempts: full(p.attempts, now),
      moderation: '0', accepted: '0', reservedBytes: '0', acceptedDebit: '0' };
    sql.exec('INSERT OR IGNORE INTO control VALUES (1, ?)', JSON.stringify(initial));
    const c = this.control();
    check(c.schema === 3 && c.origin === origin, 'incompatible_native_database');
  }
  control(): Control { return JSON.parse(this.sql.exec<{ value: string }>('SELECT value FROM control WHERE id=1').one().value); }
  save(c: Control) { this.sql.exec('UPDATE control SET value=? WHERE id=1', JSON.stringify(c)); }
  source(address: string) { return this.sql.exec<Source>('SELECT * FROM sources WHERE address=?', address).toArray()[0]; }
  result(path: string) { return this.sql.exec<Result>('SELECT * FROM results WHERE path=?', path).toArray()[0]; }
  accepted(id: string) { return this.sql.exec<Result>('SELECT * FROM results WHERE action=?', id).toArray()[0]; }
}

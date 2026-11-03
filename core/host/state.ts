import { full, type BucketState } from '../../shared/bucket.ts';
import { check } from '../src/bytes.ts';
import type { Policy } from './policy.ts';

export type Control = {
  schema: 1; origin: string; epoch: string; paused: boolean;
  growth: BucketState; burst: BucketState; attempts: BucketState;
  accepted: string; reservedBytes: string; acceptedDebit: string;
};
export interface Source extends Record<string, SqlStorageValue> {
  address: string; bytes: number; debit: number; reserved_epoch: string;
  reserved_at_ms: string; published_epoch: string | null; submitted_at_ms: string | null;
}
export interface Entry extends Record<string, SqlStorageValue> {
  path: string; collection: string; number: string; kind: string;
  value: string | null; controller: string | null; binding: string | null;
  action: string; epoch: string; submitted_at_ms: string;
}
export interface Accepted extends Record<string, SqlStorageValue> {
  id: string; result: string; epoch: string; accepted_at_ms: string; debit: number;
  header: string; body: string | null; source: string | null; signature: string | null;
  key_record: string | null; author_binding: string | null; receipt: string;
}
export class State {
  constructor(readonly sql: SqlStorage, origin: string, p: Policy, now: number) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        address TEXT PRIMARY KEY, bytes INTEGER NOT NULL, debit INTEGER NOT NULL,
        reserved_epoch TEXT NOT NULL, reserved_at_ms TEXT NOT NULL,
        published_epoch TEXT, submitted_at_ms TEXT);
      CREATE TABLE IF NOT EXISTS heads (collection TEXT PRIMARY KEY, number TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (
        path TEXT PRIMARY KEY, collection TEXT NOT NULL, number TEXT NOT NULL, kind TEXT NOT NULL,
        value TEXT, controller TEXT, binding TEXT, action TEXT NOT NULL,
        epoch TEXT NOT NULL, submitted_at_ms TEXT NOT NULL, UNIQUE(collection, number));
      CREATE TABLE IF NOT EXISTS accepted (
        id TEXT PRIMARY KEY, result TEXT NOT NULL, epoch TEXT NOT NULL,
        accepted_at_ms TEXT NOT NULL, debit INTEGER NOT NULL,
        header TEXT NOT NULL, body TEXT, source TEXT, signature TEXT,
        key_record TEXT, author_binding TEXT, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suppressions (
        path TEXT NOT NULL, revision TEXT NOT NULL, epoch TEXT NOT NULL,
        suppressed INTEGER NOT NULL, at_ms TEXT NOT NULL, PRIMARY KEY(path, revision));
      CREATE TABLE IF NOT EXISTS cuts (epoch TEXT PRIMARY KEY, control TEXT NOT NULL, at_ms TEXT NOT NULL);`);
    const initial: Control = { schema: 1, origin, epoch: '0', paused: false,
      growth: full(p.growth, now), burst: full(p.burst, now), attempts: full(p.attempts, now),
      accepted: '0', reservedBytes: '0', acceptedDebit: '0' };
    sql.exec('INSERT OR IGNORE INTO control VALUES (1, ?)', JSON.stringify(initial));
    const c = this.control();
    check(c.schema === 1 && c.origin === origin, 'incompatible_native_database');
  }
  control(): Control { return JSON.parse(this.sql.exec<{ value: string }>('SELECT value FROM control WHERE id=1').one().value); }
  save(c: Control) { this.sql.exec('UPDATE control SET value=? WHERE id=1', JSON.stringify(c)); }
  source(address: string) { return this.sql.exec<Source>('SELECT * FROM sources WHERE address=?', address).toArray()[0]; }
  entry(path: string) { return this.sql.exec<Entry>('SELECT * FROM entries WHERE path=?', path).toArray()[0]; }
  accepted(id: string) { return this.sql.exec<Accepted>('SELECT * FROM accepted WHERE id=?', id).toArray()[0]; }
  suppression(path: string) {
    return this.sql.exec<{ revision: string; suppressed: number }>(
      'SELECT revision, suppressed FROM suppressions WHERE path=? ORDER BY revision DESC LIMIT 1', path).toArray()[0];
  }
}

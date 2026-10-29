import type { BucketState } from '../../shared/bucket.ts';

export interface Totals {
  reservedBlobs: number; reservedBytes: number;
  confirmedBlobs: number; confirmedBytes: number; blockedAddresses: number;
}
export interface Control extends Totals {
  schema: 3;
  epoch: number;
  receipts: number;
  paused: boolean;
  proofOfWorkBits?: number;
  proofOfWorkPerByte?: number;
  long: BucketState; burst: BucketState; attempts: BucketState; challenges: BucketState;
}
// Each pair is an immutable fact. NULL means that event has never committed.
export interface Receipt extends Record<string, SqlStorageValue> {
  address: string; bytes: number; debit: number;
  reserved_epoch: number | null; reserved_at_ms: number | null;
  published_epoch: number | null; submitted_at_ms: number | null;
  blocked_epoch: number | null; blocked_at_ms: number | null;
}
export const status = (r: Receipt): 'pending' | 'stored' | 'blocked' =>
  r.blocked_epoch !== null ? 'blocked' : r.published_epoch !== null ? 'stored' : 'pending';
export function atEpoch(r: Receipt, epoch: number): Receipt | null {
  const copy = { ...r };
  for (const [event, time] of [['reserved_epoch', 'reserved_at_ms'], ['published_epoch', 'submitted_at_ms'], ['blocked_epoch', 'blocked_at_ms']] as const) {
    if (copy[event] !== null && copy[event]! > epoch) { copy[event] = null; copy[time] = null; }
  }
  if (copy.reserved_epoch === null) copy.debit = 0;
  return copy.reserved_epoch === null && copy.blocked_epoch === null ? null : copy;
}
export const emptyTotals = (): Totals => ({ reservedBlobs: 0, reservedBytes: 0, confirmedBlobs: 0, confirmedBytes: 0, blockedAddresses: 0 });
export const readControl = (sql: SqlStorage): Control => JSON.parse(sql.exec<{ value: string }>('SELECT value FROM control WHERE id=1').one().value);
export const saveControl = (sql: SqlStorage, state: Control): void => { sql.exec('UPDATE control SET value=? WHERE id=1', JSON.stringify(state)); };
export const readReceipt = (sql: SqlStorage, address: string): Receipt | undefined => sql.exec<Receipt>('SELECT * FROM receipts WHERE address=?', address).toArray()[0];
export function insertReceipt(sql: SqlStorage, r: Receipt): void {
  sql.exec(`INSERT INTO receipts(address,bytes,debit,reserved_epoch,reserved_at_ms,published_epoch,submitted_at_ms,blocked_epoch,blocked_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?)`, r.address, r.bytes, r.debit, r.reserved_epoch, r.reserved_at_ms, r.published_epoch, r.submitted_at_ms, r.blocked_epoch, r.blocked_at_ms);
}

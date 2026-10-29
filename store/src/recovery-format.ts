// Logical archive validation. Exact bytes and immutable facts; no deployment schema.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { HARD_MAX_BLOB_BYTES } from './config.ts';
import { validate } from './bytes.ts';
import { parseAddress, workTarget } from './proof.ts';
import { HttpError } from './types.ts';
import { emptyTotals, status, type Receipt, type Totals } from './state.ts';
export { emptyTotals } from './state.ts';
export type { Totals } from './state.ts';
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_HEADER_BYTES = 16384;
export const PAGE_SIZE = 128;
export const HASH = /^[0-9a-f]{64}$/;
export const FORMAT = 'sprig-store-snapshot-v2';
export interface SnapshotHeader {
  type: 'header'; format: typeof FORMAT; id: string; source_origin: string;
  captured_at_ms: number; expires_at_ms: number; epoch: number; receipts: number;
  totals: Totals; proof_of_work: { bits: number; per_byte: number };
}
export interface SnapshotRecord {
  type: 'record'; receipt: Receipt; object: { body: string; validation_policy: string } | null;
}
export interface Progress { after: string; count: number; chain: string; totals: Totals; epoch: number }
export function check(ok: unknown, code = 'invalid_snapshot'): asserts ok {
  if (!ok) throw new HttpError(400, code);
}
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const nextChain = (chain: string, line: string) => digest(chain + '\n' + line);
export function fields(value: unknown, required: string[], optional: string[] = []): void {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  check(required.every(key => Object.hasOwn(object, key)) && Object.keys(object).every(key => [...required, ...optional].includes(key)));
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max);
}
export function bareOrigin(value: unknown): string {
  check(typeof value === 'string');
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, 'invalid_origin'); }
  check(url.href === url.origin + '/' && !url.username && !url.password, 'invalid_origin');
  check(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'invalid_origin');
  return url.origin;
}
export function equalJSON(a: unknown, b: unknown): boolean {
  const sorted = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}
export function validateHeader(value: unknown): SnapshotHeader {
  fields(value, ['type', 'format', 'id', 'source_origin', 'captured_at_ms', 'expires_at_ms', 'epoch', 'receipts', 'totals', 'proof_of_work']);
  const h = value as SnapshotHeader;
  check(h.type === 'header' && h.format === FORMAT && typeof h.id === 'string' && HASH.test(h.id));
  check(bareOrigin(h.source_origin) === h.source_origin);
  integer(h.captured_at_ms); integer(h.expires_at_ms); integer(h.epoch, Number.MAX_SAFE_INTEGER - 1); integer(h.receipts);
  check(h.expires_at_ms > h.captured_at_ms);
  fields(h.totals, Object.keys(emptyTotals()));
  for (const n of Object.values(h.totals)) integer(n);
  fields(h.proof_of_work, ['bits', 'per_byte']);
  integer(h.proof_of_work.bits, 256); integer(h.proof_of_work.per_byte, 1e9);
  try { workTarget(h.proof_of_work.bits, h.proof_of_work.per_byte, HARD_MAX_BLOB_BYTES); }
  catch { throw new HttpError(400, 'invalid_snapshot_policy'); }
  return h;
}
export function validateRecord(value: unknown): { record: SnapshotRecord; bytes: Uint8Array | null } {
  fields(value, ['type', 'receipt', 'object']);
  const record = value as SnapshotRecord, r = record.receipt;
  check(record.type === 'record');
  fields(r, ['address', 'bytes', 'debit', 'reserved_epoch', 'reserved_at_ms', 'published_epoch', 'submitted_at_ms', 'blocked_epoch', 'blocked_at_ms']);
  check(typeof r.address === 'string');
  const address = parseAddress(r.address); check(address);
  integer(r.bytes, HARD_MAX_BLOB_BYTES); integer(r.debit, HARD_MAX_BLOB_BYTES);
  check(r.bytes === address.bytes);
  for (const [epoch, time] of [['reserved_epoch','reserved_at_ms'], ['published_epoch','submitted_at_ms'], ['blocked_epoch','blocked_at_ms']] as const) {
    if (r[epoch] === null) check(r[time] === null);
    else { integer(r[epoch]); integer(r[time]); }
  }
  if (r.reserved_epoch === null) check(r.debit === 0 && r.published_epoch === null && r.blocked_epoch !== null);
  else check(r.debit >= Math.max(1, r.bytes));
  if (r.published_epoch !== null) check(r.reserved_epoch !== null && r.reserved_epoch <= r.published_epoch);
  if (r.blocked_epoch !== null) check((r.reserved_epoch === null || r.reserved_epoch <= r.blocked_epoch)
    && (r.published_epoch === null || r.published_epoch <= r.blocked_epoch));
  if (status(r) !== 'stored') { check(record.object === null); return { record, bytes: null }; }
  check(record.object !== null);
  const object = record.object;
  fields(object, ['body', 'validation_policy']);
  check(typeof object.body === 'string' && object.body.length <= Math.ceil(HARD_MAX_BLOB_BYTES / 3) * 4);
  const bytes = Buffer.from(object.body, 'base64');
  check(bytes.toString('base64') === object.body && bytes.length === address.bytes && digest(bytes) === address.digest, 'snapshot_body_mismatch');
  check(['utf8-v1', 'ascii-v1'].includes(object.validation_policy));
  validate(bytes, object.validation_policy);
  return { record, bytes };
}
export function progress(header: SnapshotHeader): Progress {
  return { after: '', count: 0, chain: digest(JSON.stringify(header)), totals: emptyTotals(), epoch: header.epoch };
}
export function advance(previous: Progress, r: Receipt, line: string): Progress {
  check(r.address > previous.after, 'snapshot_order');
  for (const key of ['reserved_epoch', 'published_epoch', 'blocked_epoch'] as const)
    check(r[key] === null || r[key]! <= previous.epoch, 'snapshot_future_fact');
  const totals = { ...previous.totals };
  if (r.reserved_epoch !== null) { totals.reservedBlobs++; totals.reservedBytes += r.debit; }
  if (status(r) === 'stored') { totals.confirmedBlobs++; totals.confirmedBytes += r.bytes; }
  if (status(r) === 'blocked') totals.blockedAddresses++;
  for (const value of Object.values(totals)) integer(value);
  return { after: r.address, count: previous.count + 1, chain: nextChain(previous.chain, line), totals, epoch: previous.epoch };
}
export function complete(header: SnapshotHeader, p: Progress, chain: string): void {
  check(HASH.test(chain) && p.chain === chain && p.count === header.receipts, 'snapshot_incomplete');
  check(equalJSON(p.totals, header.totals), 'snapshot_accounting_mismatch');
}

// Shared, bounded archive validation. No storage calls or executable archive content.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { config, HARD_MAX_BLOB_BYTES, type Config } from './config.ts';
import { validate } from './bytes.ts';
import { parseAddress, workTarget } from './proof.ts';
import { HttpError, type Env } from './types.ts';
import type { Control, Receipt } from './state.ts';

export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_HEADER_BYTES = 16384;
export const PAGE_SIZE = 128;
export const HASH = /^[0-9a-f]{64}$/;
export const FORMAT = 'sprig-store-snapshot-v1';
export interface SnapshotHeader {
  type: 'header'; format: typeof FORMAT; id: string; source_origin: string;
  captured_at_ms: number; receipts: number; policy: Config; control: Control;
}
export type ObjectData = {
  body: string; custom: Record<string, string>;
  http: Omit<R2HTTPMetadata, 'cacheExpiry'> & { cacheExpiry?: string };
};
export interface SnapshotRecord { type: 'record'; receipt: Receipt; object: ObjectData | null }
export interface Totals { reservedBlobs: number; reservedBytes: number; confirmedBlobs: number; confirmedBytes: number; blockedAddresses: number }
export interface Progress { after: string; count: number; chain: string; totals: Totals }

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

// Reuse the actual configuration validator, including hard ceilings and bucket relationships.
function policyEnv(p: Config): Partial<Env> {
  return {
    MAX_BLOB_BYTES: String(p.maxBytes), MINIMUM_DEBIT_BYTES: String(p.minimumDebit), VALIDATION_POLICY: p.validationPolicy,
    PROOF_OF_WORK_BITS: String(p.proofOfWorkBits), PROOF_OF_WORK_PER_BYTE: String(p.proofOfWorkPerByte),
    CHALLENGE_BURST: String(p.challenges?.capacity), CHALLENGES_PER_MINUTE: String(p.challenges?.refill),
    CHALLENGE_CAPACITY: String(p.challengeCapacity), CHALLENGE_TTL_SECONDS: String(p.challengeTtlMs / 1000),
    LONG_CAPACITY_BYTES: String(p.long?.capacity), LONG_REFILL_BYTES_PER_DAY: String(p.long?.refill),
    BURST_CAPACITY_BYTES: String(p.burst?.capacity), BURST_REFILL_BYTES_PER_HOUR: String(p.burst?.refill),
    ATTEMPT_CAPACITY: String(p.attempts?.capacity), ATTEMPTS_PER_MINUTE: String(p.attempts?.refill),
    UPLOAD_TIMEOUT_MS: String(p.uploadTimeoutMs), BROWSER_CACHE_SECONDS: String(p.browserCacheSeconds),
  };
}
export function equalJSON(a: unknown, b: unknown): boolean {
  const sorted = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}
export const emptyTotals = (): Totals => ({ reservedBlobs: 0, reservedBytes: 0, confirmedBlobs: 0, confirmedBytes: 0, blockedAddresses: 0 });

export function validateHeader(value: unknown): SnapshotHeader {
  fields(value, ['type', 'format', 'id', 'source_origin', 'captured_at_ms', 'receipts', 'policy', 'control']);
  const h = value as SnapshotHeader;
  check(h.type === 'header' && h.format === FORMAT && typeof h.id === 'string' && HASH.test(h.id));
  check(bareOrigin(h.source_origin) === h.source_origin);
  integer(h.captured_at_ms); integer(h.receipts);
  check(h.policy && typeof h.policy === 'object');
  try { check(equalJSON(config(policyEnv(h.policy)), h.policy)); } catch { throw new HttpError(400, 'invalid_snapshot_policy'); }
  const s = h.control;
  fields(s, ['schema', 'paused', 'long', 'burst', 'attempts', 'challenges', ...Object.keys(emptyTotals())], ['proofOfWorkBits', 'proofOfWorkPerByte']);
  check(s.schema === 2 && s.paused === true);
  if (s.proofOfWorkBits !== undefined) integer(s.proofOfWorkBits, 256);
  if (s.proofOfWorkPerByte !== undefined) integer(s.proofOfWorkPerByte, 1e9);
  try { workTarget(s.proofOfWorkBits ?? h.policy.proofOfWorkBits, s.proofOfWorkPerByte ?? h.policy.proofOfWorkPerByte, h.policy.maxBytes); }
  catch { throw new HttpError(400, 'invalid_snapshot_work'); }
  for (const key of ['long', 'burst', 'attempts', 'challenges'] as const) {
    const b = s[key]; fields(b, ['tokens', 'atMs', 'remainder']);
    integer(b.tokens, h.policy[key].capacity); integer(b.atMs); integer(b.remainder, h.policy[key].periodMs - 1);
  }
  for (const key of Object.keys(emptyTotals()) as (keyof Totals)[]) integer(s[key]);
  return h;
}

export function validateRecord(value: unknown): { record: SnapshotRecord; bytes: Uint8Array | null } {
  fields(value, ['type', 'receipt', 'object']);
  const record = value as SnapshotRecord, r = record.receipt;
  check(record.type === 'record');
  fields(r, ['address', 'status', 'bytes', 'debit', 'submitted_at_ms']);
  check(typeof r.address === 'string');
  const address = parseAddress(r.address); check(address);
  check(['pending', 'stored', 'blocked'].includes(r.status));
  integer(r.bytes, HARD_MAX_BLOB_BYTES); integer(r.debit, HARD_MAX_BLOB_BYTES);
  if (r.submitted_at_ms !== null) integer(r.submitted_at_ms);
  if (r.debit === 0) check(r.status === 'blocked' && r.bytes === 0 && r.submitted_at_ms === null);
  else check(r.bytes === address.bytes && r.debit >= Math.max(1, r.bytes));
  if (r.status === 'blocked') { check(record.object === null); return { record, bytes: null }; }
  if (record.object === null) { check(r.status === 'pending'); return { record, bytes: null }; }
  const object = record.object;
  fields(object, ['body', 'custom', 'http']);
  check(typeof object.body === 'string' && object.body.length <= Math.ceil(HARD_MAX_BLOB_BYTES / 3) * 4);
  const bytes = Buffer.from(object.body, 'base64');
  check(bytes.toString('base64') === object.body && bytes.length === address.bytes && digest(bytes) === address.digest, 'snapshot_body_mismatch');
  check(object.custom && typeof object.custom === 'object' && !Array.isArray(object.custom));
  check(Object.values(object.custom).every(value => typeof value === 'string') && Buffer.byteLength(JSON.stringify(object.custom)) <= 16384);
  check(object.custom.kind === 'blob' && object.custom.sha256 === address.digest);
  check(['utf8-v1', 'ascii-v1'].includes(object.custom.validation_policy ?? ''));
  check(r.submitted_at_ms === null ? object.custom.submitted_at_ms === undefined : object.custom.submitted_at_ms === String(r.submitted_at_ms), 'snapshot_timestamp_mismatch');
  validate(bytes, object.custom.validation_policy!);
  fields(object.http, [], ['contentType', 'contentLanguage', 'contentDisposition', 'contentEncoding', 'cacheControl', 'cacheExpiry']);
  check(Object.values(object.http).every(value => typeof value === 'string') && Buffer.byteLength(JSON.stringify(object.http)) <= 16384);
  if (object.http.cacheExpiry !== undefined) {
    check(Number.isFinite(Date.parse(object.http.cacheExpiry)));
    check(new Date(object.http.cacheExpiry).toISOString() === object.http.cacheExpiry);
  }
  return { record, bytes };
}

export function progress(header: SnapshotHeader): Progress {
  return { after: '', count: 0, chain: digest(JSON.stringify(header)), totals: emptyTotals() };
}
export function advance(previous: Progress, r: Receipt, line: string): Progress {
  check(r.address > previous.after, 'snapshot_order');
  const totals = { ...previous.totals };
  if (r.debit > 0) { totals.reservedBlobs++; totals.reservedBytes += r.debit; }
  if (r.status === 'stored') { totals.confirmedBlobs++; totals.confirmedBytes += r.bytes; }
  if (r.status === 'blocked') totals.blockedAddresses++;
  for (const value of Object.values(totals)) integer(value);
  return { after: r.address, count: previous.count + 1, chain: nextChain(previous.chain, line), totals };
}
export function complete(header: SnapshotHeader, p: Progress, chain: string): void {
  check(HASH.test(chain) && p.chain === chain && p.count === header.receipts, 'snapshot_incomplete');
  for (const key of Object.keys(emptyTotals()) as (keyof Totals)[]) check(p.totals[key] === header.control[key], 'snapshot_accounting_mismatch');
}

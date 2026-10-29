// All entrypoints run under the coordinator's existing writer mutex.
import { Buffer } from 'node:buffer';
import { refill } from '../../shared/bucket.ts';
import { objectKey, verifiedBody } from './bytes.ts';
import type { Config } from './config.ts';
import { parseAddress } from './proof.ts';
import { failure, HttpError, type Env, type Result } from './types.ts';
import type { Control, Receipt } from './state.ts';
import { advance, bareOrigin, check, complete, digest, emptyTotals, equalJSON, fields, FORMAT, HASH,
  PAGE_SIZE, progress, validateHeader, validateRecord, type Progress, type SnapshotHeader, type SnapshotRecord } from './recovery-format.ts';

type Maintenance = { kind: 'snapshot'; header: SnapshotHeader }
  | { kind: 'restore'; header: SnapshotHeader; expected: string; progress: Progress; lastRecord?: string }
  | { kind: 'restored'; id: string; chain: string };
function session(sql: SqlStorage): Maintenance | undefined {
  const row = sql.exec<{ value: string }>('SELECT value FROM maintenance WHERE id=1').toArray()[0];
  return row && JSON.parse(row.value) as Maintenance;
}
export function recoveryLocked(sql: SqlStorage): boolean {
  const s = session(sql); return s !== undefined && s.kind !== 'restored';
}
const read = (sql: SqlStorage): Control => JSON.parse(sql.exec<{ value: string }>('SELECT value FROM control WHERE id=1').one().value);
const save = (sql: SqlStorage, state: Control) => { sql.exec('UPDATE control SET value=? WHERE id=1', JSON.stringify(state)); };
const saveSession = (sql: SqlStorage, value: Maintenance) => { sql.exec('INSERT OR REPLACE INTO maintenance(id,value) VALUES(1,?)', JSON.stringify(value)); };
const row = (sql: SqlStorage, address: string) => sql.exec<Receipt>('SELECT * FROM receipts WHERE address=?', address).toArray()[0];
const count = (sql: SqlStorage, table: 'receipts' | 'tickets') => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;
export type RecoveryValue = SnapshotHeader | SnapshotRecord | { addresses: string[] } | { uploads_paused: true } | { complete: boolean; after?: string; uploads_paused?: boolean } | { after: string };
const success = (value: RecoveryValue): Result<RecoveryValue> => ({ ok: true, value });

export async function recovery(ctx: DurableObjectState, env: Env, policy: Config, action: string, input: Uint8Array, origin: string): Promise<Result<RecoveryValue>> {
  let data: Record<string, unknown>, line: string;
  try { line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); data = JSON.parse(line || '{}'); }
  catch { throw new HttpError(400, 'invalid_recovery_json'); }
  check(data !== null && typeof data === 'object' && !Array.isArray(data));
  const sql = ctx.storage.sql, current = session(sql);

  if (action === 'snapshot/begin') {
    fields(data, []);
    if (env.RESTORE_MODE !== undefined || current?.kind === 'restore') return failure(409, 'restore_in_progress');
    if (current?.kind === 'snapshot') return success(current.header);
    const state = read(sql), now = Date.now();
    state.paused = true;
    for (const key of ['long', 'burst', 'attempts', 'challenges'] as const) state[key] = refill(state[key], policy[key], now);
    const header: SnapshotHeader = { type: 'header', format: FORMAT,
      id: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), source_origin: bareOrigin(origin),
      captured_at_ms: now, receipts: count(sql, 'receipts'), policy, control: state };
    validateHeader(header);
    ctx.storage.transactionSync(() => {
      save(sql, state);
      saveSession(sql, { kind: 'snapshot', header });
      // A freeze invalidates admitted-but-unfinished uploads and outstanding tickets.
      sql.exec('DELETE FROM tickets');
    });
    await ctx.storage.sync();
    return success(header);
  }
  if (action.startsWith('snapshot/')) {
    check(current?.kind === 'snapshot' && data.id === current.header.id, 'snapshot_not_active');
    if (action === 'snapshot/end') {
      fields(data, ['id']);
      sql.exec('DELETE FROM maintenance'); await ctx.storage.sync();
      return success({ uploads_paused: true }); // Resume is always a separate operator action.
    }
    if (action === 'snapshot/page') {
      fields(data, ['id', 'after']);
      check(typeof data.after === 'string' && (data.after === '' || parseAddress(data.after)));
      return success({ addresses: sql.exec<{ address: string }>(
        'SELECT address FROM receipts WHERE address > ? ORDER BY address LIMIT ?', data.after, PAGE_SIZE).toArray().map(r => r.address) });
    }
    if (action === 'snapshot/object') {
      fields(data, ['id', 'address']);
      check(typeof data.address === 'string');
      const address = parseAddress(data.address); check(address);
      const receipt = row(sql, data.address);
      if (!receipt) return failure(404, 'receipt_not_found');
      const record: SnapshotRecord = { type: 'record', receipt, object: null };
      if (receipt.status !== 'blocked') {
        const object = await env.BLOBS.get(objectKey(data.address));
        if (!object && receipt.status === 'stored') return failure(503, 'snapshot_object_missing');
        if (object) {
          const bytes = await verifiedBody(object, address.digest, address.bytes);
          record.object = { body: Buffer.from(bytes).toString('base64'), custom: object.customMetadata ?? {},
            http: JSON.parse(JSON.stringify(object.httpMetadata ?? {})) };
        }
      }
      // Never export suppressed source, even if an earlier tombstone write failed.
      validateRecord(record);
      return success(record);
    }
    return failure(404, 'not_found');
  }

  if (!action.startsWith('restore/') || env.RESTORE_MODE !== '1') return failure(404, 'not_found');
  if (action === 'restore/begin') {
    fields(data, ['header', 'chain']);
    const header = validateHeader(data.header);
    check(typeof data.chain === 'string' && HASH.test(data.chain));
    check(equalJSON(header.policy, policy), 'restore_policy_mismatch');
    if (current?.kind === 'restored' && current.id === header.id && current.chain === data.chain) return success({ complete: true });
    if (current?.kind === 'restore') {
      check(current.expected === data.chain && equalJSON(current.header, header), 'different_restore_active');
      return success({ complete: false, after: current.progress.after });
    }
    check(!current && count(sql, 'receipts') === 0 && count(sql, 'tickets') === 0, 'restore_requires_empty_target');
    const state = read(sql);
    for (const key of Object.keys(emptyTotals()) as (keyof ReturnType<typeof emptyTotals>)[]) check(state[key] === 0, 'restore_requires_empty_target');
    check((await env.BLOBS.list({ limit: 1 })).objects.length === 0, 'restore_requires_empty_bucket');
    state.paused = true;
    ctx.storage.transactionSync(() => {
      save(sql, state);
      saveSession(sql, { kind: 'restore', header, expected: data.chain as string, progress: progress(header) });
    });
    await ctx.storage.sync();
    return success({ complete: false, after: '' });
  }
  if (action === 'restore/finish' && current?.kind === 'restored') {
    fields(data, ['id', 'chain']); check(data.id === current.id && data.chain === current.chain);
    return success({ complete: true, uploads_paused: true });
  }
  check(current?.kind === 'restore', 'restore_not_active');
  // Refuse a mid-restore deployment with a different admission policy.
  check(equalJSON(current.header.policy, policy), 'restore_policy_mismatch');
  if (action === 'restore/record') {
    const { record, bytes } = validateRecord(data), receipt = record.receipt;
    const recordHash = digest(line);
    if (receipt.address === current.progress.after && recordHash === current.lastRecord) return success({ after: receipt.address });
    check(current.progress.count < current.header.receipts, 'too_many_restore_records');
    const next = advance(current.progress, receipt, line);
    check(!row(sql, receipt.address), 'restore_receipt_conflict');
    if (record.object !== null || receipt.status === 'blocked') {
      const object = record.object;
      const custom = object?.custom ?? { kind: 'blocked', ...(receipt.submitted_at_ms === null ? {} : { submitted_at_ms: String(receipt.submitted_at_ms) }) };
      const { cacheExpiry, ...http } = object?.http ?? {};
      const body = bytes ?? crypto.getRandomValues(new Uint8Array(32));
      const written = await env.BLOBS.put(objectKey(receipt.address), body, {
        onlyIf: new Headers({ 'If-None-Match': '*' }), customMetadata: custom,
        httpMetadata: { ...http, ...(cacheExpiry === undefined ? {} : { cacheExpiry: new Date(cacheExpiry) }) },
      });
      if (!written) {
        // A retry after R2 committed but SQLite did not must match, never overwrite.
        const existing = await env.BLOBS.get(objectKey(receipt.address));
        check(existing, 'restore_object_missing');
        try {
          check(equalJSON(existing.customMetadata ?? {}, custom) && equalJSON(JSON.parse(JSON.stringify(existing.httpMetadata ?? {})), object?.http ?? {}), 'restore_metadata_conflict');
          if (object) await verifiedBody(existing, parseAddress(receipt.address)!.digest, receipt.bytes);
          else check(existing.size === 32, 'restore_tombstone_conflict');
        } finally { if (!existing.bodyUsed) void existing.body.cancel().catch(() => {}); }
      }
    }
    // R2 first, then receipt + progress atomically. Pending reservations stay pending.
    ctx.storage.transactionSync(() => {
      sql.exec('INSERT INTO receipts(address,status,bytes,debit,submitted_at_ms) VALUES(?,?,?,?,?)',
        receipt.address, receipt.status, receipt.bytes, receipt.debit, receipt.submitted_at_ms);
      saveSession(sql, { ...current, progress: next, lastRecord: recordHash });
    });
    await ctx.storage.sync();
    return success({ after: receipt.address });
  }
  if (action === 'restore/finish') {
    fields(data, ['id', 'chain']); check(data.id === current.header.id && data.chain === current.expected);
    complete(current.header, current.progress, current.expected);
    const state = structuredClone(current.header.control), now = Date.now();
    state.paused = true;
    // No rollback-created credit, no catch-up credit for time spent restoring.
    for (const key of ['long', 'burst', 'attempts', 'challenges'] as const) state[key] = { tokens: 0, atMs: now, remainder: 0 };
    ctx.storage.transactionSync(() => {
      save(sql, state); sql.exec('DELETE FROM tickets');
      saveSession(sql, { kind: 'restored', id: current.header.id, chain: current.expected });
    });
    await ctx.storage.sync();
    return success({ complete: true, uploads_paused: true });
  }
  return failure(404, 'not_found');
}

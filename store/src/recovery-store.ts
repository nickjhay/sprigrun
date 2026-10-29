import { Buffer } from 'node:buffer';
import { objectKey, verifiedBody } from './bytes.ts';
import type { Config } from './config.ts';
import { parseAddress } from './proof.ts';
import { failure, HttpError, type Env, type Result } from './types.ts';
import { status, atEpoch, readControl, saveControl, readReceipt, insertReceipt, type Receipt, type Totals } from './state.ts';
import { advance, bareOrigin, check, complete, digest, emptyTotals, equalJSON, fields, FORMAT, HASH,
  PAGE_SIZE, progress, validateHeader, validateRecord, type Progress, type SnapshotHeader, type SnapshotRecord } from './recovery-format.ts';

export const SNAPSHOT_TTL_MS = 86400000;
type Maintenance = { kind: 'snapshot'; header: SnapshotHeader }
  | { kind: 'snapshot_done'; header: SnapshotHeader; chain: string }
  | { kind: 'restore'; header: SnapshotHeader; expected: string; progress: Progress; lastRecord?: string }
  | { kind: 'restored'; id: string; chain: string };
function session(sql: SqlStorage): Maintenance | undefined {
  const row = sql.exec<{ value: string }>('SELECT value FROM maintenance WHERE id=1').toArray()[0];
  return row && JSON.parse(row.value) as Maintenance;
}
export const recoveryLocked = (sql: SqlStorage): boolean => session(sql)?.kind === 'restore';
export function snapshotPins(sql: SqlStorage, receipt: Receipt): boolean {
  const current = session(sql);
  if (current?.kind !== 'snapshot' || current.header.expires_at_ms <= Date.now()) return false;
  const old = atEpoch(receipt, current.header.epoch);
  return old !== null && status(old) === 'stored';
}
const saveSession = (sql: SqlStorage, value: Maintenance) => { sql.exec('INSERT OR REPLACE INTO maintenance(id,value) VALUES(1,?)', JSON.stringify(value)); };
export function clearRestored(sql: SqlStorage): void { if (session(sql)?.kind === 'restored') sql.exec('DELETE FROM maintenance'); }
export type RecoveryValue = SnapshotHeader | SnapshotRecord | { addresses: string[] } | { released: true }
  | { complete: boolean; after?: string; uploads_paused?: boolean } | { after: string };
const success = (value: RecoveryValue): Result<RecoveryValue> => ({ ok: true, value });
function active(sql: SqlStorage, id: unknown): SnapshotHeader {
  const s = session(sql);
  check(s?.kind === 'snapshot' && s.header.id === id, 'snapshot_not_active');
  check(Date.now() < s.header.expires_at_ms, 'snapshot_expired');
  return s.header;
}
export async function recovery(ctx: DurableObjectState, env: Env, policy: Config, action: string, input: Uint8Array, origin: string): Promise<Result<RecoveryValue>> {
  let data: Record<string, unknown>, line: string;
  try { line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); data = JSON.parse(line || '{}'); }
  catch { throw new HttpError(400, 'invalid_recovery_json'); }
  check(data !== null && typeof data === 'object' && !Array.isArray(data));
  const sql = ctx.storage.sql, current = session(sql);

  if (action === 'snapshot/begin') {
    fields(data, []);
    if (env.RESTORE_MODE !== undefined || current?.kind === 'restore') return failure(409, 'restore_in_progress');
    if (current?.kind === 'snapshot' && current.header.expires_at_ms > Date.now()) return success(current.header);
    const state = readControl(sql), now = Date.now();
    const totals = Object.fromEntries(Object.keys(emptyTotals()).map(key => [key, state[key as keyof Totals]])) as unknown as Totals;
    const header: SnapshotHeader = { type: 'header', format: FORMAT,
      id: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), source_origin: bareOrigin(origin),
      captured_at_ms: now, expires_at_ms: now + SNAPSHOT_TTL_MS, epoch: state.epoch,
      receipts: state.receipts, totals, proof_of_work: {
        bits: state.proofOfWorkBits ?? policy.proofOfWorkBits, per_byte: state.proofOfWorkPerByte ?? policy.proofOfWorkPerByte } };
    validateHeader(header);
    ctx.storage.transactionSync(() => {
      state.epoch++; saveControl(sql, state); saveSession(sql, { kind: 'snapshot', header });
    });
    await ctx.storage.sync();
    return success(header);
  }
  if (action.startsWith('snapshot/')) {
    if (action === 'snapshot/finish' && current?.kind === 'snapshot_done') {
      fields(data, ['id', 'count', 'chain']);
      check(data.id === current.header.id && data.count === current.header.receipts && data.chain === current.chain);
      return success({ complete: true });
    }
    if (action === 'snapshot/end') {
      fields(data, ['id']);
      check((current?.kind === 'snapshot' || current?.kind === 'snapshot_done') && current.header.id === data.id, 'snapshot_not_active');
      sql.exec('DELETE FROM maintenance'); await ctx.storage.sync();
      return success({ released: true });
    }
    const header = active(sql, data.id);
    if (action === 'snapshot/finish') {
      fields(data, ['id', 'count', 'chain']);
      check(data.count === header.receipts && typeof data.chain === 'string' && HASH.test(data.chain));
      // Authenticated exporter attests that records are verified and durable.
      // Persist its completion outcome before releasing the pin/returning the ACK.
      saveSession(sql, { kind: 'snapshot_done', header, chain: data.chain });
      await ctx.storage.sync(); return success({ complete: true });
    }
    if (action === 'snapshot/page') {
      fields(data, ['id', 'after']);
      check(typeof data.after === 'string' && (data.after === '' || parseAddress(data.after)));
      return success({ addresses: sql.exec<{ address: string }>(
        `SELECT address FROM receipts WHERE address > ? AND (reserved_epoch <= ? OR blocked_epoch <= ?)
         ORDER BY address LIMIT ?`, data.after, header.epoch, header.epoch, PAGE_SIZE).toArray().map(r => r.address) });
    }
    if (action === 'snapshot/object') {
      fields(data, ['id', 'address']); check(typeof data.address === 'string');
      const address = parseAddress(data.address); check(address);
      const latest = readReceipt(sql, data.address), receipt = latest && atEpoch(latest, header.epoch);
      if (!receipt) return failure(404, 'receipt_not_found');
      const record: SnapshotRecord = { type: 'record', receipt, object: null };
      if (status(receipt) === 'stored') {
        const object = await env.BLOBS.get(objectKey(data.address));
        if (!object) return failure(503, 'snapshot_object_missing');
        const bytes = await verifiedBody(object, address.digest, address.bytes);
        record.object = { body: Buffer.from(bytes).toString('base64'), validation_policy: object.customMetadata!.validation_policy! };
      }
      // A lease may expire, be aborted or be replaced during the R2 await.
      active(sql, header.id); validateRecord(record); return success(record);
    }
    return failure(404, 'not_found');
  }
  if (!action.startsWith('restore/') || env.RESTORE_MODE !== '1') return failure(404, 'not_found');
  if (action === 'restore/begin') {
    fields(data, ['header', 'chain']);
    const header = validateHeader(data.header);
    check(typeof data.chain === 'string' && HASH.test(data.chain));
    if (current?.kind === 'restored' && current.id === header.id && current.chain === data.chain) return success({ complete: true });
    if (current?.kind === 'restore') {
      check(current.expected === data.chain && equalJSON(current.header, header), 'different_restore_active');
      return success({ complete: false, after: current.progress.after });
    }
    const state = readControl(sql);
    check(!current && state.receipts === 0 && sql.exec('SELECT address FROM receipts LIMIT 1').toArray().length === 0
      && sql.exec('SELECT id FROM tickets LIMIT 1').toArray().length === 0, 'restore_requires_empty_target');
    for (const key of Object.keys(emptyTotals()) as (keyof Totals)[]) check(state[key] === 0, 'restore_requires_empty_target');
    check((await env.BLOBS.list({ limit: 1 })).objects.length === 0, 'restore_requires_empty_bucket');
    state.paused = true;
    ctx.storage.transactionSync(() => {
      saveControl(sql, state); saveSession(sql, { kind: 'restore', header, expected: data.chain as string, progress: progress(header) });
    });
    await ctx.storage.sync(); return success({ complete: false, after: '' });
  }
  if (action === 'restore/finish' && current?.kind === 'restored') {
    fields(data, ['id', 'chain']); check(data.id === current.id && data.chain === current.chain);
    return success({ complete: true, uploads_paused: true });
  }
  check(current?.kind === 'restore', 'restore_not_active');
  if (action === 'restore/record') {
    const { record, bytes } = validateRecord(data), receipt = record.receipt;
    const recordHash = digest(line);
    if (receipt.address === current.progress.after && recordHash === current.lastRecord) return success({ after: receipt.address });
    check(current.progress.count < current.header.receipts, 'too_many_restore_records');
    const next = advance(current.progress, receipt, line);
    check(!readReceipt(sql, receipt.address), 'restore_receipt_conflict');
    if (record.object) {
      const parsed = parseAddress(receipt.address)!;
      const custom = { kind: 'blob', sha256: parsed.digest, validation_policy: record.object.validation_policy };
      const written = await env.BLOBS.put(objectKey(receipt.address), bytes!, {
        onlyIf: new Headers({ 'If-None-Match': '*' }), customMetadata: custom, sha256: parsed.digest,
      });
      if (!written) {
        const existing = await env.BLOBS.get(objectKey(receipt.address)); check(existing, 'restore_object_missing');
        try {
          check(equalJSON(existing.customMetadata ?? {}, custom), 'restore_metadata_conflict');
          await verifiedBody(existing, parsed.digest, receipt.bytes);
        } finally { if (!existing.bodyUsed) void existing.body.cancel().catch(() => {}); }
      }
    }
    ctx.storage.transactionSync(() => {
      insertReceipt(sql, receipt); saveSession(sql, { ...current, progress: next, lastRecord: recordHash });
    });
    await ctx.storage.sync(); return success({ after: receipt.address });
  }
  if (action === 'restore/finish') {
    fields(data, ['id', 'chain']); check(data.id === current.header.id && data.chain === current.expected);
    complete(current.header, current.progress, current.expected);
    const state = readControl(sql), now = Date.now();
    Object.assign(state, current.header.totals, { epoch: current.header.epoch + 1, receipts: current.header.receipts,
      paused: true, proofOfWorkBits: current.header.proof_of_work.bits, proofOfWorkPerByte: current.header.proof_of_work.per_byte });
    for (const key of ['long', 'burst', 'attempts', 'challenges'] as const) state[key] = { tokens: 0, atMs: now, remainder: 0 };
    ctx.storage.transactionSync(() => {
      saveControl(sql, state); sql.exec('DELETE FROM tickets'); saveSession(sql, { kind: 'restored', id: current.header.id, chain: current.expected });
    });
    await ctx.storage.sync(); return success({ complete: true, uploads_paused: true });
  }
  return failure(404, 'not_found');
}

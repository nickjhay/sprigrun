import { partition, shardFor, barrierState, barrierTransition, dividedPolicy, same, type BarrierState } from './topology.ts';
import { canonical, fields } from './shape.ts';
export { canonical, fields } from './shape.ts';
// Portable logical archive contract. No SQL, R2 or HTTP implementation here.
import { check, contentAddress, LIMITS, matches, nextU64, orderedU64, parseAddress,
  textBytes, u64 } from '../src/bytes.ts';
import { canonicalOrigin, parsePostTarget, parseReference } from '../src/references.ts';
import { parsePlotBinding } from '../src/authority.ts';
import { parseAction } from '../src/action.ts';
import { parseReceipt } from '../src/receipt.ts';
import { collection } from './placement.ts';
import { validateChange, type PolicyChange } from './moderation.ts';
import { policy, type Policy } from './policy.ts';
import type { Control, Result, Source } from './state.ts';

export const FORMAT = 'sprig-native-snapshot/6';
export const MAX_LINE = 2 * 1024 * 1024;
export const PAGE_SIZE = 32;
export const TABLES = ['sources', 'results', 'moderation', 'cuts'] as const;
export type Cut = { epoch: string; control: string; at_ms: string };
export type Base = { chain: string; cut: Cut };
export type Header = { type: 'header'; format: typeof FORMAT; epoch: string; capturedAtMs: string;
  control: Control; policy: Policy; base: Base | null };
export type Record = ({ type: 'sources'; row: Source }
  | { type: 'results'; row: Result; body: string | null }
  | { type: 'moderation'; row: PolicyChange } | { type: 'cuts'; row: Cut }
  | { type: 'pause'; paused: boolean } | { type: 'barrier'; state: BarrierState }) & { position: string };
export type End = { type: 'end'; count: string; chain: string };
export type Progress = { count: string; chain: string; position: string;
  moderation: string; accepted: string; debit: string; reserved: string;
  epoch: string; paused: boolean; barrier: BarrierState | null; atCut: boolean };

function integer(x: unknown, positive = false): asserts x is number {
  check(typeof x === 'number' && Number.isSafeInteger(x) && x >= (positive ? 1 : 0), 'archive_integer');
}
function decimal(x: unknown) { check(matches(/^(0|[1-9][0-9]{0,38})$/, x), 'archive_decimal'); }
function padded(x: unknown): asserts x is string {
  check(matches(/^[0-9]{20}$/, x) && orderedU64(String(BigInt(x))) === x, 'archive_epoch');
}
function smallText(x: unknown, max: number): asserts x is string {
  check(typeof x === 'string' && x.length <= max && textBytes(x).length <= max, 'archive_text');
}
export function parseLine(line: string): unknown {
  smallText(line, MAX_LINE);
  check(!line.includes('\n') && !line.includes('\r'), 'archive_line');
  const value: unknown = JSON.parse(line);
  check(canonical(value) === line, 'archive_noncanonical');
  return value;
}
export async function digest(text: string): Promise<string> {
  const bytes = textBytes(text); check(bytes.length <= MAX_LINE + 65, 'archive_line_limit');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
export function hash(x: unknown): asserts x is string { check(matches(/^[0-9a-f]{64}$/, x), 'archive_hash'); }
export function validatePolicy(value: unknown): Policy {
  fields(value, ['sourceBytes', 'chatBytes', 'minimumDebit', 'growth', 'burst', 'attempts']);
  for (const name of ['growth', 'burst', 'attempts']) fields(value[name], ['capacity', 'refill', 'periodMs']);
  return policy(value as Policy);
}
export function validateControl(value: unknown): Control {
  fields(value, ['schema', 'partition', 'barrier', 'origin', 'journal', 'position', 'epoch', 'paused', 'growth', 'burst', 'attempts', 'moderation', 'accepted', 'reservedBytes', 'acceptedDebit']);
  check(value.schema === 6 && typeof value.paused === 'boolean', 'archive_control');
  partition(value.partition); barrierState(value.barrier);
  check(value.partition !== null || value.barrier === null, 'archive_partition');
  check(matches(/^[0-9a-f]{32}$/, value.journal), 'archive_journal');
  u64(value.position); canonicalOrigin(value.origin); u64(value.epoch); u64(value.accepted); u64(value.moderation);
  decimal(value.reservedBytes); decimal(value.acceptedDebit);
  for (const name of ['growth', 'burst', 'attempts']) {
    fields(value[name], ['tokens', 'atMs', 'remainder']);
    for (const n of Object.values(value[name])) integer(n);
  }
  return value as Control;
}
export function validateHeader(value: unknown): Header {
  check(value !== null && typeof value === 'object' && (value as Header).format === FORMAT, 'archive_version');
  fields(value, ['type', 'format', 'epoch', 'capturedAtMs', 'control', 'policy', 'base']);
  check(value.type === 'header', 'archive_version');
  u64(value.epoch); nextU64(value.epoch); u64(value.capturedAtMs);
  const c = validateControl(value.control), p = validatePolicy(value.policy);
  if (c.partition !== null) check(c.origin === c.partition.topology.origin
    && same(p, dividedPolicy(c.partition.topology, c.partition.shard))
    && c.barrier?.phase === 'held' && c.barrier.epoch === value.epoch, 'archive_partition');
  check(c.epoch === value.epoch && u64(c.position) > 0n, 'archive_cut_mismatch');
  if (value.base !== null) {
    fields(value.base, ['chain', 'cut']); hash(value.base.chain);
    const base = cutHeader(value.base.cut);
    check(base.control.origin === c.origin && base.control.journal === c.journal && same(base.control.partition, c.partition), 'archive_base_journal');
    check(canonical(base.policy) === canonical(p), 'archive_base_policy');
    check(u64(base.epoch) < u64(c.epoch) && u64(base.control.position) < u64(c.position), 'archive_base_order');
  }
  check(textBytes(canonical(value)).length <= 32768, 'archive_header_limit');
  return value as Header;
}
export function cutHeader(row: Cut): Header {
  fields(row, ['epoch', 'control', 'at_ms']);
  padded(row.epoch); smallText(row.control, 16384); u64(row.at_ms);
  const { _policy, ...control } = parseLine(row.control) as any;
  check(_policy !== undefined, 'cut_predates_archive_format');
  return validateHeader({ type: 'header', format: FORMAT, epoch: String(BigInt(row.epoch)),
    capturedAtMs: row.at_ms, control, policy: _policy, base: null });
}
export function cutFromHeader(h: Header): Cut {
  return { epoch: orderedU64(h.epoch), control: canonical({ ...h.control, _policy: h.policy }), at_ms: h.capturedAtMs };
}
export function end(value: unknown): End {
  fields(value, ['type', 'count', 'chain']); check(value.type === 'end', 'archive_footer');
  u64(value.count); hash(value.chain); return value as End;
}
export function recordKey(record: Record): string {
  switch (record.type) {
    case 'pause': return record.paused ? '1' : '0';
    case 'barrier': return canonical(record.state);
    case 'sources': return record.row.address;
    case 'results': return record.row.path;
    case 'moderation': return record.row.position;
    case 'cuts': return record.row.epoch;
  }
}
export async function validateRecord(value: unknown, h: Header): Promise<Record> {
  check(value !== null && typeof value === 'object', 'archive_record');
  const r = value as Record;
  check(r.type === 'pause' || r.type === 'barrier' || TABLES.includes(r.type), 'archive_record');
  fields(r, r.type === 'results' ? ['type', 'position', 'row', 'body'] : r.type === 'pause'
    ? ['type', 'position', 'paused'] : r.type === 'barrier' ? ['type', 'position', 'state'] : ['type', 'position', 'row']);
  padded(r.position);
  check(BigInt(r.position) > 0n && r.position <= orderedU64(h.control.position), 'archive_position');
  if (r.type === 'pause') { check(typeof r.paused === 'boolean', 'archive_pause'); return r; }
  if (r.type === 'barrier') { check(h.control.partition !== null && barrierState(r.state) !== null, 'archive_barrier'); return r; }
  const row = r.row;
  const p = h.control.partition;
  if (p && (r.type === 'sources' || r.type === 'results'))
    check(await shardFor(p.topology, r.type === 'sources' ? '/sea/' + r.row.address : r.row.path) === p.shard, 'archive_wrong_shard');
  if (r.type === 'sources') {
    const s = r.row;
    fields(s, ['address','bytes','debit','reserved_epoch','reserved_at_ms']);
    const address = parseAddress(s.address, LIMITS.sourceBytes);
    integer(s.bytes); integer(s.debit, true); check(s.bytes === address.length && s.debit >= s.bytes, 'archive_source_size');
    padded(s.reserved_epoch); u64(s.reserved_at_ms);
    check(s.reserved_epoch <= orderedU64(h.epoch), 'archive_future_fact');
  } else if (r.type === 'results') {
    const a = r.row;
    if (a.source === null) check(r.body === null, 'archive_inline_body');
    else {
      smallText(r.body, LIMITS.sourceBytes);
      check(await contentAddress(textBytes(r.body)) === a.source, 'archive_source_hash');
    }
    fields(a, ['path','collection','number','kind','value','controller','binding','action','epoch',
      'accepted_at_ms','debit','header','body','source','signature','key_record','author_binding','receipt']);
    const ref = parseReference(a.path);
    parseAddress(a.action); integer(a.debit, true); u64(a.accepted_at_ms);
    if (ref.kind === 'sea') {
      check(a.kind === 'sea' && a.source === ref.address && a.body === null
        && a.collection === null && a.number === null && a.value === null
        && a.controller === null && a.binding === null, 'archive_source_action');
    } else {
      const t = parsePostTarget(a.path);
      check(t.kind !== 'sea' && t.anchor !== null && ref.kind !== 'step' && ref.kind !== 'chat', 'archive_entry');
      check(a.kind === t.kind && a.collection === collection(t) && a.number === orderedU64(t.anchor), 'archive_placement');
      check(a.source === null, 'archive_inline_action');
      smallText(a.body, LIMITS.sourceBytes);
      if (a.kind === 'plot') {
        check(a.value === null && a.controller !== null && a.binding !== null, 'archive_plot');
        check(parseReference(a.controller).kind === 'sea', 'archive_plot');
        smallText(a.binding, LIMITS.recordBytes);
        const b = parsePlotBinding(textBytes(a.binding), h.control.origin);
        check(b.plot === a.path && b.key === a.controller, 'archive_plot');
      } else {
        check(a.controller === null && a.binding === null, 'archive_entry');
        if (a.kind === 'chat') check(a.value === null, 'archive_message');
        else check(a.value !== null && parseReference(a.value).kind === 'sea', 'archive_publication');
      }
    }
    smallText(a.header, 2048); check(parseAction(textBytes(a.header), h.control.origin).body.length === 0, 'archive_header');
    smallText(a.receipt, LIMITS.recordBytes); parseReceipt(textBytes(a.receipt), h.control.origin);
    for (const v of [a.key_record, a.author_binding]) if (v !== null) smallText(v, LIMITS.recordBytes);
    if (a.signature !== null) smallText(a.signature, 86);
  } else if (r.type === 'moderation') {
    validateChange(r.row);
    check(r.row.position <= orderedU64(h.control.moderation), 'archive_future_policy');
  } else {
    const old = cutHeader(r.row);
    check(old.control.origin === h.control.origin && old.control.journal === h.control.journal && same(old.control.partition, h.control.partition), 'archive_origin');
    check(canonical(old.policy) === canonical(h.policy), 'archive_policy');
    check(old.control.position === String(BigInt(r.position)), 'archive_cut_position');
    if (r.position === orderedU64(h.control.position))
      check(canonical(old) === canonical({ ...h, base: null }), 'archive_cut_mismatch');
  }
  if (r.type !== 'sources') {
    padded(row.epoch); check(row.epoch <= orderedU64(h.epoch), 'archive_future_fact');
  }
  return r;
}
export async function initial(h: Header): Promise<Progress> {
  const c = h.base === null ? null : cutHeader(h.base.cut).control;
  return { count: '0', chain: await digest(canonical(h)), position: c?.position ?? '0',
    moderation: c?.moderation ?? '0', accepted: c?.accepted ?? '0', debit: c?.acceptedDebit ?? '0',
    reserved: c?.reservedBytes ?? '0', epoch: c === null ? '0' : nextU64(c.epoch),
    paused: c?.paused ?? false, barrier: c?.barrier ?? null, atCut: false };
}
function accounting(p: Progress, c: Control) {
  check(p.position === c.position && p.moderation === c.moderation && p.accepted === c.accepted
    && p.debit === c.acceptedDebit && p.reserved === c.reservedBytes && p.paused === c.paused && same(p.barrier, c.barrier), 'archive_accounting');
}
export async function advance(p: Progress, r: Record, line: string): Promise<Progress> {
  check(r.position === orderedU64(nextU64(p.position)), 'archive_position_gap');
  const q = { ...p, count: nextU64(p.count), position: String(BigInt(r.position)),
    chain: await digest(p.chain + '\n' + line), atCut: false };
  if (r.type === 'barrier') { barrierTransition(p.barrier, r.state, p.epoch); q.barrier = r.state; return q; }
  check(p.barrier?.phase !== 'held' || r.type === 'cuts', 'archive_held_mutation');
  if (r.type === 'pause') { q.paused = r.paused; return q; }
  const epoch = r.type === 'sources' ? r.row.reserved_epoch : r.row.epoch;
  check(r.type === 'moderation' ? epoch <= orderedU64(p.epoch) : epoch === orderedU64(p.epoch), 'archive_fact_epoch');
  if (r.type === 'sources') q.reserved = String(BigInt(q.reserved) + BigInt(r.row.debit));
  if (r.type === 'results') {
    q.accepted = nextU64(q.accepted); q.debit = String(BigInt(q.debit) + BigInt(r.row.debit));
  }
  if (r.type === 'moderation') {
    check(r.row.position === orderedU64(nextU64(q.moderation)), 'archive_policy_gap');
    q.moderation = nextU64(q.moderation);
  }
  if (r.type === 'cuts') {
    const c = cutHeader(r.row).control; accounting(q, c);
    check(c.epoch === q.epoch, 'archive_cut_gap'); q.epoch = nextU64(q.epoch); q.atCut = true;
  }
  return q;
}
export function complete(h: Header, p: Progress, footer: End) {
  check(p.count === footer.count && p.chain === footer.chain, 'archive_incomplete');
  accounting(p, h.control);
  check(p.atCut && p.epoch === nextU64(h.epoch), 'archive_final_cut');
}

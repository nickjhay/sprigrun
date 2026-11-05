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

export const FORMAT = 'sprig-native-snapshot/7';
export const MAX_LINE = 2 * 1024 * 1024;
export const PAGE_SIZE = 32;
export const TABLES = ['sources', 'results', 'moderation'] as const;
export type Checkpoint = { capturedAtMs: string; control: Control; policy: Policy };
export type Base = { chain: string; checkpoint: Checkpoint };
export type Header = Checkpoint & { type: 'header'; format: typeof FORMAT; base: Base | null };
export type Record = ({ type: 'sources'; row: Source }
  | { type: 'results'; row: Result; body: string | null }
  | { type: 'moderation'; row: PolicyChange }
  | { type: 'pause'; paused: boolean }) & { position: string };
export type End = { type: 'end'; count: string; chain: string };
export type Progress = { count: string; chain: string; position: string;
  moderation: string; accepted: string; debit: string; reserved: string; paused: boolean };

function integer(x: unknown, positive = false): asserts x is number {
  check(typeof x === 'number' && Number.isSafeInteger(x) && x >= (positive ? 1 : 0), 'archive_integer');
}
function decimal(x: unknown) { check(matches(/^(0|[1-9][0-9]{0,38})$/, x), 'archive_decimal'); }
function padded(x: unknown): asserts x is string {
  check(matches(/^[0-9]{20}$/, x) && orderedU64(String(BigInt(x))) === x, 'archive_position');
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
  fields(value, ['schema', 'origin', 'journal', 'position', 'paused', 'growth', 'burst', 'attempts', 'moderation', 'accepted', 'reservedBytes', 'acceptedDebit']);
  check(value.schema === 7 && typeof value.paused === 'boolean', 'archive_control');
  check(matches(/^[0-9a-f]{32}$/, value.journal), 'archive_journal');
  u64(value.position); canonicalOrigin(value.origin); u64(value.accepted); u64(value.moderation);
  decimal(value.reservedBytes); decimal(value.acceptedDebit);
  for (const name of ['growth', 'burst', 'attempts']) {
    fields(value[name], ['tokens', 'atMs', 'remainder']);
    for (const n of Object.values(value[name])) integer(n);
  }
  return value as Control;
}
function checkpoint(value: unknown): Checkpoint {
  fields(value, ['capturedAtMs', 'control', 'policy']);
  u64(value.capturedAtMs); validateControl(value.control); validatePolicy(value.policy);
  return value as Checkpoint;
}
export function checkpointFromHeader(h: Header): Checkpoint {
  return { capturedAtMs: h.capturedAtMs, control: h.control, policy: h.policy };
}
export function validateHeader(value: unknown): Header {
  check(value !== null && typeof value === 'object' && (value as Header).format === FORMAT, 'archive_version');
  fields(value, ['type', 'format', 'capturedAtMs', 'control', 'policy', 'base']);
  check(value.type === 'header', 'archive_version');
  const h = value as Header, current = checkpoint(checkpointFromHeader(h)), c = current.control;
  if (h.base !== null) {
    fields(h.base, ['chain', 'checkpoint']); hash(h.base.chain);
    const base = checkpoint(h.base.checkpoint);
    check(base.control.origin === c.origin && base.control.journal === c.journal, 'archive_base_journal');
    check(canonical(base.policy) === canonical(h.policy), 'archive_base_policy');
    check(u64(base.control.position) <= u64(c.position), 'archive_base_order');
  }
  check(textBytes(canonical(h)).length <= 32768, 'archive_header_limit');
  return h;
}
export function end(value: unknown): End {
  fields(value, ['type', 'count', 'chain']); check(value.type === 'end', 'archive_footer');
  u64(value.count); hash(value.chain); return value as End;
}
export function recordKey(record: Record): string {
  switch (record.type) {
    case 'pause': return record.paused ? '1' : '0';
    case 'sources': return record.row.address;
    case 'results': return record.row.path;
    case 'moderation': return record.row.position;
  }
}
export async function validateRecord(value: unknown, h: { control: { origin: string; position: string } }): Promise<Record> {
  check(value !== null && typeof value === 'object', 'archive_record');
  const r = value as Record;
  check(r.type === 'pause' || TABLES.includes(r.type), 'archive_record');
  fields(r, r.type === 'results' ? ['type', 'position', 'row', 'body'] : r.type === 'pause'
    ? ['type', 'position', 'paused'] : ['type', 'position', 'row']);
  padded(r.position);
  check(BigInt(r.position) > 0n && r.position <= orderedU64(h.control.position), 'archive_position');
  if (r.type === 'pause') { check(typeof r.paused === 'boolean', 'archive_pause'); return r; }
  if (r.type === 'sources') {
    const s = r.row;
    fields(s, ['address','bytes','debit','reserved_at_ms']);
    const address = parseAddress(s.address, LIMITS.sourceBytes);
    integer(s.bytes); integer(s.debit, true); check(s.bytes === address.length && s.debit >= s.bytes, 'archive_source_size');
    u64(s.reserved_at_ms);
  } else if (r.type === 'results') {
    const a = r.row;
    if (a.source === null) check(r.body === null, 'archive_inline_body');
    else {
      smallText(r.body, LIMITS.sourceBytes);
      check(await contentAddress(textBytes(r.body)) === a.source, 'archive_source_hash');
    }
    fields(a, ['path','collection','number','kind','value','controller','binding','action',
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
  }
  return r;
}
export async function initial(h: Header): Promise<Progress> {
  const c = h.base?.checkpoint.control;
  return { count: '0', chain: await digest(canonical(h)), position: c?.position ?? '0',
    moderation: c?.moderation ?? '0', accepted: c?.accepted ?? '0', debit: c?.acceptedDebit ?? '0',
    reserved: c?.reservedBytes ?? '0', paused: c?.paused ?? false };
}
function accounting(p: Progress, c: Control) {
  check(p.position === c.position && p.moderation === c.moderation && p.accepted === c.accepted
    && p.debit === c.acceptedDebit && p.reserved === c.reservedBytes && p.paused === c.paused, 'archive_accounting');
}
export async function advance(p: Progress, r: Record, line: string): Promise<Progress> {
  check(r.position === orderedU64(nextU64(p.position)), 'archive_position_gap');
  const q = { ...p, count: nextU64(p.count), position: String(BigInt(r.position)),
    chain: await digest(p.chain + '\n' + line) };
  if (r.type === 'pause') { q.paused = r.paused; return q; }
  if (r.type === 'sources') q.reserved = String(BigInt(q.reserved) + BigInt(r.row.debit));
  if (r.type === 'results') {
    q.accepted = nextU64(q.accepted); q.debit = String(BigInt(q.debit) + BigInt(r.row.debit));
  }
  if (r.type === 'moderation') {
    check(r.row.position === orderedU64(nextU64(q.moderation)), 'archive_policy_gap');
    q.moderation = nextU64(q.moderation);
  }
  return q;
}
export function complete(h: Header, p: Progress, footer: End) {
  check(p.count === footer.count && p.chain === footer.chain, 'archive_incomplete');
  accounting(p, h.control);
}

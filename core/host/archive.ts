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

export const FORMAT = 'sprig-native-snapshot/3';
export const MAX_LINE = 2 * 1024 * 1024;
export const PAGE_SIZE = 32;
export const TABLES = ['sources', 'results', 'moderation', 'cuts'] as const;
export type Table = typeof TABLES[number];
export type Cut = { epoch: string; control: string; at_ms: string };
export type Header = { type: 'header'; format: typeof FORMAT; epoch: string; capturedAtMs: string;
  control: Control; policy: Policy };
export type Record = { type: 'sources'; row: Source; body: string | null }
  | { type: 'results'; row: Result }
  | { type: 'moderation'; row: PolicyChange } | { type: 'cuts'; row: Cut };
export type End = { type: 'end'; count: string; chain: string };
export type Progress = { count: string; chain: string; order: string;
  moderation: string; accepted: string; debit: string; reserved: string; bodies: string; published: string; cuts: string };

export function fields(value: unknown, names: readonly string[]): asserts value is { [key: string]: any } {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'archive_fields');
  const keys = Object.keys(value);
  check(keys.length === names.length && names.every(k => Object.hasOwn(value, k)), 'archive_fields');
}
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
export function canonical(value: unknown): string {
  function sorted(v: any): any {
    if (v !== null && typeof v === 'object') {
      check(!Array.isArray(v), 'archive_array');
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])]));
    }
    return v;
  }
  return JSON.stringify(sorted(value));
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
  fields(value, ['schema', 'origin', 'epoch', 'paused', 'growth', 'burst', 'attempts', 'moderation', 'accepted', 'reservedBytes', 'acceptedDebit']);
  check(value.schema === 3 && typeof value.paused === 'boolean', 'archive_control');
  canonicalOrigin(value.origin); u64(value.epoch); u64(value.accepted); u64(value.moderation);
  decimal(value.reservedBytes); decimal(value.acceptedDebit);
  for (const name of ['growth', 'burst', 'attempts']) {
    fields(value[name], ['tokens', 'atMs', 'remainder']);
    for (const n of Object.values(value[name])) integer(n);
  }
  return value as Control;
}
export function validateHeader(value: unknown): Header {
  fields(value, ['type', 'format', 'epoch', 'capturedAtMs', 'control', 'policy']);
  check(value.type === 'header' && value.format === FORMAT, 'archive_version');
  u64(value.epoch); nextU64(value.epoch); u64(value.capturedAtMs);
  const c = validateControl(value.control); validatePolicy(value.policy);
  check(c.epoch === value.epoch, 'archive_cut_mismatch');
  check(textBytes(canonical(value)).length <= 16384, 'archive_header_limit');
  return value as Header;
}
export function cutHeader(row: Cut): Header {
  padded(row.epoch); smallText(row.control, 16384); u64(row.at_ms);
  const { _policy, ...control } = JSON.parse(row.control);
  check(_policy !== undefined, 'cut_predates_archive_format');
  return validateHeader({ type: 'header', format: FORMAT, epoch: String(BigInt(row.epoch)),
    capturedAtMs: row.at_ms, control, policy: _policy });
}
export function end(value: unknown): End {
  fields(value, ['type', 'count', 'chain']); check(value.type === 'end', 'archive_footer');
  u64(value.count); hash(value.chain); return value as End;
}
export function recordKey(record: Record): string {
  switch (record.type) {
    case 'sources': return record.row.address;
    case 'results': return record.row.path;
    case 'moderation': return record.row.position;
    case 'cuts': return record.row.epoch;
  }
}
export async function validateRecord(value: unknown, h: Header): Promise<Record> {
  check(value !== null && typeof value === 'object', 'archive_record');
  const r = value as Record;
  check(TABLES.includes(r.type), 'archive_record');
  fields(r, r.type === 'sources' ? ['type', 'row', 'body'] : ['type', 'row']);
  const row = r.row;
  if (r.type === 'sources') {
    const s = r.row;
    fields(s, ['address','bytes','debit','reserved_epoch','reserved_at_ms']);
    const address = parseAddress(s.address, LIMITS.sourceBytes);
    integer(s.bytes); integer(s.debit, true); check(s.bytes === address.length && s.debit >= s.bytes, 'archive_source_size');
    padded(s.reserved_epoch); u64(s.reserved_at_ms);
    check(s.reserved_epoch <= orderedU64(h.epoch), 'archive_future_fact');
    if (r.body !== null) {
      smallText(r.body, LIMITS.sourceBytes);
      check(await contentAddress(textBytes(r.body)) === s.address, 'archive_source_hash');
    }
  } else if (r.type === 'results') {
    const a = r.row;
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
    fields(r.row, ['epoch','control','at_ms']);
    smallText(r.row.control, 16384); u64(r.row.at_ms);
    const { _policy, ...control } = JSON.parse(r.row.control);
    const old = validateControl(control);
    if (_policy !== undefined) validatePolicy(_policy);
    check(old.origin === h.control.origin && orderedU64(old.epoch) === r.row.epoch, 'archive_origin');
  }
  if (r.type !== 'sources') {
    padded(row.epoch); check(row.epoch <= orderedU64(h.epoch), 'archive_future_fact');
  }
  return r;
}
export async function initial(h: Header): Promise<Progress> {
  return { count: '0', chain: await digest(canonical(h)), order: '', moderation: '0', accepted: '0', debit: '0',
    reserved: '0', bodies: '0', published: '0', cuts: '0' };
}
export async function advance(p: Progress, r: Record, line: string): Promise<Progress> {
  const order = TABLES.indexOf(r.type) + ':' + recordKey(r);
  check(order > p.order, 'archive_order');
  const q = { ...p, count: nextU64(p.count), order, chain: await digest(p.chain + '\n' + line) };
  if (r.type === 'sources') {
    q.reserved = String(BigInt(q.reserved) + BigInt(r.row.debit));
    if (r.body !== null) q.bodies = nextU64(q.bodies);
  }
  if (r.type === 'results') {
    q.accepted = nextU64(q.accepted); q.debit = String(BigInt(q.debit) + BigInt(r.row.debit));
    if (r.row.kind === 'sea') q.published = nextU64(q.published);
  }
  if (r.type === 'moderation') {
    check(r.row.position === orderedU64(nextU64(q.moderation)), 'archive_policy_gap');
    q.moderation = nextU64(q.moderation);
  }
  if (r.type === 'cuts') { check(r.row.epoch === orderedU64(q.cuts), 'archive_cut_gap'); q.cuts = nextU64(q.cuts); }
  return q;
}
export function complete(h: Header, p: Progress, footer: End) {
  check(p.count === footer.count && p.chain === footer.chain, 'archive_incomplete');
  check(p.moderation === h.control.moderation && p.accepted === h.control.accepted && p.debit === h.control.acceptedDebit
    && p.bodies === p.published && p.reserved === h.control.reservedBytes && p.cuts === nextU64(h.epoch), 'archive_accounting');
}

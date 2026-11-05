import { check, textBytes } from '../src/bytes.ts';
import { parseAction, type Action } from '../src/action.ts';
import { parseReceipt } from '../src/receipt.ts';
import { formatReference, parseReference } from '../src/references.ts';
import { at, collection } from './placement.ts';
import type { Result } from './state.ts';

/** No bodies, signatures or caller-provided authority. Only accepted immutable fields. */
export type Fact = Pick<Result, 'path' | 'kind' | 'value' | 'controller' | 'binding'>;
export function fact(r: Fact): Fact {
  return { path: r.path, kind: r.kind, value: r.value, controller: r.controller, binding: r.binding };
}
/** Describe dependencies once; callers separately enforce visibility or historical validity. */
export function requiredReferences(action: Action, key: string | null, value: string | null) {
  const t = action.target;
  const plot = t.kind === 'publication' ? formatReference(t.plot) : null;
  const subject = t.kind === 'chat' ? formatReference(t.subject) : null;
  const present = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null);
  return { retained: present([action.author, key]), readable: present([value, plot, subject]), plot,
    anchor: t.kind !== 'sea' && t.anchor !== null ? at(collection(t), t.kind, t.anchor) : null };
}
export function readableLinks(r: Fact): string[] {
  const ref = parseReference(r.path), links: string[] = [];
  if (ref.kind === 'publication') links.push(formatReference(ref.plot));
  if (ref.kind === 'message') links.push(formatReference(ref.subject));
  if (r.value !== null) links.push(r.value);
  return links;
}
/** Historical dependency checks use the same references as live admission. */
export async function checkResultLinks(a: Result, origin: string, existing: (path: string) => Promise<Fact>) {
  const action = parseAction(textBytes(a.header), origin);
  const key = parseReceipt(textBytes(a.receipt), origin).key;
  const refs = requiredReferences(action, key, a.value);
  const facts = new Map<string, Fact>();
  for (const path of new Set([...refs.retained, ...refs.readable, ...(refs.anchor ? [refs.anchor] : [])])) facts.set(path, await existing(path));
  if (action.author !== null) {
    check(key !== null, 'archive_authority');
    const author = facts.get(action.author)!;
    if (author.kind !== 'sea') check(author.controller === key && author.binding === a.author_binding, 'archive_plot_authority');
  }
  if (refs.plot) check(key !== null && facts.get(refs.plot)!.controller === key, 'archive_plot_authority');
}

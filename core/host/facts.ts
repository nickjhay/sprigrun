import { check, textBytes } from '../src/bytes.ts';
import { parseAction } from '../src/action.ts';
import { parseReceipt } from '../src/receipt.ts';
import { formatReference, parseReference } from '../src/references.ts';
import { at, collection } from './placement.ts';
import type { Result } from './state.ts';

/** No bodies, signatures or caller-provided authority. Only accepted immutable fields. */
export type Fact = Pick<Result, 'path' | 'kind' | 'value' | 'controller' | 'binding' | 'epoch'>;
export function fact(r: Result): Fact {
  return { path: r.path, kind: r.kind, value: r.value, controller: r.controller, binding: r.binding, epoch: r.epoch };
}
export function readableLinks(r: Fact): string[] {
  const ref = parseReference(r.path), links: string[] = [];
  if (ref.kind === 'publication') links.push(formatReference(ref.plot));
  if (ref.kind === 'message') links.push(formatReference(ref.subject));
  if (r.value !== null) links.push(r.value);
  return links;
}
/** Both single-shard import and final cluster validation use these exact checks. */
export async function checkResultLinks(a: Result, origin: string, existing: (path: string) => Promise<Fact>) {
  const action = parseAction(textBytes(a.header), origin), t = action.target;
  const key = parseReceipt(textBytes(a.receipt), origin).key;
  if (action.author !== null) {
    check(key !== null, 'archive_authority'); await existing(key);
    const author = await existing(action.author);
    if (author.kind !== 'sea') check(author.controller === key && author.binding === a.author_binding, 'archive_plot_authority');
  }
  if (a.value !== null) await existing(a.value);
  if (t.kind === 'publication') check(key !== null && (await existing(formatReference(t.plot))).controller === key, 'archive_plot_authority');
  if (t.kind === 'chat') await existing(formatReference(t.subject));
  if (t.kind !== 'sea' && t.anchor !== null) await existing(at(collection(t), t.kind, t.anchor));
}

import { check, LIMITS, utf8 } from '../src/bytes.ts';
import { formatReference, parseReference, type PostTarget } from '../src/references.ts';
import type { Action } from '../src/action.ts';

export function collection(target: Exclude<PostTarget, { kind: 'sea' }>): string {
  switch (target.kind) {
    case 'grove': return '/grove/' + target.topic.join('/');
    case 'plot': return '/plot/' + target.handle;
    case 'publication': return formatReference(target.plot) + '/' + target.topic.join('/');
    case 'chat': return '/chat' + formatReference(target.subject);
  }
}
export function at(c: string, kind: string, n: string) { return c + (kind === 'chat' ? '/' : '.') + n; }
/** The same payload contract is used for live admission and archive checking. */
export function bodyValue(action: Action): string | null {
  const target = action.target;
  if (target.kind === 'plot') check(action.body.length === 0, 'plot_body_must_be_empty');
  if (target.kind !== 'grove' && target.kind !== 'publication') return null;
  check(action.body.length <= LIMITS.path + 1, 'invalid_publication_body');
  const text = utf8(action.body), value = text.slice(0, -1);
  check(text === value + '\n' && parseReference(value).kind === 'sea', 'invalid_publication_body');
  return value;
}

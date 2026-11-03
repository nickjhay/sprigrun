import { check, LIMITS, matches, parseAddress, u64 } from './bytes.ts';

export type Plot = { kind: 'plot'; handle: string; number: string };
export type Publication =
  | { kind: 'grove'; topic: string[]; number: string }
  | { kind: 'publication'; plot: Plot; topic: string[]; number: string };
export type Subject = Plot | Publication | { kind: 'sea'; address: string }
  | { kind: 'step'; publication: Publication; number: string };
export type Reference = Subject | { kind: 'chat'; subject: Subject }
  | { kind: 'message'; subject: Subject; number: string };

export function word(value: string): string {
  check(value.length <= LIMITS.word && matches(/^[a-z_][a-z0-9_]*$/, value), 'invalid_word');
  return value;
}
function topic(words: string[]): string {
  check(words.length > 0 && words.length <= LIMITS.topicWords, 'invalid_topic');
  return words.map(word).join('/');
}
function number(n: string): string { u64(n); return n; }
function plotPath(p: Plot): string {
  check(p.kind === 'plot', 'invalid_plot');
  return '/plot/' + word(p.handle) + '.' + number(p.number);
}
function publicationPath(p: Publication): string {
  check(p.kind === 'grove' || p.kind === 'publication', 'invalid_publication');
  return (p.kind === 'grove' ? '/grove' : plotPath(p.plot))
    + '/' + topic(p.topic) + '.' + number(p.number);
}
function subjectPath(s: Subject): string {
  switch (s.kind) {
    case 'sea': parseAddress(s.address, LIMITS.sourceBytes); return '/sea/' + s.address;
    case 'plot': return plotPath(s);
    case 'grove': case 'publication': return publicationPath(s);
    case 'step': return publicationPath(s.publication) + '/step/' + number(s.number);
    default: throw new Error('invalid_subject');
  }
}
export function formatReference(ref: Reference): string {
  let path: string;
  if (ref.kind === 'chat' || ref.kind === 'message') {
    path = '/chat' + subjectPath(ref.subject);
    if (ref.kind === 'message') path += '/' + number(ref.number);
  } else path = subjectPath(ref);
  check(path.length <= LIMITS.path, 'path_limit');
  return path;
}

/** A single token grammar determines punctuation in both accepted spellings. */
function decodeTokens(tokens: string[]): Reference {
  let i = 0;
  const take = () => { const t = tokens[i++]; check(t !== undefined, 'incomplete_reference'); return t; };
  const takeNumber = () => number(take());
  const takeTopic = () => {
    const words: string[] = [];
    while (tokens[i] !== undefined && !matches(/^[0-9]+$/, tokens[i])) {
      check(words.length < LIMITS.topicWords, 'invalid_topic');
      words.push(word(take()));
    }
    check(words.length > 0, 'invalid_topic');
    return words;
  };
  const chat = tokens[i] === 'chat';
  if (chat) i++;
  const service = take();
  let subject: Subject;
  if (service === 'sea') {
    const address = take(); parseAddress(address, LIMITS.sourceBytes);
    subject = { kind: 'sea', address };
  } else if (service === 'grove') {
    subject = { kind: 'grove', topic: takeTopic(), number: takeNumber() };
  } else {
    check(service === 'plot', 'invalid_service');
    const plot: Plot = { kind: 'plot', handle: word(take()), number: takeNumber() };
    subject = plot;
    if (tokens[i] !== undefined && !matches(/^[0-9]+$/, tokens[i])) {
      subject = { kind: 'publication', plot, topic: takeTopic(), number: takeNumber() };
    }
  }
  if ((subject.kind === 'grove' || subject.kind === 'publication') && tokens[i] === 'step') {
    i++;
    subject = { kind: 'step', publication: subject, number: takeNumber() };
  }
  let ref: Reference = subject;
  if (chat) {
    ref = i === tokens.length ? { kind: 'chat', subject }
      : { kind: 'message', subject, number: takeNumber() };
  }
  check(i === tokens.length, 'reference_suffix');
  return ref;
}
function pathCharacters(path: string): void {
  check(typeof path === 'string' && path.length <= LIMITS.path
    && matches(/^\/[a-z0-9_./]+$/, path), 'invalid_path');
}
export function parseReference(path: string): Reference {
  pathCharacters(path);
  const ref = decodeTokens(path.slice(1).replaceAll('/', '.').split('.'));
  check(formatReference(ref) === path, 'noncanonical_reference');
  return ref;
}
export function toCompact(path: string): string {
  return formatReference(parseReference(path)).slice(1).replaceAll('/', '.');
}
export function fromCompact(compact: string): string {
  check(typeof compact === 'string' && compact.length < LIMITS.path
    && matches(/^[a-z0-9_.]+$/, compact), 'invalid_compact');
  const path = formatReference(decodeTokens(compact.split('.')));
  check(path.slice(1).replaceAll('/', '.') === compact, 'noncanonical_compact');
  return path;
}
export function parseAuthor(path: string): Plot | { kind: 'sea'; address: string } {
  const ref = parseReference(path);
  check(ref.kind === 'plot' || ref.kind === 'sea', 'invalid_author');
  return ref;
}
export function parseSubject(path: string): Subject {
  const ref = parseReference(path);
  check(ref.kind !== 'chat' && ref.kind !== 'message', 'invalid_subject');
  return ref;
}
export function chatPath(subject: string): string {
  return formatReference({ kind: 'chat', subject: parseSubject(subject) });
}
/** Call before accepting a subject, so its chat's maximal entry still fits. */
export function assertChatFits(subject: string): void {
  formatReference({ kind: 'message', subject: parseSubject(subject), number: '18446744073709551615' });
}

export type PostTarget =
  | { kind: 'sea' }
  | { kind: 'grove'; topic: string[]; anchor: string | null }
  | { kind: 'plot'; handle: string; anchor: string | null }
  | { kind: 'publication'; plot: Plot; topic: string[]; anchor: string | null }
  | { kind: 'chat'; subject: Subject; anchor: string | null };
export function parsePostTarget(path: string): PostTarget {
  pathCharacters(path);
  if (path === '/sea') return { kind: 'sea' };
  if (path.startsWith('/chat/')) {
    const ref = parseReference(path);
    check(ref.kind === 'chat' || ref.kind === 'message', 'invalid_post_target');
    return { kind: 'chat', subject: ref.subject, anchor: ref.kind === 'message' ? ref.number : null };
  }
  const parts = path.slice(1).split('/');
  if (parts[0] === 'grove') {
    if (parts.at(-1)!.includes('.')) {
      const ref = parseReference(path);
      check(ref.kind === 'grove', 'invalid_post_target');
      return { kind: 'grove', topic: ref.topic, anchor: ref.number };
    }
    topic(parts.slice(1)); return { kind: 'grove', topic: parts.slice(1), anchor: null };
  }
  check(parts[0] === 'plot' && parts[1] !== undefined, 'invalid_post_target');
  if (parts.length === 2) {
    if (!parts[1].includes('.')) return { kind: 'plot', handle: word(parts[1]), anchor: null };
    const ref = parseReference(path);
    check(ref.kind === 'plot', 'invalid_post_target');
    return { kind: 'plot', handle: ref.handle, anchor: ref.number };
  }
  if (parts.at(-1)!.includes('.')) {
    const ref = parseReference(path);
    check(ref.kind === 'publication', 'invalid_post_target');
    return { kind: 'publication', plot: ref.plot, topic: ref.topic, anchor: ref.number };
  }
  const plot = parseReference('/plot/' + parts[1]);
  check(plot.kind === 'plot', 'invalid_plot');
  topic(parts.slice(2));
  return { kind: 'publication', plot, topic: parts.slice(2), anchor: null };
}
export function canonicalOrigin(origin: string): string {
  check(typeof origin === 'string' && origin.length <= LIMITS.origin
    && matches(/^https?:\/\/[^\s/?#]+$/, origin), 'invalid_origin');
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error('invalid_origin'); }
  check(url.origin === origin && url.username === '' && url.password === '', 'noncanonical_origin');
  check(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'insecure_origin');
  return origin;
}
export function parseDestination(destination: string, expectedOrigin: string) {
  canonicalOrigin(expectedOrigin);
  check(destination.startsWith(expectedOrigin + '/'), 'wrong_origin');
  const path = destination.slice(expectedOrigin.length);
  return { path, target: parsePostTarget(path) };
}

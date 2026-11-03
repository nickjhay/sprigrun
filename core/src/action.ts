import { check, contentAddress, copyBytes, LIMITS, textBytes, utf8 } from './bytes.ts';
import { parseAuthor, parseDestination, type PostTarget } from './references.ts';

export const ACTION_MARKER = '#!sprig.run/spec/action/1';
export type Action = {
  destination: string; author: string | null; body: Uint8Array<ArrayBuffer>;
  path: string; target: PostTarget;
};
/** Metadata LF LF, then POST URL LF LF, then exact UTF-8 payload. */
export function parseAction(input: Uint8Array, origin: string): Action {
  const bytes = copyBytes(input);
  let end = -1;
  for (let i = 0; i < Math.min(bytes.length - 1, LIMITS.metadataBytes); i++)
    if (bytes[i] === 10 && bytes[i + 1] === 10) { end = i; break; }
  check(end >= 0 && end + 2 <= LIMITS.metadataBytes, 'invalid_metadata');
  const metadata = utf8(bytes.subarray(0, end)).split('\n');
  check(metadata[0] === ACTION_MARKER, 'unsupported_action_version');
  let author: string | null = null;
  check(metadata.length === 1 || metadata.length === 2, 'invalid_metadata');
  if (metadata.length === 2) {
    check(metadata[1]!.startsWith('author: '), 'invalid_metadata');
    author = metadata[1]!.slice(8);
    parseAuthor(author);
  }
  const start = end + 2;
  let lineEnd = -1;
  for (let i = start; i < Math.min(bytes.length, start + LIMITS.requestLineBytes); i++)
    if (bytes[i] === 10) { lineEnd = i; break; }
  check(lineEnd >= 0 && bytes[lineEnd + 1] === 10, 'invalid_request_frame');
  const request = utf8(bytes.subarray(start, lineEnd));
  check(request.startsWith('POST '), 'invalid_method');
  const destination = request.slice(5);
  const { path, target } = parseDestination(destination, origin);
  const body = bytes.slice(lineEnd + 2);
  check(body.length <= LIMITS.sourceBytes, 'body_limit');
  utf8(body);
  return { destination, author, body, path, target };
}
export function actionBytes(input: { destination: string; author?: string | null; body: Uint8Array },
  origin: string): Uint8Array<ArrayBuffer> {
  parseDestination(input.destination, origin);
  if (input.author != null) parseAuthor(input.author);
  const body = copyBytes(input.body, LIMITS.sourceBytes);
  const header = textBytes(ACTION_MARKER + (input.author == null ? '' : '\nauthor: ' + input.author)
    + '\n\nPOST ' + input.destination + '\n\n');
  check(header.length + body.length <= LIMITS.actionBytes, 'bytes_limit');
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header); bytes.set(body, header.length);
  parseAction(bytes, origin);
  return bytes;
}
export async function actionId(input: Uint8Array, origin: string): Promise<string> {
  const bytes = copyBytes(input);
  parseAction(bytes, origin);
  return contentAddress(bytes);
}

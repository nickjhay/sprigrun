/** Exact-byte primitives shared by clients and the future native service. */
export const LIMITS = Object.freeze({
  word: 32, topicWords: 8, path: 512, origin: 256,
  sourceBytes: 256 * 1024, metadataBytes: 1024, requestLineBytes: 1024,
  actionBytes: 256 * 1024 + 2048, recordBytes: 2048,
});
export const U64_MAX = (1n << 64n) - 1n;
export class ProtocolError extends Error {
  constructor(code: string) { super(code); this.name = 'ProtocolError'; }
}
export function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new ProtocolError(code);
}
export function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function copyBytes(bytes: Uint8Array, max = LIMITS.actionBytes): Uint8Array<ArrayBuffer> {
  check(bytes instanceof Uint8Array && bytes.byteLength <= max, 'bytes_limit');
  return Uint8Array.from(bytes); // Buffer.slice() would alias caller-owned memory.
}
export function utf8(bytes: Uint8Array): string {
  try { return decoder.decode(bytes); } catch { throw new ProtocolError('invalid_utf8'); }
}
export function textBytes(text: string): Uint8Array<ArrayBuffer> {
  check(typeof text === 'string', 'invalid_text');
  const bytes = Uint8Array.from(encoder.encode(text));
  check(utf8(bytes) === text, 'invalid_text'); // Do not replace lone surrogates.
  return bytes;
}
export function u64(text: string): bigint {
  check(matches(/^(0|[1-9][0-9]{0,19})$/, text), 'invalid_u64');
  const value = BigInt(text);
  check(value <= U64_MAX, 'u64_overflow');
  return value;
}
export function nextU64(text: string): string {
  const value = u64(text);
  check(value < U64_MAX, 'u64_overflow');
  return String(value + 1n);
}
/** Fixed-width decimal TEXT sorts correctly in SQLite without Number coercion. */
export function orderedU64(text: string): string { u64(text); return text.padStart(20, '0'); }
export function parseAddress(address: string, max = LIMITS.actionBytes) {
  check(matches(/^[0-9a-f]{64}_(0|[1-9][0-9]{0,19})$/, address), 'invalid_address');
  const [digest, length] = address.split('_') as [string, string];
  const n = u64(length);
  check(n <= BigInt(max), 'address_size_limit');
  return { digest, length: Number(n) }; // Bounded above before conversion.
}
export async function contentAddress(input: Uint8Array): Promise<string> {
  const bytes = copyBytes(input);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, n => n.toString(16).padStart(2, '0')).join('') + '_' + bytes.length;
}
export function base64url(bytes: Uint8Array): string {
  // Only small public keys/signatures use this helper.
  check(bytes.length <= 128, 'encoding_size_limit');
  return btoa(Array.from(bytes, n => String.fromCharCode(n)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unbase64url(text: string, length: number): Uint8Array<ArrayBuffer> {
  check(text.length === Math.ceil(length * 8 / 6)
    && matches(/^[A-Za-z0-9_-]+$/, text), 'invalid_base64url');
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
  catch { throw new ProtocolError('invalid_base64url'); }
  check(bytes.length === length && base64url(bytes) === text, 'invalid_base64url');
  return bytes;
}

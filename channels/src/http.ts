export class HttpError extends Error {
  constructor(public status: number, public code: string, message = code, public retry = 0) { super(message); }
}
export const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Channel-Epoch, Channel-Message-Id, Channel-Ticket, Channel-Nonce',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
export function failure(error: unknown): Response {
  const e = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'The channel service could not complete this request.');
  const response = json({ error: e.code, message: e.message }, e.status);
  if (e.retry) response.headers.set('Retry-After', String(e.retry));
  return response;
}
export async function readBody(request: Request, max: number, timeoutMs: number): Promise<Uint8Array> {
  const encoding = request.headers.get('Content-Encoding');
  if (encoding && encoding !== 'identity') throw new HttpError(415, 'unsupported_encoding');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > max)) throw new HttpError(413, 'body_too_large');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), bytes = new Uint8Array(max);
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, 'body_timeout')), timeoutMs); });
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), timeout]);
      if (r.done) return bytes.subarray(0, size);
      if (size + r.value.byteLength > max) throw new HttpError(413, 'body_too_large');
      bytes.set(r.value, size); size += r.value.byteLength;
    }
  } catch (e) { void reader.cancel().catch(() => {}); throw e; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new HttpError(422, 'invalid_utf8', 'Send a well-formed UTF-8 string. Its exact characters will be retained.'); }
}

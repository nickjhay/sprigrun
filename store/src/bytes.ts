import { HARD_MAX_BLOB_BYTES } from './config.ts';
import { HttpError } from './types.ts';

export const DIGEST = /^[0-9a-f]{64}$/;
export const objectKey = (digest: string) => `b/${digest}`;

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Admission checks must be bounded, must not execute source, and must not edit it.
export function validate(bytes: Uint8Array, policy: string): void {
  if (policy === 'ascii-v1') {
    if (bytes.some(byte => byte > 127)) throw new HttpError(422, 'invalid_ascii');
  } else if (policy === 'utf8-v1') {
    try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new HttpError(422, 'invalid_utf8'); }
  } else throw new Error('unknown_validation_policy');
}

export function checkUploadHeaders(request: Request, maxBytes: number): void {
  const encoding = request.headers.get('Content-Encoding');
  if (encoding && encoding.toLowerCase().trim() !== 'identity') throw new HttpError(415, 'content_encoding_not_supported');
  const length = request.headers.get('Content-Length');
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw new HttpError(400, 'invalid_content_length');
    if (BigInt(length) > BigInt(maxBytes)) throw new HttpError(413, 'blob_too_large');
  }
}

export async function readBounded(request: Request, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  // Bound retained memory, not just payload length. Keeping arbitrary chunks
  // also keeps their object overhead and possibly much larger backing buffers.
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(408, 'upload_timeout')), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (length + value.byteLength > maxBytes) throw new HttpError(413, 'blob_too_large');
      bytes.set(value, length);
      length += value.byteLength;
    }
    return bytes.subarray(0, length);
  } catch (error) {
    // Do not await cancellation: an uncooperative stream must not delay rejection.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function isTombstone(object: R2Object): boolean {
  return object.customMetadata?.kind === 'blocked';
}

export async function verifiedBody(object: R2ObjectBody, digest: string, expectedBytes: number): Promise<Uint8Array> {
  try {
    if (isTombstone(object)) throw new HttpError(410, 'blob_blocked');
    // Do not accidentally expose raw-v1 objects from the binary/grant edition.
    // Tightening admission to ASCII must still leave older UTF-8 source readable.
    const policy = object.customMetadata?.validation_policy;
    if (object.customMetadata?.kind !== 'blob' || !['utf8-v1', 'ascii-v1'].includes(policy ?? '')) {
      throw new Error('unsupported_stored_format');
    }
    if (object.size !== expectedBytes) throw new Error('stored_blob_length_mismatch');
    if (object.size > HARD_MAX_BLOB_BYTES) throw new Error('stored_blob_exceeds_runtime_limit');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== object.size || await sha256(bytes) !== digest) throw new Error('stored_blob_integrity_failure');
    // Verify the stored contract too; trusted metadata alone is not validation.
    try { validate(bytes, policy!); }
    catch { throw new Error('stored_blob_format_failure'); }
    return bytes;
  } catch (error) {
    if (!object.bodyUsed) void object.body.cancel().catch(() => {});
    throw error;
  }
}

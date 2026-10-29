// Browser helper: small bounded puzzles; source bytes never change.
import { parseAddress, proofDigest, validChallenge, type Challenge } from '../src/proof.ts';

export interface SolveOptions { signal?: AbortSignal; maxTrials?: number; timeoutMs?: number }
const MAX_BYTES = 1024 * 1024;

async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function solveChallenge(challenge: Challenge, options: SolveOptions = {}): Promise<string> {
  if (!validChallenge(challenge)) throw new Error('Invalid challenge');
  const maxTrials = options.maxTrials ?? 1000000;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(maxTrials) || maxTrials < 1 || maxTrials > 100000000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid solver limits');
  const until = Math.min(Date.now() + timeoutMs, challenge.expires_at_ms);
  for (let i = 0; i < maxTrials; i++) {
    options.signal?.throwIfAborted();
    if (Date.now() >= until) throw new Error('Challenge expired or solver time limit reached');
    const nonce = i.toString(16).padStart(16, '0');
    if (await proofDigest(challenge, nonce) <= challenge.target) return nonce;
  }
  throw new Error(`No solution in ${maxTrials} trials; increase the local solver budget if appropriate`);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(new TextDecoder().decode(await readLimited(response, 4096))) as Record<string, unknown>;
}
function problem(response: Response, result: Record<string, unknown>): never {
  const message = typeof result?.message === 'string' ? `: ${result.message}` : '';
  throw new Error(`Upload failed (${response.status})${message}`);
}

export async function shareSource(origin: string, source: string, options: SolveOptions = {}): Promise<string> {
  return shareSourceBytes(origin, new TextEncoder().encode(source), options);
}
export async function shareSourceBytes(origin: string, input: Uint8Array, options: SolveOptions = {}): Promise<string> {
  if (input.length > MAX_BYTES) throw new Error('Source exceeds client size limit');
  const bytes = new Uint8Array(input); // Freeze the bytes across asynchronous hashing/upload.
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const digest = await hash(bytes);
  const address = `${digest}_${bytes.length}`;
  const checkPublished = (result: Record<string, unknown>) => {
    if (result.address !== address || result.digest !== digest || result.bytes !== bytes.length) throw new Error('Upload identity mismatch');
    return address;
  };
  // The common, no-work case is one request. Only an explicit work requirement
  // starts the challenge flow; network/server failures never cause an auto-retry.
  const direct = await fetch(new URL('/b', origin), {
    method: 'POST', body: bytes, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    credentials: 'omit', redirect: 'error', signal: deadline(options.signal),
  });
  const directResult = await responseJson(direct);
  if (direct.ok) return checkPublished(directResult);
  if (direct.status !== 428 || directResult.error !== 'proof_required') problem(direct, directResult);
  const issued = await fetch(new URL(`/challenge/b/${address}`, origin), {
    method: 'POST', credentials: 'omit', redirect: 'error', signal: deadline(options.signal),
  });
  const ticket = await responseJson(issued);
  if (issued.status === 409 && ticket?.error === 'already_written') return address;
  if (!issued.ok) problem(issued, ticket);
  if (!validChallenge(ticket) || ticket.address !== address) throw new Error('Challenge address/format mismatch');
  const nonce = await solveChallenge(ticket, options);
  const response = await fetch(new URL(`/b/${address}`, origin), {
    method: 'PUT', body: bytes, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Blob-Ticket': ticket.id, 'Blob-Nonce': nonce },
    credentials: 'omit', redirect: 'error', signal: deadline(options.signal),
  });
  const result = await responseJson(response);
  if (response.status === 409 && result?.error === 'already_written') return address;
  if (!response.ok) problem(response, result);
  return checkPublished(result);
}

export async function loadSource(origin: string, address: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; source: string }> {
  const parsed = parseAddress(address);
  if (!parsed) throw new Error('Invalid address');
  const response = await fetch(new URL(`/b/${address}`, origin), { credentials: 'omit', redirect: 'error', signal: deadline(signal) });
  if (!response.ok) throw new Error(`Load failed (${response.status})`);
  const bytes = await readLimited(response, parsed.bytes);
  if (bytes.length !== parsed.bytes) throw new Error('Downloaded blob length mismatch');
  if (await hash(bytes) !== parsed.digest) throw new Error('Downloaded blob digest mismatch');
  return { bytes, source: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const buffer = new Uint8Array(maxBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > buffer.length) throw new Error('Blob exceeds client size limit');
      buffer.set(value, length); length += value.length;
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return buffer.slice(0, length);
}
// Identity verification does not replace simulator execution/memory limits.

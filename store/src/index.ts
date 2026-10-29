import { timingSafeEqual } from 'node:crypto';
import { config, type Config } from './config.ts';
import { checkUploadHeaders, objectKey, readBounded, verifiedBody } from './bytes.ts';
import { parseAddress, proofPrefix, TICKET_ID, NONCE } from './proof.ts';
import { failure, HttpError, type Env, type Failure } from './types.ts';
import { documentation, DISCOVERY_LINKS } from './help.ts';

export { StoreCoordinator } from './coordinator.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'ETag, Location, Retry-After, Link',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

function json(value: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(value) + '\n', { status, headers });
}

function failed(result: Failure): Response {
  return json({ error: result.error, message: result.message, proof_of_work: result.proof_of_work,
    help: '/help', retry_after_seconds: result.retryAfter }, result.status,
    result.retryAfter === undefined ? {} : { 'Retry-After': String(result.retryAfter) });
}

function coordinator(env: Env) { return env.STORE.get(env.STORE.idFromName('global')); }

function notModified(request: Request, etag: string): boolean {
  const value = request.headers.get('If-None-Match');
  return value !== null && value.split(',').some(candidate => {
    const tag = candidate.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

async function getBlob(request: Request, env: Env, address: string, policy: Config): Promise<Response> {
  const { digest, bytes: expectedBytes } = parseAddress(address)!;
  const object = await env.BLOBS.get(objectKey(address));
  if (!object) throw new HttpError(404, 'blob_not_found');
  const bytes = await verifiedBody(object, digest, expectedBytes);
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(bytes.length),
    'Cache-Control': `private, max-age=${policy.browserCacheSeconds}, immutable`,
    ETag: `"sha256-${address}"`,
  });
  // Only evaluate conditionals after finding an allowed, verified blob. An ETag
  // alone must not turn a missing or blocked object into a successful 304.
  if (notModified(request, headers.get('ETag')!)) {
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { headers });
}

function authorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN || !/^[0-9a-f]{64}$/i.test(env.ADMIN_TOKEN)) return false;
  const encoder = new TextEncoder();
  const actual = encoder.encode(request.headers.get('Authorization') ?? '');
  const expected = encoder.encode(`Bearer ${env.ADMIN_TOKEN}`);
  // The required token length is public. Compare its contents in constant time.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  // Disabled, unknown and unauthenticated admin routes all look absent.
  if (request.method !== 'POST' || !authorized(request, env)) throw new HttpError(404, 'not_found');
  const store = coordinator(env);
  if (url.pathname === '/admin/pause' || url.pathname === '/admin/resume') {
    const paused = url.pathname === '/admin/pause';
    const result = await store.setPaused(paused);
    return result.ok ? json({ uploads_paused: paused }) : failed(result);
  }
  if (url.pathname.startsWith('/admin/pow/')) {
    const match = /^\/admin\/pow\/(default|0|[1-9]\d{0,2})(?:\/(0|[1-9]\d{0,9}))?$/.exec(url.pathname);
    if (!match || (match[1] === 'default' && match[2] !== undefined)) throw new HttpError(400, 'invalid_proof_of_work_parameters');
    const result = await store.setProofOfWork(match[1] === 'default' ? null : Number(match[1]), match[2] === undefined ? undefined : Number(match[2]));
    return result.ok ? json(result.value) : failed(result);
  }
  const address = url.pathname.startsWith('/admin/block/') ? url.pathname.slice('/admin/block/'.length) : '';
  if (!parseAddress(address)) throw new HttpError(404, 'not_found');
  const result = await store.block(address);
  return result.ok ? json({ address, origin_blocked: true }) : failed(result);
}

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (url.search) throw new HttpError(400, 'query_parameters_not_supported');
  const doc = documentation(url);
  if (doc) {
    const allow = 'GET, HEAD, OPTIONS';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': allow, 'Access-Control-Max-Age': '86400', 'Cache-Control': 'no-store',
    } });
    if (!['GET', 'HEAD'].includes(request.method)) {
      return json({ error: 'method_not_allowed', help: '/help' }, 405, { Allow: allow });
    }
    return new Response(doc.body, { headers: {
      'Content-Type': doc.type, 'Cache-Control': 'public, max-age=300',
    } });
  }
  const policy = config(env);
  if (url.pathname.startsWith('/admin/')) return admin(request, env, url);
  const address = url.pathname.startsWith('/b/') ? url.pathname.slice(3) : '';
  const blob = parseAddress(address);
  const challengeAddress = url.pathname.startsWith('/challenge/b/') ? url.pathname.slice(13) : '';
  const challenge = parseAddress(challengeAddress);
  const collection = url.pathname === '/b';
  if (url.pathname !== '/' && !blob && !challenge && !collection) throw new HttpError(404, 'not_found');
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Blob-Ticket, Blob-Nonce',
      'Access-Control-Max-Age': '86400', 'Cache-Control': 'no-store',
    } });
  }
  if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
    const key = new Request(url.href, { method: 'GET' });
    let response = await caches.default.match(key);
    if (!response) {
      const stats = await coordinator(env).stats();
      const text = 'help /help\n' + Object.entries(stats).map(([key, value]) => `${key} ${value}`).join('\n') + '\n';
      response = new Response(text, { headers: {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=5, s-maxage=5',
      } });
      ctx.waitUntil(caches.default.put(key, response.clone()).catch(() => {}));
    }
    return response;
  }
  if (blob && ['GET', 'HEAD'].includes(request.method)) return getBlob(request, env, address, policy);
  if (((challenge || collection) && request.method === 'POST') || (blob && request.method === 'PUT')) {
    if (request.headers.has('Authorization')) throw new HttpError(400, 'upload_authorization_not_supported');
    const size = collection ? policy.maxBytes : (challenge ?? blob)!.bytes;
    if (size > policy.maxBytes) throw new HttpError(413, 'blob_too_large');
    checkUploadHeaders(request, challenge ? 0 : size);
    // Approximate edge limit; the DO separately enforces exact global budgets.
    if (env.UPLOAD_RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!(await env.UPLOAD_RATE_LIMITER.limit({ key: ip })).success) throw new HttpError(429, 'client_attempt_limit', 60);
    }
    const store = coordinator(env);
    if (collection) {
      if (request.headers.has('Blob-Ticket') || request.headers.has('Blob-Nonce')) throw new HttpError(400, 'use_addressed_put_for_proof');
      const admission = await store.admitOpenUpload();
      if (!admission.ok) return failed(admission);
      const bytes = await readBounded(request, size, policy.uploadTimeoutMs);
      const result = await store.publish(null, bytes);
      if (!result.ok) return failed(result);
      const address = `${result.value.digest}_${result.value.bytes}`;
      const path = `/b/${address}`;
      return json({ address, digest: result.value.digest, bytes: result.value.bytes, url: path,
        submitted_at_ms: result.value.submitted_at_ms }, result.value.created ? 201 : 200, { Location: path });
    }
    if (challenge) {
      const result = await store.challenge(challengeAddress);
      return result.ok ? json({ ...result.value, message_prefix: proofPrefix(result.value) }, 201) : failed(result);
    }
    const id = request.headers.get('Blob-Ticket') ?? '';
    const nonce = request.headers.get('Blob-Nonce') ?? '';
    if (!TICKET_ID.test(id) || !NONCE.test(nonce)) return failed({
      ...failure(400, 'proof_required'),
      message: `Request POST /challenge/b/${address}, solve the returned challenge locally, then PUT these exact bytes with Blob-Ticket and Blob-Nonce headers. A nonce is exactly 16 lowercase hexadecimal digits.`,
    });
    const admission = await store.redeem(address, id, nonce);
    if (!admission.ok) return failed(admission);
    const bytes = await readBounded(request, size, policy.uploadTimeoutMs);
    const result = await store.publish(address, bytes);
    if (!result.ok) return failed(result);
    const path = `/b/${address}`;
    return json({ address, digest: result.value.digest, bytes: result.value.bytes, url: path,
      submitted_at_ms: result.value.submitted_at_ms }, 201, { Location: path });
  }
  return json({ error: 'method_not_allowed', help: '/help' }, 405, { Allow: challenge || collection ? 'POST, OPTIONS' : blob ? 'GET, HEAD, PUT, OPTIONS' : 'GET, HEAD, OPTIONS' });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try { response = await route(request, env, ctx, url); }
    catch (error) {
      if (error instanceof HttpError) {
        response = failed(failure(error.status, error.code, error.retryAfter));
      } else {
        console.error('request_failed');
        response = failed(failure(503, 'service_unavailable', 5));
      }
    }
    // Cached Responses may have immutable headers. Always make a writable copy.
    response = new Response(request.method === 'HEAD' ? null : response.body, response);
    for (const [key, value] of Object.entries(SECURITY)) response.headers.set(key, value);
    if (!url.pathname.startsWith('/admin/')) {
      for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
      response.headers.set('Link', DISCOVERY_LINKS);
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

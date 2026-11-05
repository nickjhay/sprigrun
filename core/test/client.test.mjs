import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeClient } from '../scripts/http-client.mjs';
import { MAX_LINE } from '../host/archive.ts';
const client = (fetcher, options) => nativeClient('https://sprig.run', { token: 'a'.repeat(64), fetcher, ...options });
test('HTTP client bounds unadvertised bodies, rejects invalid UTF-8 and redacts remote errors', async () => {
  await assert.rejects(client(async () => new Response(new Uint8Array(2 * MAX_LINE + 4097))).checkpoint(), /response_size_limit/);
  await assert.rejects(client(async () => new Response(new Uint8Array([255]))).checkpoint(), /encoded data/);
  await assert.rejects(client(async () => new Response('SECRET\x1b[31m', { status: 500 })).checkpoint(), /^Error: 500: request_failed$/);
  await assert.rejects(client(async () => new Response('snapshot_busy\nprivate detail', { status: 503 })).checkpoint(), /^Error: 503: snapshot_busy$/);
});
test('deadline bounds stalled fetch and stalled body, and credentials never follow redirects', async () => {
  await assert.rejects(client(() => new Promise(() => {}), { timeoutMs: 20 }).checkpoint(), /request_timeout/);
  let cancelled = false;
  await assert.rejects(client(async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }, { timeoutMs: 20 }).checkpoint(), /request_timeout/);
  assert.equal(cancelled, true);
  assert.throws(() => client(fetch, { timeoutMs: Infinity }), /invalid_request_timeout/);
});

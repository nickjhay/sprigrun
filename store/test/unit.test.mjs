import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseAddress, proofDigest, workTarget } from '../src/proof.ts';
import assert from 'node:assert/strict';
import { full, refill, waitSeconds } from '../../shared/bucket.ts';
import { config } from '../src/config.ts';
import { sha256, validate, readBounded, checkUploadHeaders } from '../src/bytes.ts';

test('refill retains fractional tokens without minting on backwards clocks', () => {
  const policy = { capacity: 10, refill: 3, periodMs: 1000 };
  let state = { tokens: 0, atMs: 0, remainder: 0 };
  for (let i = 1; i <= 1000; i++) state = refill(state, policy, i);
  assert.deepEqual(state, { tokens: 3, atMs: 1000, remainder: 0 });
  assert.deepEqual(refill(state, policy, 20), state);
  assert.equal(refill(state, policy, 1e12).tokens, 10);
});

test('arbitrary debits stay within the capacity + elapsed refill envelope', () => {
  const policy = { capacity: 123, refill: 17, periodMs: 1000 };
  let state = full(policy, 0), now = 0, admitted = 0, seed = 123456;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 10000; i++) {
    now += random() % 131;
    state = refill(state, policy, now);
    const debit = 1 + random() % 30;
    if (state.tokens >= debit) { state.tokens -= debit; admitted += debit; }
    assert.ok(admitted <= policy.capacity + Math.floor(now * policy.refill / policy.periodMs));
    assert.ok(state.tokens >= 0 && state.tokens <= policy.capacity);
  }
});

test('retry-after covers the actual refill time', () => {
  const policy = { capacity: 100, refill: 3, periodMs: 1000 };
  const state = { tokens: 0, atMs: 0, remainder: 999 };
  const wait = waitSeconds(state, policy, 10);
  assert.equal(wait, 4);
  assert.ok(refill(state, policy, wait * 1000).tokens >= 10);
});

test('policy changes clamp balances and do not refill to a new capacity', () => {
  const policy = { capacity: 5, refill: 1, periodMs: 1000 };
  assert.equal(refill({ tokens: 100, atMs: 0, remainder: 0 }, policy, 0).tokens, 5);
  assert.equal(refill({ tokens: 3, atMs: 0, remainder: 0 }, { ...policy, capacity: 100 }, 0).tokens, 3);
});

test('default quotas stay capped after decades idle and bound a subsequent busy week', () => {
  const policy = config({});
  const MiB = 2 ** 20;
  const idle = 20 * 365 * 86400000;
  let long = refill({ tokens: 0, atMs: 0, remainder: 0 }, policy.long, idle);
  let burst = refill({ tokens: 0, atMs: 0, remainder: 0 }, policy.burst, idle);
  assert.equal(long.tokens, 200 * MiB);
  assert.equal(burst.tokens, 8 * MiB);
  long = refill(long, policy.long, idle * 2);
  burst = refill(burst, policy.burst, idle * 2);
  assert.equal(long.tokens, 200 * MiB);
  assert.equal(burst.tokens, 8 * MiB);

  const cumulative = [0];
  let total = 0;
  for (let minute = 0; minute <= 7 * 24 * 60; minute++) {
    const now = idle * 2 + minute * 60000;
    long = refill(long, policy.long, now);
    burst = refill(burst, policy.burst, now);
    // Demand is always sufficient to spend all usable credit immediately.
    const debit = Math.floor(Math.min(long.tokens, burst.tokens) / policy.minimumDebit) * policy.minimumDebit;
    long.tokens -= debit;
    burst.tokens -= debit;
    total += debit;
    cumulative.push(total);
    assert.ok(total - cumulative[Math.max(0, minute - 60)] <= 16 * MiB);
    assert.ok(total - cumulative[Math.max(0, minute - 1440)] <= 200 * MiB);
    assert.ok(total <= 200 * MiB + Math.floor(100 * MiB * minute / 1440));
  }
  assert.ok(total >= 7 * 100 * MiB, 'sustained admission can use the daily refill');
});

test('UTF-8 checks reject malformed encodings and preserve BOM, NUL and CRLF', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0, 13, 10, 0xc3, 0xa9]);
  const copy = bytes.slice();
  validate(bytes, 'utf8-v1');
  assert.deepEqual(bytes, copy);
  for (const invalid of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xff], [0xe2, 0x82]]) {
    assert.throws(() => validate(new Uint8Array(invalid), 'utf8-v1'), /invalid_utf8/);
  }
  assert.equal(await sha256(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('ASCII is an alternate admission policy, not a normalization', () => {
  validate(new Uint8Array([0, 10, 127]), 'ascii-v1');
  assert.throws(() => validate(new Uint8Array([128]), 'ascii-v1'), /invalid_ascii/);
  assert.throws(() => validate(new Uint8Array(), 'typo'), /unknown_validation_policy/);
});

test('streaming upload rejects excess bytes without trusting Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); },
    cancel() { cancelled = true; },
  });
  const request = new Request('https://example.test/b', { method: 'POST', body: stream, duplex: 'half' });
  await assert.rejects(readBounded(request, 5, 1000), /blob_too_large/);
  assert.equal(cancelled, true);
});

test('stalled body is cancelled on timeout', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const request = new Request('https://example.test/b', { method: 'POST', body: stream, duplex: 'half' });
  await assert.rejects(readBounded(request, 5, 20), /upload_timeout/);
  assert.equal(cancelled, true);
});

test('bounded reads concatenate bytes exactly', async () => {
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0, 1])); c.enqueue(new Uint8Array([2])); c.close(); } });
  const request = new Request('https://example.test/b', { method: 'POST', body: stream, duplex: 'half' });
  assert.deepEqual(await readBounded(request, 3, 1000), new Uint8Array([0, 1, 2]));
});

test('bounded reads snapshot reused backing buffers instead of retaining chunks', async () => {
  const backing = new Uint8Array(1024 * 1024);
  let index = 0;
  const stream = new ReadableStream({ pull(c) {
    if (index === 128) return c.close();
    backing[0] = index++;
    c.enqueue(backing.subarray(0, 1));
  } }, { highWaterMark: 0 });
  const request = new Request('https://example.test/b', { method: 'POST', body: stream, duplex: 'half' });
  assert.deepEqual(await readBounded(request, 128, 1000), Uint8Array.from({ length: 128 }, (_, i) => i));
});

test('header checks reject compressed uploads and oversized declared bodies', () => {
  const request = headers => new Request('https://example.test/b', { method: 'POST', headers });
  assert.throws(() => checkUploadHeaders(request({ 'Content-Encoding': 'gzip' }), 10), /content_encoding_not_supported/);
  assert.throws(() => checkUploadHeaders(request({ 'Content-Length': '999999999999999999999999999' }), 10), /blob_too_large/);
  assert.throws(() => checkUploadHeaders(request({ 'Content-Length': '-1' }), 10), /invalid_content_length/);
});

test('configuration fails closed on unsafe sizes, unfit buckets and policy typos', () => {
  assert.equal(config({}).browserCacheSeconds, 31536000);
  assert.throws(() => config({ MAX_BLOB_BYTES: '2000000' }));
  assert.throws(() => config({ BURST_CAPACITY_BYTES: '2' }));
  assert.throws(() => config({ ATTEMPT_CAPACITY: 'NaN' }));
  assert.throws(() => config({ VALIDATION_POLICY: 'utf8-v2' }));
});


test('addresses have one canonical byte-length representation and a hard ceiling', () => {
  const h = 'a'.repeat(64);
  assert.deepEqual(parseAddress(h + '_0'), { digest: h, bytes: 0 });
  assert.equal(parseAddress(h + '_1048576').bytes, 1048576);
  for (const suffix of ['_00', '_01', '_+1', '_-1', '_1.0', '_1e2', '_1048577', '_12345678', '_1/']) assert.equal(parseAddress(h + suffix), null);
  assert.equal(parseAddress('A'.repeat(64) + '_1'), null);
});

test('work target combines fixed and byte costs with exact integer arithmetic', () => {
  const space = 1n << 256n;
  for (const [bits, perByte, bytes] of [[0,0,0], [16,8,262144], [80,1000,1], [256,0,1048576]]) {
    assert.equal(BigInt('0x' + workTarget(bits, perByte, bytes)) + 1n, space / ((1n << BigInt(bits)) + BigInt(bytes * perByte)));
  }
  assert.throws(() => workTarget(256, 1, 1));
  assert.throws(() => workTarget(9, -1, 1));
});

test('wire proof hashes exactly the documented ASCII fields and newline delimiters', async () => {
  const c = { protocol: 'blob-store-upload-v1', id: '1'.repeat(64), address: '2'.repeat(64) + '_7', expires_at_ms: 1800000000000, target: workTarget(5,2,7) };
  const nonce = '0123456789abcdef';
  const message = [c.protocol,c.id,c.address,String(c.expires_at_ms),c.target,nonce,''].join('\n');
  assert.equal(await proofDigest(c, nonce), createHash('sha256').update(message).digest('hex'));
});

test('challenge configuration bounds tables, lifetimes, issuance and work', () => {
  const c = config({});
  assert.equal(c.challengeCapacity,512); assert.equal(c.challengeTtlMs,600000);
  assert.equal(config({ PROOF_OF_WORK_BITS: '256' }).proofOfWorkBits,256);
  for (const bad of [{ CHALLENGE_CAPACITY:'0' },{ CHALLENGE_TTL_SECONDS:'3601' },{ CHALLENGE_BURST:'10001' },{ PROOF_OF_WORK_BITS:'257' },{ PROOF_OF_WORK_PER_BYTE:'-1' },{ PROOF_OF_WORK_BITS:'256', PROOF_OF_WORK_PER_BYTE:'1' }]) assert.throws(() => config(bad));
});

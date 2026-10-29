#!/usr/bin/env node
// Deliberately exercises destructive admin operations on a disposable store.
// Never deploy the test Worker: this script uses only the public production API.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { solveChallenge } from '../examples/client.ts';
import { validChallenge } from '../src/proof.ts';

const [mode, filename, consent, ...extra] = process.argv.slice(2);
if (!['prepare', 'verify'].includes(mode) || !filename || consent !== '--disposable' || extra.length) {
  throw new Error('Usage: rehearse.mjs prepare|verify STATE_FILE --disposable (dedicated rehearsal store only)');
}
const origin = new URL(process.env.BLOB_STORE_URL ?? '');
if (origin.href !== origin.origin + '/') throw new Error('BLOB_STORE_URL must be a bare origin without credentials, path, query or fragment');
assert.ok(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)), 'Use HTTPS except on loopback');
const token = process.env.BLOB_STORE_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN;
if (!/^[0-9a-f]{64}$/i.test(token ?? '')) throw new Error('Set BLOB_STORE_ADMIN_TOKEN (or ADMIN_TOKEN in a private environment file); it is never saved');
const signal = AbortSignal.timeout(120000);
const started = performance.now();
let requests = 0;
const address = bytes => `${createHash('sha256').update(bytes).digest('hex')}_${bytes.length}`;

async function request(path, options = {}) {
  requests++;
  const response = await fetch(new URL(path, origin), {
    ...options, redirect: 'error', credentials: 'omit', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  const chunks = new Uint8Array(4096);
  let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        assert.ok(length + value.length <= chunks.length, 'Response exceeds rehearsal limit');
        chunks.set(value, length); length += value.length;
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  return { status: response.status, headers: response.headers, bytes: Buffer.from(chunks.subarray(0, length)) };
}
function expect(result, status, error) {
  assert.equal(result.status, status, `Expected HTTP ${status}, got ${result.status}`);
  if (error) assert.equal(JSON.parse(result.bytes).error, error);
  return result;
}
async function stats() {
  const r = expect(await request('/'), 200);
  return Object.fromEntries(r.bytes.toString('utf8').trim().split('\n').map(line => {
    const at = line.indexOf(' '); return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function profile(s) {
  for (const [key, value] of Object.entries({
    service: 'bounded-blob-store', validation: 'utf8-v1', max_blob_bytes: '128',
    minimum_debit_bytes: '64', long_capacity_bytes: '256', burst_capacity_bytes: '256',
    long_refill_bytes_per_day: '1', burst_refill_bytes_per_hour: '1',
  })) assert.equal(s[key], value, `Not the disposable rehearsal profile: ${key}`);
}
const admin = async path => {
  const r = expect(await request(`/admin/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
};
async function ticket(bytes) {
  const id = address(bytes);
  const r = expect(await request(`/challenge/b/${id}`, { method: 'POST' }), 201);
  const challenge = JSON.parse(r.bytes);
  assert.ok(validChallenge(challenge)); assert.equal(challenge.address, id);
  return { challenge, nonce: await solveChallenge(challenge, { signal, maxTrials: 100000, timeoutMs: 5000 }) };
}
const put = (proof, bytes) => request(`/b/${proof.challenge.address}`, {
  method: 'PUT', body: bytes, headers: { 'Content-Type': 'text/plain; charset=utf-8',
    'Blob-Ticket': proof.challenge.id, 'Blob-Nonce': proof.nonce },
});
async function publish(bytes) {
  const proof = await ticket(bytes);
  const result = expect(await put(proof, bytes), 201);
  const value = JSON.parse(result.bytes);
  assert.equal(value.address, address(bytes)); assert.equal(value.bytes, bytes.length);
  return proof;
}
async function read(bytes) {
  const path = `/b/${address(bytes)}`;
  const r = expect(await request(path), 200);
  assert.deepEqual(r.bytes, bytes);
  assert.equal(address(r.bytes), address(bytes));
  assert.match(r.headers.get('Cache-Control') ?? '', /^private,.*immutable$/);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(r.headers.get('Content-Type') ?? '', /^text\/plain/);
  const etag = `"sha256-${address(bytes)}"`;
  assert.equal(r.headers.get('ETag'), etag);
  const head = expect(await request(path, { method: 'HEAD' }), 200);
  assert.equal(head.bytes.length, 0); assert.equal(head.headers.get('Content-Length'), String(bytes.length));
  expect(await request(path, { headers: { 'If-None-Match': etag } }), 304);
}
async function blocked(bytes) {
  for (const method of ['GET', 'HEAD']) {
    const r = expect(await request(`/b/${address(bytes)}`, { method, headers: { 'If-None-Match': '*' } }), 410);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  }
}

let state;
let file;
try {
  let current = await stats();
  profile(current);
  // The public status page has a five-second edge cache. Do not interpret a
  // just-preparation snapshot as lost control state after a quick redeployment.
  if (mode === 'verify') {
    for (let retry = 0; retry < 6 && (current.uploads_paused !== 'true' || current.reserved_blobs_total !== '4'); retry++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      current = await stats(); profile(current);
    }
  }
  if (mode === 'prepare') {
    for (const key of ['reserved_blobs_total', 'blocked_addresses', 'outstanding_challenges']) assert.equal(current[key], '0', 'Use a fresh dedicated store');
    assert.equal(current.uploads_paused, 'false');
    assert.equal(current.proof_of_work_bits, '4');
    assert.equal(current.proof_of_work_per_byte, '1');
    state = { format: 'store-rehearsal-1', origin: origin.origin, seed: randomBytes(16).toString('hex'), prepared: false };
    // Claim the filename before any mutation; do not overwrite an earlier run.
    file = await open(filename, 'wx', 0o600);
    await file.writeFile(JSON.stringify(state) + '\n'); await file.sync();
  } else {
    file = await open(filename, 'r');
    assert.ok((await file.stat()).size <= 4096, 'State file too large');
    state = JSON.parse(await file.readFile('utf8'));
    assert.equal(state.format, 'store-rehearsal-1');
    assert.equal(state.origin, origin.origin, 'Use the original origin; the state file cannot redirect requests');
    assert.match(state.seed ?? '', /^[0-9a-f]{32}$/); assert.equal(state.prepared, true);
  }
  const source = name => Buffer.from(`# ${name} ${state.seed}\n`);
  const keep = source('keep'), repair = source('repair'), block = source('block'), last = source('last'), excess = source('excess'), live = source('live');
  if (mode === 'prepare') {
    expect(await request('/admin/pause', { method: 'POST' }), 404);
    await admin('pause');
    expect(await request(`/challenge/b/${address(keep)}`, { method: 'POST' }), 503, 'uploads_paused');
    await admin('resume');
    const preflight = expect(await request(`/b/${address(keep)}`, { method: 'OPTIONS', headers: {
      Origin: 'https://sprig.run', 'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type,blob-ticket,blob-nonce',
    } }), 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(preflight.headers.get('Access-Control-Allow-Headers') ?? '', /Blob-Ticket/);

    state.spent = await publish(keep);
    await read(keep);
    expect(await put(state.spent, keep), 409, 'challenge_unavailable');
    expect(await request(`/challenge/b/${address(keep)}`, { method: 'POST' }), 409, 'already_written');

    const wrong = await ticket(repair);
    const different = Buffer.from(repair); different[0] ^= 1;
    expect(await put(wrong, different), 422, 'digest_mismatch');
    expect(await put(wrong, repair), 409, 'challenge_unavailable');
    await publish(repair); // A bad body must not permanently poison this address.
    const invalid = Buffer.from([255]);
    expect(await put(await ticket(invalid), invalid), 422, 'invalid_utf8');
    expect(await request(`/b/${address(invalid)}`), 404);

    await publish(block); await admin(`block/${address(block)}`); await blocked(block);
    await publish(last);
    const full = await ticket(excess);
    expect(await put(full, excess), 429, 'growth_limit');
    expect(await put(full, excess), 409, 'challenge_unavailable');
    state.live = await ticket(live);
    // Leave an unmistakable persisted override for the post-deployment check.
    await admin('pow/5/2');
    // Leave paused on success. A failed run may need manual pause; never resume in finally.
    await admin('pause');
    state.prepared = true;
    const encoded = JSON.stringify(state) + '\n';
    await file.write(encoded, 0, 'utf8'); await file.truncate(Buffer.byteLength(encoded)); await file.sync();
    console.log('Prepared: four reservations, three readable blobs, one block; uploads left paused.');
    console.log('Restart/redeploy the SAME Worker and storage, then run verify with this state file.');
  } else {
    assert.equal(current.uploads_paused, 'true');
    assert.equal(current.proof_of_work_bits, '5'); assert.equal(current.proof_of_work_per_byte, '2');
    assert.equal(current.proof_of_work_override, 'true');
    assert.equal(current.reserved_blobs_total, '4'); assert.equal(current.reserved_debit_bytes_total, '256');
    assert.equal(current.confirmed_unblocked_blobs, '3'); assert.equal(current.blocked_addresses, '1');
    for (const bytes of [keep, repair, last]) await read(bytes);
    await blocked(block);
    expect(await request(`/b/${address(excess)}`), 404);
    for (const [proof, bytes] of [[state.spent, keep], [state.live, live]]) {
      assert.ok(validChallenge(proof?.challenge)); assert.ok(/^[0-9a-f]{16}$/.test(proof.nonce ?? ''));
      assert.equal(proof.challenge.address, address(bytes));
      assert.ok(proof.challenge.expires_at_ms > Date.now() + 120000, 'Verify before the original tickets expire; expiry would mask lost ticket state');
    }
    expect(await put(state.spent, keep), 503, 'uploads_paused');
    try {
      await admin('resume');
      expect(await put(state.spent, keep), 409, 'challenge_unavailable');
      const different = Buffer.from(live); different[0] ^= 1;
      // A live pre-restart ticket must reach body validation, even at full quota.
      expect(await put(state.live, different), 422, 'digest_mismatch');
      expect(await put(state.live, live), 409, 'challenge_unavailable');
      expect(await request(`/challenge/b/${address(block)}`, { method: 'POST' }), 410, 'blob_blocked');
      expect(await put(await ticket(excess), excess), 429, 'growth_limit');
    } finally { await admin('pause'); }
    console.log('Verified after restart: exact bytes, block, reservations, pause, work override and ticket state.');
    console.log('Uploads left paused. Verification consumes the saved live ticket; do not repeat it.');
  }
  console.log(`${requests} HTTP requests in ${Math.round(performance.now() - started)} ms (wall time, not billable CPU).`);
} finally { await file?.close(); }

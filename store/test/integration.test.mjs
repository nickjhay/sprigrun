import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel } from 'miniflare';

const TOKEN = 'a'.repeat(64);
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = bytes => `${digestOf(bytes)}_${Buffer.byteLength(bytes)}`;
const BINDINGS = {
  ADMIN_TOKEN: TOKEN, MAX_BLOB_BYTES: '128', MINIMUM_DEBIT_BYTES: '64',
  LONG_CAPACITY_BYTES: '256', BURST_CAPACITY_BYTES: '256',
  LONG_REFILL_BYTES_PER_DAY: '1', BURST_REFILL_BYTES_PER_HOUR: '1',
  ATTEMPT_CAPACITY: '1000', ATTEMPTS_PER_MINUTE: '1000',
  CHALLENGE_BURST: '1000', CHALLENGES_PER_MINUTE: '1000',
};

before(async () => {
  await build({ entryPoints: ['test/worker.ts'], outfile: 'dist/test-worker.mjs', bundle: true,
    format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:crypto'] });
});

function start(bindings = {}, persist, production = false) {
  const vars = Object.fromEntries(Object.entries({ ...BINDINGS, ...bindings }).map(([key, value]) => [key, { type: 'text', value }]));
  return new Miniflare({
    ...(persist ? { resourcePersistencePath: persist } : {}),
    cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
    workers: [{ config: {
      name: 'blob-test', compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm',
        contents: readFileSync(resolve(production ? 'dist/worker.mjs' : 'dist/test-worker.mjs'), 'utf8') } } },
      exports: { StoreCoordinator: { type: 'durable-object', storage: 'sqlite' } },
      env: { ...vars, BLOBS: { type: 'r2', name: 'BLOBS' },
        STORE: { type: 'durable-object', worker: 'blob-test', exportName: 'StoreCoordinator' } },
    } }],
  });
}

function use(t, bindings = {}, production = false) {
  const mf = start(bindings, undefined, production);
  t.after(() => mf.dispose());
  return mf;
}
const request = (mf, path, options) => mf.dispatchFetch(`https://blobs.example.test${path}`, options);
const issue = (mf, address) => request(mf, `/challenge/b/${address}`, { method: 'POST' });
// Independent oracle deliberately does not import the implementation's encoder.
const proofHash = (c, nonce) => digestOf([c.protocol,c.id,c.address,String(c.expires_at_ms),c.target,nonce,''].join('\n'));
function solve(c, start = 0) {
  for (let i=start; i<start+1000000; i++) {
    const nonce=i.toString(16).padStart(16,'0');
    if (BigInt('0x'+proofHash(c,nonce)) <= BigInt('0x'+c.target)) return nonce;
  }
  throw new Error('fixture solver exhausted');
}
const redeem = (mf, c, bytes, nonce=solve(c), headers={}) => request(mf, `/b/${c.address}`, { method:'PUT', body:bytes,
  headers:{ 'Content-Type':'text/plain; charset=utf-8', 'Blob-Ticket':c.id, 'Blob-Nonce':nonce, ...headers } });
const upload = async (mf, bytes, headers = {}) => {
  const issued = await issue(mf,hash(bytes));
  if (!issued.ok) return issued;
  return redeem(mf,await issued.json(),bytes,undefined,headers);
};
const stats = async mf => (await request(mf, '/__test/stats')).json();
const admin = (mf, path, token = TOKEN) => request(mf, `/admin/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

test('production entrypoint round-trips exact bytes, hash, HEAD and conditional GET', async t => {
  const mf = use(t, {}, true);
  const bytes = Buffer.from('\ufefffrom world.v4 import *\r\n# café\0\n');
  const digest = hash(bytes);
  const created = await upload(mf, bytes);
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(await created.json(), { address: digest, digest: digestOf(bytes), bytes: bytes.length, url: `/b/${digest}` });
  assert.equal(created.headers.get('Location'), `/b/${digest}`);
  assert.equal(created.headers.get('Cache-Control'), 'no-store');
  const read = await request(mf, `/b/${digest}`);
  assert.equal(read.status, 200);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
  assert.equal(read.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
  assert.equal(read.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(read.headers.get('X-Content-Type-Options'), 'nosniff');
  const head = await request(mf, `/b/${digest}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(bytes.length));
  assert.equal(await head.text(), '');
  const conditional = await request(mf, `/b/${digest}`, { headers: { 'If-None-Match': `W/"sha256-${digest}"` } });
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), '');
  assert.equal((await upload(mf, bytes)).status, 409);
  const root = await request(mf, '/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /confirmed_unblocked_blobs 1\n/);
  assert.equal((await request(mf, '/__test/stats')).status, 404);
});

test('simultaneous duplicate uploads create one receipt and one quota debit', async t => {
  const mf = use(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => upload(mf, 'same')));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 11);
  const state = await stats(mf);
  assert.equal(state.reserved_blobs_total, 1);
  assert.equal(state.reserved_debit_bytes_total, 64);
  assert.equal(state.confirmed_unblocked_bytes, 4);
});

test('new uploads need one R2 write; ambiguous retries verify the existing object', async t => {
  const mf = use(t);
  const calls = async () => (await request(mf, '/__test/storage-calls')).json();
  assert.equal((await upload(mf, 'new')).status, 201);
  assert.deepEqual(await calls(), { gets: 0, puts: 1 });
  assert.equal((await upload(mf, 'new')).status, 409);
  assert.deepEqual(await calls(), { gets: 0, puts: 1 });
  await request(mf, '/__test/fault/after-write');
  assert.equal((await upload(mf, 'retry')).status, 503);
  assert.deepEqual(await calls(), { gets: 0, puts: 2 });
  assert.equal((await upload(mf, 'retry')).status, 201);
  assert.deepEqual(await calls(), { gets: 1, puts: 3 });
  assert.equal((await stats(mf)).reserved_debit_bytes_total, 128);
  assert.equal(await (await request(mf, `/b/${hash('retry')}`)).text(), 'retry');
});

test('conditional publication never overwrites an existing tombstone or corrupt object', async t => {
  const mf = use(t), bucket = await mf.getR2Bucket('BLOBS');
  for (const [source, bytes, metadata, status] of [
    ['blocked', 'tombstone', { kind: 'blocked' }, 410],
    ['valid', 'wrong', { kind: 'blob', validation_policy: 'utf8-v1' }, 503],
  ]) {
    const key = `b/${hash(source)}`;
    await bucket.put(key, bytes, { customMetadata: metadata });
    assert.equal((await upload(mf, source)).status, status);
    const stored = await bucket.get(key);
    assert.equal(await stored.text(), bytes);
    assert.deepEqual(stored.customMetadata, metadata);
  }
  assert.equal((await stats(mf)).confirmed_unblocked_blobs, 0);
});

test('simultaneous distinct uploads cannot exceed either growth bucket', async t => {
  const mf = use(t);
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => upload(mf, `blob ${i}`)));
  assert.equal(responses.filter(r => r.status === 201).length, 4);
  assert.equal(responses.filter(r => r.status === 429).length, 6);
  const rejected = responses.find(r => r.status === 429);
  assert.ok(Number(rejected.headers.get('Retry-After')) > 0);
  const state = await stats(mf);
  assert.equal(state.reserved_debit_bytes_total, 256);
  assert.equal(state.confirmed_unblocked_blobs, 4);
});

for (const limiting of ['LONG_CAPACITY_BYTES', 'BURST_CAPACITY_BYTES']) {
  test(`${limiting} independently constrains admission`, async t => {
    const mf = use(t, { [limiting]: '128' });
    assert.equal((await upload(mf, 'a')).status, 201);
    assert.equal((await upload(mf, 'b')).status, 201);
    assert.equal((await upload(mf, 'c')).status, 429);
    assert.equal((await stats(mf)).reserved_debit_bytes_total, 128);
  });
}

test('invalid source uses attempt budget but never storage growth budget', async t => {
  const mf = use(t, { ATTEMPT_CAPACITY: '2', ATTEMPTS_PER_MINUTE: '1' });
  for (let i = 0; i < 2; i++) assert.equal((await upload(mf, new Uint8Array([255]))).status, 422);
  const rejected = await upload(mf, 'valid');
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error, 'attempt_limit');
  assert.equal((await stats(mf)).reserved_debit_bytes_total, 0);
});

test('concurrent attempts cannot spend the same global token twice', async t => {
  const mf = use(t, { ATTEMPT_CAPACITY: '3', ATTEMPTS_PER_MINUTE: '1' });
  const results = await Promise.all(Array.from({ length: 12 }, () => upload(mf, new Uint8Array([255]))));
  assert.equal(results.filter(r => r.status === 422).length, 3);
  assert.equal(results.filter(r => r.status === 429).length, 9);
  assert.equal((await stats(mf)).reserved_debit_bytes_total, 0);
});

test('HTTP limits, canonical routes and CORS', async t => {
  const mf = use(t);
  assert.equal((await upload(mf, 'x'.repeat(129))).status, 413);
  assert.equal((await upload(mf, 'x', { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await request(mf, '/b', { method: 'POST' })).status, 404);
  assert.equal((await request(mf, `/b/${'A'.repeat(64)}`)).status, 404);
  assert.equal((await request(mf, '/?x=1')).status, 400);
  assert.equal((await request(mf, `/b/${hash('x')}`, { method: 'OPTIONS', headers: { Origin: 'https://app.example.test' } })).status, 204);
  const missing = await request(mf, `/b/${'0'.repeat(64)}_0`, { headers: { 'If-None-Match': '*' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
  assert.equal(missing.headers.get('Access-Control-Allow-Origin'), '*');
});

test('source-only API exposes no grants and rejects credentialed uploads', async t => {
  const mf = use(t);
  assert.equal((await admin(mf, 'grants')).status, 404);
  const response = await upload(mf, 'source', { Authorization: `Bearer ${TOKEN}` });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'upload_authorization_not_supported');
  assert.equal((await stats(mf)).reserved_debit_bytes_total, 0);
});

test('empty blobs are valid but incur the minimum debit', async t => {
  const mf = use(t);
  assert.equal((await upload(mf, '')).status, 201);
  const read = await request(mf, `/b/${hash('')}`);
  assert.equal(read.status, 200);
  assert.equal(await read.text(), '');
  assert.equal((await stats(mf)).reserved_debit_bytes_total, 64);
});

test('a stored object with the wrong bytes fails closed', async t => {
  const mf = use(t);
  await upload(mf, 'original');
  const digest = hash('original');
  const bucket = await mf.getR2Bucket('BLOBS');
  await bucket.put(`b/${digest}`, 'tampered', {
    customMetadata: { kind: 'blob', validation_policy: 'utf8-v1' },
  });
  const read = await request(mf, `/b/${digest}`, { headers: { 'If-None-Match': '*' } });
  assert.equal(read.status, 503);
  assert.equal(read.headers.get('Cache-Control'), 'no-store');
  assert.equal((await upload(mf, 'original')).status, 409);
});

test('admin authentication, pause/resume, block and blocked re-upload', async t => {
  const mf = use(t);
  await upload(mf, 'source');
  const digest = hash('source');
  assert.equal((await admin(mf, 'pause', 'wrong')).status, 404);
  assert.equal((await admin(mf, 'pause', 'c'.repeat(64))).status, 404);
  assert.equal((await admin(mf, 'pause')).status, 200);
  assert.equal((await upload(mf, 'new')).status, 503);
  assert.equal((await request(mf, `/b/${digest}`)).status, 200);
  assert.equal((await admin(mf, 'resume')).status, 200);
  assert.equal((await admin(mf, `block/${digest}`)).status, 200);
  assert.equal((await admin(mf, `block/${digest}`)).status, 200);
  assert.equal((await request(mf, `/b/${digest}`, { headers: { 'If-None-Match': '*' } })).status, 410);
  assert.equal((await upload(mf, 'source')).status, 410);
  const state = await stats(mf);
  assert.equal(state.blocked_addresses, 1);
  assert.equal(state.confirmed_unblocked_blobs, 0);
  assert.equal(state.reserved_debit_bytes_total, 64);
});

test('admin endpoints are disabled without a valid configured secret', async t => {
  const mf = use(t, { ADMIN_TOKEN: '' });
  const response = await admin(mf, 'pause');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

for (const mode of ['before-write', 'after-write']) {
  test(`${mode} failure keeps a reservation and retries do not debit again`, async t => {
    const mf = use(t);
    await request(mf, `/__test/fault/${mode}`);
    assert.equal((await upload(mf, 'retry me')).status, 503);
    const interrupted = await stats(mf);
    assert.equal(interrupted.reserved_debit_bytes_total, 64);
    assert.equal(interrupted.confirmed_unblocked_blobs, 0);
    const readable = await request(mf, `/b/${hash('retry me')}`);
    assert.equal(readable.status, mode === 'after-write' ? 200 : 404);
    assert.equal((await upload(mf, 'retry me')).status, 201);
    assert.equal((await upload(mf, 'retry me')).status, 409);
    const repaired = await stats(mf);
    assert.equal(repaired.reserved_debit_bytes_total, 64);
    assert.equal(repaired.confirmed_unblocked_blobs, 1);
  });
}

test('failed origin block is reported, prevents publishing, and can be retried', async t => {
  const mf = use(t);
  await upload(mf, 'block me');
  const digest = hash('block me');
  await request(mf, '/__test/fault/before-block');
  assert.equal((await admin(mf, `block/${digest}`)).status, 503);
  // The R2 replacement failed: the old origin object still exists until retry.
  assert.equal((await request(mf, `/b/${digest}`)).status, 200);
  assert.equal((await upload(mf, 'block me')).status, 410);
  assert.equal((await admin(mf, `block/${digest}`)).status, 200);
  assert.equal((await request(mf, `/b/${digest}`)).status, 410);
});

test('blocking a digest wins against racing uploads and cannot be undone', async t => {
  const mf = use(t);
  const digest = hash('race');
  const results = await Promise.all([
    ...Array.from({ length: 8 }, () => upload(mf, 'race')),
    admin(mf, `block/${digest}`),
  ]);
  assert.equal(results.at(-1).status, 200);
  assert.ok(results.slice(0, -1).every(r => [409, 201, 410].includes(r.status)));
  assert.equal((await request(mf, `/b/${digest}`)).status, 410);
  assert.equal((await upload(mf, 'race')).status, 410);
});

test('GET ignores stale shared entries, and block needs no cache purge', async t => {
  const mf = use(t);
  await upload(mf, 'cache');
  const digest = hash('cache');
  const first = await request(mf, `/b/${digest}`);
  assert.equal(first.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
  await first.text();
  // A leftover entry from an older shared-cache deployment cannot bypass R2.
  const cache = (await mf.getCaches()).default;
  await cache.put(`https://blobs.example.test/b/${digest}`, new Response('cache', {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  }));
  const blocked = await admin(mf, `block/${digest}`);
  assert.deepEqual(await blocked.json(), { address: digest, origin_blocked: true });
  assert.equal((await request(mf, `/b/${digest}`)).status, 410);
});

test('quota reservations and tombstones survive a full runtime restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'blob-store-test-'));
  let mf = start({}, directory);
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  await request(mf, '/__test/fault/after-write');
  assert.equal((await upload(mf, 'pending')).status, 503);
  await upload(mf, 'blocked');
  await admin(mf, `block/${hash('blocked')}`);
  await mf.dispose();
  mf = start({}, directory);
  assert.equal((await stats(mf)).reserved_debit_bytes_total, 128);
  assert.equal((await upload(mf, 'pending')).status, 201);
  assert.equal((await stats(mf)).reserved_debit_bytes_total, 128);
  assert.equal((await request(mf, `/b/${hash('blocked')}`)).status, 410);
  assert.equal((await upload(mf, 'blocked')).status, 410);
});

test('source-only serving rejects raw, unknown and falsely labelled objects before conditional success', async t => {
  const mf = use(t);
  const bucket = await mf.getR2Bucket('BLOBS');
  for (const [bytes, metadata] of [
    [Buffer.from('binary-edition text'), { kind: 'blob', validation_policy: 'raw-v1' }],
    [Buffer.from('unknown policy'), { kind: 'blob', validation_policy: 'future-v1' }],
    [Buffer.from('missing metadata'), undefined],
    [Buffer.from([255]), { kind: 'blob', validation_policy: 'utf8-v1' }],
    [Buffer.from('é'), { kind: 'blob', validation_policy: 'ascii-v1' }],
  ]) {
    const digest = hash(bytes);
    await bucket.put(`b/${digest}`, bytes, { customMetadata: metadata });
    for (const method of ['GET', 'HEAD']) {
      const response = await request(mf, `/b/${digest}`, { method, headers: { 'If-None-Match': '*' } });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  }
});

test('older UTF-8 source remains readable after ASCII admission is enabled', async t => {
  const mf = use(t, { VALIDATION_POLICY: 'ascii-v1' });
  const bytes = Buffer.from('café');
  const bucket = await mf.getR2Bucket('BLOBS');
  await bucket.put(`b/${hash(bytes)}`, bytes, {
    customMetadata: { kind: 'blob', validation_policy: 'utf8-v1' },
  });
  const response = await request(mf, `/b/${hash(bytes)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await upload(mf, bytes)).status, 422);
});

test('blocking an empty blob changes its ETag and defeats an old conditional promotion', async t => {
  const mf = use(t);
  const bucket = await mf.getR2Bucket('BLOBS');
  await upload(mf, '');
  const key = `b/${hash('')}`;
  const old = await bucket.head(key);
  assert.equal((await admin(mf, `block/${hash('')}`)).status, 200);
  const staleWrite = await bucket.put(key, '', {
    onlyIf: new Headers({ 'If-Match': old.httpEtag }),
    customMetadata: { kind: 'blob', validation_policy: 'raw-v1' },
  });
  assert.equal(staleWrite, null);
  assert.equal((await request(mf, `/b/${hash('')}`)).status, 410);
});

test('one valid proof admits exactly one concurrent body, even with different valid nonces', async t => {
  const mf=use(t,{PROOF_OF_WORK_BITS:'5'});
  const c=await (await issue(mf,hash('same'))).json();
  const n1=solve(c), n2=solve(c,parseInt(n1,16)+1);
  const responses=await Promise.all(Array.from({length:12},(_,i)=>redeem(mf,c,'same',i%2?n1:n2)));
  assert.equal(responses.filter(r=>r.status===201).length,1);
  assert.equal(responses.filter(r=>r.status===409).length,11);
  assert.equal((await stats(mf)).outstanding_challenges,0);
  assert.equal((await stats(mf)).reserved_debit_bytes_total,64);
});

test('wrong body hash consumes the ticket but never reserves or poisons the address', async t => {
  const mf=use(t);
  const c=await (await issue(mf,hash('real'))).json();
  const bad=await redeem(mf,c,'fake');
  assert.equal(bad.status,422); assert.equal((await bad.json()).error,'digest_mismatch');
  assert.equal((await redeem(mf,c,'real')).status,409);
  assert.equal((await stats(mf)).reserved_debit_bytes_total,0);
  assert.equal((await upload(mf,'real')).status,201);
});

test('invalid source and incorrect actual length consume tickets', async t => {
  const mf=use(t);
  for (const [advertised,body,error] of [['longer','short','length_mismatch'],[Buffer.from([255]),Buffer.from([255]),'invalid_utf8']]) {
    const c=await (await issue(mf,hash(advertised))).json();
    const r=await redeem(mf,c,body); assert.equal(r.status,422); assert.equal((await r.json()).error,error);
    assert.equal((await redeem(mf,c,advertised)).status,409);
  }
  assert.equal((await stats(mf)).reserved_debit_bytes_total,0);
});

test('bad, replayed and wrong-address proofs are rejected before reading a body', async t => {
  const mf=use(t,{PROOF_OF_WORK_BITS:'8'});
  const c=await (await issue(mf,hash('x'))).json();
  let weak=0;
  while(BigInt('0x'+proofHash(c,weak.toString(16).padStart(16,'0')))<=BigInt('0x'+c.target)) weak++;
  const probe=nonce=>request(mf,'/__test/probe',{headers:{'Test-Path':`/b/${c.address}`,'Blob-Ticket':c.id,'Blob-Nonce':nonce}});
  const bad=await probe(weak.toString(16).padStart(16,'0'));
  assert.equal(bad.status,422); assert.equal(bad.headers.get('Test-Body-Pulls'),'0');
  const problem=await bad.json(); assert.match(problem.message,/Do not change the source bytes/);
  assert.equal(problem.proof_of_work.target,c.target);
  assert.equal((await stats(mf)).outstanding_challenges,1);
  assert.equal((await redeem(mf,{...c,address:hash('y')},'y',solve(c))).status,400);
  assert.equal((await redeem(mf,c,'x')).status,201);
  const replay=await probe(solve(c)); assert.equal(replay.status,409); assert.equal(replay.headers.get('Test-Body-Pulls'),'0');
});

test('issuance rate and outstanding capacity independently bound abandoned tickets', async t => {
  const mf=use(t,{CHALLENGE_BURST:'3',CHALLENGES_PER_MINUTE:'1',CHALLENGE_CAPACITY:'2'});
  assert.equal((await issue(mf,hash('a'))).status,201);
  assert.equal((await issue(mf,hash('b'))).status,201);
  let r=await issue(mf,hash('c')); assert.equal((await r.json()).error,'challenge_table_full');
  r=await issue(mf,hash('d')); assert.equal((await r.json()).error,'challenge_rate_limit');
  assert.equal((await stats(mf)).outstanding_challenges,2);
  assert.equal((await stats(mf)).reserved_debit_bytes_total,0);
  const bucket=await mf.getR2Bucket('BLOBS'); assert.equal((await bucket.list()).objects.length,0);
});

test('expired records reject proofs and are reclaimed before allocating a new ticket', async t => {
  const mf=use(t,{CHALLENGE_CAPACITY:'1'});
  const c=await (await issue(mf,hash('a'))).json();
  assert.equal((await issue(mf,hash('b'))).status,429);
  await request(mf,'/__test/expire');
  assert.equal((await redeem(mf,c,'a')).status,409);
  assert.equal((await issue(mf,hash('b'))).status,201);
  assert.equal((await stats(mf)).outstanding_challenges,1);
});

test('concurrent issuance cannot overrun its persistent global bucket', async t => {
  const mf=use(t,{CHALLENGE_BURST:'3',CHALLENGES_PER_MINUTE:'1'});
  const rs=await Promise.all(Array.from({length:12},(_,i)=>issue(mf,hash(`x${i}`))));
  assert.equal(rs.filter(r=>r.status===201).length,3);
  assert.equal(rs.filter(r=>r.status===429).length,9);
});

test('fixed and per-byte work are pinned in outstanding tickets across live admin changes', async t => {
  const mf=use(t,{PROOF_OF_WORK_BITS:'4',PROOF_OF_WORK_PER_BYTE:'2'});
  const c=await (await issue(mf,hash('abc'))).json();
  assert.equal(BigInt('0x'+c.target)+1n,(1n<<256n)/22n);
  assert.equal((await admin(mf,'pow/12/8')).status,200);
  const c2=await (await issue(mf,hash('abc'))).json();
  assert.equal(BigInt('0x'+c2.target)+1n,(1n<<256n)/4120n);
  assert.equal((await redeem(mf,c,'abc')).status,201,'old offer honored');
  assert.equal((await redeem(mf,c2,'abc')).status,409,'address already written');
  assert.equal((await admin(mf,'pow/default')).status,200);
  assert.equal((await stats(mf)).proof_of_work_bits,4);
  assert.equal((await stats(mf)).proof_of_work_per_byte,2);
  assert.equal((await admin(mf,'pow/256/1')).status,400);
  assert.equal((await admin(mf,'pow/04')).status,400);
  assert.equal((await admin(mf,'pow/8','wrong')).status,404);
});

test('outstanding tickets, consumed-ticket absence and issuance credits survive restarts', async t => {
  const dir=await mkdtemp(join(tmpdir(),'tickets-'));
  let mf=start({CHALLENGE_BURST:'3',CHALLENGES_PER_MINUTE:'1'},dir);
  t.after(async()=>{await mf.dispose();await rm(dir,{recursive:true,force:true});});
  const spent=await (await issue(mf,hash('real'))).json();
  const live=await (await issue(mf,hash('live'))).json();
  await redeem(mf,spent,'fake');
  await admin(mf,'pow/5/4');
  await mf.dispose(); mf=start({CHALLENGE_BURST:'3',CHALLENGES_PER_MINUTE:'1',PROOF_OF_WORK_BITS:'6'},dir);
  assert.equal((await stats(mf)).proof_of_work_bits,5);
  assert.equal((await stats(mf)).proof_of_work_per_byte,4);
  assert.equal((await redeem(mf,spent,'real')).status,409);
  assert.equal((await redeem(mf,live,'live')).status,201);
  assert.equal((await issue(mf,hash('third'))).status,201);
  assert.equal((await issue(mf,hash('fourth'))).status,429);
  await admin(mf,'pow/default'); assert.equal((await stats(mf)).proof_of_work_bits,6);
});

test('permanent receipts refuse recreating an evicted object; no public write bypass', async t => {
  const mf=use(t);
  await upload(mf,'written');
  const bucket=await mf.getR2Bucket('BLOBS'); await bucket.delete(`b/${hash('written')}`);
  assert.equal((await issue(mf,hash('written'))).status,409);
  assert.equal((await request(mf,`/b/${hash('new')}`,{method:'PUT',body:'new'})).status,400);
  assert.equal((await request(mf,'/b',{method:'POST',body:'new'})).status,404);
  for (const s of ['_01','_+1','_1.0','_1048577']) assert.equal((await request(mf,`/challenge/b/${digestOf('x')}${s}`,{method:'POST'})).status,404);
});

test('real upload, smoke and admin CLIs work against the production entrypoint', async t => {
  const mf=use(t,{},true), base=(await mf.ready).origin;
  const dir=await mkdtemp(join(tmpdir(),'upload-cli-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'world.sprig'); const bytes=Buffer.from('\ufeffx = 1\r\n'); await writeFile(file,bytes);
  const options={env:{...process.env,BLOB_STORE_URL:base,BLOB_STORE_ADMIN_TOKEN:TOKEN}};
  const run=promisify(execFile);
  assert.match((await run(process.execPath,['scripts/admin.mjs','pow','5','2'],options)).stdout,/"proof_of_work_per_byte":2/);
  for (let i=0;i<2;i++) assert.equal((await run(process.execPath,['scripts/upload.mjs',file],options)).stdout.trim(),hash(bytes));
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/b/${hash(bytes)}`)).arrayBuffer()),bytes);
  assert.match((await run(process.execPath,['scripts/smoke.mjs'],options)).stdout,/Verified challenge/);
  assert.match((await run(process.execPath,['scripts/admin.mjs','pow','default'],options)).stdout,/"proof_of_work_bits":0/);
  await assert.rejects(run(process.execPath,['scripts/admin.mjs','pow','257'],options));
});

test('v0.4 state is rejected rather than silently resetting quotas and block records', async t => {
  const dir=await mkdtemp(join(tmpdir(),'schema-'));
  let mf=start({},dir);
  t.after(async()=>{await mf.dispose();await rm(dir,{recursive:true,force:true});});
  await request(mf,'/__test/legacy'); await mf.dispose(); mf=start({},dir,true);
  assert.equal((await issue(mf,hash('x'))).status,503);
});

test('body timeout and oversized actual stream each spend one proof without claiming the address', async t => {
  const mf=use(t,{UPLOAD_TIMEOUT_MS:'100'});
  for (const stall of [true,false]) {
    const c=await (await issue(mf,hash('x'))).json();
    const r=await request(mf,'/__test/probe',{headers:{'Test-Path':`/b/${c.address}`,'Blob-Ticket':c.id,'Blob-Nonce':solve(c),...(stall?{'Test-Stall':'1'}:{})}});
    assert.equal(r.status,stall?408:413);
    assert.ok(Number(r.headers.get('Test-Body-Pulls'))>0);
    assert.equal((await redeem(mf,c,'x')).status,409);
    assert.equal((await stats(mf)).reserved_debit_bytes_total,0);
  }
  assert.equal((await upload(mf,'x')).status,201);
});

test('read length mismatches fail before GET/HEAD conditional success',async t=>{
  const mf=use(t), bucket=await mf.getR2Bucket('BLOBS');
  const address=`${digestOf('x')}_2`;
  await bucket.put(`b/${address}`,'x',{customMetadata:{kind:'blob',validation_policy:'utf8-v1'}});
  for (const method of ['GET','HEAD']) assert.equal((await request(mf,`/b/${address}`,{method,headers:{'If-None-Match':'*'}})).status,503);
});

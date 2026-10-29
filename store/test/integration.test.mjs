import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { verify as verifyArchive, budget } from '../scripts/recover.mjs';
import { progress, advance, complete } from '../src/recovery-format.ts';
import { demoSources } from '../../src/examples.ts';
import { interpret } from '../../src/moss/interpreter.ts';

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
    format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:crypto','node:buffer'] });
});

function start(bindings = {}, persist, production = false, port) {
  const vars = Object.fromEntries(Object.entries({ ...BINDINGS, ...bindings }).map(([key, value]) => [key, { type: 'text', value }]));
  return new Miniflare({
    ...(port === undefined ? {} : { port }),
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
const receipt = async (mf, bytes) => (await request(mf, `/__test/receipt/${hash(bytes)}`)).json();
const post = (mf, bytes, headers = {}) => request(mf, '/b', { method: 'POST', body: bytes,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
const admin = (mf, path, token = TOKEN) => request(mf, `/admin/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

test('documentation discovery works without a usable store and verifies the exact skill bytes', async t => {
  // Invalid storage configuration proves that these routes do not initialize the
  // coordinator or require its live policy. Use the actual deployed entrypoint.
  const mf = use(t, { MAX_BLOB_BYTES: 'invalid' }, true);
  const help = await request(mf, '/help');
  assert.equal(help.status, 200);
  const instructions = await help.text();
  assert.match(instructions, /--data-binary @world\.sprig/);
  assert.match(instructions, /POST \/challenge\/b\/\{address\}/);
  assert.match(instructions, /nonce \+ "\\n"/);

  const index = await (await request(mf, '/.well-known/agent-skills/index.json')).json();
  assert.equal(index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  assert.equal(index.skills.length, 1);
  const entry = index.skills[0];
  assert.equal(entry.type, 'skill-md');
  const skill = await request(mf, entry.url);
  const artifact = Buffer.from(await skill.arrayBuffer());
  assert.equal(entry.digest, `sha256:${digestOf(artifact)}`);
  assert.equal(artifact.toString(), `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n\n${instructions}`);

  const llms = await (await request(mf, '/llms.txt')).text();
  const links = [...llms.matchAll(/\]\((\/[^)]*)\)/g)].map(match => match[1]);
  // The root is deliberately broken in this fixture; every documentation link
  // must still resolve, with proper HEAD, CORS and method/error semantics.
  for (const path of links.filter(path => path !== '/')) {
    const get = await request(mf, path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get('Cache-Control'), 'public, max-age=300');
    assert.equal(get.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(get.headers.get('Access-Control-Expose-Headers'), /\bLink\b/);
    assert.match(get.headers.get('Link'), /<\/help>; rel="help service-doc"/);
    assert.match(get.headers.get('Link'), /rel="api-catalog"/);
    assert.equal(get.headers.get('X-Content-Type-Options'), 'nosniff');
    const head = await request(mf, path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Type'), get.headers.get('Content-Type'));
    assert.equal(await head.text(), '');
    const options = await request(mf, path, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
    const wrong = await request(mf, path, { method: 'POST', body: 'unused' });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('Allow'), 'GET, HEAD, OPTIONS');
    assert.equal((await wrong.json()).help, '/help');
  }
  const catalogResponse = await request(mf, '/.well-known/api-catalog');
  assert.equal(catalogResponse.headers.get('Content-Type'), 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"');
  const catalog = await catalogResponse.json();
  assert.equal(catalog.linkset[0].item[0].href, 'https://blobs.example.test/b');
  assert.equal(catalog.linkset[1].anchor, 'https://blobs.example.test/b');
  assert.equal(catalog.linkset[1]['service-doc'][0].href, 'https://blobs.example.test/help');
  const local = await mf.dispatchFetch('http://localhost:8787/.well-known/api-catalog');
  assert.equal((await local.json()).linkset[1]['service-doc'][0].href, 'http://localhost:8787/help');
  assert.equal((await request(mf, '/help?unexpected=true')).status, 400);
  assert.equal((await request(mf, '/')).status, 503);
});

test('root stats and errors advertise help without losing statuses or retry delays', async t => {
  const mf = use(t, {}, true);
  const root = await request(mf, '/');
  assert.match(await root.text(), /^help \/help\n/);
  for (const path of ['/unknown', '/.well-known/agent-skills/missing/SKILL.md']) {
    const absent = await request(mf, path);
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).help, '/help');
  }
  const method = await request(mf, '/b');
  assert.equal(method.status, 405);
  assert.equal((await method.json()).help, '/help');
  await admin(mf, 'pow/1/0');
  const proof = await post(mf, 'source');
  assert.equal(proof.status, 428);
  const detail = await proof.json();
  assert.equal(detail.help, '/help');
  assert.match(detail.message, /solve|search/i);
  await admin(mf, 'pause');
  const paused = await post(mf, 'source');
  assert.equal(paused.status, 503);
  const error = await paused.json();
  assert.equal(error.help, '/help');
  assert.equal(error.retry_after_seconds, Number(paused.headers.get('Retry-After')));
  assert.ok(error.retry_after_seconds > 0);
  assert.equal((await request(mf, '/help')).status, 200);
});

test('production entrypoint round-trips exact bytes, hash, HEAD and conditional GET', async t => {
  const mf = use(t, {}, true);
  const bytes = Buffer.from('\ufefffrom world.v4 import *\r\n# café\0\n');
  const digest = hash(bytes);
  const created = await upload(mf, bytes);
  assert.equal(created.status, 201, await created.clone().text());
  const result = await created.json();
  assert.ok(Number.isSafeInteger(result.submitted_at_ms) && result.submitted_at_ms > 0);
  assert.deepEqual(result, { address: digest, digest: digestOf(bytes), bytes: bytes.length, url: `/b/${digest}`, submitted_at_ms: result.submitted_at_ms });
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

test('plain POST computes identity, returns original timestamp and is idempotent without tickets', async t => {
  const mf=use(t), bytes=Buffer.from('\ufeffprint("café")\r\n\0'), before=Date.now();
  const created=await post(mf,bytes);
  assert.equal(created.status,201);
  const first=await created.json();
  assert.deepEqual(first,{address:hash(bytes),digest:digestOf(bytes),bytes:bytes.length,url:`/b/${hash(bytes)}`,submitted_at_ms:first.submitted_at_ms});
  assert.ok(first.submitted_at_ms>=before && first.submitted_at_ms<=Date.now());
  assert.equal(created.headers.get('Location'),first.url);
  assert.equal(created.headers.get('Access-Control-Allow-Origin'),'*');
  const bucket=await mf.getR2Bucket('BLOBS'), object=await bucket.get(`b/${hash(bytes)}`);
  assert.deepEqual(Buffer.from(await object.arrayBuffer()),bytes);
  assert.equal(object.customMetadata.submitted_at_ms,String(first.submitted_at_ms));
  const duplicates=await Promise.all(Array.from({length:6},()=>post(mf,bytes)));
  for(const duplicate of duplicates){assert.equal(duplicate.status,200);assert.deepEqual(await duplicate.json(),first);}
  assert.equal((await stats(mf)).reserved_debit_bytes_total,64);
  assert.equal((await stats(mf)).outstanding_challenges,0);
  assert.deepEqual(await (await request(mf,'/__test/storage-calls')).json(),{gets:6,puts:1});
  assert.equal((await post(mf,'')).status,201);
});

test('concurrent direct POSTs respect growth and attempt limits', async t => {
  const mf=use(t);
  const results=await Promise.all(Array.from({length:10},(_,i)=>post(mf,`source ${i}`)));
  assert.equal(results.filter(r=>r.status===201).length,4);
  assert.equal(results.filter(r=>r.status===429).length,6);
  assert.equal((await stats(mf)).reserved_debit_bytes_total,256);
  const limited=use(t,{ATTEMPT_CAPACITY:'2',ATTEMPTS_PER_MINUTE:'1'});
  const invalid=await Promise.all(Array.from({length:5},()=>post(limited,new Uint8Array([255]))));
  assert.equal(invalid.filter(r=>r.status===422).length,2);
  assert.equal(invalid.filter(r=>r.status===429).length,3);
  assert.equal((await stats(limited)).reserved_blobs_total,0);
});

test('POST refuses work, pause and exhausted admission before reading the body', async t => {
  const mf=use(t);
  for(const policy of ['pow/1/0','pow/0/1','pause']){
    await admin(mf,policy);
    const response=await request(mf,'/__test/probe',{headers:{'Test-Path':'/b','Test-Method':'POST'}});
    assert.equal(response.status,policy==='pause'?503:428);
    assert.equal(response.headers.get('Test-Body-Pulls'),'0');
    if(policy!=='pause')assert.match((await response.json()).message,/POST \/challenge\/b\//);
  }
  await admin(mf,'resume'); await admin(mf,'pow/0/0');
  assert.equal((await post(mf,'allowed')).status,201);
  const limited=use(t,{ATTEMPT_CAPACITY:'1',ATTEMPTS_PER_MINUTE:'1'});
  await post(limited,'one');
  const response=await request(limited,'/__test/probe',{headers:{'Test-Path':'/b','Test-Method':'POST'}});
  assert.equal(response.status,429); assert.equal(response.headers.get('Test-Body-Pulls'),'0');
});

test('POST rechecks a work requirement introduced during body reading', async t => {
  const mf=use(t);
  const response=await request(mf,'/__test/probe',{headers:{'Test-Path':'/b','Test-Method':'POST','Test-Pow-On-Read':'1','Test-Body':'race'}});
  assert.equal(response.status,428); assert.equal(response.headers.get('Test-Body-Pulls'),'1');
  assert.equal((await stats(mf)).reserved_blobs_total,0);
  assert.equal((await request(mf,`/b/${hash('race')}`)).status,404);
});

test('direct POST bounds actual streams, refuses compressed bodies and never bypasses blocks', async t => {
  const mf=use(t,{UPLOAD_TIMEOUT_MS:'100'});
  for(const stall of [true,false]){
    const response=await request(mf,'/__test/probe',{headers:{'Test-Path':'/b','Test-Method':'POST',...(stall?{'Test-Stall':'1'}:{})}});
    assert.equal(response.status,stall?408:413);
  }
  assert.equal((await post(mf,'encoded',{'Content-Encoding':'gzip'})).status,415);
  assert.equal((await post(mf,'x',{Authorization:'Bearer unexpected'})).status,400);
  const created=await (await post(mf,'blocked')).json();
  const race=await Promise.all([post(mf,'blocked'),admin(mf,`block/${hash('blocked')}`),post(mf,'blocked')]);
  assert.ok(race.every(r=>[200,410].includes(r.status)));
  assert.equal((await post(mf,'blocked')).status,410);
  assert.equal((await request(mf,`/b/${hash('blocked')}`)).status,410);
  const tombstone=await (await mf.getR2Bucket('BLOBS')).head(`b/${hash('blocked')}`);
  assert.equal(tombstone.customMetadata.submitted_at_ms,String(created.submitted_at_ms));
  assert.equal((await stats(mf)).reserved_blobs_total,1);
});

for(const mode of ['before-write','after-write']){
  test(`submission timestamp survives ${mode}, restart and idempotent repair`,async t=>{
    const directory=await mkdtemp(join(tmpdir(),'submitted-at-'));
    let mf=start({},directory);
    t.after(async()=>{await mf.dispose();await rm(directory,{recursive:true,force:true});});
    await request(mf,`/__test/fault/${mode}`);
    assert.equal((await post(mf,'retry')).status,503);
    const original=await receipt(mf,'retry');
    assert.ok(Number.isSafeInteger(original.submitted_at_ms));
    await mf.dispose(); mf=start({},directory);
    const repaired=await post(mf,'retry'); assert.equal(repaired.status,201);
    assert.equal((await repaired.json()).submitted_at_ms,original.submitted_at_ms);
    const duplicate=await post(mf,'retry'); assert.equal(duplicate.status,200);
    assert.equal((await duplicate.json()).submitted_at_ms,original.submitted_at_ms);
    const object=await (await mf.getR2Bucket('BLOBS')).head(`b/${hash('retry')}`);
    assert.equal(object.customMetadata.submitted_at_ms,String(original.submitted_at_ms));
    assert.equal((await stats(mf)).reserved_debit_bytes_total,64);
  });
}

test('v0.5 timestamp migration retains quota and blocks without inventing history',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'timestamp-migration-'));
  let mf=start({},directory);
  t.after(async()=>{await mf.dispose();await rm(directory,{recursive:true,force:true});});
  const old='café';
  await post(mf,old); await admin(mf,`block/${hash('blocked')}`);
  // Simulate the pre-field schema and original object metadata, then upgrade.
  await (await mf.getR2Bucket('BLOBS')).put(`b/${hash(old)}`,old,{customMetadata:{kind:'blob',sha256:digestOf(old),validation_policy:'utf8-v1'}});
  await request(mf,'/__test/forget-times');
  await mf.dispose(); mf=start({VALIDATION_POLICY:'ascii-v1'},directory);
  // A stricter policy for new uploads must not break an existing object's identity.
  const duplicate=await post(mf,old); assert.equal(duplicate.status,200);
  assert.equal((await duplicate.json()).submitted_at_ms,null);
  assert.equal((await post(mf,'blocked')).status,410);
  assert.equal((await stats(mf)).reserved_debit_bytes_total,64);
  assert.ok(Number.isSafeInteger((await (await post(mf,'new')).json()).submitted_at_ms));
});

test('a duplicate or pending repair refuses corrupt submission metadata',async t=>{
  const mf=use(t), bucket=await mf.getR2Bucket('BLOBS');
  for(const pending of [false,true]){
    const source=pending?'pending':'stored';
    if(pending)await request(mf,'/__test/fault/after-write');
    assert.equal((await post(mf,source)).status,pending?503:201);
    await bucket.put(`b/${hash(source)}`,source,{customMetadata:{kind:'blob',sha256:digestOf(source),validation_policy:'utf8-v1',submitted_at_ms:'1'}});
    assert.equal((await post(mf,source)).status,503);
    assert.equal((await bucket.head(`b/${hash(source)}`)).customMetadata.submitted_at_ms,'1');
  }
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
  assert.equal((await request(mf, '/b', { method: 'POST' })).status, 201);
  assert.equal((await request(mf, '/b')).status, 405);
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
  assert.equal(c.message_prefix,[c.protocol,c.id,c.address,String(c.expires_at_ms),c.target,''].join('\n'));
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
  assert.equal((await post(mf,'written')).status,503);
  await admin(mf,'pow/1/0');
  assert.equal((await post(mf,'new')).status,428);
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
  assert.match((await run(process.execPath,['scripts/smoke.mjs'],options)).stdout,/Verified source/);
  assert.match((await run(process.execPath,['scripts/admin.mjs','pow','default'],options)).stdout,/"proof_of_work_bits":0/);
  const curl=await run('curl',['--silent','--show-error','--fail-with-body','--max-time','15','-H','Content-Type: text/plain; charset=utf-8','--data-binary',`@${file}`,`${base}/b`]);
  assert.equal(JSON.parse(curl.stdout).address,hash(bytes));
  assert.match((await run(process.execPath,['scripts/admin.mjs','pause'],{
    env:{...options.env,BLOB_STORE_ADMIN_TOKEN:undefined,ADMIN_TOKEN:TOKEN},
  })).stdout,/"uploads_paused":true/);
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

test('deployment rehearsal refuses missing consent, credentials and a production-sized profile', async t => {
  const mf = use(t, { LONG_CAPACITY_BYTES: '209715200' }, true);
  const base = (await mf.ready).origin;
  const dir = await mkdtemp(join(tmpdir(), 'rehearsal-guards-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const env = { ...process.env, BLOB_STORE_URL: base, BLOB_STORE_ADMIN_TOKEN: TOKEN };
  const run = promisify(execFile);
  for (const [args, overrides, message] of [
    [['prepare', file], {}, /disposable/],
    [['prepare', file, '--disposable'], { BLOB_STORE_ADMIN_TOKEN: '' }, /BLOB_STORE_ADMIN_TOKEN/],
    [['prepare', file, '--disposable'], {}, /Not the disposable rehearsal profile/],
    [['prepare', file, '--disposable'], { BLOB_STORE_URL: base + '/path' }, /bare origin/],
  ]) await assert.rejects(run(process.execPath, ['scripts/rehearse.mjs', ...args], { env: { ...env, ...overrides } }), error => {
    assert.match(error.stderr, message); return true;
  });
  assert.equal((await request(mf, '/__test/stats')).status, 404);
  assert.match(await (await request(mf, '/')).text(), /reserved_blobs_total 0\n/);
});

test('real deployment rehearsal verifies production storage across a full restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'store-rehearsal-'));
  const profile = { PROOF_OF_WORK_BITS: '4', PROOF_OF_WORK_PER_BYTE: '1', CHALLENGE_TTL_SECONDS: '3600' };
  let mf = start(profile, join(directory, 'storage'), true);
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const base = await mf.ready;
  const stateFile = join(directory, 'state.rehearsal.json');
  const options = { env: { ...process.env, BLOB_STORE_URL: base.origin, BLOB_STORE_ADMIN_TOKEN: undefined, ADMIN_TOKEN: TOKEN }, timeout: 120000 };
  const run = promisify(execFile);
  const prepared = await run(process.execPath, ['scripts/rehearse.mjs', 'prepare', stateFile, '--disposable'], options);
  assert.match(prepared.stdout, /uploads left paused/);
  assert.ok(!readFileSync(stateFile, 'utf8').includes(TOKEN));
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const keep = `# keep ${state.seed}\n`;
  assert.equal((await request(mf, `/b/${hash(keep)}`)).status, 200);
  await mf.dispose();
  mf = start(profile, join(directory, 'storage'), true, Number(base.port));
  await mf.ready;
  const verified = await run(process.execPath, ['scripts/rehearse.mjs', 'verify', stateFile, '--disposable'], options);
  assert.match(verified.stdout, /Verified after restart/);
  assert.match(await (await request(mf, '/')).text(), /uploads_paused true\n/);
});

const recover = (mf, action, data = {}, token = TOKEN) => request(mf, `/admin/recovery/${action}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: typeof data === 'string' ? data : JSON.stringify(data),
});
const control = async mf => (await request(mf, '/__test/control')).json();
async function snapshot(mf) {
  const begun = await recover(mf, 'snapshot/begin'); assert.equal(begun.status, 200, await begun.clone().text());
  const header = await begun.json(), records = []; let state = progress(header);
  for (;;) {
    const { addresses } = await (await recover(mf, 'snapshot/page', { id: header.id, after: state.after })).json();
    if (!addresses.length) break;
    for (const address of addresses) {
      const response = await recover(mf, 'snapshot/object', { id: header.id, address });
      assert.equal(response.status, 200, await response.clone().text());
      const record = await response.json(), line = JSON.stringify(record);
      records.push(record); state = advance(state, record.receipt, line);
    }
  }
  complete(header, state, state.chain);
  return { header, records, chain: state.chain };
}
const beginRestore = (mf, s) => recover(mf, 'restore/begin', { header: s.header, chain: s.chain });
const finishRestore = (mf, s) => recover(mf, 'restore/finish', { id: s.header.id, chain: s.chain });
const cli = promisify(execFile);
async function recoveryCLI(mf, ...args) {
  return cli(process.execPath, ['scripts/recover.mjs', ...args], { timeout: 120000,
    env: { ...process.env, BLOB_STORE_URL: (await mf.ready).origin, BLOB_STORE_ADMIN_TOKEN: TOKEN } });
}

test('snapshot freeze survives restart, excludes in-flight publication, and locks all administrative mutations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sprig-freeze-'));
  let mf = start({}, dir); t.after(async () => { await mf.dispose(); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await recover(mf, 'snapshot/begin', {}, 'bad')).status, 404);
  assert.equal((await recover(mf, 'restore/begin')).status, 404);
  const source = 'freeze before body publication';
  const result = await request(mf, '/__test/probe', { headers: {
    'Test-Path': '/b', 'Test-Method': 'POST', 'Test-Body': source, 'Test-Freeze-On-Read': '1',
  } });
  assert.equal(result.status, 503);
  assert.equal((await stats(mf)).reserved_blobs_total, 0);
  const first = await snapshot(mf);
  await mf.dispose(); mf = start({}, dir);
  assert.deepEqual((await snapshot(mf)).header, first.header);
  for (const path of ['pause', 'resume', 'pow/3/0', `block/${hash(source)}`])
    assert.equal((await admin(mf, path)).status, 409, path);
  assert.equal((await post(mf, source)).status, 503);
  assert.equal((await issue(mf, hash(source))).status, 503);
  assert.equal((await recover(mf, 'snapshot/end', { id: '0'.repeat(64) })).status, 400);
  assert.equal((await recover(mf, 'snapshot/end', { id: first.header.id })).status, 200);
  assert.equal((await post(mf, source)).status, 503);
  assert.equal((await admin(mf, 'resume')).status, 200);
  assert.equal((await post(mf, source)).status, 201);
});

test('a lost local store finds the fern, original history, quotas and blocks through the real recovery CLI', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sprig-lost-fern-')), archive = join(dir, 'fern.jsonl');
  const sourceDir = join(dir, 'lost'), targetDir = join(dir, 'found');
  const vars = { MAX_BLOB_BYTES: '8192', MINIMUM_DEBIT_BYTES: '64', LONG_CAPACITY_BYTES: '65536', BURST_CAPACITY_BYTES: '65536' };
  let source = start(vars, sourceDir, true), target;
  t.after(async () => { if (source) await source.dispose(); if (target) await target.dispose(); await rm(dir, { recursive: true, force: true }); });
  const demo = await demoSources(), originals = [demo.fernProgram, demo.fernLibrary, '\ufeff# original bytes\r\n"moss 🌿"\u0000\r\n'];
  const submissions = new Map();
  for (const text of originals) {
    const response = await post(source, text); assert.equal(response.status, 201);
    submissions.set(hash(text), (await response.json()).submitted_at_ms);
  }
  const blocked = 'suppressed fern note', never = hash('unseen blocked address');
  assert.equal((await post(source, blocked)).status, 201);
  assert.equal((await admin(source, `block/${hash(blocked)}`)).status, 200);
  assert.equal((await admin(source, `block/${never}`)).status, 200);
  const ticket = await (await issue(source, hash('outstanding'))).json();
  assert.equal((await admin(source, 'pow/3/2')).status, 200);
  const exported = await recoveryCLI(source, 'export', archive);
  assert.match(exported.stdout, /Source remains frozen/);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  await assert.rejects(recoveryCLI(source, 'export', archive), /EEXIST/);
  const saved = await verifyArchive(archive); assert.equal(saved.count, 5);
  const archived = await readFile(archive, 'utf8');
  assert.ok(!archived.includes(ticket.id) && !archived.includes(TOKEN));
  assert.ok(!archived.includes(Buffer.from(blocked).toString('base64')));
  assert.equal((await request(source, `/b/${demo.fernProgramAddress}`)).status, 200);
  assert.equal((await post(source, 'new source')).status, 503);
  // Allocate the empty target while the source still owns its port, so the OS
  // cannot reuse that origin and trip the CLI's separate-origin guard.
  target = start({ ...vars, RESTORE_MODE: '1' }, targetDir, true);
  await target.ready;
  await source.dispose(); source = undefined;
  await rm(sourceDir, { recursive: true, force: true }); // Lose R2 and SQL, not just the process.

  assert.equal((await request(target, '/')).status, 503);
  assert.equal((await request(target, '/help')).status, 200);
  assert.match((await recoveryCLI(target, 'restore', archive, '--empty-target')).stdout, /"complete":true/);
  assert.equal((await request(target, `/b/${demo.fernProgramAddress}`)).status, 503);
  assert.equal((await admin(target, 'resume')).status, 409);
  await target.dispose(); target = start({ ...vars, RESTORE_MODE: '1' }, targetDir);
  await recoveryCLI(target, 'restore', archive, '--empty-target');
  const restoredControl = await control(target);
  for (const key of ['reservedBlobs', 'reservedBytes', 'confirmedBlobs', 'confirmedBytes', 'blockedAddresses', 'proofOfWorkBits', 'proofOfWorkPerByte'])
    assert.equal(restoredControl[key], saved.header.control[key], key);
  for (const key of ['long', 'burst', 'attempts', 'challenges']) {
    assert.equal(restoredControl[key].tokens, 0); assert.equal(restoredControl[key].remainder, 0);
  }
  assert.equal((await stats(target)).outstanding_challenges, 0);
  await target.dispose(); target = start(vars, targetDir); // Deliberate local cutover, still paused.
  for (const text of originals) {
    const address = hash(text), response = await request(target, `/b/${address}`);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(text));
    const meta = await (await target.getR2Bucket('BLOBS')).head(`b/${address}`);
    assert.equal(meta.customMetadata.submitted_at_ms, String(submissions.get(address)));
    assert.equal((await receipt(target, text)).submitted_at_ms, submissions.get(address));
  }
  for (const address of [hash(blocked), never]) for (const method of ['GET', 'HEAD'])
    assert.equal((await request(target, `/b/${address}`, { method, headers: { 'If-None-Match': `"sha256-${address}"` } })).status, 410);
  assert.equal((await post(target, 'still paused')).status, 503);
  let output = '', answers = ['Koru', '', ''];
  const load = async address => {
    const response = await request(target, `/b/${address}`); assert.equal(response.status, 200);
    return new Uint8Array(await response.arrayBuffer());
  };
  await interpret(await load(demo.fernProgramAddress), { print: text => output += text, input: async () => answers.shift(), load });
  assert.ok(output.endsWith('Koru is here. The morning can take its time.\n'));
  assert.equal(answers.length, 0);
  t.diagnostic('Lost both source databases; restored 5 receipts; the fern loaded its recovered library and unfurled.');
});

test('recovery preserves pending reservations and failed suppression, and resumes an ambiguous R2 restore write', async t => {
  const vars = { LONG_CAPACITY_BYTES: '1024', BURST_CAPACITY_BYTES: '1024' };
  const source = use(t, vars), dir = await mkdtemp(join(tmpdir(), 'sprig-restore-retry-'));
  let target = start({ ...vars, RESTORE_MODE: '1' }, dir);
  t.after(async () => { await target.dispose(); await rm(dir, { recursive: true, force: true }); });
  const fixtures = ['pending absent', 'pending present', 'blocked old bytes'];
  for (const [i, fault] of ['before-write', 'after-write'].entries()) {
    await request(source, `/__test/fault/${fault}`); assert.equal((await post(source, fixtures[i])).status, 503);
  }
  assert.equal((await post(source, fixtures[2])).status, 201);
  await request(source, '/__test/fault/before-block');
  assert.equal((await admin(source, `block/${hash(fixtures[2])}`)).status, 503);
  assert.equal((await request(source, `/b/${hash(fixtures[2])}`)).status, 200);
  const saved = await snapshot(source);
  assert.equal(saved.records.find(r => r.receipt.status === 'blocked').object, null);
  assert.equal(saved.header.control.reservedBytes, 192);
  assert.equal((await beginRestore(target, saved)).status, 200);
  assert.equal((await finishRestore(target, saved)).status, 400);
  let interrupted = false;
  for (const record of saved.records) {
    if (record.object && !interrupted) {
      await request(target, '/__test/fault/after-write');
      assert.equal((await recover(target, 'restore/record', record)).status, 503);
      await target.dispose(); target = start({ ...vars, RESTORE_MODE: '1' }, dir);
      assert.equal((await beginRestore(target, saved)).status, 200); interrupted = true;
    }
    assert.equal((await recover(target, 'restore/record', record)).status, 200);
    assert.equal((await recover(target, 'restore/record', record)).status, 200);
  }
  assert.ok(interrupted);
  assert.equal((await recover(target, 'restore/record', saved.records[0])).status, 400);
  assert.equal((await finishRestore(target, saved)).status, 200);
  await target.dispose(); target = start(vars, dir);
  const before = await stats(target);
  assert.equal(before.reserved_debit_bytes_total, 192); assert.equal(before.confirmed_unblocked_blobs, 0);
  assert.equal((await request(target, `/b/${hash(fixtures[2])}`)).status, 410);
  assert.equal((await admin(target, 'resume')).status, 200);
  const afterRefill = async text => {
    let result = await post(target, text);
    if (result.status === 429) {
      assert.equal((await result.json()).error, 'attempt_limit');
      assert.equal(result.headers.get('Retry-After'), '1');
      await new Promise(resolve => setTimeout(resolve, 1000));
      result = await post(target, text);
    }
    return result;
  };
  for (const text of fixtures.slice(0, 2)) {
    const result = await afterRefill(text); assert.equal(result.status, 201, await result.clone().text());
    assert.equal((await result.json()).submitted_at_ms, saved.records.find(r => r.receipt.address === hash(text)).receipt.submitted_at_ms);
  }
  const after = await stats(target);
  assert.equal(after.reserved_debit_bytes_total, 192); assert.equal(after.confirmed_unblocked_blobs, 2);
  assert.equal((await afterRefill(fixtures[2])).status, 410);
});

test('restore refuses nonempty targets, policy mismatches, tampered data and premature completion', async t => {
  const source = use(t); assert.equal((await post(source, 'integrity')).status, 201);
  const saved = await snapshot(source), target = use(t, { RESTORE_MODE: '1' });
  const mismatched = use(t, { RESTORE_MODE: '1', MAX_BLOB_BYTES: '127' });
  assert.equal((await beginRestore(mismatched, saved)).status, 400);
  const occupied = use(t, { RESTORE_MODE: '1' });
  await (await occupied.getR2Bucket('BLOBS')).put('unrelated', 'bytes');
  assert.equal((await beginRestore(occupied, saved)).status, 400);
  const blocked = use(t, { RESTORE_MODE: '1' }); await admin(blocked, `block/${hash('blocked')}`);
  assert.equal((await beginRestore(blocked, saved)).status, 400);
  assert.equal((await beginRestore(target, saved)).status, 200);
  for (const change of [r => { r.object.body = Buffer.from('bad').toString('base64'); },
    r => { r.receipt.submitted_at_ms++; }, r => { r.receipt.debit = 0; }]) {
    const bad = structuredClone(saved.records[0]); change(bad);
    assert.equal((await recover(target, 'restore/record', bad)).status, 400);
  }
  assert.equal((await finishRestore(target, saved)).status, 400);
  const bucket = await target.getR2Bucket('BLOBS'); assert.equal((await bucket.list()).objects.length, 0);
  const record = saved.records[0]; await bucket.put(`b/${record.receipt.address}`, 'conflicting external write');
  assert.equal((await recover(target, 'restore/record', record)).status, 400);
  assert.equal(await (await bucket.get(`b/${record.receipt.address}`)).text(), 'conflicting external write');
  const typo = use(t, { RESTORE_MODE: '0' });
  assert.equal((await post(typo, 'source')).status, 503);
  assert.equal((await recover(typo, 'restore/begin')).status, 404);
});

test('offline archive verification rejects truncation, corruption, reordering, accounting drift and oversized lines before restore HTTP', async t => {
  const source = use(t), dir = await mkdtemp(join(tmpdir(), 'sprig-bad-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await post(source, 'one'); await post(source, 'two'); const saved = await snapshot(source);
  const encoded = [saved.header, ...saved.records, { type: 'trailer', count: 2, chain: saved.chain }].map(r => JSON.stringify(r));
  const variants = [encoded.slice(0, -1).join('\n') + '\n', encoded.join('\n'),
    [encoded[0], encoded[2], encoded[1], encoded[3]].join('\n') + '\n',
    encoded.join('\n').replace(saved.chain, '0'.repeat(64)) + '\n',
    encoded.join('\n') + '\n{}\n', 'x'.repeat(2 * 1024 * 1024 + 1) + '\n'];
  const drift = structuredClone(saved.header); drift.control.reservedBytes++;
  let state = progress(drift);
  for (const r of saved.records) state = advance(state, r.receipt, JSON.stringify(r));
  variants.push([drift, ...saved.records, { type: 'trailer', count: 2, chain: state.chain }].map(r => JSON.stringify(r)).join('\n') + '\n');
  for (const [i, contents] of variants.entries()) {
    const file = join(dir, `${i}.jsonl`); await writeFile(file, contents); await assert.rejects(verifyArchive(file));
    const result = await cli(process.execPath, ['scripts/recover.mjs', 'restore', file, '--empty-target'], {
      env: { ...process.env, BLOB_STORE_URL: '', BLOB_STORE_ADMIN_TOKEN: '' },
    }).catch(e => e);
    assert.equal(result.code, 1); assert.doesNotMatch(result.stderr, /invalid_origin|missing_admin_token/);
  }
  const valid = join(dir, 'valid.jsonl'); await writeFile(valid, encoded.join('\n') + '\n');
  assert.equal((await verifyArchive(valid)).count, 2);
  await assert.rejects(verifyArchive(valid, { ...budget(), bytes: 1 }), /archive_byte_limit/);
  await assert.rejects(verifyArchive(valid, { ...budget(), records: 1 }), /archive_record_limit/);
});

test('snapshot pagination covers every receipt once and a missing stored object prevents a complete archive', async t => {
  const source = use(t, { MINIMUM_DEBIT_BYTES: '1', LONG_CAPACITY_BYTES: '4096', BURST_CAPACITY_BYTES: '4096' });
  for (let i = 0; i < 129; i++) assert.equal((await post(source, `frond ${i}`)).status, 201);
  const saved = await snapshot(source);
  assert.equal(saved.records.length, 129);
  assert.equal(new Set(saved.records.map(r => r.receipt.address)).size, 129);
  const dir = await mkdtemp(join(tmpdir(), 'sprig-incomplete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The active header was captured through the stable test origin; release it
  // before using the CLI's actual loopback origin for a new snapshot.
  await recover(source, 'snapshot/end', { id: saved.header.id });
  const bucket = await source.getR2Bucket('BLOBS');
  await bucket.delete(`b/${saved.records[0].receipt.address}`);
  const file = join(dir, 'incomplete.jsonl');
  await assert.rejects(recoveryCLI(source, 'export', file), /snapshot_object_missing/);
  await assert.rejects(verifyArchive(file), /archive_incomplete/);
  assert.equal((await stats(source)).maintenance_locked, true);
  const header = JSON.parse((await readFile(file, 'utf8')).split('\n')[0]);
  await recoveryCLI(source, 'release', header.id);
  assert.equal((await stats(source)).maintenance_locked, false);
  assert.equal((await stats(source)).uploads_paused, true);
});

test('empty snapshots restore and unauthenticated recovery never exposes an administrative body', async t => {
  const source = use(t), target = use(t, { RESTORE_MODE: '1' }), saved = await snapshot(source);
  const absent = await recover(source, 'snapshot/object', { id: saved.header.id, address: hash('absent') }, 'bad');
  assert.equal(absent.status, 404); assert.equal(absent.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(saved.header.receipts, 0);
  assert.equal((await beginRestore(target, saved)).status, 200);
  assert.equal((await finishRestore(target, saved)).status, 200);
  assert.equal((await control(target)).long.tokens, 0);
});

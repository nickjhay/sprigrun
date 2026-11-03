import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { actionBytes, actionId } from '../src/action.ts';
import { contentAddress, textBytes } from '../src/bytes.ts';
import { keyRecordBytes, signAction, verifyAction } from '../src/authority.ts';
import { nextAppendAction, parseReceipt, receiptForAction } from '../src/receipt.ts';
import { DEFAULT_POLICY } from '../host/policy.ts';

const origin = 'https://sprig.run';
let moduleCode, scratch;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sprig-native-'));
  const compiled = await build({ entryPoints: [resolve('core/test/host-worker.ts')], bundle: true,
    write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  moduleCode = compiled.outputFiles[0].text;
});
after(async () => { await rm(scratch, { recursive: true, force: true }); });
function start(overrides = {}, persist) {
  const p = { ...DEFAULT_POLICY,
    growth: { ...DEFAULT_POLICY.growth, refill: 1 },
    burst: { ...DEFAULT_POLICY.burst, refill: 1 },
    attempts: { capacity: 10000, refill: 1, periodMs: 86400000 }, ...overrides };
  return new Miniflare({ cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
    ...(persist ? { resourcePersistencePath: persist } : {}),
    workers: [{ config: { name: 'native-test', compatibilityDate: '2026-10-26',
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: moduleCode } } },
      exports: { TestCoordinator: { type: 'durable-object', storage: 'sqlite' } },
      env: { CORE_ORIGIN: { type: 'text', value: origin }, CORE_POLICY: { type: 'json', value: p },
        SOURCES: { type: 'r2', name: 'SOURCES' },
        CORE: { type: 'durable-object', worker: 'native-test', exportName: 'TestCoordinator' } },
    } }],
  });
}
function use(t, policy) { const mf = start(policy); t.after(() => mf.dispose()); return mf; }
const rpc = (mf, path, value = {}) => mf.dispatchFetch(origin + path,
  { method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
const submit = (mf, bytes, signature, lost = false) => mf.dispatchFetch(origin + (lost ? '/lose-reply' : '/submit'),
  { method: 'POST', body: bytes, headers: signature ? { Signature: signature } : {} });
async function good(response) { const r = await response, s = await r.text(); assert.equal(r.status, 200, s); return s; }
async function bad(response, code) { const r = await response; assert.equal(r.status, 409); assert.match(await r.text(), new RegExp(code)); }
async function json(response) { return JSON.parse(await good(response)); }
const act = (path, body = '', author) => actionBytes({ destination: origin + path, body: textBytes(body), author }, origin);
async function accept(mf, bytes, signature) {
  const receipt = await good(submit(mf, bytes, signature));
  await receiptForAction(bytes, textBytes(receipt), origin);
  return parseReceipt(textBytes(receipt), origin).result.slice(origin.length);
}
async function source(mf, body) { return accept(mf, act('/sea', body)); }
async function garden(mf) { const value = await source(mf, '1 2 + print'); return accept(mf, act('/grove/fern', value + '\n')); }
async function identity(mf, handle = 'moss') {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const record = keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const key = await source(mf, new TextDecoder().decode(record));
  const creation = act('/plot/' + handle, '', key);
  const plot = await accept(mf, creation, await signAction(creation, pair.privateKey, origin));
  return { pair, key, plot };
}
async function held(mf, n = 1) {
  for (let i = 0; i < 80; i++) {
    if (await json(rpc(mf, '/waiting')) === n) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('preparation did not reach the barrier');
}

test('source preparation, publication, chat, and a repeated intended send use real SQLite/R2', async t => {
  const mf = use(t), publication = await garden(mf);
  assert.equal(publication, '/grove/fern.0');
  const message = act('/chat' + publication, 'There is room for another fern.');
  const receipt = await good(submit(mf, message));
  const repeated = await nextAppendAction(message, textBytes(receipt), textBytes('There is room for another fern.'), origin);
  assert.equal(await accept(mf, repeated), '/chat/grove/fern.0/1');
  assert.equal(await good(rpc(mf, '/read', { path: '/chat/grove/fern.0/0' })), 'There is room for another fern.');
  assert.equal(await json(rpc(mf, '/latest', { path: '/chat/grove/fern.0' })), '/chat/grove/fern.0/1');
  const before = await json(rpc(mf, '/stats'));
  assert.equal(await good(submit(mf, message)), receipt);
  const after = await json(rpc(mf, '/stats'));
  assert.equal(after.accepted, before.accepted);
  assert.equal(after.acceptedDebit, before.acceptedDebit);
  assert.equal(after.reservedBytes, before.reservedBytes);
  assert.equal(after.attempts.tokens, before.attempts.tokens - 1);
});

test('concurrent duplicate actions accept once; distinct actions allocate distinct ordered numbers', async t => {
  const mf = use(t), publication = await garden(mf);
  const bytes = act('/chat' + publication, 'same');
  const receipts = await Promise.all(Array.from({ length: 6 }, () => good(submit(mf, bytes))));
  assert.equal(new Set(receipts).size, 1);
  const paths = await Promise.all(Array.from({ length: 6 }, (_, i) => accept(mf, act('/chat' + publication, 'message ' + i))));
  assert.deepEqual(paths.sort(), Array.from({ length: 6 }, (_, i) => '/chat' + publication + '/' + (i + 1)));
  assert.equal((await json(rpc(mf, '/stats'))).accepted, '9');
});

test('SQLite and R2 retain exact UTF-8 bodies, including BOM, NUL, CRLF and nested markers', async t => {
  const mf = use(t), body = '\ufeff\0\r\n#!sprig.run/spec/action/1\n🪴';
  const sourceAction = act('/sea', body), value = await accept(mf, sourceAction);
  const chatAction = act('/chat' + value, body), message = await accept(mf, chatAction);
  for (const path of [value, message]) {
    const response = await rpc(mf, '/read', { path });
    assert.equal(response.status, 200);
    // Response.text() strips a leading BOM; inspect transported bytes instead.
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), textBytes(body));
  }
  for (const bytes of [sourceAction, chatAction]) {
    const evidence = await json(rpc(mf, '/evidence', { id: await actionId(bytes, origin) }));
    assert.equal(evidence.action, new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
  }
});

test('lost acknowledgement and process restart retain receipt, order, time, and debit', async t => {
  const persist = join(scratch, 'restart');
  let mf = start({}, persist); t.after(() => mf.dispose());
  const publication = await garden(mf), bytes = act('/chat' + publication, 'remember me');
  const oldValue = await source(mf, 'x'.repeat(128));
  assert.equal((await submit(mf, bytes, undefined, true)).status, 503);
  const before = await json(rpc(mf, '/stats'));
  const receipt = await good(submit(mf, bytes));
  await mf.dispose(); mf = start({ sourceBytes: 8 }, persist);
  assert.equal(await good(rpc(mf, '/read', { path: oldValue })), 'x'.repeat(128));
  assert.equal(await source(mf, 'x'.repeat(128)), oldValue);
  await bad(submit(mf, act('/sea', 'y'.repeat(128))), 'source_size_limit');
  assert.equal(await good(submit(mf, bytes)), receipt);
  const after = await json(rpc(mf, '/stats'));
  assert.equal(after.accepted, before.accepted);
  assert.equal(after.acceptedDebit, before.acceptedDebit);
  const next = await nextAppendAction(bytes, textBytes(receipt), textBytes('still here'), origin);
  assert.equal(await accept(mf, next), '/chat/grove/fern.0/1');
});

test('a fault inside acceptance rolls back counter, action identity, receipt and growth debit', async t => {
  const mf = use(t), publication = await garden(mf), bytes = act('/chat' + publication, 'retry after fault');
  const before = await json(rpc(mf, '/stats'));
  await good(rpc(mf, '/fail'));
  await bad(submit(mf, bytes), 'injected_rollback');
  const failed = await json(rpc(mf, '/stats'));
  assert.equal(failed.accepted, before.accepted);
  assert.equal(failed.acceptedDebit, before.acceptedDebit);
  assert.equal(failed.growth.tokens, before.growth.tokens);
  assert.equal((await json(rpc(mf, '/rows'))).entries.length, 1);
  assert.equal(await accept(mf, bytes), '/chat/grove/fern.0/0');
});

test('failed source acceptance leaves a private, paid preparation; retry publishes it once', async t => {
  const mf = use(t), bytes = act('/sea', 'private until committed');
  const path = '/sea/' + await contentAddress(textBytes('private until committed'));
  await good(rpc(mf, '/fail'));
  await bad(submit(mf, bytes), 'injected_rollback');
  await bad(rpc(mf, '/read', { path }), 'source_unavailable');
  const failed = await json(rpc(mf, '/stats'));
  assert.equal(failed.accepted, '0'); assert.equal(failed.acceptedDebit, '0');
  assert.equal(failed.reservedBytes, '8192');
  assert.equal(await accept(mf, bytes), path);
  const after = await json(rpc(mf, '/stats'));
  assert.equal(after.reservedBytes, failed.reservedBytes);
  assert.equal(after.accepted, '1');
});

test('normal source creation needs one R2 PUT; ambiguous PUT retries verify and reuse its reservation', async t => {
  const mf = use(t);
  await source(mf, 'ordinary');
  assert.deepEqual(await json(rpc(mf, '/io')), { puts: 1, gets: 0, waiting: 0 });
  const bytes = act('/sea', 'ambiguous');
  const path = '/sea/' + await contentAddress(textBytes('ambiguous'));
  await good(rpc(mf, '/fail-put', { when: 'after' }));
  await bad(submit(mf, bytes), 'injected_put_ambiguous');
  await bad(rpc(mf, '/read', { path }), 'source_unavailable');
  const failed = await json(rpc(mf, '/stats'));
  assert.equal(await accept(mf, bytes), path);
  assert.equal((await json(rpc(mf, '/stats'))).reservedBytes, failed.reservedBytes);
  assert.deepEqual(await json(rpc(mf, '/io')), { puts: 3, gets: 1, waiting: 0 });
});

test('a failed or corrupt R2 preparation cannot publish an object or weaken hash verification', async t => {
  const mf = use(t), body = 'valid source', bytes = act('/sea', body);
  const address = await contentAddress(textBytes(body));
  await good(rpc(mf, '/fail-put', { when: 'before' }));
  await bad(submit(mf, bytes), 'injected_put_failure');
  await good(rpc(mf, '/corrupt', { address, body: 'evil! source' }));
  await bad(submit(mf, bytes), 'source_integrity_failure');
  await bad(rpc(mf, '/read', { path: '/sea/' + address }), 'source_unavailable');
  assert.equal((await json(rpc(mf, '/stats'))).accepted, '0');
});

test('anchors must exist; stale and suppressed anchors remain valid continuation points', async t => {
  const mf = use(t), publication = await garden(mf), base = '/chat' + publication;
  await bad(submit(mf, act(base + '/9', 'future')), 'anchor_unavailable');
  assert.equal(await accept(mf, act(base, 'first')), base + '/0');
  assert.equal(await accept(mf, act(base, 'second')), base + '/1');
  await good(rpc(mf, '/suppress', { path: base + '/0', suppressed: true }));
  assert.equal(await accept(mf, act(base + '/0', 'stale')), base + '/2');
});

test('signed plot authors resolve retained bindings, retain verifiable evidence, and enforce ownership', async t => {
  const mf = use(t), owner = await identity(mf), other = await identity(mf, 'lichen');
  const value = await source(mf, 'source owned by no one');
  const publish = act(owner.plot + '/notes', value + '\n', owner.plot);
  const signature = await signAction(publish, owner.pair.privateKey, origin);
  assert.equal(await accept(mf, publish, signature), owner.plot + '/notes.0');
  const evidence = await json(rpc(mf, '/evidence', { id: await actionId(publish, origin) }));
  assert.equal(evidence.action, new TextDecoder().decode(publish));
  assert.equal(evidence.signature, signature);
  const verified = await verifyAction(textBytes(evidence.action), evidence.signature,
    { keyRecord: textBytes(evidence.keyRecord), plotBinding: textBytes(evidence.plotBinding) }, origin);
  assert.equal(verified.key, owner.key);
  await bad(submit(mf, publish, await signAction(publish, other.pair.privateKey, origin)), 'invalid_signature');
  const intrusion = act(owner.plot + '/notes', value + '\n', other.plot);
  await bad(submit(mf, intrusion, await signAction(intrusion, other.pair.privateKey, origin)), 'wrong_controller');
  await bad(submit(mf, act(owner.plot + '/notes', value + '\n')), 'wrong_controller');
  await bad(submit(mf, act('/plot/anonymous')), 'author_required');
  // Reusing a valid signature with a forged claimed handle cannot replace its accepted binding.
  const forged = act(owner.plot + '/notes', value + '\n', '/plot/nobody.0');
  await bad(submit(mf, forged, signature), 'entry_unavailable');
});

test('two handles can share a controller while author labels remain signed and distinct', async t => {
  const mf = use(t), owner = await identity(mf);
  const create = act('/plot/fern', '', owner.key);
  const second = await accept(mf, create, await signAction(create, owner.pair.privateKey, origin));
  const a = act('/chat' + owner.plot, 'hello', owner.plot), b = act('/chat' + owner.plot, 'hello', second);
  await accept(mf, a, await signAction(a, owner.pair.privateKey, origin));
  assert.equal(await accept(mf, b, await signAction(b, owner.pair.privateKey, origin)), '/chat' + owner.plot + '/1');
});

test('suppression during preparation is rechecked; latest never rewinds and receipts never replay', async t => {
  const mf = use(t), publication = await garden(mf), base = '/chat' + publication;
  const first = act(base, 'first'), second = act(base, 'second');
  const receipt = await good(submit(mf, second));
  await accept(mf, first);
  await good(rpc(mf, '/suppress', { path: base + '/1', suppressed: true }));
  await bad(rpc(mf, '/latest', { path: base }), 'suppressed');
  await bad(submit(mf, first), 'suppressed');
  await bad(rpc(mf, '/evidence', { id: await actionId(first, origin) }), 'suppressed');
  assert.equal(await good(submit(mf, second)), receipt);
  await good(rpc(mf, '/hold'));
  const pending = submit(mf, act(base, 'late'));
  await held(mf);
  await good(rpc(mf, '/suppress', { path: publication, suppressed: true }));
  await good(rpc(mf, '/release'));
  await bad(pending, 'suppressed');
  await good(rpc(mf, '/suppress', { path: publication, suppressed: false }));
  await good(rpc(mf, '/suppress', { path: base + '/1', suppressed: false }));
  assert.equal(await accept(mf, first), base + '/1');
  assert.equal(await accept(mf, act(base, 'late')), base + '/2');
});

test('authority suppression during verification/preparation prevents acceptance', async t => {
  const mf = use(t), owner = await identity(mf);
  const bytes = act('/chat' + owner.plot, 'signed', owner.plot);
  await good(rpc(mf, '/hold'));
  const pending = submit(mf, bytes, await signAction(bytes, owner.pair.privateKey, origin));
  await held(mf);
  await good(rpc(mf, '/suppress', { path: owner.key, suppressed: true }));
  await good(rpc(mf, '/release'));
  await bad(pending, 'suppressed');
});

test('growth exhaustion rejects atomically; attempts meter rejected requests independently', async t => {
  const bucket = { capacity: 32768, refill: 1, periodMs: 86400000 };
  const mf = use(t, { sourceBytes: 1024, growth: bucket, burst: bucket,
    attempts: { capacity: 8, refill: 1, periodMs: 86400000 } });
  const publication = await garden(mf); // 16 KiB source + 8 KiB publication.
  const before = await json(rpc(mf, '/stats'));
  await bad(submit(mf, act('/chat' + publication, 'one byte too far')), 'growth_limit');
  assert.equal((await json(rpc(mf, '/stats'))).accepted, before.accepted);
  const accepted = await good(submit(mf, act('/grove/fern', (await source(mf, '1 2 + print')) + '\n')));
  assert.match(accepted, /grove\/fern.0/); // Retries need attempts, not fresh growth credit.
  for (let i = 0; i < 3; i++) await bad(submit(mf, textBytes('bad')), 'invalid_metadata');
  await bad(submit(mf, textBytes('bad')), 'attempt_limit');
});

test('u64 allocation works beyond JS safe integers and rejects overflow without partial acceptance', async t => {
  const mf = use(t), publication = await garden(mf), base = '/chat' + publication;
  await good(rpc(mf, '/head', { collection: base, number: '9007199254740992' }));
  assert.equal(await accept(mf, act(base, 'large')), base + '/9007199254740993');
  await bad(submit(mf, act(base + '/9007199254740992', 'gap anchor')), 'anchor_unavailable');
  await good(rpc(mf, '/head', { collection: base, number: '18446744073709551614' }));
  assert.equal(await accept(mf, act(base, 'last')), base + '/18446744073709551615');
  const before = await json(rpc(mf, '/stats'));
  await bad(submit(mf, act(base, 'overflow')), 'u64_overflow');
  assert.equal((await json(rpc(mf, '/stats'))).acceptedDebit, before.acceptedDebit);
});

test('an epoch cut does not wait for a stalled R2 PUT and moves pending commits across the boundary', async t => {
  const mf = use(t), value = 'a fern between epochs', bytes = act('/sea', value);
  await good(rpc(mf, '/hold-put'));
  const pending = submit(mf, bytes);
  for (let i = 0; i < 80; i++) {
    if ((await json(rpc(mf, '/io'))).waiting === 1) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await json(rpc(mf, '/io'))).waiting, 1);
  assert.equal(await json(rpc(mf, '/cut')), '0');
  const during = await json(rpc(mf, '/rows'));
  assert.equal(during.accepted.length, 0);
  assert.equal(during.sources[0].reserved_epoch, '00000000000000000000');
  assert.equal(during.sources[0].published_epoch, null);
  await good(rpc(mf, '/release-put')); await good(pending);
  const after = await json(rpc(mf, '/rows'));
  assert.equal(after.sources[0].published_epoch, '00000000000000000001');
  assert.equal(after.accepted[0].epoch, '00000000000000000001');
  assert.equal(JSON.parse(after.cuts[0].control).accepted, '0');
});

test('pause blocks an in-flight commit and bounded preparation leaves operator control responsive', async t => {
  const mf = use(t), publication = await garden(mf), base = '/chat' + publication;
  await good(rpc(mf, '/hold'));
  const pending = Array.from({ length: 8 }, (_, i) => submit(mf, act(base, 'held ' + i)));
  await held(mf, 8);
  await bad(submit(mf, act(base, 'ninth')), 'preparation_busy');
  await good(rpc(mf, '/pause', { paused: true }));
  assert.equal(await json(rpc(mf, '/cut')), '0');
  await good(rpc(mf, '/release'));
  await Promise.all(pending.map(response => bad(response, 'writes_paused')));
  await good(rpc(mf, '/pause', { paused: false }));
  assert.equal(await accept(mf, act(base, 'after')), base + '/0');
});

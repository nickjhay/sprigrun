import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { actionBytes, actionId } from '../src/action.ts';
import { contentAddress, orderedU64, textBytes } from '../src/bytes.ts';
import { keyRecordBytes, signAction, verifyAction } from '../src/authority.ts';
import { nextAppendAction, parseReceipt, receiptForAction } from '../src/receipt.ts';
import { backup, incrementalBackup, restore } from '../scripts/recover.mjs';
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
function start(overrides = {}, persist, restoring = false) {
  const p = { ...DEFAULT_POLICY,
    growth: { ...DEFAULT_POLICY.growth, refill: 1 },
    burst: { ...DEFAULT_POLICY.burst, refill: 1 },
    attempts: { capacity: 10000, refill: 1, periodMs: 86400000 }, ...overrides };
  return new Miniflare({ cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
    ...(persist ? { resourcePersistencePath: persist } : {}),
    workers: [{ config: { name: 'native-test', compatibilityDate: '2026-10-26',
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: moduleCode } } },
      exports: { TestCoordinator: { type: 'durable-object', storage: 'sqlite' } },
      env: { ...(restoring ? { CORE_RESTORE_MODE: { type: 'text', value: '1' } } : {}),
        CORE_ORIGIN: { type: 'text', value: origin }, CORE_POLICY: { type: 'json', value: p },
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
  for (const [bytes, path] of [[sourceAction, value], [chatAction, message]]) {
    const evidence = await json(rpc(mf, '/evidence', { path }));
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
  const journal = (await json(rpc(mf, '/rows'))).journal;
  await good(rpc(mf, '/fail'));
  await bad(submit(mf, bytes), 'injected_rollback');
  const failed = await json(rpc(mf, '/stats'));
  assert.equal(failed.accepted, before.accepted);
  assert.equal(failed.acceptedDebit, before.acceptedDebit);
  assert.equal(failed.growth.tokens, before.growth.tokens);
  assert.equal(failed.position, before.position);
  assert.deepEqual((await json(rpc(mf, '/rows'))).journal, journal);
  assert.equal((await json(rpc(mf, '/rows'))).results.length, 2);
  assert.equal(await accept(mf, bytes), '/chat/grove/fern.0/0');
  const committed = await json(rpc(mf, '/stats'));
  assert.equal(BigInt(committed.position), BigInt(before.position) + 1n);
  await accept(mf, bytes);
  await good(rpc(mf, '/read', { path: '/chat/grove/fern.0/0' }));
  assert.equal((await json(rpc(mf, '/stats'))).position, committed.position);
});

test('exhausted recovery position fails closed without an unjournaled result or control change', async t => {
  const mf = use(t), publication = await garden(mf);
  await good(rpc(mf, '/journal-position', { position: '18446744073709551615' }));
  const rows = await json(rpc(mf, '/rows')), before = await json(rpc(mf, '/stats'));
  await bad(submit(mf, act('/chat' + publication, 'overflow')), 'u64_overflow');
  await bad(rpc(mf, '/pause', { paused: true }), 'u64_overflow');
  await bad(rpc(mf, '/cut'), 'u64_overflow');
  assert.deepEqual(await json(rpc(mf, '/rows')), rows);
  const after = await json(rpc(mf, '/stats'));
  for (const k of ['position', 'epoch', 'accepted', 'acceptedDebit', 'paused']) assert.equal(after[k], before[k]);
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
  const evidence = await json(rpc(mf, '/evidence', { path: owner.plot + '/notes.0' }));
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
  await bad(rpc(mf, '/evidence', { path: base + '/1' }), 'suppressed');
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

test('author blocking during verification/preparation prevents a new acceptance', async t => {
  const mf = use(t), owner = await identity(mf);
  const bytes = act('/chat' + owner.plot, 'signed', owner.plot);
  await good(rpc(mf, '/hold'));
  const pending = submit(mf, bytes, await signAction(bytes, owner.pair.privateKey, origin));
  await held(mf);
  await good(rpc(mf, '/block-author', { key: owner.key, blocked: true }));
  await good(rpc(mf, '/release'));
  await bad(pending, 'author_blocked');
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
  assert.equal(during.results.length, 0);
  assert.equal(during.sources[0].reserved_epoch, '00000000000000000000');
  await good(rpc(mf, '/release-put')); await good(pending);
  const after = await json(rpc(mf, '/rows'));
  assert.equal(after.results[0].epoch, '00000000000000000001');
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

// These operator methods only traverse the test adapter, never a public router.
function recovery(mf) {
  return {
    cut: () => json(rpc(mf, '/cut')),
    snapshotHeader: (epoch, base, chain) => json(rpc(mf, '/snapshotHeader', { epoch, base, chain })),
    snapshotPage: (epoch, after) => json(rpc(mf, '/snapshotPage', { epoch, after })),
    snapshotRecord: (epoch, position) => json(rpc(mf, '/snapshotRecord', { epoch, position })),
    restoreBegin: (header, footer, target) => json(rpc(mf, '/restoreBegin', { header, footer, target })),
    restoreRecord: (index, line) => json(rpc(mf, '/restoreRecord', { index, line })),
    restoreFinish: () => json(rpc(mf, '/restoreFinish')),
  };
}

test('a pre-cut paid reservation restores without an unpublished R2 body, even when it later commits', async t => {
  const mf = use(t), value = 'between epochs', bytes = act('/sea', value);
  await good(rpc(mf, '/hold-put'));
  const pending = submit(mf, bytes);
  for (let i = 0; i < 100 && (await json(rpc(mf, '/io'))).waiting !== 1; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await json(rpc(mf, '/io'))).waiting, 1);
  const core = recovery(mf), epoch = await core.cut();
  const page = await core.snapshotPage(epoch, '0');
  const during = await core.snapshotRecord(epoch, page.keys[0]);
  assert.equal(JSON.parse(during).type, 'sources'); assert.equal(Object.hasOwn(JSON.parse(during), 'body'), false);
  await good(rpc(mf, '/release-put')); await good(pending);
  assert.equal(await core.snapshotRecord(epoch, page.keys[0]), during);
  const file = join(scratch, 'reservation.jsonl'), saved = await backup(core, file, epoch);
  const deltaFile = join(scratch, 'reservation-delta.jsonl');
  const delta = await incrementalBackup(core, deltaFile, file, saved.footer.chain);
  const target = start({}, undefined, true); t.after(() => target.dispose());
  assert.equal((await restore(recovery(target), file, saved.footer.chain, delta.footer.chain)).phase, 'awaiting_delta');
  const rows = await json(rpc(target, '/rows')), io = await json(rpc(target, '/io'));
  assert.equal(rows.sources.length, 1);
  assert.equal(rows.results.length, 0); assert.equal(io.puts, 0); assert.equal(io.gets, 0);
  assert.equal((await json(rpc(target, '/stats'))).reservedBytes, '8192');
  assert.equal((await restore(recovery(target), deltaFile, delta.footer.chain)).phase, 'restored');
  const published = await json(rpc(target, '/rows'));
  assert.equal(published.sources.length, 1); assert.equal(published.results.length, 1);
  assert.equal(published.sources[0].reserved_epoch, orderedU64('0'));
  assert.equal(published.results[0].epoch, orderedU64('1'));
  assert.equal((await json(rpc(target, '/io'))).puts, 1);
  assert.equal((await json(rpc(target, '/stats'))).reservedBytes, '8192');
});

test('restore handles ambiguous R2 PUT and lost acknowledgements without duplicate rows or debit', async t => {
  const mf = use(t); await garden(mf);
  const file = join(scratch, 'ambiguous-restore.jsonl'), saved = await backup(recovery(mf), file);
  const target = start({}, undefined, true); t.after(() => target.dispose());
  await good(rpc(target, '/fail-put', { when: 'after' }));
  await assert.rejects(restore(recovery(target), file, saved.footer.chain), /injected_put_ambiguous/);
  assert.equal((await json(rpc(target, '/restoreStatus'))).count, '1');
  assert.equal((await json(rpc(target, '/rows'))).sources.length, 1);
  assert.equal((await json(rpc(target, '/rows'))).results.length, 0);
  await restore(recovery(target), file, saved.footer.chain);
  const io = await json(rpc(target, '/io'));
  assert.equal(io.puts, 2); assert.ok(io.gets >= 1);
  assert.equal((await json(rpc(target, '/stats'))).reservedBytes, saved.header.control.reservedBytes);
});

test('nonempty R2 blocks restore and leaves the target quarantined', async t => {
  const mf = use(t); await garden(mf);
  const file = join(scratch, 'bucket-guard.jsonl'), saved = await backup(recovery(mf), file);
  const target = start({}, undefined, true); t.after(() => target.dispose());
  await good(rpc(target, '/corrupt', { address: await contentAddress(textBytes('orphan')), body: 'orphan' }));
  await assert.rejects(restore(recovery(target), file, saved.footer.chain), /restore_requires_empty_bucket/);
  assert.equal((await json(rpc(target, '/restoreStatus'))).phase, 'starting');
  await bad(rpc(target, '/pause', { paused: false }), 'recovery_mode');
});

test('recovery preserves allocation gaps and exact u64 numbers beyond JavaScript precision', async t => {
  const mf = use(t), publication = await garden(mf), base = '/chat' + publication;
  await good(rpc(mf, '/head', { collection: base, number: '9007199254740992' }));
  const result = await accept(mf, act(base, 'large'));
  const file = join(scratch, 'large-number.jsonl'), saved = await backup(recovery(mf), file);
  const target = start({}, undefined, true); t.after(() => target.dispose());
  await restore(recovery(target), file, saved.footer.chain);
  const rows = await json(rpc(target, '/rows'));
  const entry = rows.results.find(e => e.path === result);
  assert.equal(entry.number, '00009007199254740993');
  assert.equal(rows.heads.find(h => h.collection === base).number, entry.number);
});

test('distinct source actions race for one result and receipt; the loser spends no publication credit', async t => {
  const mf = use(t), alice = await identity(mf, 'alice'), bob = await identity(mf, 'bob');
  const body = 'the first committed fern', path = '/sea/' + await contentAddress(textBytes(body));
  const actions = [alice, bob].map(owner => act('/sea', body, owner.plot));
  const signatures = await Promise.all(actions.map((a, i) => signAction(a, [alice, bob][i].pair.privateKey, origin)));
  const before = await json(rpc(mf, '/stats'));
  await good(rpc(mf, '/hold'));
  const pending = actions.map((a, i) => submit(mf, a, signatures[i]));
  await held(mf, 2);
  await good(rpc(mf, '/release'));
  const replies = await Promise.all(pending), winner = replies.findIndex(r => r.status === 200), loser = 1 - winner;
  assert.ok(winner >= 0);
  const receipt = await good(replies[winner]);
  await bad(replies[loser], 'already_stored');
  const after = await json(rpc(mf, '/stats'));
  assert.equal(BigInt(after.accepted) - BigInt(before.accepted), 1n);
  assert.equal(BigInt(after.acceptedDebit) - BigInt(before.acceptedDebit), 8192n);
  assert.equal(BigInt(after.reservedBytes) - BigInt(before.reservedBytes), 8192n);
  assert.equal(before.growth.tokens - after.growth.tokens, 16384);
  const results = (await json(rpc(mf, '/rows'))).results.filter(r => r.path === path);
  assert.equal(results.length, 1); assert.equal(results[0].receipt, receipt);
  assert.equal(results[0].action, await actionId(actions[winner], origin));
  await receiptForAction(actions[winner], textBytes(receipt), origin);
  await assert.rejects(receiptForAction(actions[loser], textBytes(receipt), origin), /wrong_receipt_action/);
  assert.equal(await good(submit(mf, actions[winner], signatures[winner])), receipt);
  await bad(submit(mf, actions[loser], signatures[loser]), 'already_stored');
  await bad(submit(mf, actions[winner], 'A'.repeat(86)), 'invalid_signature');
  await bad(submit(mf, actions[winner]), 'signature_required');
  const retry = await json(rpc(mf, '/stats'));
  assert.equal(retry.acceptedDebit, after.acceptedDebit); assert.equal(retry.growth.tokens, after.growth.tokens);
  await good(rpc(mf, '/suppress', { path, suppressed: true }));
  for (const i of [winner, loser]) await bad(submit(mf, actions[i], signatures[i]), 'suppressed');
});

test('a private reservation claims no first-publication rights; a later signed commit wins', async t => {
  const mf = use(t), owner = await identity(mf), body = 'prepared is not published';
  const anonymous = act('/sea', body), signed = act('/sea', body, owner.key);
  await good(rpc(mf, '/fail'));
  await bad(submit(mf, anonymous), 'injected_rollback');
  const prepared = await json(rpc(mf, '/stats'));
  const signature = await signAction(signed, owner.pair.privateKey, origin);
  const receipt = await good(submit(mf, signed, signature));
  const committed = await json(rpc(mf, '/stats'));
  assert.equal(committed.reservedBytes, prepared.reservedBytes);
  await bad(submit(mf, anonymous), 'already_stored');
  assert.equal(await good(submit(mf, signed, signature)), receipt);
});

test('hiding a key changes public visibility, not retained signing authority; no evidence bypass', async t => {
  const mf = use(t), owner = await identity(mf), publication = await garden(mf);
  await good(rpc(mf, '/suppress', { path: owner.key, suppressed: true }));
  const bytes = act('/chat' + publication, 'A hidden key can still sign.', owner.plot);
  const signature = await signAction(bytes, owner.pair.privateKey, origin);
  const result = await accept(mf, bytes, signature);
  assert.equal(await good(rpc(mf, '/read', { path: result })), 'A hidden key can still sign.');
  await bad(rpc(mf, '/evidence', { path: result }), 'suppressed');
  await bad(submit(mf, bytes, signature), 'suppressed'); // Retry must not bypass receipt visibility.
  await good(rpc(mf, '/suppress', { path: owner.key, suppressed: false }));
  const evidence = await json(rpc(mf, '/evidence', { path: result }));
  await verifyAction(textBytes(evidence.action), evidence.signature,
    { keyRecord: textBytes(evidence.keyRecord), plotBinding: textBytes(evidence.plotBinding) }, origin);
  assert.equal(await good(submit(mf, bytes, signature)), evidence.receipt);
});

test('a key block covers every author alias, preserves historical evidence and does not consume a number', async t => {
  const mf = use(t), owner = await identity(mf), publication = await garden(mf);
  const bytes = act('/chat' + publication, 'Before the block.', owner.plot);
  const signature = await signAction(bytes, owner.pair.privateKey, origin);
  const result = await accept(mf, bytes, signature);
  const old = await json(rpc(mf, '/evidence', { path: result }));
  const before = await json(rpc(mf, '/stats'));
  await good(rpc(mf, '/block-author', { key: owner.key, blocked: true }));
  for (const author of [owner.plot, owner.key]) {
    const next = act(result, 'After the block.', author);
    await bad(submit(mf, next, await signAction(next, owner.pair.privateKey, origin)), 'author_blocked');
  }
  assert.equal(await good(submit(mf, bytes, signature)), old.receipt);
  assert.deepEqual(await json(rpc(mf, '/evidence', { path: result })), old);
  assert.equal((await json(rpc(mf, '/stats'))).acceptedDebit, before.acceptedDebit);
  assert.equal(await accept(mf, act(result, 'Anonymous stays open.')), '/chat' + publication + '/1');
  await good(rpc(mf, '/block-author', { key: owner.key, blocked: false }));
  const next = act(result, 'The key is admitted again.', owner.plot);
  assert.equal(await accept(mf, next, await signAction(next, owner.pair.privateKey, origin)), '/chat' + publication + '/2');
});

test('an action accepted before policy delivery can be hidden later without rewriting history', async t => {
  const mf = use(t), owner = await identity(mf);
  const bytes = act('/chat' + owner.plot, 'Accepted before the operator block.', owner.plot);
  const sig = await signAction(bytes, owner.pair.privateKey, origin), result = await accept(mf, bytes, sig);
  const before = await json(rpc(mf, '/rows'));
  await good(rpc(mf, '/block-author', { key: owner.key, blocked: true }));
  await good(rpc(mf, '/suppress', { path: result, suppressed: true }));
  await bad(rpc(mf, '/read', { path: result }), 'suppressed');
  await bad(rpc(mf, '/evidence', { path: result }), 'suppressed');
  const after = await json(rpc(mf, '/rows'));
  assert.deepEqual(after.results, before.results); assert.deepEqual(after.heads, before.heads);
});


test('a late policy with an older issue epoch cannot enter an already closed snapshot', async t => {
  const mf = use(t), owner = await identity(mf);
  await good(rpc(mf, '/block-author', { key: owner.key, blocked: true }));
  const epoch = await json(rpc(mf, '/cut'));
  const before = await json(rpc(mf, '/snapshotHeader', { epoch }));
  await good(rpc(mf, '/policy-batch', [{ position: orderedU64('2'), effect: 'block',
    path: owner.key, active: 0, epoch: orderedU64(epoch), at_ms: String(Date.now()) }]));
  const old = await json(rpc(mf, '/snapshotPage', { epoch, after: '0' }));
  const cut = JSON.parse(before).control.position;
  assert.equal(old.keys.at(-1), cut);
  assert.equal(await json(rpc(mf, '/snapshotHeader', { epoch })), before);
  await bad(rpc(mf, '/snapshotRecord', { epoch, position: String(BigInt(cut) + 1n) }), 'archive_position');
  const nextEpoch = await json(rpc(mf, '/cut'));
  const next = await json(rpc(mf, '/snapshotPage', { epoch: nextEpoch, after: cut }));
  assert.equal(next.keys.length, 2); // Late policy and the next cut.
});


test('moderation cannot reserve an unallocated numbered entry on a standalone core', async t => {
  const mf = use(t);
  await bad(rpc(mf, '/suppress', {path:'/grove/unallocated.0',suppressed:true}), 'entry_unavailable');
  const value = await source(mf, 'A free place.');
  assert.equal(await accept(mf, act('/grove/unallocated', value + '\n')), '/grove/unallocated.0');
});

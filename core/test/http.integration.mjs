import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { parseHTML } from 'linkedom';
import { nativeClient } from '../scripts/http-client.mjs';
import { plantLocal } from '../scripts/plant-local.mjs';
import { backup, restore } from '../scripts/recover.mjs';
import { actionBytes } from '../src/action.ts';
import { contentAddress, textBytes, utf8 } from '../src/bytes.ts';
import { parseReceipt } from '../src/receipt.ts';
import { signAction, verifyAction, keyRecordBytes } from '../src/authority.ts';
import { DEFAULT_POLICY } from '../host/policy.ts';
import { HTTP_DEFAULTS } from '../http/transport.ts';
import { refill } from '../../shared/bucket.ts';
const origin = 'https://sprig.run', token = 'a'.repeat(64);
let moduleCode, scratch;
before(async () => { scratch = await mkdtemp(join(tmpdir(), 'sprig-http-tests-')); moduleCode = (await build({ entryPoints: [resolve('core/test/http-worker.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] })).outputFiles[0].text; });
after(() => rm(scratch, { recursive: true, force: true }));
function start({ policy, httpPolicy, capacity = 800_000_000, restoring = false, localOperator = false, logicalOrigin = origin, adminToken = token, directory } = {}) {
    const p = { ...DEFAULT_POLICY, attempts: { capacity: 10000, refill: 1, periodMs: 86400000 }, ...policy };
    const h = { ...HTTP_DEFAULTS, readCapacity: 10000, readRefill: 1, readPeriodMs: 86400000, ...httpPolicy };
    return new Miniflare({ cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false }, ...(directory ? { resourcePersistencePath: directory } : {}), workers: [{ config: {
                    name: 'native-http-test', compatibilityDate: '2026-10-26',
                    manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: moduleCode } } },
                    exports: { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' } },
                    env: { CORE_ORIGIN: { type: 'text', value: logicalOrigin }, CORE_POLICY: { type: 'json', value: p }, CORE_HTTP_POLICY: { type: 'json', value: h },
                        CORE_CAPACITY_BYTES: { type: 'json', value: capacity },
                        ADMIN_TOKEN: { type: 'text', value: adminToken }, CORE_RESTORE_MODE: { type: 'text', value: restoring ? '1' : '0' },
                        CORE_LOCAL_OPERATOR: { type: 'text', value: localOperator ? '1' : '0' },
                        SOURCES: { type: 'r2', name: 'SOURCES' }, CORE: { type: 'durable-object', worker: 'native-http-test', exportName: 'NativeCoordinator' } }
                } }] });
}
function use(t, options) { const mf = start(options); t.after(() => mf.dispose()); return mf; }
const request = (mf, path, options = {}) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...options });
const client = mf => nativeClient(origin, { token, fetcher: (...args) => mf.dispatchFetch(...args) });
async function ok(response) { const r = await response; const value = await r.text(); assert.equal(r.status, 200, value); return value; }
async function bad(response, status, code) { const r = await response; assert.equal(r.status, status, await r.clone().text()); if (code)
    assert.match(await r.text(), new RegExp(code)); return r; }
const fault = (mf, kind, value = {}) => request(mf, '/__test/' + kind, { method: 'POST', body: JSON.stringify(value) });
const rows = async (mf) => JSON.parse(await ok(fault(mf, 'rows')));
const put = async (mf, text) => client(mf).publish('/sea', textBytes(text));
async function garden(mf) { const source = await put(mf, '1 2 + print'); const pub = await client(mf).publish('/grove/fern', textBytes(source.result + '\n')); return { source, pub }; }
function receipt(s) { return parseReceipt(textBytes(s), origin); }
const inspect = async (mf, table) => client(mf).inspect(table);
test('HTTP exact UTF-8, idempotent receipt, raw MIME, HEAD and conditional semantics', async (t) => {
    const mf = use(t), value = '\ufeff\0\r\n<script>globalThis.attacked=true</script>🌿';
    const sent = await put(mf, value), info = receipt(sent.receipt);
    assert.equal(sent.result, '/sea/' + await contentAddress(textBytes(value)));
    assert.equal((await put(mf, value)).receipt, sent.receipt);
    const raw = await request(mf, sent.result);
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), textBytes(value));
    assert.match(raw.headers.get('Content-Type'), /^text\/plain/);
    assert.equal(raw.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(raw.headers.get('Cache-Control'), 'private, max-age=300, immutable');
    assert.match(raw.headers.get('Content-Security-Policy'), /sandbox/);
    const etag = raw.headers.get('ETag');
    const head = await request(mf, sent.result, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await request(mf, sent.result, { headers: { 'If-None-Match': etag } })).status, 304);
    assert.equal(await ok(request(mf, '/receipt' + sent.result)), sent.receipt);
    const html = await ok(request(mf, sent.result + '?view=html'));
    const dom = parseHTML(html).document;
    assert.equal(dom.querySelectorAll('script').length, 0);
    assert.ok(dom.querySelector('pre').textContent.includes('<script>'));
    assert.equal(dom.querySelectorAll('.digest span').length, 64);
    await client(mf).suppress(sent.result, true);
    for (const method of ['GET', 'HEAD'])
        assert.equal((await request(mf, sent.result, { method, headers: { 'If-None-Match': etag } })).status, 404);
});
test('a raw marker stays payload; signed mode is explicit and binds the actual receiving URL', async (t) => {
    const mf = use(t), inner = actionBytes({ destination: origin + '/sea', body: textBytes('inside') }, origin);
    const stored = await client(mf).publish('/sea', inner);
    assert.equal(await ok(request(mf, stored.result)), utf8(inner));
    assert.equal(receipt(stored.receipt).key, null);
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const key = (await client(mf).publish('/sea', keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))))).result;
    const action = actionBytes({ destination: origin + '/plot/moss', author: key, body: new Uint8Array() }, origin);
    const signature = await signAction(action, pair.privateKey, origin);
    await bad(request(mf, '/plot/fern', { method: 'POST', body: action, headers: { 'Sprig-Signature': signature } }), 400, 'wrong_destination');
    const created = await client(mf).publish('/plot/moss', action, signature);
    assert.equal(created.result, '/plot/moss.0');
    const e = JSON.parse(await ok(request(mf, '/evidence' + created.result)));
    await verifyAction(textBytes(e.action), e.signature, { keyRecord: textBytes(e.keyRecord) }, origin);
    await bad(request(mf, '/plot/moss', { method: 'POST', body: action, headers: { 'Sprig-Signature': 'A'.repeat(86) } }), 403, 'invalid_signature');
    await bad(request(mf, '/plot/moss', { method: 'POST', body: '' }), 403, 'author_required');
});
test('normal-admission planting covers plots, publications, chats, receipts and spec links', async (t) => {
    const mf = use(t), pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
    const planted = await plantLocal(client(mf), pem), before = await rows(mf);
    assert.deepEqual(await plantLocal(client(mf), pem), planted);
    const after = await rows(mf);
    assert.deepEqual(after.results, before.results);
    for (const path of ['/', '/explore', '/spec', '/help', '/SKILL.md', '/llms.txt', '/.well-known/agent-skills/index.json', '/.well-known/',
        '/sea?view=html', '/grove?view=html', '/plot?view=html', '/chat?view=html', '/action?view=html',
        planted.plots.moss + '?view=html', '/explore?kind=publication&under=' + encodeURIComponent(planted.plots.moss)])
        assert.equal((await request(mf, path)).status, 200, path);
    const home = parseHTML(await ok(request(mf, '/'))).document;
    assert.equal(home.querySelector('pre').textContent, `printf '1 2 + print\\n' | curl --fail-with-body -sS --data-binary @- '${origin}/sea'`);
    const publication = await ok(request(mf, planted.publications.morning + '?view=html'));
    const doc = parseHTML(publication).document;
    for (const a of doc.querySelectorAll('a')) {
        const href = a.getAttribute('href');
        assert.equal((await request(mf, href)).status, 200, href);
    }
    const accepted = before.results.find(a => a.path === planted.messages[0]);
    const page = parseHTML(await ok(request(mf, '/receipt' + accepted.path + '?view=html'))).document;
    assert.equal(page.querySelector('pre').textContent, accepted.receipt);
    assert.ok(page.querySelector('a[href="/spec/receipt/1"]'));
    assert.equal((await request(mf, '/spec/receipt/1')).status, 200);
});
test('suppression reaches listings, aliases, receipts and evidence; latest does not rewind', async (t) => {
    const mf = use(t), { source, pub } = await garden(mf), c = client(mf);
    const first = await c.publish('/chat' + pub.result, textBytes('first'));
    const last = await c.publish(first.result, textBytes('private-looking-public-text'));
    const lastPath = last.result;
    await c.suppress(last.result, true);
    for (const path of [last.result, last.result + '?view=html', '/action' + lastPath, '/action' + lastPath + '?view=html', '/receipt' + lastPath, '/evidence' + lastPath, '/chat' + pub.result + '?select=latest'])
        await bad(request(mf, path), 404);
    assert.equal(await ok(request(mf, '/chat' + pub.result)), first.result + '\n');
    const next = await c.publish(last.result, textBytes('third'));
    assert.ok(next.result.endsWith('/2'));
    const latest = await request(mf, '/chat' + pub.result + '?select=latest&view=html');
    assert.equal(latest.status, 303);
    assert.equal(latest.headers.get('Location'), next.result + '?view=html');
    assert.equal(latest.headers.get('Cache-Control'), 'no-store');
    await c.suppress(source.result, true);
    for (const path of [pub.result, pub.result + '?view=html', first.result, '/action' + pub.result, '/receipt' + source.result])
        await bad(request(mf, path), 404);
    assert.equal(await ok(request(mf, '/grove')), '');
    assert.equal(await ok(request(mf, '/chat')), '');
});
test('bounded listings progress through a fully hidden page without R2 reads or durable view writes', async (t) => {
    const mf = use(t), { pub } = await garden(mf), c = client(mf), base = '/chat' + pub.result;
    for (let n = 0; n < 35; n++) {
        const sent = await c.publish(base, textBytes('message ' + n));
        if (n < 32)
            await c.suppress(sent.result, true);
    }
    const before = await rows(mf), io = JSON.parse(await ok(fault(mf, 'io'))), control = (await inspect(mf, 'control')).rows;
    const first = await request(mf, base);
    assert.equal(first.status, 200);
    const link = first.headers.get('Link').match(/<([^>]+)>; rel="next"/)[1];
    assert.equal(link, base + '?after=31');
    assert.match(await first.text(), /^# next:/);
    assert.equal(await ok(request(mf, link)), [32, 33, 34].map(n => base + '/' + n + '\n').join(''));
    await ok(request(mf, '/sea?view=html'));
    await ok(request(mf, '/action?view=html'));
    await ok(request(mf, '/stats'));
    assert.deepEqual(await rows(mf), before);
    assert.deepEqual((await inspect(mf, 'control')).rows, control);
    assert.deepEqual(JSON.parse(await ok(fault(mf, 'io'))), io);
});
test('numeric collection order retains u64 precision and stable cursors across gaps', async (t) => {
    const mf = use(t), { pub } = await garden(mf), c = client(mf), base = '/chat' + pub.result;
    for (let n = 0; n < 12; n++)
        await c.publish(base, textBytes('m' + n));
    assert.equal(await ok(request(mf, base + '?after=8')), [9, 10, 11].map(n => base + '/' + n + '\n').join(''));
    await ok(fault(mf, 'head', { collection: base, number: '9007199254740992' }));
    const large = await c.publish(base, textBytes('large'));
    assert.equal(await ok(request(mf, base + '?after=11')), large.result + '\n');
    await bad(request(mf, base + '?after=01'), 400, 'invalid_u64');
});
test('body reception is timed, bounded and prepaid; a pause during reception prevents commitment', async (t) => {
    const mf = use(t, { httpPolicy: { uploadTimeoutMs: 100 } });
    for (const headers of [{ 'Test-Stall': '1' }, {}]) {
        const r = await request(mf, '/__test/probe', { headers });
        assert.equal(r.status, headers['Test-Stall'] ? 408 : 413, await r.clone().text());
        assert.ok(Number(r.headers.get('Test-Body-Pulls')) > 0);
    }
    const state = (await inspect(mf, 'control')).rows[0];
    assert.equal(state.attempts.tokens, 9998);
    assert.equal(state.reservedBytes, '0');
    await bad(request(mf, '/__test/probe', { headers: { 'Test-Pause': '1', 'Test-Body': 'hello' } }), 503, 'writes_paused');
    assert.equal((await rows(mf)).results.length, 0);
    await client(mf).pause(false);
    await put(mf, 'after');
});
test('attempt exhaustion rejects before the upload is consumed', async (t) => {
    const mf = use(t, { policy: { attempts: { capacity: 1, refill: 1, periodMs: 86400000 } } });
    await bad(request(mf, '/sea', { method: 'POST', body: new Uint8Array([255]) }), 422, 'invalid_utf8');
    const r = await bad(request(mf, '/__test/probe', { headers: { 'Test-Stall': '1' } }), 429, 'attempt_limit');
    assert.equal(r.headers.get('Test-Body-Pulls'), '0');
    assert.equal((await rows(mf)).sources.length, 0);
});
test('read overload is bounded independently; operator controls remain usable', async (t) => {
    const mf = use(t, { httpPolicy: { readCapacity: 2, readRefill: 1, readPeriodMs: 86400000 } });
    await ok(request(mf, '/sea'));
    await ok(request(mf, '/grove'));
    const r = await bad(request(mf, '/chat'), 429, 'read_limit');
    assert.ok(Number(r.headers.get('Retry-After')) > 0);
    await client(mf).pause(true);
    assert.equal((await inspect(mf, 'control')).rows[0].paused, true);
    assert.equal((await request(mf, '/help')).status, 200);
});
test('canonical paths, queries, methods and CORS never turn into a write bypass', async (t) => {
    const mf = use(t);
    for (const path of ['/sea?view=html&view=raw', '/sea?offset=1', '/grove//fern', '/grove/%66ern'])
        await bad(request(mf, path), 400);
    await bad(request(mf, '/sea', { method: 'DELETE' }), 405);
    await bad(request(mf, '/sea?select=latest'), 400);
    await bad(request(mf, '/sea', { method: 'POST', body: 'x', headers: { Authorization: 'Bearer secret' } }), 400);
    await bad(request(mf, '/sea', { method: 'POST', body: 'x', headers: { 'Content-Encoding': 'gzip' } }), 415);
    await bad(request(mf, '/sea', { method: 'POST', body: 'x', headers: { 'Content-Type': 'multipart/form-data' } }), 415);
    await bad(mf.dispatchFetch('https://evil.invalid/sea', { method: 'POST', body: 'x' }), 400, 'wrong_origin');
    const preflight = await request(mf, '/sea', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Sprig-Signature/);
    await bad(request(mf, '/hold', { method: 'POST' }), 404);
    assert.equal((await rows(mf)).results.length, 0);
});
test('operator endpoints reject missing, malformed and wrong credentials without reflecting secrets', async (t) => {
    const mf = use(t);
    for (const authorization of [undefined, 'Bearer ' + 'b'.repeat(64), 'Bearer ' + 'é'.repeat(64)]) {
        const r = await bad(request(mf, '/admin/inspect?table=control', { headers: authorization ? { Authorization: authorization } : {} }), 404);
        assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
        assert.ok(!(await r.clone().text()).includes(token));
    }
    await bad(request(mf, '/admin/inspect?table=sources%3BDROP%20TABLE%20control', { headers: { Authorization: 'Bearer ' + token } }), 400, 'invalid_table');
    await client(mf).pause(true);
    assert.equal((await inspect(mf, 'control')).rows[0].paused, true);
    const disabled = use(t, { adminToken: 'too-short' });
    await bad(request(disabled, '/admin/inspect', { headers: { Authorization: 'Bearer too-short' } }), 404);
});
test('local operator browsing needs explicit loopback configuration and never permits anonymous writes', async (t) => {
    const prod = use(t, { localOperator: true });
    await bad(request(prod, '/admin?view=html'), 404);
    const local = use(t, { localOperator: true, logicalOrigin: 'http://127.0.0.1:8789' });
    const get = (p, o = {}) => local.dispatchFetch('http://127.0.0.1:8789' + p, o);
    await ok(get('/admin?view=html'));
    await bad(get('/admin?view=html', { headers: { Origin: 'https://evil.invalid', 'Sec-Fetch-Site': 'cross-site' } }), 404);
    await bad(get('/admin/pause', { method: 'POST', body: '{"paused":true}' }), 404);
});
test('a failed preparation is visible only in operator inspection, and raw reads still verify R2', async (t) => {
    const mf = use(t);
    await ok(fault(mf, 'fail'));
    await bad(request(mf, '/sea', { method: 'POST', body: 'reserved' }), 503);
    assert.equal(await ok(request(mf, '/sea')), '');
    const reserved = (await inspect(mf, 'sources')).rows;
    assert.equal(reserved.length, 1);
    assert.equal((await inspect(mf, 'results')).rows.length, 0);
    await bad(request(mf, '/sea/' + reserved[0].address), 404);
    const sent = await put(mf, 'good');
    await ok(fault(mf, 'corrupt', { address: sent.result.slice(5), body: 'evil' }));
    await bad(request(mf, sent.result, { headers: { 'If-None-Match': '*' } }), 503, 'service_unavailable');
});
test('whole-core backup and quarantined restore work through authenticated HTTP', async (t) => {
    const mf = use(t), { pub } = await garden(mf);
    await client(mf).publish('/chat' + pub.result, textBytes('hello'));
    const file = join(scratch, 'http.jsonl'), saved = await backup(client(mf), file);
    const restored = use(t, { restoring: true });
    await bad(request(restored, '/sea'), 503, 'recovery_mode');
    await restore(client(restored), file, saved.footer.chain);
    assert.equal((await client(restored).restoreStatus()).phase, 'restored');
    assert.equal((await inspect(restored, 'results')).rows.length, 3);
    await bad(request(restored, pub.result), 503, 'recovery_mode');
    await client(restored).restoreRelease(saved.footer.chain, 'history-reconciled');
    await bad(request(restored, pub.result), 503, 'recovery_mode');
});
test('eight stalled HTTP bodies fill the shared slots, then deadlines release them', async (t) => {
    const mf = use(t, { httpPolicy: { uploadTimeoutMs: 1500 } });
    const pending = Array.from({ length: 8 }, () => request(mf, '/__test/probe', { headers: { 'Test-Stall': '1' } }));
    let active = 0;
    for (let n = 0; n < 100; n++) {
        active = Number((await ok(request(mf, '/stats'))).match(/^active_uploads (\d+)$/m)[1]);
        if (active === 8)
            break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(active, 8);
    const refused = await bad(request(mf, '/__test/probe', { headers: { 'Test-Body': 'ninth' } }), 429, 'preparation_busy');
    assert.equal(refused.headers.get('Test-Body-Pulls'), '0');
    for (const r of await Promise.all(pending))
        await bad(r, 408, 'upload_timeout');
    assert.equal((await inspect(mf, 'control')).rows[0].attempts.tokens, 9992);
    await put(mf, 'slots are free');
});
test('suppressing a key hides retained evidence without erasing authored public messages', async (t) => {
    const mf = use(t), pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
    const planted = await plantLocal(client(mf), pem), accepted = (await rows(mf)).results;
    const message = planted.messages[0], path = accepted.find(a => a.path === message).path;
    const keyPage = parseHTML(await ok(request(mf, planted.key + '?view=html'))).document;
    assert.ok(keyPage.querySelector('a[href="/spec/key/1"]'));
    await client(mf).suppress(planted.key, true);
    assert.equal((await request(mf, message)).status, 200);
    for (const p of ['/action', '/receipt', '/evidence'])
        await bad(request(mf, p + path), 404);
    assert.ok(!(await ok(request(mf, '/action'))).includes(path));
    assert.equal((await rows(mf)).results.length, accepted.length);
});
test('production entrypoint retains HTTP records across restart and exposes no fault router', async () => {
    const { startNative } = await import('../scripts/local-http.mjs');
    const directory = join(scratch, 'production-restart');
    let host = await startNative({ port: 0, origin, directory, adminToken: token });
    try {
        const sent = await client(host.mf).publish('/sea', textBytes('restart the fern'));
        await host.close();
        host = await startNative({ port: 0, origin, directory, adminToken: token });
        assert.equal(await ok(request(host.mf, sent.result)), 'restart the fern');
        assert.equal((await client(host.mf).publish('/sea', textBytes('restart the fern'))).receipt, sent.receipt);
        for (const path of ['/__test/rows', '/hold', '/pause', '/submit'])
            await bad(request(host.mf, path, { method: 'POST', body: '{}' }), 404);
    }
    finally {
        await host.close();
    }
});

test('duplicate source replies link one mirrored receipt, never acknowledge the losing signature', async t => {
    const mf = use(t), c = client(mf);
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const key = (await c.publish('/sea', keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))))).result;
    const first = await put(mf, 'shared fern');
    const action = actionBytes({ destination: origin + '/sea', body: textBytes('shared fern'), author: key }, origin);
    const signature = await signAction(action, pair.privateKey, origin);
    const before = (await inspect(mf, 'control')).rows[0], beforeIO = JSON.parse(await ok(fault(mf, 'io')));
    const duplicate = await bad(request(mf, '/sea', { method: 'POST', body: action, headers: { 'Sprig-Signature': signature } }), 409);
    const text = await duplicate.clone().text();
    assert.match(text, /^already_stored\n/);
    assert.match(text, /No new publication was recorded/);
    assert.ok(text.includes('object: ' + first.result));
    assert.ok(text.includes('receipt: /receipt' + first.result));
    assert.match(duplicate.headers.get('Link'), /rel="describedby"/);
    assert.equal(duplicate.headers.get('Cache-Control'), 'no-store');
    assert.equal(duplicate.headers.get('Location'), null);
    const after = (await inspect(mf, 'control')).rows[0], afterIO = JSON.parse(await ok(fault(mf, 'io')));
    for (const k of ['accepted', 'acceptedDebit', 'reservedBytes']) assert.equal(after[k], before[k]);
    assert.equal(after.attempts.tokens, before.attempts.tokens - 1);
    assert.equal(afterIO.puts, beforeIO.puts); assert.equal(afterIO.gets, beforeIO.gets + 1); // author key only
    for (const prefix of ['/action', '/receipt', '/evidence']) {
        const r = await request(mf, prefix + first.result);
        assert.equal(r.status, 200); assert.equal(r.headers.get('Cache-Control'), 'no-store');
        await bad(request(mf, prefix + '/' + receipt(first.receipt).action), 404); // retired hash-only route
        await bad(request(mf, prefix + '/grove/fern'), 404); // not a concrete result
    }
    assert.equal(await ok(request(mf, '/receipt' + first.result)), first.receipt);
    const doc = parseHTML(await ok(request(mf, first.result + '?view=html'))).document;
    assert.ok(doc.querySelector(`a[href="/receipt${first.result}?view=html"]`));
    await c.suppress(first.result, true);
    await bad(request(mf, '/sea', { method: 'POST', body: action, headers: { 'Sprig-Signature': signature } }), 404, 'unavailable');
    await bad(request(mf, '/receipt' + first.result), 404);
});

test('operator author blocks preserve historical signatures, meter rejected attempts and expose a bounded policy cursor', async t => {
    const mf = use(t), c = client(mf), pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const key = (await c.publish('/sea', keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))))).result;
    const creation = actionBytes({ destination: origin + '/plot/policy_test', author: key, body: new Uint8Array() }, origin);
    const plot = await c.publish('/plot/policy_test', creation, await signAction(creation, pair.privateKey, origin));
    const bytes = actionBytes({ destination: origin + '/chat' + plot.result, author: plot.result, body: textBytes('before') }, origin);
    const signature = await signAction(bytes, pair.privateKey, origin), sent = await c.publish('/chat' + plot.result, bytes, signature);
    const evidence = await ok(request(mf, '/evidence' + sent.result));
    await c.blockAuthor(key, true);
    assert.equal(await ok(request(mf, '/evidence' + sent.result)), evidence);
    assert.equal((await c.publish('/chat' + plot.result, bytes, signature)).receipt, sent.receipt);
    const next = actionBytes({ destination: origin + sent.result, author: key, body: textBytes('after') }, origin);
    await bad(request(mf, sent.result, { method: 'POST', body: next,
        headers: { 'Sprig-Signature': await signAction(next, pair.privateKey, origin) } }), 403, 'author_blocked');
    await bad(request(mf, '/admin/block-author', { method: 'POST', body: JSON.stringify({ key, blocked: false }) }), 404);
    await bad(request(mf, '/admin/policy'), 404);
    await c.blockAuthor(key, true); // No duplicate policy fact for an unchanged decision.
    let feed = await c.policyPage();
    assert.equal(feed.status.applied, '1'); assert.equal(feed.changes[0].effect, 'block');
    await c.suppress(key, true);
    for (const prefix of ['/action', '/receipt', '/evidence']) await bad(request(mf, prefix + sent.result), 404);
    await bad(request(mf, '/chat' + plot.result, { method: 'POST', body: bytes,
        headers: { 'Sprig-Signature': signature } }), 404); // Exact-retry receipt is not a visibility bypass.
    for (let i = 0; i < 40; i++) await c.blockAuthor(key, i % 2 === 1);
    feed = await c.policyPage(); assert.equal(feed.changes.length, 32); assert.equal(feed.more, true);
    const rest = await c.policyPage(feed.after);
    assert.equal(rest.more, false); assert.equal(rest.after, rest.status.applied);
    assert.equal((await inspect(mf, 'moderation')).rows.length, 32);
});

test('capacity cutoff refuses uploads before body/attempt/R2 work; reads and operator work remain available', async t => {
    const mf = use(t, { capacity: 1048576 }), c = client(mf);
    const saved = await put(mf, 'A fern needs a little room.');
    await ok(fault(mf, 'fill'));
    const before = (await inspect(mf, 'control')).rows[0], io = await ok(fault(mf, 'io'));
    const r = await bad(request(mf, '/__test/probe', { headers: { 'Test-Stall': '1' } }), 503, 'capacity_limit');
    assert.equal(r.headers.get('Test-Body-Pulls'), '0');
    assert.equal(r.headers.get('Retry-After'), null);
    assert.deepEqual((await inspect(mf, 'control')).rows[0], before);
    assert.equal(await ok(fault(mf, 'io')), io);
    assert.equal(await ok(request(mf, '/receipt' + saved.result)), saved.receipt);
    assert.equal(await ok(request(mf, saved.result)), 'A fern needs a little room.');
    assert.match(await ok(request(mf, '/stats')), /journal_capacity_bytes 1048576\ncapacity_reached true/);
    await c.suppress(saved.result, true); await c.pause(true);
    const archive = join(scratch, 'capacity.jsonl');
    assert.ok((await backup(c, archive)).footer.count !== '0');
});
test('a transaction that crosses the cutoff rolls back allocation, receipt and growth debit', async t => {
    const mf = use(t, { capacity: 1048576 }), c = client(mf), g = await garden(mf);
    const before = await rows(mf), state = (await inspect(mf, 'control')).rows[0];
    const size = JSON.parse(await ok(fault(mf, 'measure'))).databaseBytes;
    await ok(fault(mf, 'fill-on-commit'));
    await bad(request(mf, '/chat' + g.pub.result, { method: 'POST', body: 'A leaf too far.' }), 503, 'capacity_limit');
    assert.deepEqual(await rows(mf), before);
    const after = (await inspect(mf, 'control')).rows[0];
    for (const field of ['accepted', 'acceptedDebit', 'position']) assert.deepEqual(after[field], state[field], field);
    for (const field of ['growth', 'burst']) assert.deepEqual(after[field], refill(state[field], DEFAULT_POLICY[field], after[field].atMs), field);
    assert.equal(after.attempts.tokens, state.attempts.tokens - 1);
    assert.equal(JSON.parse(await ok(fault(mf, 'measure'))).databaseBytes, size);
    assert.equal((await c.publish('/chat' + g.pub.result, textBytes('A leaf that fits.'))).result, '/chat' + g.pub.result + '/0');
});
test('an upload already in flight cannot commit after another operation fills the journal', async t => {
    const mf = use(t, { capacity: 1048576 }), g = await garden(mf);
    await ok(fault(mf, 'hold'));
    const pending = request(mf, '/chat' + g.pub.result, { method: 'POST', body: 'Still growing.' });
    for (let n = 0; ; n++) {
        if (JSON.parse(await ok(fault(mf, 'waiting'))) === 1) break;
        assert.ok(n < 100); await new Promise(r => setTimeout(r, 10));
    }
    await ok(fault(mf, 'fill')); await ok(fault(mf, 'release'));
    await bad(pending, 503, 'capacity_limit');
    assert.equal((await rows(mf)).results.filter(r => r.kind === 'chat').length, 0);
});

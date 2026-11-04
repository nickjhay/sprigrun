import '../../scripts/check-node.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { probe, origin } from '../test/probe.mjs';
import { DEFAULT_POLICY } from '../host/policy.ts';
import { HTTP_DEFAULTS } from '../http/transport.ts';
import { actionBytes } from '../src/action.ts';
import { signAction, keyRecordBytes } from '../src/authority.ts';
import { textBytes } from '../src/bytes.ts';

/** No remote target option: this can only load a fresh disposable local host. */
export async function rehearse(count = 128) {
  assert.ok(Number.isSafeInteger(count) && count >= 8 && count <= 512, 'count must be 8..512');
  const host = await probe({ policy: { burst: { capacity: 64 * 2 ** 20, refill: 1, periodMs: 86400000 } } });
  const samples = [];
  try {
    const c = host.client;
    async function sample(kind, fn) {
      const before = await host.measure(), times = [];
      for (let i = 0; i < count; i++) { const start = performance.now(); await fn(i); times.push(performance.now() - start); }
      const after = await host.measure(); times.sort((a, b) => a - b);
      const item = { kind, count, databaseBytes: after.databaseBytes - before.databaseBytes,
        bytesPerAction: (after.databaseBytes - before.databaseBytes) / count,
        r2Puts: after.puts - before.puts, r2Gets: after.gets - before.gets,
        localWallMsMedian: +times[Math.floor(count / 2)].toFixed(2), localWallMsP95: +times[Math.ceil(count * .95) - 1].toFixed(2) };
      samples.push(item); return item;
    }
    const source = i => textBytes(String(i).padEnd(32768, '.'));
    let pubSource;
    const fresh = await sample('source_32kib', async i => { pubSource = await c.publish('/sea', source(i)); });
    assert.equal(fresh.r2Puts, count); assert.equal(fresh.r2Gets, 0);
    const retries = await sample('exact_source_retry', i => c.publish('/sea', source(i)));
    assert.equal(retries.r2Puts, 0); assert.equal(retries.r2Gets, 0); assert.equal(retries.databaseBytes, 0);
    const publication = await c.publish('/grove/fern', textBytes(pubSource.result + '\n'));
    const chat = '/chat' + publication.result;
    await sample('anonymous_chat_1kib', i => c.publish(chat, textBytes(String(i).padEnd(1024, '.'))));
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const key = await c.publish('/sea', keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))));
    const action = actionBytes({ destination: origin + '/plot/fern', author: key.result, body: new Uint8Array() }, origin);
    const plot = await c.publish('/plot/fern', action, await signAction(action, pair.privateKey, origin));
    await sample('signed_chat_1kib', async i => {
      const bytes = actionBytes({ destination: origin + chat, author: plot.result, body: textBytes(String(i).padEnd(1024, '.')) }, origin);
      await c.publish(chat, bytes, await signAction(bytes, pair.privateKey, origin));
    });
    await sample('publication', i => c.publish('/grove/other' + i, textBytes(pubSource.result + '\n')));
    const longTopic = Array.from({ length: 7 }, (_, i) => 'fern_' + i + '_'.repeat(26)).join('/');
    await sample('long_path_publication', i => c.publish('/grove/' + longTopic + '/p' + i, textBytes(pubSource.result + '\n')));
    for (const item of samples.filter(s => s.kind.includes('chat'))) assert.equal(item.r2Puts, 0);
    return { format: 'sprig-local-rehearsal/1', node: process.version, count, samples, throttles: await throttles(),
      note: 'Local workerd/SQLite/R2 emulation. Elapsed client time includes transport, signing and validation; it is not Worker CPU or production throughput. Page allocation is a small-sample estimate.' };
  } finally { await host.close(); }
}
async function throttles() {
  // Preserve production capacities, with a near-zero refill so the rehearsal is reproducible on slow CI.
  const h = await probe({ policy: { attempts: { ...DEFAULT_POLICY.attempts, refill: 1, periodMs: 86400000 } },
    httpPolicy: { ...HTTP_DEFAULTS, readRefill: 1, readPeriodMs: 86400000 } });
  try {
    const writes = {}, reads = {};
    for (let i = 0; i < 40; i++) {
      const r = await h.request('/sea', { method: 'POST', body: 'same source' });
      writes[r.status] = (writes[r.status] ?? 0) + 1; await r.text();
    }
    const before = await h.measure();
    for (let i = 0; i < 140; i++) {
      const r = await h.request('/sea'); reads[r.status] = (reads[r.status] ?? 0) + 1; await r.text();
    }
    assert.deepEqual(writes, { 200: 30, 429: 10 }); assert.deepEqual(reads, { 200: 120, 429: 20 });
    assert.deepEqual(await h.measure(), before); // listings neither write SQL nor read R2
    assert.equal(before.puts, 1);
    return { writes, reads, r2Puts: before.puts, r2Gets: before.gets };
  } finally { await h.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv.length <= 3, 'Usage: npm run rehearse:core -- [8..512]');
  console.log(JSON.stringify(await rehearse(process.argv[2] === undefined ? 128 : Number(process.argv[2])), null, 2));
}

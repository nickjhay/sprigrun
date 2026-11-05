import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { probe, origin, backupToken } from './probe.mjs';
import { capture, checkBackup, main } from '../scripts/backup.mjs';
import { backup, restore, verify } from '../scripts/recover.mjs';
import { startNative } from '../scripts/local-http.mjs';
import { nativeClient } from '../scripts/http-client.mjs';
import { textBytes } from '../src/bytes.ts';
async function fixture(t, options) {
  const host = await probe(options), dir = await mkdtemp(join(tmpdir(), 'sprig-ops-'));
  await mkdir(join(dir, 'witness'));
  t.after(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...host, dir, archive: join(dir, 'archive.jsonl'), witness: join(dir, 'witness', 'cut.json') };
}
test('backup-only credential exports suppressed bytes but cannot mutate, inspect or restore', async t => {
  const h = await fixture(t), source = await h.client.publish('/sea', textBytes('a quiet fern'));
  await h.client.suppress(source.result, true);
  const env = { SPRIG_BACKUP_TOKEN: backupToken };
  const saved = await main(['capture', origin, h.archive, '--witness', h.witness], { env, fetcher: h.fetcher, out() {}, progress() {} });
  assert.equal((await checkBackup(h.archive, h.witness)).chain, saved.chain);
  assert.match(await readFile(h.archive, 'utf8'), /a quiet fern/);
  assert.equal((await stat(h.archive)).mode & 0o777, 0o600);
  assert.equal((await stat(h.witness)).mode & 0o777, 0o600);
  for (const [path, method] of [['/admin/pause', 'POST'], ['/admin/suppress', 'POST'], ['/admin/block-author', 'POST'], ['/admin/policy', 'GET'], ['/admin/restore/begin', 'POST'],
    ['/admin/inspect?table=control', 'GET'], ['/admin/recovery/status', 'GET'], ['/admin/snapshot/header?epoch=0', 'POST']]) {
    const r = await h.request(path, { method, headers: { Authorization: 'Bearer ' + backupToken }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, 404, path); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal((await h.request('/admin/snapshot/header?epoch=0', { headers: { Authorization: 'Bearer ' + 'c'.repeat(64) } })).status, 404);
  const completed = await promisify(execFile)(process.execPath, ['core/scripts/backup.mjs', 'check', h.archive, '--witness', h.witness]);
  assert.equal(JSON.parse(completed.stdout).chain, saved.chain);
  const target = await startNative({ port: 0, origin, restoring: true, policy: (await verify(h.archive)).header.policy, adminToken: 'd'.repeat(64) });
  t.after(() => target.close());
  const restored = await restore(nativeClient(origin, { token: 'd'.repeat(64), fetcher: (...args) => target.mf.dispatchFetch(...args) }), h.archive, saved.chain);
  assert.equal(restored.phase, 'restored');
});
test('batched and individual export produce identical archives, even with later writes', async t => {
  const h = await fixture(t), s = await h.client.publish('/sea', textBytes('source'));
  const pub = await h.client.publish('/grove/fern', textBytes(s.result + '\n'));
  for (let i = 0; i < 40; i++) await h.client.publish('/chat' + pub.result, textBytes('message ' + i));
  const epoch = await h.backup.cut();
  for (let i = 0; i < 35; i++) await h.client.publish('/chat' + pub.result, textBytes('future ' + i));
  const before = await h.measure();
  const saved = await backup(h.backup, h.archive, epoch);
  assert.equal((await h.measure()).gets - before.gets, 1);
  const second = join(h.dir, 'individual.jsonl');
  await backup({ ...h.backup, snapshotBatch: undefined }, second, epoch);
  assert.deepEqual(await readFile(h.archive), await readFile(second));
  assert.equal((await h.measure()).gets - before.gets, 2);
  assert.ok(BigInt(saved.footer.count) > 40n);
  await assert.rejects(h.backup.snapshotBatch(epoch, 'sources', ''), /snapshot_sources_individual/);
});
test('batch byte bound makes progress with large records', async t => {
  const h = await fixture(t, { policy: { chatBytes: 256 * 1024 } });
  const s = await h.client.publish('/sea', textBytes('x'));
  const pub = await h.client.publish('/grove/large', textBytes(s.result + '\n'));
  // Control characters expand in canonical archive JSON; a single valid record may exceed 512 KiB.
  for (let i = 0; i < 3; i++) await h.client.publish('/chat' + pub.result, textBytes(i + '\0'.repeat(90000)));
  const epoch = await h.backup.cut(), seen = [];
  let after = '';
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 10);
    const page = await h.backup.snapshotBatch(epoch, 'results', after);
    seen.push(...page.records.map(line => JSON.parse(line).row.action));
    if (page.done) break;
    assert.ok(page.after > after); after = page.after;
  }
  assert.equal(seen.length, 5); assert.equal(new Set(seen).size, 5);
  await backup(h.backup, h.archive, epoch);
});
test('capture refuses collisions before cutting; pins origin and independently held digest', async t => {
  const h = await fixture(t); let cuts = 0;
  const c = { ...h.backup, cut: async () => { cuts++; return h.backup.cut(); } };
  await assert.rejects(capture(c, h.archive, join(h.dir, 'same.json')), /separate_witness_directory_required/);
  await writeFile(h.witness, 'existing');
  await assert.rejects(capture(c, h.archive, h.witness), /output_exists/); assert.equal(cuts, 0);
  await rm(h.witness);
  const saved = await capture(c, h.archive, h.witness);
  await assert.rejects(capture(c, h.archive, h.witness), /output_exists/); assert.equal(cuts, 1);
  const wrong = join(h.dir, 'wrong.json');
  await writeFile(wrong, JSON.stringify({ ...saved, chain: '0'.repeat(64) }));
  await assert.rejects(checkBackup(h.archive, wrong), /trusted_digest_mismatch/);
  await assert.rejects(backup({ ...h.backup, origin: 'https://other.example' }, join(h.dir, 'other.jsonl'), saved.epoch), /archive_origin/);
  await writeFile(h.archive, (await readFile(h.archive)).subarray(0, 100));
  await assert.rejects(checkBackup(h.archive, h.witness), /archive_truncated/);
});
test('a witness publication race preserves the completed archive and the competing witness', async t => {
  const h = await fixture(t);
  await assert.rejects(capture(h.backup, h.archive, h.witness, { onCut: () => {
    // Queue the competing write before export can finish.
    t.competing = writeFile(h.witness, 'other witness');
  } }), /archive_saved_but_witness_failed/);
  await t.competing;
  assert.match(await readFile(h.archive, 'utf8'), /"type":"end"/);
  assert.equal(await readFile(h.witness, 'utf8'), 'other witness');
});

test('bounded local rehearsal preserves retry and admission invariants', async () => {
  const { rehearse } = await import('../scripts/rehearse.mjs');
  await assert.rejects(rehearse(513), /count must be/);
  const result = await rehearse(8);
  assert.equal(result.samples.length, 6);
  assert.equal(result.throttles.writes[429], 10);
});

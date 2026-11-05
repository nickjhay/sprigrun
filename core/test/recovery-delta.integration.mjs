import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localNative } from '../scripts/local-native.mjs';
import { backup, incrementalBackup, restore, restoreChain, prepareRestoreChain, verify, verifyChain } from '../scripts/recover.mjs';
import { plant, action, origin, drillPolicy } from '../scripts/recovery-garden.mjs';
import { parseReceipt } from '../src/receipt.ts';
import { signAction } from '../src/authority.ts';
import { textBytes, utf8, orderedU64 } from '../src/bytes.ts';
import { canonical, digest } from '../host/archive.ts';

let dir, files, parts, garden, signed, signature, signedReceipt, value, publication, lastMessage, serial = 0;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sprig-deltas-'));
  files = ['full', 'delta1', 'delta2'].map(n => join(dir, n + '.jsonl')); parts = [];
  const host = await localNative({ policy: drillPolicy });
  try {
    const c = host.core; garden = await plant(c);
    parts.push(await backup(c, files[0]));
    await c.blockAuthor(garden.key, false);
    signed = action('/chat' + garden.plot, 'A signed leaf after the snapshot.', garden.plot);
    signature = await signAction(signed, garden.pair.privateKey, origin);
    signedReceipt = await c.submit(signed, signature);
    value = parseReceipt(textBytes(await c.submit(action('/sea', 'A new value in the delta.'))), origin).result.slice(origin.length);
    publication = parseReceipt(textBytes(await c.submit(action('/grove/after', value + '\n'))), origin).result.slice(origin.length);
    await c.pause(true); await c.pause(false);
    parts.push(await incrementalBackup(c, files[1], files[0], parts[0].footer.chain));
    lastMessage = parseReceipt(textBytes(await c.submit(action('/chat' + publication, 'The final leaf.'))), origin).result.slice(origin.length);
    await c.suppress(garden.source, true);
    await c.blockAuthor(garden.key, true);
    await c.pause(true);
    parts.push(await incrementalBackup(c, files[2], files[1], parts[1].footer.chain));
  } finally { await host.dispose(); }
});
after(() => rm(dir, { recursive: true, force: true }));
async function target(t, name) {
  const directory = join(dir, name ?? 'target-' + serial++);
  let host = await localNative({ directory, policy: drillPolicy, restoring: true });
  const result = { get core() { return host.core; }, async reopen(restoring) {
    await host.dispose(); host = await localNative({ directory, policy: drillPolicy, restoring });
  } };
  t.after(() => host.dispose()); return result;
}
const rows = async file => (await readFile(file, 'utf8')).trimEnd().split('\n');
async function rewrite(file, mutate) {
  const values = (await rows(file)).map(JSON.parse); mutate(values);
  let chain = await digest(canonical(values[0]));
  for (const r of values.slice(1, -1)) chain = await digest(chain + '\n' + canonical(r));
  values[values.length - 1] = { type: 'end', count: String(values.length - 2), chain };
  const path = join(dir, 'changed-' + serial++ + '.jsonl');
  await writeFile(path, values.map(canonical).join('\n') + '\n'); return { path, chain };
}

test('snapshot plus two deltas restores exact history, blocks, times and numbers without reviving credit', async t => {
  const h = await target(t), final = parts[2].footer.chain;
  assert.equal((await restoreChain(h.core, files, final)).phase, 'restored');
  const c = await h.core.stats();
  for (const key of ['journal', 'position', 'accepted', 'reservedBytes', 'acceptedDebit', 'moderation'])
    assert.equal(c[key], parts[2].header.control[key], key);
  assert.equal(Object.hasOwn(c, 'epoch'), false); assert.equal(c.paused, true);
  for (const name of ['growth', 'burst', 'attempts']) assert.equal(c[name].tokens, 0);
  await h.core.restoreFinish(); assert.deepEqual(await h.core.stats(), c); // Finishing twice changes no credits/times.
  await h.core.restoreRelease(final, 'history-reconciled');
  const released = await h.core.stats(); await h.core.restoreRelease(final, 'history-reconciled');
  assert.deepEqual(await h.core.stats(), released);
  await h.reopen(false); await h.core.pause(false);
  assert.equal(utf8(await h.core.read(value)), 'A new value in the delta.');
  await assert.rejects(h.core.read(garden.source), /suppressed/);
  const result = parseReceipt(textBytes(signedReceipt), origin).result.slice(origin.length);
  const evidence = await h.core.evidence(result);
  assert.equal(evidence.action, utf8(signed)); assert.equal(evidence.signature, signature);
  assert.equal(evidence.receipt, signedReceipt);
  const before = await h.core.stats(); assert.equal(await h.core.submit(signed, signature), signedReceipt);
  assert.equal((await h.core.stats()).position, before.position);
  const blocked = action(result, 'Rejected by the recovered key block.', garden.key);
  await assert.rejects(h.core.submit(blocked, await signAction(blocked, garden.pair.privateKey, origin)), /author_blocked/);
  const next = parseReceipt(textBytes(await h.core.submit(action(lastMessage, 'A leaf after recovery.'))), origin);
  assert.equal(next.result, origin + '/chat' + publication + '/1');
  const again = join(dir, 'recovered-full.jsonl'), saved = await backup(h.core, again);
  const second = await target(t);
  assert.equal((await restore(second.core, again, saved.footer.chain)).phase, 'restored');
});

test('a pinned missing suffix stays quarantined across restart; import resumes after a lost record reply', async t => {
  const h = await target(t), final = parts[2].footer.chain;
  assert.equal((await restore(h.core, files[0], parts[0].footer.chain, final)).phase, 'awaiting_delta');
  await assert.rejects(h.core.restoreRelease(final, 'history-reconciled'), /restore_not_complete/);
  await h.reopen(false);
  await assert.rejects(h.core.read(garden.key), /recovery_mode/);
  await assert.rejects(h.core.pause(false), /recovery_mode/);
  await h.reopen(true);
  const lines = await rows(files[1]);
  await h.core.restoreBegin(lines[0], lines.at(-1), final);
  for (let i = 1; i <= 3; i++) await h.core.restoreRecord(String(i), lines[i]);
  const previous = await h.core.restoreStatus();
  assert.deepEqual(await h.core.restoreRecord('3', lines[3]), previous);
  await assert.rejects(h.core.restoreRecord('3', lines[2]), /restore_record_order/);
  await assert.rejects(h.core.restoreFinish(), /archive_incomplete/);
  await h.reopen(true);
  assert.deepEqual(await h.core.restoreStatus(), previous);
  assert.equal((await restoreChain(h.core, files, final)).phase, 'restored');
});

test('chain verification refuses missing, duplicated, reordered, foreign and truncated segments before import', async t => {
  const h = await target(t), final = parts[2].footer.chain;
  for (const plan of [[files[0], files[2]], [files[0], files[1], files[1], files[2]],
    [files[0], files[2], files[1]], [files[1], files[2]], [files[0], files[1]]]) {
    await assert.rejects(restoreChain(h.core, plan, final));
    assert.equal(await h.core.restoreStatus(), null);
  }
  const foreign = await localNative({ policy: drillPolicy }); t.after(() => foreign.dispose());
  const otherFile = join(dir, 'foreign.jsonl'); await backup(foreign.core, otherFile);
  await assert.rejects(verifyChain([otherFile, files[1], files[2]], final), /archive_base_mismatch/);
  const truncated = join(dir, 'truncated.jsonl');
  await writeFile(truncated, (await readFile(files[2])).subarray(0, -1));
  await assert.rejects(verifyChain([files[0], files[1], truncated], final), /archive_truncated/);
  await assert.rejects(verifyChain(files, '0'.repeat(64)), /trusted_digest_mismatch/);
});

test('record gaps, duplicates and reordering reject even with a recomputed delta checksum', async () => {
  for (const mutate of [v => v.splice(2, 1), v => v.splice(2, 0, v[1]),
    v => { [v[1], v[2]] = [v[2], v[1]]; }]) {
    const changed = await rewrite(files[1], mutate);
    await assert.rejects(verify(changed.path, changed.chain), /archive_position_gap/);
  }
});

test('a delta cannot be substituted at an active recovery, or weaken its pinned end', async t => {
  const h = await target(t), final = parts[2].footer.chain;
  await restore(h.core, files[0], parts[0].footer.chain, final);
  const last = await rows(files[2]);
  await assert.rejects(h.core.restoreBegin(last[0], last.at(-1), final), /restore_base_mismatch/);
  const base = await rows(files[0]);
  await assert.rejects(h.core.restoreBegin(base[0], base.at(-1), parts[0].footer.chain), /different_restore_target/);
  assert.equal((await h.core.restoreStatus()).phase, 'awaiting_delta');
});

test('a validly framed delta cannot introduce a dependent before its accepted predecessor', async t => {
  const changed = await rewrite(files[1], v => {
    const preparation = v.findIndex(r => r.type === 'sources');
    const acceptance = v.findIndex(r => r.type === 'results' && r.row.kind === 'sea');
    const x = v[preparation], y = v[acceptance];
    v[preparation] = { ...y, position: x.position }; v[acceptance] = { ...x, position: y.position };
  });
  await verify(changed.path, changed.chain); // Counts and signatures need contextual checking at restore.
  const h = await target(t);
  await restore(h.core, files[0], parts[0].footer.chain, changed.chain);
  await assert.rejects(restore(h.core, changed.path, changed.chain), /archive_missing_source/);
  assert.equal((await h.core.restoreStatus()).phase, 'importing');
});

test('prepared restore cannot trust changed bytes, framing or caller-mutated descriptors', async t => {
  const original = await readFile(files[0], 'utf8'), chain = parts[0].footer.chain;
  for (const kind of ['body', 'footer', 'trailing']) {
    const file = join(dir, 'after-preflight-' + kind + '.jsonl'); await writeFile(file, original);
    const prepared = await prepareRestoreChain([file], chain), h = await target(t);
    const values = original.trimEnd().split('\n').map(JSON.parse);
    if (kind === 'body') values.find(r => r.type === 'results' && r.row.kind === 'sea').body += 'changed';
    if (kind === 'footer') values.pop();
    if (kind === 'trailing') values.push({ unexpected: true });
    await writeFile(file, values.map(canonical).join('\n') + '\n');
    await assert.rejects(prepared.restore(h.core), kind === 'body' ? /archive_source_hash/ : kind === 'footer' ? /archive_changed/ : /archive_trailing_data/);
    assert.equal((await h.core.restoreStatus()).phase, 'importing');
    await assert.rejects(h.core.read(garden.key), /recovery_mode/);
  }
  const input = [files[0]], prepared = await prepareRestoreChain(input, chain), h = await target(t);
  input[0] = 'not-the-checked-file'; prepared.final.footer.chain = '0'.repeat(64);
  assert.equal((await prepared.restore(h.core)).phase, 'restored');
  assert.equal((await h.core.restoreStatus()).expected, chain);
});

test('an empty increment is read-only and restores after its exact base', async t => {
  const source = await localNative({ policy: drillPolicy }); t.after(() => source.dispose());
  await plant(source.core);
  const fullFile = join(dir, 'unchanged-full.jsonl'), deltaFile = join(dir, 'unchanged-delta.jsonl');
  const full = await backup(source.core, fullFile), before = await source.core.stats();
  const delta = await incrementalBackup(source.core, deltaFile, fullFile, full.footer.chain);
  assert.deepEqual(await source.core.stats(), before);
  assert.equal(delta.footer.count, '0');
  assert.equal(delta.header.control.position, full.header.control.position);
  const h = await target(t);
  assert.equal((await restoreChain(h.core, [fullFile, deltaFile], delta.footer.chain)).phase, 'restored');
  assert.equal((await h.core.stats()).accepted, before.accepted);
});

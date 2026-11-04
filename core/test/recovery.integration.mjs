import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localNative } from '../scripts/local-native.mjs';
import { backup, restore, verify, lines } from '../scripts/recover.mjs';
import { action, drillPolicy, origin, plant } from '../scripts/recovery-garden.mjs';
import { canonical, initial, advance, parseLine } from '../host/archive.ts';
import { textBytes, utf8 } from '../src/bytes.ts';
import { parseReceipt } from '../src/receipt.ts';

let scratch, archive, saved, garden, all, serial = 0;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sprig-recovery-tests-'));
  archive = join(scratch, 'original.jsonl');
  const host = await localNative({ policy: drillPolicy });
  try { garden = await plant(host.core); saved = await backup(host.core, archive); }
  finally { await host.dispose(); }
  all = (await readFile(archive, 'utf8')).trimEnd().split('\n');
});
after(() => rm(scratch, { recursive: true, force: true }));
async function target(t, options = {}) {
  const host = await localNative({ policy: drillPolicy, restoring: true, ...options });
  t.after(() => host.dispose()); return host.core;
}
async function changed(change) {
  const rows = all.map(parseLine); change(rows);
  let p = await initial(rows[0]);
  for (const r of rows.slice(1, -1)) p = await advance(p, r, canonical(r));
  const footer = { type: 'end', count: p.count, chain: p.chain };
  rows[rows.length - 1] = footer;
  const file = join(scratch, 'changed-' + serial++ + '.jsonl');
  await writeFile(file, rows.map(canonical).join('\n') + '\n');
  return { file, footer };
}

test('loss of SQLite and R2: restore exact receipts, authority, times and suppression; resume above consumed numbers', async t => {
  const directory = join(scratch, 'complete');
  let host = await localNative({ directory, policy: drillPolicy, restoring: true });
  t.after(() => host.dispose());
  const c = host.core;
  assert.equal((await restore(c, archive, saved.footer.chain)).phase, 'restored');
  assert.equal((await c.restoreFinish()).phase, 'restored');
  const state = await c.stats();
  assert.equal(state.epoch, '1'); assert.equal(state.paused, true);
  for (const k of ['growth', 'burst', 'attempts']) assert.equal(state[k].tokens, 0);
  for (const k of ['accepted', 'reservedBytes', 'acceptedDebit']) assert.equal(state[k], saved.header.control[k]);
  await assert.rejects(c.read(garden.source), /recovery_mode/);
  await assert.rejects(c.pause(false), /recovery_mode/);
  await assert.rejects(c.restoreRelease(saved.footer.chain, 'yes'), /restore_history_confirmation/);
  await c.restoreRelease(saved.footer.chain, 'history-reconciled');
  await assert.rejects(c.read(garden.source), /recovery_mode/); // environment fence still present
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy });
  await assert.rejects(host.core.submit(action('/sea', 'premature')), /writes_paused/);
  await host.core.pause(false);
  assert.equal(utf8(await host.core.read(garden.source)), '\ufeff1 2 + print\r\n\0🌿');
  for (const item of garden.history) {
    if (item.result === garden.hidden) {
      await assert.rejects(host.core.evidence(item.result), /suppressed/);
      await assert.rejects(host.core.submit(item.bytes, item.signature), /suppressed/);
    } else {
      assert.equal(await host.core.submit(item.bytes, item.signature), item.receipt);
      const evidence = await host.core.evidence(item.result);
      assert.equal(evidence.action, utf8(item.bytes)); assert.equal(evidence.signature, item.signature);
    }
  }
  await assert.rejects(host.core.latest('/chat' + garden.grove), /suppressed/);
  const receipt = await host.core.submit(action(garden.hidden, 'After recovery.'));
  assert.equal(parseReceipt(textBytes(receipt), origin).result, origin + '/chat' + garden.grove + '/2');
  const again = join(scratch, 'second-generation.jsonl');
  const second = await backup(host.core, again);
  const secondTarget = await target(t);
  assert.equal((await restore(secondTarget, again, second.footer.chain)).phase, 'restored');
});

test('interrupted restore resumes after restart; a lost acknowledgement can repeat only the identical last record', async t => {
  const directory = join(scratch, 'interrupted');
  let host = await localNative({ directory, policy: drillPolicy, restoring: true });
  t.after(() => host.dispose());
  await host.core.restoreBegin(all[0], all.at(-1));
  await assert.rejects(host.core.restoreFinish(), /archive_incomplete/);
  for (let i = 1; i <= 3; i++) await host.core.restoreRecord(String(i), all[i]);
  assert.equal((await host.core.restoreRecord('3', all[3])).count, '3');
  await assert.rejects(host.core.restoreRecord('3', all[2]), /restore_record_order/);
  await assert.rejects(host.core.restoreRecord('5', all[5]), /restore_record_order/);
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy });
  // Dropping the environment flag cannot expose a partly reconstructed database.
  await assert.rejects(host.core.read(garden.source), /recovery_mode/);
  await assert.rejects(host.core.submit(action('/sea', 'early')), /recovery_mode/);
  await assert.rejects(host.core.pause(false), /recovery_mode/);
  await assert.rejects(host.core.restoreFinish(), /restore_mode_required/);
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy, restoring: true });
  assert.equal((await host.core.restoreStatus()).count, '3');
  assert.equal((await restore(host.core, archive, saved.footer.chain)).phase, 'restored');
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy });
  await assert.rejects(host.core.read(garden.source), /recovery_mode/);
  await assert.rejects(host.core.cut(), /recovery_mode/);
});

test('a trusted digest is required before mutating the target', async t => {
  const core = await target(t);
  await assert.rejects(restore(core, archive, '0'.repeat(64)), /trusted_digest_mismatch/);
  assert.equal(await core.restoreStatus(), null);
  await assert.rejects(restore(core, archive), /archive_hash/);
});

test('restore rejects changed origin, policy, and preexisting database', async t => {
  const otherOrigin = await target(t, { origin: 'https://other.invalid' });
  await assert.rejects(restore(otherOrigin, archive, saved.footer.chain), /archive_origin/);
  const otherPolicy = await target(t, { policy: { ...drillPolicy, chatBytes: 100 } });
  await assert.rejects(restore(otherPolicy, archive, saved.footer.chain), /restore_policy_mismatch/);
  const directory = join(scratch, 'occupied');
  let host = await localNative({ directory, policy: drillPolicy });
  t.after(() => host.dispose());
  await host.core.submit(action('/sea', 'already here'));
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy, restoring: true });
  await assert.rejects(restore(host.core, archive, saved.footer.chain), /restore_requires_empty_target/);
});

test('archive framing rejects truncation, duplicate JSON keys, CRLF, reorder and trailing bytes', async () => {
  const variants = [
    all.join('\n'), // missing final newline
    all.slice(0, -1).join('\n') + '\n',
    all[0].replace('"epoch":"0"', '"epoch":"0","epoch":"0"') + '\n' + all.slice(1).join('\n') + '\n',
    all.join('\r\n') + '\r\n',
    [all[0], all[2], all[1], ...all.slice(3)].join('\n') + '\n',
    all.join('\n') + '\n{}\n',
    all.join('\n').replace('1 2 + print', '1 3 + print') + '\n',
    all.slice(0, -2).concat(all.at(-1)).join('\n') + '\n',
    'x'.repeat(2 * 1024 * 1024 + 1),
  ];
  for (const value of variants) {
    const file = join(scratch, 'bad-' + serial++);
    await writeFile(file, value); await assert.rejects(verify(file));
  }
});

test('recomputed checksum cannot substitute for signature, entry or acceptance validation', async t => {
  const changes = [
    rows => { const r = rows.find(r => r.type === 'results' && r.row.signature); r.row.signature = 'A'.repeat(86); },
    rows => { const r = rows.find(r => r.type === 'results'); r.row.accepted_at_ms = '1'; },
    rows => { const r = rows.find(r => r.type === 'results' && r.row.kind === 'chat'); r.row.body += 'changed'; },
    rows => {
      const r = rows.find(r => r.type === 'results' && r.row.kind === 'grove');
      r.row.value = '/sea/' + 'a'.repeat(64) + '_1'; // valid reference grammar, wrong action value
    },
  ];
  for (const change of changes) {
    const tampered = await changed(change), core = await target(t);
    await verify(tampered.file, tampered.footer.chain); // structural validation alone is insufficient
    await assert.rejects(restore(core, tampered.file, tampered.footer.chain));
    assert.equal((await core.restoreStatus()).phase, 'verifying');
    await assert.rejects(core.read(garden.source), /recovery_mode/);
    await assert.rejects(core.restoreRelease(tampered.footer.chain, 'history-reconciled'), /restore_not_complete/);
  }
});

test('a cut stays stable after later appends, visibility changes and other cuts; pages bound examined rows', async t => {
  const host = await localNative({ policy: drillPolicy }); t.after(() => host.dispose());
  const core = host.core;
  const planted = await plant(core), epoch = await core.cut();
  const headerBefore = await core.snapshotHeader(epoch);
  await core.suppress(planted.hidden, false);
  for (let i = 0; i < 40; i++) await core.submit(action('/grove/aaa_' + i, planted.source + '\n'));
  await core.cut();
  const first = await core.snapshotPage(epoch, 'results', '/grove/');
  assert.deepEqual(first.keys, []); assert.equal(first.done, false); assert.ok(first.after);
  const file = join(scratch, 'later-copy.jsonl');
  const b = await backup(core, file, epoch), rows = [];
  for await (const line of lines(file)) rows.push(parseLine(line));
  assert.equal(rows.filter(r => r.type === 'results').length, 7);
  assert.equal(rows.filter(r => r.type === 'suppressions' && r.row.path === planted.hidden).length, 1);
  const recovered = await target(t);
  assert.equal((await restore(recovered, file, b.footer.chain)).phase, 'restored');
  assert.equal(await core.snapshotHeader(epoch), headerBefore);
  await assert.rejects(core.snapshotPage(epoch, 'control; DROP TABLE entries', ''), /archive_table/);
});

test('backup publication is exclusive and leaves no partial files on failure', async t => {
  const host = await localNative({ policy: drillPolicy }); t.after(() => host.dispose());
  const directory = join(scratch, 'publication');
  const { mkdir } = await import('node:fs/promises'); await mkdir(directory);
  const file = join(directory, 'keep.jsonl'); await writeFile(file, 'keep this');
  await assert.rejects(backup(host.core, file), /archive_exists/);
  assert.equal(await readFile(file, 'utf8'), 'keep this');
  assert.deepEqual(await readdir(directory), ['keep.jsonl']);
});

test('empty history and a maximally escaped source both fit the bounded archive format', async t => {
  const host = await localNative({ policy: drillPolicy }); t.after(() => host.dispose());
  const emptyFile = join(scratch, 'empty.jsonl'), empty = await backup(host.core, emptyFile);
  assert.equal(empty.footer.count, '1');
  const emptyTarget = await target(t);
  assert.equal((await restore(emptyTarget, emptyFile, empty.footer.chain)).phase, 'restored');
  await host.core.submit(action('/sea', '\0'.repeat(256 * 1024)));
  const file = join(scratch, 'escaped.jsonl'), saved = await backup(host.core, file);
  const core = await target(t);
  assert.equal((await restore(core, file, saved.footer.chain)).phase, 'restored');
});

test('result verification is bounded, survives restart and keeps forward references quarantined', async t => {
  const original = await localNative({ policy: drillPolicy }); t.after(() => original.dispose());
  const g = await plant(original.core);
  // Chats sort before their grove and source dependencies; source rows have no acceptance metadata.
  for (let i = 0; i < 40; i++) await original.core.submit(action('/chat' + g.grove, 'batch ' + i));
  const file = join(scratch, 'two-pass.jsonl'), b = await backup(original.core, file);
  const directory = join(scratch, 'verify-restart');
  let host = await localNative({ directory, policy: drillPolicy, restoring: true }); t.after(() => host.dispose());
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  await host.core.restoreBegin(lines[0], lines.at(-1));
  for (let i = 1; i < lines.length - 1; i++) await host.core.restoreRecord(String(i), lines[i]);
  const partial = await host.core.restoreFinish();
  assert.equal(partial.phase, 'verifying'); assert.ok(partial.verifiedThrough.startsWith('/chat/'));
  await assert.rejects(host.core.restoreRelease(b.footer.chain, 'history-reconciled'), /restore_not_complete/);
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy });
  await assert.rejects(host.core.read(g.source), /recovery_mode/);
  assert.equal((await host.core.restoreStatus()).verifiedThrough, partial.verifiedThrough);
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy, restoring: true });
  assert.equal((await restore(host.core, file, b.footer.chain)).phase, 'restored');
  await host.core.restoreRelease(b.footer.chain, 'history-reconciled');
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy });
  await host.core.pause(false);
  for (const item of g.history) if (item.result !== g.hidden)
    assert.equal(await host.core.submit(item.bytes, item.signature), item.receipt);
});

test('restoration retains first-publication ownership of the receipt, including a signed winner', async t => {
  const { keyRecordBytes, signAction } = await import('../src/authority.ts');
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const original = await localNative({ policy: drillPolicy }); t.after(() => original.dispose());
  const keyReceipt = await original.core.submit(action('/sea', utf8(keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))))));
  const key = parseReceipt(textBytes(keyReceipt), origin).result.slice(origin.length);
  const signed = action('/sea', 'the persistent fern', key), signature = await signAction(signed, pair.privateKey, origin);
  const receipt = await original.core.submit(signed, signature), result = parseReceipt(textBytes(receipt), origin).result.slice(origin.length);
  const file = join(scratch, 'first-publication.jsonl'), b = await backup(original.core, file);
  const directory = join(scratch, 'first-publication');
  let host = await localNative({ directory, policy: drillPolicy, restoring: true }); t.after(() => host.dispose());
  await restore(host.core, file, b.footer.chain);
  await host.core.restoreRelease(b.footer.chain, 'history-reconciled');
  await host.dispose(); host = await localNative({ directory, policy: drillPolicy });
  await host.core.pause(false);
  const before = await host.core.stats();
  await assert.rejects(host.core.submit(action('/sea', 'the persistent fern')), /already_stored/);
  assert.equal(await host.core.submit(signed, signature), receipt);
  assert.equal((await host.core.evidence(result)).receipt, receipt);
  assert.equal((await host.core.stats()).acceptedDebit, before.acceptedDebit);
});

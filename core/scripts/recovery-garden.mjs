// Development keys are ephemeral. Never reuse them as production identities.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { actionBytes, actionId } from '../src/action.ts';
import { textBytes, utf8 } from '../src/bytes.ts';
import { keyRecordBytes, signAction } from '../src/authority.ts';
import { parseReceipt } from '../src/receipt.ts';
import { DEFAULT_POLICY } from '../host/policy.ts';
import { localNative } from './local-native.mjs';
import { backup, restore } from './recover.mjs';

export const origin = 'https://sprig.run';
// The drill needs prompt refill after restoration clears spendable credit.
export const drillPolicy = { ...DEFAULT_POLICY,
  growth: { capacity: 16 * 1024 * 1024, refill: 16 * 1024 * 1024, periodMs: 1 },
  burst: { capacity: 16 * 1024 * 1024, refill: 16 * 1024 * 1024, periodMs: 1 },
  attempts: { capacity: 10000, refill: 10000, periodMs: 1 } };
export const action = (path, body = '', author) => actionBytes({ destination: origin + path,
  body: textBytes(body), author }, origin);
export async function plant(core) {
  const history = [];
  async function add(path, body = '', author, privateKey) {
    const bytes = action(path, body, author);
    const signature = privateKey ? await signAction(bytes, privateKey, origin) : null;
    const receipt = await core.submit(bytes, signature);
    const result = parseReceipt(textBytes(receipt), origin).result.slice(origin.length);
    history.push({ bytes, signature, receipt, result, id: await actionId(bytes, origin) });
    return result;
  }
  const source = await add('/sea', '\ufeff1 2 + print\r\n\0🌿');
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const key = await add('/sea', utf8(keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))));
  const plot = await add('/plot/moss', '', key, pair.privateKey);
  const grove = await add('/grove/fern', source + '\n');
  const publication = await add(plot + '/garden', source + '\n', plot, pair.privateKey);
  const chat = await add('/chat' + grove, 'There is room for another fern.', plot, pair.privateKey);
  const hidden = await add(chat, 'A leaf kept in the archive.');
  await core.suppress(hidden, true);
  // Interleave target policies; the archive preserves their global policy position.
  await core.suppress(plot, true); await core.suppress(plot, false);
  await core.suppress(publication, true); await core.suppress(publication, false);
  await core.blockAuthor(key, true);
  return { history, source, key, plot, grove, publication, chat, hidden, pair };
}
export async function drill(file) {
  const work = await mkdtemp(join(tmpdir(), 'sprig-recovery-'));
  let host;
  try {
    host = await localNative({ directory: join(work, 'original'), policy: drillPolicy });
    const garden = await plant(host.core);
    const originalStats = await host.core.stats();
    const binding = await host.core.read(garden.plot);
    const saved = await backup(host.core, file);
    await host.dispose(); host = null;
    await rm(join(work, 'original'), { recursive: true, force: true });
    console.log('Original SQLite and R2 removed. Only the archive remains.');
    const target = join(work, 'restored');
    host = await localNative({ directory: target, policy: drillPolicy, restoring: true });
    await restore(host.core, file, saved.footer.chain);
    await assert.rejects(host.core.read(garden.source), /recovery_mode/);
    // Valid only because this isolated drill knows there was no post-cut history.
    await host.core.restoreRelease(saved.footer.chain, 'history-reconciled');
    await host.dispose();
    host = await localNative({ directory: target, policy: drillPolicy });
    assert.equal((await host.core.stats()).paused, true);
    await host.core.pause(false);
    assert.deepEqual(await host.core.read(garden.plot), binding);
    for (const item of garden.history) {
      if (item.result === garden.hidden) {
        await assert.rejects(host.core.read(item.result), /suppressed/);
        await assert.rejects(host.core.submit(item.bytes, item.signature), /suppressed/);
      } else {
        assert.equal(await host.core.submit(item.bytes, item.signature), item.receipt);
        assert.equal((await host.core.evidence(item.result)).action, utf8(item.bytes));
      }
    }
    for (const k of ['moderation', 'accepted', 'acceptedDebit', 'reservedBytes'])
      assert.equal((await host.core.stats())[k], originalStats[k]);
    const receipt = await host.core.submit(action(garden.hidden, 'The fern came back.'));
    assert.equal(parseReceipt(textBytes(receipt), origin).result, origin + '/chat' + garden.grove + '/2');
    console.log('Exact receipts, signatures, plot authority, content hiding, author blocks and quota totals survived.');
    console.log('The next chat entry is /chat' + garden.grove + '/2 (the hidden /1 stays consumed).');
    console.log(`Archive: ${resolve(file)}\nTrusted chain: ${saved.footer.chain}`);
    console.log('One restored receipt:\n' + garden.history[5].receipt);
    return saved;
  } finally { await host?.dispose(); await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv.length <= 3, 'usage: npm run demo:recovery -- [new-archive.jsonl]');
  const file = process.argv[2] ?? join(await mkdtemp(join(tmpdir(), 'sprig-archive-')), 'garden.jsonl');
  await drill(file);
}

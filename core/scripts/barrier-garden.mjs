// Disposable local failure drill. Includes privileged test hooks; never deploy it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localCluster, finish, origin, bodyOn } from '../test/barrier-local.mjs';
import { actionBytes } from '../src/action.ts';
import { textBytes, utf8 } from '../src/bytes.ts';
import { parseReceipt } from '../src/receipt.ts';
import { backup, verify } from './recover.mjs';
const directory = await mkdtemp(join(tmpdir(), 'sprig-barrier-garden-'));
const id = randomUUID().replaceAll('-', '');
let host;
try {
  host = await localCluster({ directory }); await host.controller.initialize();
  const plants = { fern: 'A fern unfolds between two cuts.\n', moss: 'Moss keeps the small things together.\n' }, paths = {};
  for (const name of Object.keys(plants)) {
    const body = plants[name] = await bodyOn(name, plants[name]);
    const receipt = await host.shard(name).submit(actionBytes({ destination: origin + '/sea', body: textBytes(body) }, origin));
    paths[name] = parseReceipt(textBytes(receipt), origin).result.slice(origin.length);
  }
  await host.controller.start(id); await host.controller.fail('cut:fern');
  for (;;) {
    try { await host.controller.step(id); }
    catch (error) { if (!error.message.includes('injected_cut:fern')) throw error; break; }
  }
  console.log('Lost a cut acknowledgement. Stopping the controller and both shards.');
  await host.dispose(); host = await localCluster({ directory });
  const m = await finish(host.controller, id);
  console.log('Resumed the same barrier; published both cuts before releasing either shard.');
  for (const name of Object.keys(plants)) {
    const core = host.shard(name), file = join(directory, name + '.jsonl');
    const archive = await backup(core, file, m.epoch); await verify(file, archive.footer.chain);
    if (utf8(await core.read(paths[name])) !== plants[name]) throw Error('plant_changed');
    const rows = await core.testCommand('rows', {});
    if (rows.cuts.length !== 1 || (await core.stats()).epoch !== '1') throw Error('duplicate_cut');
    console.log(name + ': one cut, verified archive, original source intact.');
  }
  console.log('The shared photograph is complete. The cluster recovery drill also restores references across these participants.');
} finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }

// Privileged local fault harness, never a public deployment entrypoint.
import { NativeBarrier } from '../host/barrier.ts';
import { TestCoordinator } from './host-worker.ts';
export { TestCoordinator };
export class TestBarrier extends NativeBarrier {
  private failure: string | null = null;
  fail(point: string) { this.failure = point; }
  async omitCut(id: string, shard: string) {
    const r = this.status(id); if (!r || r.phase !== 'publish') throw Error('test_phase');
    delete r.cuts[shard]; this.ctx.storage.sql.exec('UPDATE barrier_rounds SET value=? WHERE id=?', JSON.stringify(r), id);
    await this.ctx.storage.sync();
  }
  private hit(point: string) { if (this.failure === point) { this.failure = null; throw Error('injected_' + point); } }
  protected override async afterRemote(phase: string, name: string) { this.hit(phase + ':' + name); }
  protected override async afterCommit(phase: string) { this.hit('commit:' + phase); }
}
const memberMethods = ['submit', 'read', 'stats', 'pause', 'suppress', 'blockAuthor', 'cut', 'barrierIdentity', 'barrierHold', 'barrierCut', 'barrierRelease',
  'snapshotHeader', 'snapshotPage', 'snapshotBatch', 'snapshotRecord', 'restoreStatus', 'restoreBegin', 'restoreRecord', 'restoreFinish', 'restoreRelease', 'testCommand'];
const controllerMethods = ['initialize', 'configuration', 'start', 'step', 'status', 'published', 'fail', 'omitCut'];
export default {
  async fetch(request: Request, env: any) {
    try {
      const { shard, method, args } = await request.json() as any;
      if (shard === null) {
        if (!controllerMethods.includes(method)) throw Error('local_method');
        return Response.json({ value: await env.CORE_BARRIER.getByName('barrier')[method](...args) ?? null });
      }
      if (!Object.hasOwn(env.CORE_TOPOLOGY.shards, shard) || !memberMethods.includes(method)) throw Error('local_method');
      if (method === 'submit') args[0] = new Uint8Array(args[0]);
      let value = await env.CORE_SHARDS.getByName(shard)[method](...args);
      if (method === 'read') value = Array.from(value);
      return Response.json({ value: value ?? null });
    } catch (e) { return Response.json({error: (e as Error).message}, {status:409}); }
  }
};

// Test-only entrypoint. Wrangler deploys src/index.ts, never this file.
import service, { StoreCoordinator as Base } from '../src/index.ts';
import type { Env } from '../src/types.ts';

export class StoreCoordinator extends Base {
  private fault: { mode: string | null; gets: number; puts: number };
  constructor(ctx: DurableObjectState, env: Env) {
    const fault = { mode: null as string | null, gets: 0, puts: 0 };
    const bucket = env.BLOBS;
    const wrapped = new Proxy(bucket, {
      get(target, name) {
        if (name === 'get') return async (...args: Parameters<R2Bucket['get']>) => {
          fault.gets++;
          return bucket.get(...args);
        };
        if (name === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
          fault.puts++;
          const kind = args[2]?.customMetadata?.kind;
          const mode = fault.mode;
          if ((kind === 'blob' && ['before-write', 'after-write'].includes(mode ?? '')) ||
              (kind === 'blocked' && mode === 'before-block')) {
            fault.mode = null;
            if (mode === 'after-write') await bucket.put(...args);
            throw new Error('injected_storage_failure');
          }
          return bucket.put(...args);
        };
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, BLOBS: wrapped });
    this.fault = fault;
  }
  testFault(mode: string) { this.fault.mode = mode; }
  testStorageCalls() { return { gets: this.fault.gets, puts: this.fault.puts }; }
  testExpire() { this.ctx.storage.sql.exec('UPDATE tickets SET expires = 1'); }
  testLegacy() {
    const row = this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM control WHERE id=1').one();
    this.ctx.storage.sql.exec('UPDATE control SET value=? WHERE id=1', JSON.stringify({...JSON.parse(row.value), schema:1}));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    const store = env.STORE.get(env.STORE.idFromName('global')) as unknown as DurableObjectStub<StoreCoordinator>;
    if (path === '/__test/expire') { await store.testExpire(); return new Response('ok'); }
    if (path === '/__test/legacy') { await store.testLegacy(); return new Response('ok'); }
    if (path === '/__test/probe') {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls++; if (!request.headers.has('Test-Stall')) c.enqueue(new Uint8Array([65])); } }, { highWaterMark: 0 });
      const probe = new Request('https://blobs.example.test' + request.headers.get('Test-Path'), { method:'PUT', headers:request.headers, body:stream });
      const result = await service.fetch(probe,env,ctx);
      result.headers.set('Test-Body-Pulls',String(pulls));
      return result;
    }
    if (path === '/__test/stats') return Response.json(await store.stats());
    if (path === '/__test/storage-calls') return Response.json(await store.testStorageCalls());
    if (path.startsWith('/__test/fault/')) {
      await store.testFault(path.slice('/__test/fault/'.length));
      return new Response('ok');
    }
    const background: Promise<unknown>[] = [];
    const tracked = new Proxy(ctx, {
      get(target, name) {
        if (name === 'waitUntil') return (promise: Promise<unknown>) => { background.push(promise); };
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await service.fetch(request, env, tracked);
    await Promise.all(background);
    return response;
  },
};

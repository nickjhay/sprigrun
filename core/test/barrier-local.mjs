import { shardFor } from '../host/topology.ts';
import { contentAddress, textBytes } from '../src/bytes.ts';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY } from '../host/policy.ts';
let compiled;
export const origin = 'https://sprig.run';
export const configuration = { format: 'sprig-topology/2', id: 'b'.repeat(32), revision: '0', origin,
  shards: { fern: true, moss: true }, budget: { ...DEFAULT_POLICY,
    attempts: { capacity: 10000, refill: 10000, periodMs: 60000 } } };
export async function localCluster({ directory, topology = configuration, restoring = false } = {}) {
  compiled ??= build({ entryPoints: [fileURLToPath(new URL('barrier-worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  const code = (await compiled).outputFiles[0].text;
  const mf = new Miniflare({ cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
    ...(directory ? { resourcePersistencePath: directory } : {}), workers: [{ config: {
      name: 'barrier-local', compatibilityDate: '2026-10-26',
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: code } } },
      exports: { TestCoordinator: { type: 'durable-object', storage: 'sqlite' }, TestBarrier: { type: 'durable-object', storage: 'sqlite' } },
      env: { CORE_ORIGIN: { type: 'text', value: topology.origin }, CORE_TOPOLOGY: { type: 'json', value: topology },
        ...(restoring ? { CORE_RESTORE_MODE: { type: 'text', value: '1' } } : {}),
        SOURCES: { type: 'r2', name: 'SOURCES' },
        CORE_SHARDS: { type: 'durable-object', worker: 'barrier-local', exportName: 'TestCoordinator' },
        CORE_BARRIER: { type: 'durable-object', worker: 'barrier-local', exportName: 'TestBarrier' } } } }] });
  async function call(shard, method, ...args) {
    if (method === 'submit') args[0] = Array.from(args[0]);
    const r = await mf.dispatchFetch('https://local.invalid', {method:'POST', body:JSON.stringify({shard, method, args})});
    const value = await r.json(); if (!r.ok) throw Error(value.error);
    return method === 'read' ? new Uint8Array(value.value) : value.value;
  }
  const adapter = shard => new Proxy({}, { get: (_, method) => method === 'origin' ? topology.origin : method === 'shardName' ? shard : (...args) => call(shard, method, ...args) });
  return { mf, controller: adapter(null), shard: adapter, dispose: () => mf.dispose() };
}
export async function finish(controller, id) {
  let state = await controller.start(id);
  for (let i = 0; state.phase !== 'done'; i++) {
    if (i > 64) throw Error('barrier_step_limit'); state = await controller.step(id);
  }
  return controller.published(id);
}

// Deterministic placement fixtures: choose source bytes for the desired physical participant.
export async function bodyOn(name, prefix, topology = configuration) {
  for (let i=0; i<1000; i++) {
    const body = prefix + '\n' + i;
    if (await shardFor(topology, '/sea/' + await contentAddress(textBytes(body))) === name) return body;
  }
  throw Error('fixture_placement');
}

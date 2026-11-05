// In-process local transport for the actual coordinator. Never deploy this
// privileged adapter: it intentionally has no operator authentication.
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { fileURLToPath } from 'node:url';
let compiled;
const methods = ['submit', 'read', 'latest', 'evidence', 'stats', 'suppress', 'blockAuthor', 'policyPage', 'policyStatus', 'pause', 'cut',
  'snapshotHeader', 'snapshotPage', 'snapshotRecord', 'snapshotBatch', 'restoreStatus', 'restoreBegin',
  'restoreRecord', 'restoreFinish', 'restoreRelease'];
export async function localNative({ directory, origin = 'https://sprig.run', policy, restoring = false } = {}) {
  compiled ??= build({ stdin: {
    contents: `export { NativeCoordinator } from './coordinator.ts';
      const methods = ${JSON.stringify(methods)};
      export default { async fetch(request, env) {
        try {
          const {method, args} = await request.json();
          if (!methods.includes(method)) throw Error('local_method');
          if (method === 'submit') args[0] = new Uint8Array(args[0]);
          let value = await env.CORE.getByName('core')[method](...args);
          if (method === 'read') value = Array.from(value);
          return Response.json({value: value ?? null});
        } catch (e) { return Response.json({error: e.message}, {status:409}); }
      } };`,
    resolveDir: fileURLToPath(new URL('../host/', import.meta.url)),
  }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  const code = (await compiled).outputFiles[0].text;
  const mf = new Miniflare({ cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
    ...(directory ? { resourcePersistencePath: directory } : {}),
    workers: [{ config: { name: 'native-local', compatibilityDate: '2026-10-26',
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: code } } },
      exports: { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' } },
      env: { CORE_ORIGIN: { type: 'text', value: origin },
        ...(policy ? { CORE_POLICY: { type: 'json', value: policy } } : {}),
        ...(restoring ? { CORE_RESTORE_MODE: { type: 'text', value: '1' } } : {}),
        SOURCES: { type: 'r2', name: 'SOURCES' },
        CORE: { type: 'durable-object', worker: 'native-local', exportName: 'NativeCoordinator' } },
    } }],
  });
  try {
    const core = Object.fromEntries(methods.map(method => [method, async (...args) => {
      if (method === 'submit') args[0] = Array.from(args[0]);
      const response = await mf.dispatchFetch('https://local.invalid', {
        method: 'POST', body: JSON.stringify({method, args}),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      return method === 'read' ? new Uint8Array(result.value) : result.value;
    }]));
    return { core, dispose: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}

// Fresh, disposable test host. Never used by the production Worker or dev:core.
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY } from '../host/policy.ts';
import { HTTP_DEFAULTS } from '../http/transport.ts';
import { nativeClient } from '../scripts/http-client.mjs';
export const origin = 'https://sprig.run';
export const adminToken = 'a'.repeat(64), backupToken = 'b'.repeat(64);
let compiled;
export async function probe({ policy = {}, httpPolicy = {} } = {}) {
  compiled ??= build({ entryPoints: [fileURLToPath(new URL('http-worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  const contents = (await compiled).outputFiles[0].text;
  const env = { CORE_ORIGIN: { type: 'text', value: origin }, SOURCES: { type: 'r2', name: 'SOURCES' },
    CORE: { type: 'durable-object', worker: 'probe', exportName: 'NativeCoordinator' },
    ADMIN_TOKEN: { type: 'text', value: adminToken }, BACKUP_TOKEN: { type: 'text', value: backupToken },
    CORE_POLICY: { type: 'json', value: { ...DEFAULT_POLICY, attempts: { capacity: 10000, refill: 1, periodMs: 86400000 }, ...policy } },
    CORE_HTTP_POLICY: { type: 'json', value: { ...HTTP_DEFAULTS, readCapacity: 10000, ...httpPolicy } } };
  const mf = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
    workers: [{ config: { name: 'probe', compatibilityDate: '2026-10-26',
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents } } },
      exports: { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' } }, env } }] });
  const fetcher = (...args) => mf.dispatchFetch(...args);
  return { close: () => mf.dispose(), fetcher,
    request: (path, options) => fetcher(origin + path, options),
    client: nativeClient(origin, { token: adminToken, fetcher }),
    backup: nativeClient(origin, { token: backupToken, fetcher }),
    async measure() {
      const r = await fetcher(origin + '/__test/measure', { method: 'POST', body: '{}' });
      if (!r.ok) throw Error('probe_failed'); return r.json();
    } };
}

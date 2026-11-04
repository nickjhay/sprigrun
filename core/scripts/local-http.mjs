import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { fileURLToPath } from 'node:url';
let compiled;
export async function startNative({ port = 8789, directory, origin = `http://127.0.0.1:${port}`, policy, httpPolicy, adminToken, backupToken, localOperator = false, restoring = false, abuseEmail } = {}) {
    if (port === 0 && origin === 'http://127.0.0.1:0')
        throw Error('port 0 requires an explicit logical origin for dispatchFetch');
    compiled ??= build({ entryPoints: [fileURLToPath(new URL('../http/worker.ts', import.meta.url))],
        bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
    const contents = (await compiled).outputFiles[0].text;
    const env = { CORE_ORIGIN: { type: 'text', value: origin }, SOURCES: { type: 'r2', name: 'SOURCES' },
        CORE: { type: 'durable-object', worker: 'native-http', exportName: 'NativeCoordinator' } };
    for (const [key, value, type] of [['CORE_POLICY', policy, 'json'], ['CORE_HTTP_POLICY', httpPolicy, 'json'],
        ['ADMIN_TOKEN', adminToken, 'text'], ['BACKUP_TOKEN', backupToken, 'text'], ['ABUSE_EMAIL', abuseEmail, 'text'],
        ['CORE_LOCAL_OPERATOR', localOperator ? '1' : undefined, 'text'], ['CORE_RESTORE_MODE', restoring ? '1' : undefined, 'text']])
        if (value !== undefined)
            env[key] = { type, value };
    const mf = new Miniflare({ host: '127.0.0.1', port, cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
        ...(directory ? { resourcePersistencePath: directory } : {}), workers: [{ config: { name: 'native-http', compatibilityDate: '2026-10-26',
                    manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents } } },
                    exports: { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' } }, env } }] });
    try {
        await mf.ready;
        return { mf, origin, close: () => mf.dispose() };
    }
    catch (error) {
        await mf.dispose();
        throw error;
    }
}

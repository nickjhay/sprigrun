import '../../scripts/check-node.mjs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { resolve, join } from 'node:path';
import { startNative } from './local-http.mjs';
import { nativeClient } from './http-client.mjs';
import { plantLocal } from './plant-local.mjs';
let port = 8789, directory = resolve('.local/native-http'), operator = false, seed = true;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--operator')
        operator = true;
    else if (args[i] === '--no-seed')
        seed = false;
    else if (args[i] === '--port' && /^[0-9]{1,5}$/.test(args[i + 1] ?? ''))
        port = Number(args[++i]);
    else if (args[i] === '--state' && args[i + 1])
        directory = resolve(args[++i]);
    else
        throw Error('usage: npm run dev:core -- [--port N] [--state DIRECTORY] [--operator] [--no-seed]');
}
if (port < 1024 || port > 65535)
    throw Error('port must be 1024..65535');
await mkdir(directory, { recursive: true, mode: 0o700 });
async function keep(file, make) {
    const path = join(directory, file);
    try {
        return await readFile(path, 'utf8');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    const value = make();
    await writeFile(path, value, { flag: 'wx', mode: 0o600 });
    return value;
}
const token = await keep('operator-token', () => randomBytes(32).toString('hex'));
const host = await startNative({ port, directory: join(directory, 'storage'), adminToken: token, localOperator: operator });
let closing = false;
async function close() { if (closing)
    return; closing = true; await host.close(); process.exit(0); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
try {
    if (seed) {
        let planted;
        try {
            planted = JSON.parse(await readFile(join(directory, 'planting.json'), 'utf8'));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        if (!planted) {
            const pem = await keep('development-key.pem', () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
            planted = await plantLocal(nativeClient(host.origin), pem);
            await writeFile(join(directory, 'planting.json.tmp'), JSON.stringify(planted, null, 2) + '\n', { mode: 0o600 });
            await rename(join(directory, 'planting.json.tmp'), join(directory, 'planting.json'));
        }
        console.log('A small development garden is planted through the public API.');
        for (const path of Object.values(planted.publications))
            console.log(host.origin + path + '?view=html');
    }
    console.log(`Sprig native commons: ${host.origin}/\nExplore: ${host.origin}/explore\nHelp: ${host.origin}/help`);
    console.log('Bound to loopback only. Development identities are not production identities.');
    console.log(`Operator token file: ${join(directory, 'operator-token')}`);
    if (operator)
        console.log(`Local read-only operator view: ${host.origin}/admin?view=html`);
    console.log('Ctrl+C stops the service. Restart after source changes; local records persist.');
}
catch (error) {
    await host.close();
    throw error;
}

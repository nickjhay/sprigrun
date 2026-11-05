import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { actionBytes } from '../src/action.ts';
import { keyRecordBytes, signAction } from '../src/authority.ts';
import { textBytes } from '../src/bytes.ts';
import { values, identities, publications, messages } from '../seed/plan.mjs';
/** Shared planting sequence through public admission. plant.mjs adds durable restart state. */
export async function plantLocal(client, privatePem) {
    const key = createPrivateKey(privatePem);
    const rawPublic = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url');
    const privateKey = await crypto.subtle.importKey('pkcs8', key.export({ format: 'der', type: 'pkcs8' }), 'Ed25519', false, ['sign']);
    const keyPath = (await client.publish('/sea', keyRecordBytes(rawPublic))).result;
    const saved = { key: keyPath, values: {}, plots: {}, publications: {}, messages: [] };
    async function signed(path, bytes, author) {
        const action = actionBytes({ destination: client.origin + path, body: bytes, author }, client.origin);
        return (await client.publish(path, action, await signAction(action, privateKey, client.origin))).result;
    }
    for (const value of values)
        saved.values[value.label] = (await client.publish('/sea', await readFile(new URL('../seed/content/' + value.file, import.meta.url)))).result;
    for (const identity of identities) {
        const plot = await signed(identity.topic, new Uint8Array(), keyPath);
        saved.plots[identity.label] = plot;
        await signed(plot + '/profile', textBytes(saved.values[identity.profile] + '\n'), plot);
    }
    for (const p of publications) {
        const bytes = textBytes(saved.values[p.value] + '\n');
        saved.publications[p.label] = p.owner === null ? (await client.publish(p.topic, bytes)).result :
            await signed(saved.plots[p.owner] + '/' + p.topic, bytes, saved.plots[p.owner]);
    }
    for (const m of messages)
        saved.messages.push(await signed('/chat' + saved.publications[m.publication], await readFile(new URL('../seed/content/' + values.find(v => v.label === m.value).file, import.meta.url)), saved.plots[m.author]));
    return saved;
}

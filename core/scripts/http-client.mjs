import { actionBytes, parseAction } from '../src/action.ts';
import { textBytes } from '../src/bytes.ts';
import { parseReceipt, receiptForAction } from '../src/receipt.ts';
import { canonicalOrigin } from '../src/references.ts';
export function nativeClient(origin, { token, fetcher = fetch } = {}) {
    canonicalOrigin(origin);
    async function request(path, method = 'GET', payload, privileged = false, signature) {
        const headers = {};
        if (privileged) {
            if (!token)
                throw Error('operator_token_required');
            headers.Authorization = 'Bearer ' + token;
        }
        if (signature)
            headers['Sprig-Signature'] = signature;
        const response = await fetcher(origin + path, { method, headers, body: payload, redirect: 'error' });
        const value = await response.text();
        if (!response.ok)
            throw Error(`${response.status}: ${value.trim()}`);
        return value;
    }
    const get = (path) => request(path, 'GET', undefined, true);
    const post = (path, value) => request(path, 'POST', value, true);
    const qs = (pairs) => new URLSearchParams(pairs).toString();
    return {
        origin,
        async publish(path, bytes, signature = null) {
            const action = signature === null ? actionBytes({ destination: origin + path, body: bytes }, origin) : bytes;
            if (signature !== null && parseAction(action, origin).destination !== origin + path)
                throw Error('wrong_destination');
            const receipt = await request(path, 'POST', bytes, false, signature);
            await receiptForAction(action, textBytes(receipt), origin);
            return { receipt, result: parseReceipt(textBytes(receipt), origin).result.slice(origin.length) };
        },
        cut: async () => JSON.parse(await post('/admin/cut', undefined)),
        snapshotHeader: epoch => get('/admin/snapshot/header?' + qs({ epoch })),
        snapshotPage: async (epoch, table, after) => JSON.parse(await get('/admin/snapshot/page?' + qs({ epoch, table, after }))),
        snapshotRecord: (epoch, table, key) => get('/admin/snapshot/record?' + qs({ epoch, table, key })),
        restoreBegin: async (header, footer) => JSON.parse(await post('/admin/restore/begin', JSON.stringify({ header, footer }))),
        restoreRecord: async (index, line) => JSON.parse(await post('/admin/restore/record?' + qs({ index }), line)),
        restoreFinish: async () => JSON.parse(await post('/admin/restore/finish', undefined)),
        restoreStatus: async () => JSON.parse(await get('/admin/recovery/status')),
        restoreRelease: async (chain, confirmation) => JSON.parse(await post('/admin/restore/release', JSON.stringify({ chain, confirmation }))),
        pause: async (paused) => JSON.parse(await post('/admin/pause', JSON.stringify({ paused }))),
        suppress: async (path, suppressed) => JSON.parse(await post('/admin/suppress', JSON.stringify({ path, suppressed }))),
        inspect: async (table, after = '') => JSON.parse(await get('/admin/inspect?' + qs({ table, after }))),
    };
}

import { actionBytes, parseAction } from '../src/action.ts';
import { textBytes } from '../src/bytes.ts';
import { parseReceipt, receiptForAction } from '../src/receipt.ts';
import { MAX_LINE } from '../host/archive.ts';
import { canonicalOrigin } from '../src/references.ts';
export function nativeClient(origin, { token, fetcher = fetch, timeoutMs = 30000 } = {}) {
    canonicalOrigin(origin);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
        throw Error('invalid_request_timeout');
    async function request(path, method = 'GET', payload, privileged = false, signature) {
        const headers = {};
        if (privileged) {
            if (!token)
                throw Error('operator_token_required');
            headers.Authorization = 'Bearer ' + token;
        }
        if (signature)
            headers['Sprig-Signature'] = signature;
        const controller = new AbortController();
        let timer, reader;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(Error('request_timeout')); }, timeoutMs);
        });
        try {
            return await Promise.race([deadline, (async () => {
                const response = await fetcher(origin + path, { method, headers, body: payload,
                    redirect: 'error', signal: controller.signal });
                const chunks = []; let size = 0;
                reader = response.body?.getReader();
                if (reader) for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > 2 * MAX_LINE + 4096) throw Error('response_size_limit');
                    chunks.push(value);
                }
                const bytes = new Uint8Array(size); let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
                const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
                if (!response.ok) {
                    const code = value.split('\n', 1)[0];
                    throw Error(`${response.status}: ${/^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : 'request_failed'}`);
                }
                return value;
            })()]);
        } finally {
            clearTimeout(timer); controller.abort();
            if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
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
        snapshotBatch: async (epoch, table, after) => JSON.parse(await get('/admin/snapshot/batch?' + qs({ epoch, table, after }))),
        snapshotRecord: (epoch, table, key) => get('/admin/snapshot/record?' + qs({ epoch, table, key })),
        restoreBegin: async (header, footer) => JSON.parse(await post('/admin/restore/begin', JSON.stringify({ header, footer }))),
        restoreRecord: async (index, line) => JSON.parse(await post('/admin/restore/record?' + qs({ index }), line)),
        restoreFinish: async () => JSON.parse(await post('/admin/restore/finish', undefined)),
        restoreStatus: async () => JSON.parse(await get('/admin/recovery/status')),
        restoreRelease: async (chain, confirmation) => JSON.parse(await post('/admin/restore/release', JSON.stringify({ chain, confirmation }))),
        pause: async (paused) => JSON.parse(await post('/admin/pause', JSON.stringify({ paused }))),
        suppress: async (path, suppressed) => JSON.parse(await post('/admin/suppress', JSON.stringify({ path, suppressed }))),
        blockAuthor: async (key, blocked) => JSON.parse(await post('/admin/block-author', JSON.stringify({ key, blocked }))),
        policyPage: async (after = '0') => JSON.parse(await get('/admin/policy?' + qs({ after }))),
        inspect: async (table, after = '') => JSON.parse(await get('/admin/inspect?' + qs({ table, after }))),
    };
}

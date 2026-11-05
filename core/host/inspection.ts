import { check, orderedU64, parseAddress, textBytes, u64 } from '../src/bytes.ts';
import { parseAction } from '../src/action.ts';
import { parseReceipt } from '../src/receipt.ts';
import { formatReference, parsePostTarget, parseReference } from '../src/references.ts';
import { collection } from './placement.ts';
import type { State, Result } from './state.ts';
export const PAGE_SIZE = 32;
export const KINDS = ['sea', 'grove', 'plot', 'publication', 'chat', 'action'] as const;
export type Item = {
    path: string;
    kind: string;
    atMs: string;
    bytes?: number;
    action?: string;
    collection?: string;
    value?: string | null;
    controller?: string | null;
};
export type Page = {
    items: Item[];
    after: string;
    more: boolean;
    examined: number;
};
export type Browse = {
    kind: string;
    container: string | null;
    after: string;
};
/** Inspection only: fixed indexed queries; no R2 listing, user SQL or durable view state. */
export class Inspection {
    constructor(private db: State, private readable: (path: string) => unknown, private action: (path: string) => Result, private origin: string) { }
    describe(path: string): Item {
        this.readable(path);
        const e = this.db.result(path)!;
        return { path, kind: e.kind, atMs: e.accepted_at_ms, action: e.action,
            ...(e.kind === 'sea' ? { bytes: parseAddress(e.source!).length } : {}),
            ...(e.collection === null ? {} : { collection: e.collection }), value: e.value, controller: e.controller };
    }
    describeAction(path: string) {
        const a = this.action(path), parsed = parseAction(textBytes(a.header), this.origin);
        return { id: a.action, result: a.path, author: parsed.author, destination: parsed.path,
            receipt: parseReceipt(textBytes(a.receipt), this.origin), rawReceipt: a.receipt,
            signature: a.signature, keyRecord: a.key_record, plotBinding: a.author_binding };
    }
    browse(q: Browse): Page {
        check(KINDS.includes(q.kind as typeof KINDS[number]), 'invalid_listing');
        check(typeof q.after === 'string' && q.after.length <= 512, 'invalid_cursor');
        let rows: {
            key: string;
            path: string;
        }[];
        if (q.kind === 'action') {
            check(q.container === null, 'invalid_listing');
            if (q.after) parseReference(q.after);
            rows = this.db.sql.exec<{ key: string; path: string }>(
                'SELECT path AS key, path FROM results WHERE path>? ORDER BY path LIMIT ?', q.after, PAGE_SIZE).toArray();
        }
        else {
            let prefix = '/' + (q.kind === 'publication' ? 'plot' : q.kind) + '/';
            if (q.container !== null) {
                const t = parsePostTarget(q.container);
                if (q.kind === 'publication' && t.kind === 'plot' && t.anchor !== null) {
                    // A plot root selects all its publication topics.
                    this.readable(q.container);
                    prefix = q.container + '/';
                }
                else {
                    check(t.kind !== 'sea' && t.kind === q.kind && t.anchor === null, 'invalid_listing');
                    if (t.kind === 'chat')
                        this.readable(formatReference(t.subject));
                    if (t.kind === 'publication')
                        this.readable(formatReference(t.plot));
                    if (q.after)
                        u64(q.after);
                    rows = this.db.sql.exec<{
                        key: string;
                        path: string;
                    }>(`SELECT number AS key, path FROM results
            WHERE collection=? AND number>? ORDER BY number LIMIT ?`, collection(t), q.after ? orderedU64(q.after) : '', PAGE_SIZE)
                        .toArray().map(r => ({ ...r, key: String(BigInt(r.key)) }));
                    return this.page(q, rows);
                }
            }
            if (q.after)
                check(q.after.startsWith(prefix) && !!parseReference(q.after), 'invalid_cursor');
            rows = this.db.sql.exec<{
                key: string;
                path: string;
            }>(`SELECT path AS key, path FROM results
        WHERE path>=? AND path<? AND path>? ORDER BY path LIMIT ?`, prefix, prefix + '\uffff', q.after, PAGE_SIZE).toArray();
        }
        return this.page(q, rows);
    }
    private page(q: Browse, rows: {
        key: string;
        path: string;
    }[]): Page {
        const items: Item[] = [];
        for (const row of rows) {
            try {
                if (q.kind === 'action') {
                    const a = this.action(row.path);
                    items.push({ path: '/action' + a.path, kind: 'action', atMs: a.accepted_at_ms, value: a.path });
                }
                else {
                    const item = this.describe(row.path);
                    if (item.kind === q.kind)
                        items.push(item);
                }
            }
            catch (e) {
                if (!(e instanceof Error) || !['suppressed', 'source_unavailable', 'entry_unavailable', 'action_unavailable'].includes(e.message))
                    throw e;
            }
        }
        return { items, after: rows.at(-1)?.key ?? q.after, more: rows.length === PAGE_SIZE, examined: rows.length };
    }
    operator(table: string, after: string) {
        check(typeof after === 'string' && after.length <= 1024, 'invalid_cursor');
        if (['control', 'recovery'].includes(table)) {
            check(after === '', 'invalid_cursor');
            const rows = this.db.sql.exec<{
                value: string;
            }>(`SELECT value FROM ${table} WHERE id=1`).toArray();
            return { table, rows: rows.map(r => JSON.parse(r.value)), after: '', more: false };
        }
        const keys: Record<string, string> = { sources: 'address', heads: 'collection', results: 'path', moderation: 'position', cuts: 'epoch', journal: 'position' };
        const key = Object.hasOwn(keys, table) ? keys[table]! : null;
        check(key, 'invalid_table');
        // Large bodies/evidence have a dedicated single-record endpoint, not 32 copies per table page.
        const projection = table === 'results' ? 'path,action,kind,collection,number,epoch,accepted_at_ms,debit,source,value,controller' : '*';
        const rows = this.db.sql.exec(`SELECT ${projection} FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT ?`, after, PAGE_SIZE).toArray();
        return { table, rows, after: String(rows.at(-1)?.[key] ?? after), more: rows.length === PAGE_SIZE };
    }
}

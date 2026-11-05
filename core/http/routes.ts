import type { Env, NativeCoordinator } from '../host/coordinator.ts';
import { KINDS, type Browse } from '../host/inspection.ts';
import { MAX_LINE, fields } from '../host/archive.ts';
import { check, contentAddress, parseAddress, textBytes, utf8, u64 } from '../src/bytes.ts';
import { parsePostTarget, parseReference } from '../src/references.ts';
import { parseReceipt } from '../src/receipt.ts';
import { actionPage } from './pages.ts';
import { listing, operatorPage, recordPage } from './pages.ts';
import { body, failure, htmlView, HttpError, json, loopback, operator, query, ReadGate, text, urlFor } from './transport.ts';
const ROOTS = new Map([['/sea', 'sea'], ['/grove', 'grove'], ['/plot', 'plot'], ['/chat', 'chat'], ['/action', 'action']]);
export function methods(path: string): string | null {
    if (path === '/explore' || path === '/stats' || ROOTS.has(path))
        return 'GET, HEAD, OPTIONS' + (path === '/sea' ? ', POST' : '');
    if (/^\/(action|receipt|evidence)\//.test(path)) {
        try {
            const ref = parseReference(path.slice(path.indexOf('/', 1)));
            if (ref.kind !== 'chat' && ref.kind !== 'step') return 'GET, HEAD, OPTIONS';
        }
        catch { }
        return null;
    }
    try {
        const target = parsePostTarget(path);
        if (target.kind !== 'sea')
            return 'GET, HEAD, POST, OPTIONS';
    }
    catch { }
    try {
        const ref = parseReference(path);
        if (ref.kind === 'sea')
            return 'GET, HEAD, OPTIONS';
    }
    catch { }
    return null;
}
function allowed(request: Request, allow: string): Response | null {
    if (request.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: {
                Allow: allow, 'Access-Control-Allow-Methods': allow, 'Access-Control-Allow-Headers': 'Content-Type, Sprig-Signature',
                'Access-Control-Max-Age': '600',
            } });
    if (!allow.split(', ').includes(request.method))
        return text('method_not_allowed\nHelp: /help\n', 405, { Allow: allow });
    return null;
}
function nextLink(url: URL, after: string, more: boolean) {
    if (!more)
        return null;
    const next = new URL(url);
    next.searchParams.set('after', after);
    return next.pathname + next.search;
}
function pageResponse(env: Env, url: URL, title: string, page: ReturnType<NativeCoordinator['browse']>, html: boolean) {
    const next = nextLink(url, page.after, page.more);
    const r = html ? listing(env, title, page, next) : text(page.items.map(i => i.path + '\n').join('') + (next ? '# next: ' + next + '\n' : ''));
    if (next)
        r.headers.set('Link', '<' + next + '>; rel="next"');
    return r;
}
async function publicRead(request: Request, env: Env, core: NativeCoordinator, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === '/stats') {
        query(url, []);
        return text(Object.entries(core.publicStats()).map(([k, v]) => k + ' ' + v).join('\n') + '\n');
    }
    if (path === '/explore') {
        const p = query(url, ['kind', 'under', 'after', 'view']);
        const kind = p.get('kind') ?? 'sea';
        check(KINDS.includes(kind as typeof KINDS[number]), 'invalid_listing');
        const q: Browse = { kind, container: p.get('under'), after: p.get('after') ?? '' };
        return pageResponse(env, url, q.container ?? kind, core.browse(q), p.get('view') === null || htmlView(p));
    }
    if (/^\/(action|receipt|evidence)\//.test(path)) {
        const p = query(url, ['view']), html = htmlView(p), kind = path.split('/')[1];
        const result = path.slice(path.indexOf('/', 1));
        const info = core.describeAction(result);
        if (kind === 'receipt')
            return html ? actionPage(env, info, info.rawReceipt, true) : text(info.rawReceipt);
        const evidence = await core.evidence(result);
        if (kind === 'evidence')
            return json(evidence);
        return html ? actionPage(env, info, evidence.action) : text(evidence.action);
    }
    const p = query(url, ['view', 'after', 'select']), html = htmlView(p);
    let q: Browse | null = null;
    if (ROOTS.has(path))
        q = { kind: ROOTS.get(path)!, container: null, after: p.get('after') ?? '' };
    else {
        try {
            const t = parsePostTarget(path);
            if (t.kind !== 'sea' && t.anchor === null)
                q = { kind: t.kind, container: path, after: p.get('after') ?? '' };
        }
        catch { }
    }
    if (p.has('select')) {
        check(p.get('select') === 'latest' && q?.container === path && !p.has('after'), 'invalid_selection');
        return new Response(null, { status: 303, headers: { Location: core.latest(path) + (html ? '?view=html' : '') } });
    }
    if (q)
        return pageResponse(env, url, q.container ?? q.kind, core.browse(q), html);
    check(!p.has('after'), 'invalid_query');
    const item = core.describe(path), bytes = await core.read(path);
    if (html)
        return recordPage(env, item, utf8(bytes));
    const etag = '"sha256-' + await contentAddress(bytes) + '"';
    // Visibility/integrity checks precede even a matching conditional or HEAD response.
    core.describe(path);
    const headers = { 'ETag': etag, 'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=300, immutable', 'Sprig-Submitted-At-Ms': item.atMs,
        'Link': '<' + path + '?view=html>; rel="alternate"; type="text/html"' };
    const condition = request.headers.get('If-None-Match');
    if (condition !== null) {
        check(condition.length <= 2048, 'invalid_conditional');
        if (condition.split(',').some(c => ['*', etag].includes(c.trim().replace(/^W\//, '')))) {
            const h = new Headers(headers);
            h.delete('Content-Length');
            return new Response(null, { status: 304, headers: h });
        }
    }
    return text(bytes, 200, headers);
}
function localOperator(request: Request, env: Env) {
    return env.CORE_LOCAL_OPERATOR === '1' && loopback(env.CORE_ORIGIN) && ['GET', 'HEAD'].includes(request.method)
        && request.headers.get('Sec-Fetch-Site') !== 'cross-site'
        && (!request.headers.has('Origin') || request.headers.get('Origin') === env.CORE_ORIGIN);
}
function backupAccess(request: Request, env: Env, path: string): boolean {
    const exportRead = ['GET', 'HEAD'].includes(request.method)
        && ['/admin/snapshot/header', '/admin/snapshot/page', '/admin/snapshot/record', '/admin/snapshot/batch'].includes(path);
    const cut = request.method === 'POST' && path === '/admin/cut';
    return (exportRead || cut) && operator(request, env.BACKUP_TOKEN);
}
async function operatorRoute(request: Request, env: Env, core: NativeCoordinator, url: URL) {
    const path = url.pathname, p = url.searchParams;
    if (['GET', 'HEAD'].includes(request.method)) {
        if (path === '/admin' || path === '/admin/inspect') {
            query(url, ['table', 'after', 'view']);
            const table = p.get('table') ?? 'control';
            const data = core.operatorInspect(table, p.get('after') ?? '');
            return htmlView(p) ? operatorPage(env, table, data, nextLink(url, data.after, data.more)) : json(data);
        }
        if (path === '/admin/policy') {
            query(url, ['after']);
            return json({ ...core.policyPage(p.get('after') ?? '0'), status: core.policyStatus() });
        }
        if (path === '/admin/recovery/status') {
            query(url, []);
            return json(core.restoreStatus());
        }
        if (path === '/admin/result') {
            query(url, ['path', 'view']);
            const value = core.operatorRecord(p.get('path') ?? '');
            return htmlView(p) ? operatorPage(env, 'Committed result', value) : json(value);
        }
        if (path.startsWith('/admin/snapshot/')) {
            const method = path.slice('/admin/snapshot/'.length);
            const names = method === 'header' ? ['epoch', 'base', 'chain'] : (method === 'page' || method === 'batch') ? ['epoch', 'after'] : method === 'record' ? ['epoch', 'position'] : null;
            if (!names)
                throw new HttpError(404, 'not_found');
            query(url, names);
            const epoch = p.get('epoch') ?? '';
            u64(epoch);
            if (method === 'header')
                return text(core.snapshotHeader(epoch, p.get('base'), p.get('chain')));
            if (method === 'batch')
                return json(await core.snapshotBatch(epoch, p.get('after') ?? '0'));
            if (method === 'page')
                return json(core.snapshotPage(epoch, p.get('after') ?? '0'));
            return text(await core.snapshotRecord(epoch, p.get('position') ?? ''));
        }
    }
    if (request.method !== 'POST')
        throw new HttpError(404, 'not_found');
    if (!operator(request, env.ADMIN_TOKEN) && !backupAccess(request, env, path))
        throw new HttpError(404, 'not_found');
    const max = path === '/admin/restore/record' ? MAX_LINE : path === '/admin/restore/begin' ? 65536 : 2048;
    const known = ['/admin/pause', '/admin/suppress', '/admin/block-author', '/admin/cut', '/admin/restore/begin', '/admin/restore/record', '/admin/restore/finish', '/admin/restore/release'];
    if (!known.includes(path))
        throw new HttpError(404, 'not_found');
    query(url, path === '/admin/restore/record' ? ['index'] : []);
    const bytes = await body(request, max, env.CORE_HTTP_POLICY?.uploadTimeoutMs ?? 10000);
    if (path === '/admin/cut' || path === '/admin/restore/finish') {
        check(bytes.length === 0, 'empty_body_required');
        return json(path === '/admin/cut' ? await core.cut() : await core.restoreFinish());
    }
    if (path === '/admin/restore/record')
        return json(await core.restoreRecord(p.get('index') ?? '', utf8(bytes)));
    let value: unknown;
    try {
        value = JSON.parse(utf8(bytes));
    }
    catch {
        throw new HttpError(400, 'invalid_json');
    }
    if (path === '/admin/pause') {
        fields(value, ['paused']);
        await core.pause(value.paused);
        return json({ paused: value.paused });
    }
    if (path === '/admin/suppress') {
        fields(value, ['path', 'suppressed']);
        await core.suppress(value.path, value.suppressed);
        return json({ path: value.path, suppressed: value.suppressed });
    }
    if (path === '/admin/block-author') {
        fields(value, ['key', 'blocked']);
        await core.blockAuthor(value.key, value.blocked);
        return json({ key: value.key, blocked: value.blocked });
    }
    if (path === '/admin/restore/begin') {
        fields(value, ['header', 'footer', 'target']);
        return json(await core.restoreBegin(value.header, value.footer, value.target));
    }
    fields(value, ['chain', 'confirmation']);
    return json(await core.restoreRelease(value.chain, value.confirmation));
}
export async function handleHttp(request: Request, env: Env, core: NativeCoordinator, reads: ReadGate, operatorGate: (run: () => Promise<Response>) => Promise<Response>): Promise<Response> {
    try {
        const url = urlFor(request, env.CORE_ORIGIN);
        if (url.pathname.startsWith('/admin')) {
            if (!operator(request, env.ADMIN_TOKEN) && !backupAccess(request, env, url.pathname) && !localOperator(request, env))
                throw new HttpError(404, 'not_found');
            return await operatorGate(() => operatorRoute(request, env, core, url));
        }
        const allow = methods(url.pathname);
        if (!allow)
            throw new HttpError(404, 'not_found');
        const special = allowed(request, allow);
        if (special)
            return special;
        if (request.method === 'POST') {
            query(url, []);
            const receipt = await core.submitHttp(request), info = parseReceipt(textBytes(receipt), env.CORE_ORIGIN);
            return text(receipt, 200, { Location: info.result,
                Link: `</action${new URL(info.result).pathname}>; rel="related", </receipt${new URL(info.result).pathname}>; rel="describedby"` });
        }
        return await reads.run(() => publicRead(request, env, core, url));
    }
    catch (error) {
        return failure(error);
    }
}

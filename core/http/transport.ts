import { AlreadyStored } from '../host/errors.ts';
import { check, textBytes } from '../src/bytes.ts';
import { canonicalOrigin } from '../src/references.ts';
import { full, refill, waitSeconds, type BucketPolicy } from '../../shared/bucket.ts';
export class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    readonly retry: number | undefined;
    constructor(status: number, code: string, retry?: number) { super(code); this.status = status; this.code = code; this.retry = retry; }
}
export const HTTP_DEFAULTS = { uploadTimeoutMs: 10000, readCapacity: 120, readRefill: 120,
    readPeriodMs: 60000, readConcurrency: 8 };
export type HttpPolicy = typeof HTTP_DEFAULTS;
export function httpPolicy(value: HttpPolicy = HTTP_DEFAULTS): HttpPolicy {
    const p = { ...value };
    for (const key of Object.keys(HTTP_DEFAULTS) as (keyof HttpPolicy)[])
        check(Number.isSafeInteger(p[key]) && p[key] > 0, 'invalid_http_policy');
    check(p.uploadTimeoutMs <= 30000 && p.readConcurrency <= 16, 'invalid_http_policy');
    return p;
}
/** Overload control, not durable billing. Recreated with the DO; GET writes no journal rows. */
export class ReadGate {
    private bucket;
    private active = 0;
    private readonly policy: BucketPolicy;
    private p: HttpPolicy;
    constructor(p: HttpPolicy) {
        this.p = p;
        this.policy = { capacity: p.readCapacity, refill: p.readRefill, periodMs: p.readPeriodMs };
        this.bucket = full(this.policy, Date.now());
    }
    async run<T>(f: () => Promise<T>): Promise<T> {
        this.bucket = refill(this.bucket, this.policy, Date.now());
        const wait = waitSeconds(this.bucket, this.policy, 1);
        if (wait || this.active >= this.p.readConcurrency)
            throw new HttpError(429, 'read_limit', wait || 1);
        this.bucket.tokens--;
        this.active++;
        try {
            return await f();
        }
        finally {
            this.active--;
        }
    }
}
export function urlFor(request: Request, origin: string): URL {
    canonicalOrigin(origin);
    const url = new URL(request.url);
    if (url.origin !== origin || url.username || url.password || url.hash || request.url !== url.href)
        throw new HttpError(400, 'wrong_origin');
    if (url.pathname.length > 600 || !/^\/[a-zA-Z0-9_./-]*$/.test(url.pathname)
        || url.pathname.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(url.pathname) || url.search.length > 2048)
        throw new HttpError(400, 'invalid_path');
    return url;
}
export function query(url: URL, allowed: string[]): URLSearchParams {
    for (const key of url.searchParams.keys())
        if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
            throw new HttpError(400, 'invalid_query');
    return url.searchParams;
}
export function htmlView(params: URLSearchParams): boolean {
    const view = params.get('view');
    if (view !== null && view !== 'html' && view !== 'raw')
        throw new HttpError(400, 'invalid_view');
    return view === 'html';
}
export function uploadHeaders(request: Request, max: number) {
    const encoding = request.headers.get('Content-Encoding');
    if (encoding && encoding.toLowerCase() !== 'identity')
        throw new HttpError(415, 'content_encoding_not_supported');
    const length = request.headers.get('Content-Length');
    if (length !== null) {
        if (!/^(0|[1-9][0-9]{0,9})$/.test(length))
            throw new HttpError(400, 'invalid_content_length');
        if (Number(length) > max)
            throw new HttpError(413, 'body_too_large');
    }
}
export async function body(request: Request, max: number, timeoutMs: number): Promise<Uint8Array<ArrayBuffer>> {
    uploadHeaders(request, max);
    if (!request.body)
        return new Uint8Array();
    const reader = request.body.getReader(), bytes = new Uint8Array(max);
    let used = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, 'upload_timeout')), timeoutMs); });
    try {
        for (;;) {
            const { done, value } = await Promise.race([reader.read(), timeout]);
            if (done)
                break;
            if (value.length > max - used)
                throw new HttpError(413, 'body_too_large');
            bytes.set(value, used);
            used += value.length;
        }
        const declared = request.headers.get('Content-Length');
        if (declared !== null && Number(declared) !== used)
            throw new HttpError(400, 'content_length_mismatch');
        return bytes.subarray(0, used);
    }
    catch (error) {
        void reader.cancel().catch(() => { });
        throw error;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        reader.releaseLock();
    }
}
export function text(value: string | Uint8Array<ArrayBuffer>, status = 200, headers: HeadersInit = {}) {
    const h = new Headers(headers);
    h.set('Content-Type', 'text/plain; charset=utf-8');
    return new Response(value, { status, headers: h });
}
export function json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value) + '\n', { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
export function failure(error: unknown): Response {
    if (error instanceof AlreadyStored)
        return text(`already_stored\n\nThese exact bytes are already available.\nobject: ${error.path}\nreceipt: /receipt${error.path}\n\nNo new publication was recorded.\nHelp: /help\n`, 409,
            { Link: `</receipt${error.path}>; rel="describedby", </help>; rel="help"` });
    const code = error instanceof Error ? error.message : '';
    let status = error instanceof HttpError ? error.status : 400;
    let retry = error instanceof HttpError ? error.retry : undefined;
    let safe = code;
    if (['suppressed', 'source_unavailable', 'entry_unavailable', 'action_unavailable', 'unsupported_read'].includes(code)) {
        status = 404;
        safe = 'unavailable';
    }
    else if (['growth_limit', 'attempt_limit', 'preparation_busy', 'snapshot_busy', 'restore_busy'].includes(code)) {
        status = 429;
        retry = 60;
    }
    else if (['writes_paused', 'recovery_mode'].includes(code)) {
        status = 503;
        retry = 60;
    }
    else if (['bytes_limit', 'source_size_limit', 'chat_size_limit'].includes(code))
        status = 413;
    else if (['wrong_controller', 'author_required', 'signature_required', 'invalid_signature', 'signature_verification_failed'].includes(code))
        status = 403;
    else if (code === 'invalid_utf8')
        status = 422;
    else if (['source_storage_unavailable', 'source_integrity_failure', 'allocation_state_invalid'].includes(code)
        || (!(error instanceof HttpError) && (!(error instanceof Error) || error.name !== 'ProtocolError'))) {
        status = 503;
        safe = 'service_unavailable';
        retry = 5;
        console.error('native_request_failed');
    }
    if (!/^[a-z0-9_]{1,100}$/.test(safe)) {
        status = 503;
        safe = 'service_unavailable';
    }
    const hints: Record<string, string> = {
        unavailable: 'This record is unavailable.',
        wrong_destination: 'The signed POST destination must exactly match this request URL.',
        author_required: 'Plot allocation and plot publications require a signed action. See /help.',
        anchor_unavailable: 'Use an existing entry as the anchor, or append to the collection root.',
        recovery_mode: 'This target is quarantined for recovery.',
        writes_paused: 'Publishing is temporarily paused.',
        invalid_utf8: 'Send valid UTF-8 bytes without changing their contents.',
        body_too_large: 'The request exceeds this operation’s byte limit. See /help.',
        upload_timeout: 'The upload took too long. Retry the same bytes to keep the same action.',
    };
    return text(`${safe}\n${hints[safe] ?? 'The request was not accepted.'}\nHelp: /help\n`, status, retry === undefined ? {} : { 'Retry-After': String(retry) });
}
export function secured(request: Request, response: Response): Response {
    const r = new Response(request.method === 'HEAD' ? null : response.body, response);
    const html = r.headers.get('Content-Type')?.startsWith('text/html');
    r.headers.set('X-Content-Type-Options', 'nosniff');
    r.headers.set('Content-Security-Policy', html
        ? "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        : "default-src 'none'; sandbox; frame-ancestors 'none'");
    r.headers.set('Referrer-Policy', 'no-referrer');
    r.headers.set('X-Frame-Options', 'DENY');
    if (!r.headers.has('Cache-Control'))
        r.headers.set('Cache-Control', 'no-store');
    r.headers.set('Link', (r.headers.get('Link') ? r.headers.get('Link') + ', ' : '') + '</help>; rel="help service-doc"; type="text/plain", </llms.txt>; rel="describedby"');
    if (!new URL(request.url).pathname.startsWith('/admin')) {
        r.headers.set('Access-Control-Allow-Origin', '*');
        r.headers.set('Access-Control-Expose-Headers', 'Location, Link, ETag, Retry-After, Sprig-Submitted-At-Ms');
    }
    return r;
}
export function operator(request: Request, token: string | undefined): boolean {
    if (!token || !/^[0-9a-f]{64}$/.test(token))
        return false;
    const received = request.headers.get('Authorization') ?? '';
    const expected = 'Bearer ' + token;
    return /^Bearer [0-9a-f]{64}$/.test(received) && received.length === expected.length && crypto.subtle.timingSafeEqual(textBytes(received), textBytes(expected));
}
export function loopback(origin: string) { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname); }

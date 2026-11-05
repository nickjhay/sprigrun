import type { NativeCoordinator, Env as CoreEnv } from '../host/coordinator.ts';
import { document } from './pages.ts';
import { methods } from './routes.ts';
import { failure, HttpError, secured, text, urlFor } from './transport.ts';
export { NativeCoordinator } from '../host/coordinator.ts';
export interface Env extends CoreEnv {
    CORE: DurableObjectNamespace<NativeCoordinator>;
    READ_RATE_LIMITER?: RateLimit;
    WRITE_RATE_LIMITER?: RateLimit;
}
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        let response: Response;
        try {
            const url = urlFor(request, env.CORE_ORIGIN);
            const doc = document(new Request(url, { method: 'GET' }), env, url);
            if (doc) {
                response = ['GET', 'HEAD'].includes(request.method) ? doc :
                    request.method === 'OPTIONS' ? new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } }) :
                        text('method_not_allowed\nHelp: /help\n', 405, { Allow: 'GET, HEAD, OPTIONS' });
            }
            else {
                if (!url.pathname.startsWith('/admin') && !methods(url.pathname))
                    throw new HttpError(404, 'not_found');
                // Edge bindings are optional additional per-location limits, not a global billing cap.
                const limit = request.method === 'POST' ? env.WRITE_RATE_LIMITER : env.READ_RATE_LIMITER;
                if (!url.pathname.startsWith('/admin') && limit && !(await limit.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })).success)
                    throw new HttpError(429, 'client_rate_limit', 60);
                response = await env.CORE.getByName('core').fetch(request);
            }
        }
        catch (error) {
            response = failure(error);
        }
        return secured(request, response);
    },
} satisfies ExportedHandler<Env>;

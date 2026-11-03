// Test-only faults around the production HTTP adapter. Never deploy this module.
import worker, { type Env } from '../http/worker.ts';
import { TestCoordinator } from './host-worker.ts';
export class HttpTestCoordinator extends TestCoordinator {
    // Construct at the application's read boundary: transport may prefetch chunks
    // before a forwarded request arrives at the DO, even when admission refuses it.
    async probe(headers: Record<string, string>): Promise<Response> {
        const h = new Headers(headers);
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({ pull: async (controller) => {
                pulls++;
                if (h.has('Test-Pause'))
                    await this.pause(true);
                if (h.has('Test-Stall'))
                    return;
                if (h.has('Test-Body')) {
                    controller.enqueue(new TextEncoder().encode(h.get('Test-Body')!));
                    controller.close();
                }
                else
                    controller.enqueue(new Uint8Array(65536));
            } }, { highWaterMark: 0 });
        const result = await this.fetch(new Request(this.env.CORE_ORIGIN + (h.get('Test-Path') ?? '/sea'), { method: 'POST', headers: h, body: stream }));
        result.headers.set('Test-Body-Pulls', String(pulls));
        return result;
    }
}
export { HttpTestCoordinator as NativeCoordinator };
export default {
    async fetch(request: Request, env: Env) {
        const path = new URL(request.url).pathname;
        const core = env.CORE.getByName('core') as unknown as DurableObjectStub<HttpTestCoordinator>;
        if (path === '/__test/probe')
            return core.probe(Object.fromEntries(request.headers));
        if (path.startsWith('/__test/')) {
            const value = request.body ? await request.json() : {};
            return Response.json(await core.testCommand(path.slice(8), value));
        }
        return worker.fetch(request, env);
    },
};

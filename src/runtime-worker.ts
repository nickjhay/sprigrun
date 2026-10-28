import { OutputBuffer, RUN_LIMITS, runtimeURL, type RuntimeAdapter } from './runtime-contract.ts';
const scope = self as unknown as DedicatedWorkerGlobalScope;
let started = false, nextId = 0;
let pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
function request(op: 'input' | 'load', value: string): Promise<unknown> {
  if (pending) return Promise.reject(new Error('Only one I/O request may be outstanding.'));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending = { id, resolve, reject };
    scope.postMessage({ type: 'request', id, op, value });
  });
}
scope.onmessage = async ({ data }) => {
  if (data?.type === 'reply') {
    if (!pending || pending.id !== data.id) return;
    const current = pending; pending = undefined;
    data.error ? current.reject(new Error(String(data.error).slice(0,4096))) : current.resolve(data.value);
    return;
  }
  if (started) return;
  started = true;
  try {
    const module = await import(runtimeURL(data.module, scope.location.origin)) as RuntimeAdapter;
    if (typeof module.run !== 'function') throw new Error('Runtime adapter must export run().');
    const output = new OutputBuffer();
    let messages = 0;
    const result = await module.run({
      source: new Uint8Array(data.bytes),
      emit(text: string) {
        if (++messages > RUN_LIMITS.outputMessages) throw new Error('Runtime output message limit reached.');
        const accepted = output.append(text);
        if (accepted) scope.postMessage({ type: 'output', text: accepted });
        if (output.truncated) throw new Error('Runtime output limit reached.');
      },
      async input(prompt: string) {
        if (typeof prompt !== 'string' || prompt.length > RUN_LIMITS.inputChars) throw new Error('Invalid input prompt.');
        const value = await request('input', prompt);
        if (typeof value !== 'string' || value.length > RUN_LIMITS.inputChars) throw new Error('Invalid terminal input.');
        return value;
      },
      async load(address: string) {
        const bytes = await request('load', address);
        if (!(bytes instanceof Uint8Array) || bytes.length > RUN_LIMITS.sourceBytes) throw new Error('Invalid source reply.');
        return bytes;
      },
    });
    scope.postMessage({ type: 'done', value: { summary: typeof result?.summary === 'string' ? result.summary.slice(0,4096) : 'Run completed.' } });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message.slice(0,4096) : 'Execution failed.' });
  }
};

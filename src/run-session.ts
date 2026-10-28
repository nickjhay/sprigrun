import { WorkerJob, type WorkerPort } from './jobs.ts';
import { OutputBuffer, RUN_LIMITS } from './runtime-contract.ts';
export interface SessionIO {
  input(prompt: string, signal: AbortSignal): Promise<string>;
  load(address: string, signal: AbortSignal): Promise<Uint8Array>;
  output(text: string): void;
  status(text: string): void;
}
export class RunSession {
  private readonly job: WorkerJob;
  private abort?: AbortController;
  constructor(create: () => WorkerPort) { this.job = new WorkerJob(create); }
  get busy(): boolean { return this.job.busy; }
  cancel(message = 'Stopped.'): void { this.abort?.abort(); this.job.cancel(message); }
  async run(message: { module: string; bytes: Uint8Array }, io: SessionIO,
    limits: { computeMs: number; sessionMs: number; inputMs: number; loadMs: number } = RUN_LIMITS): Promise<{ summary: string }> {
    this.cancel();
    const abort = new AbortController(); this.abort = abort;
    const buffer = new OutputBuffer();
    let remaining = limits.computeMs, activeSince = performance.now();
    let pending = false, requests = 0, messages = 0, lastId = 0;
    let computeTimer: ReturnType<typeof setTimeout> | undefined;
    let ioTimer: ReturnType<typeof setTimeout> | undefined;
    const live = () => this.abort === abort && !abort.signal.aborted;
    const stop = (reason: string) => { if (live()) { abort.abort(); this.job.cancel(reason); } };
    const resume = () => {
      activeSince = performance.now();
      computeTimer = setTimeout(() => stop('Compute time limit reached.'), Math.max(0, remaining));
    };
    const pause = () => {
      clearTimeout(computeTimer);
      remaining -= performance.now() - activeSince;
      if (remaining <= 0) { stop('Compute time limit reached.'); return false; }
      return true;
    };
    resume();
    try {
      return await this.job.run<{ summary: string }>(message, limits.sessionMs, event => {
        if (!live()) return;
        if (++messages > RUN_LIMITS.outputMessages + RUN_LIMITS.ioRequests) { stop('Message limit reached.'); return; }
        if (event.type === 'output') {
          if (typeof event.text !== 'string') { stop('Invalid runtime output.'); return; }
          const accepted = buffer.append(event.text); if (accepted) io.output(accepted);
          if (buffer.truncated) stop('Output limit reached.');
          return;
        }
        if (event.type !== 'request' || pending || !Number.isSafeInteger(event.id) || Number(event.id) <= lastId ||
            (event.op !== 'input' && event.op !== 'load') || typeof event.value !== 'string' ||
            event.value.length > RUN_LIMITS.inputChars || ++requests > RUN_LIMITS.ioRequests) {
          stop('Invalid or excessive runtime I/O request.'); return;
        }
        if (!pause()) return;
        pending = true; lastId = Number(event.id);
        const id = lastId, op = event.op, value = event.value;
        io.status(op === 'input' ? 'Waiting for input…' : 'Loading verified source…');
        ioTimer = setTimeout(() => stop(op === 'input' ? 'Input timed out.' : 'Source load timed out.'), op === 'input' ? limits.inputMs : limits.loadMs);
        void Promise.resolve().then<unknown>(() => op === 'input' ? io.input(value, abort.signal) : io.load(value, abort.signal)).then(
          result => {
            if (!live()) return;
            if (op === 'input' && (typeof result !== 'string' || result.length > RUN_LIMITS.inputChars)) throw new Error('Input exceeds the terminal limit.');
            clearTimeout(ioTimer); pending = false; resume(); io.status('Running…');
            this.job.send({ type: 'reply', id, value: result });
          },
          error => { if (live()) stop(error instanceof Error ? error.message : 'I/O failed.'); },
        ).catch(error => { if (live()) stop(error instanceof Error ? error.message : 'I/O failed.'); });
      });
    } finally {
      clearTimeout(computeTimer); clearTimeout(ioTimer); abort.abort();
      if (this.abort === abort) this.abort = undefined;
    }
  }
}

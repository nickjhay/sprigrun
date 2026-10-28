export interface RuntimeRequest {
  source: Uint8Array;
  emit: (text: string) => void;
  input: (prompt: string) => Promise<string>;
  load: (address: string) => Promise<Uint8Array>;
}
export interface RuntimeAdapter {
  run: (request: RuntimeRequest) => Promise<{ summary?: string }>;
}
export const RUN_LIMITS = Object.freeze({
  computeMs: 2000, sessionMs: 300000, inputMs: 120000, loadMs: 15000,
  outputChars: 65536, outputMessages: 1024, inputChars: 16384,
  ioRequests: 64, sourceBytes: 262144, totalSourceBytes: 1048576, modules: 32,
});
export function runtimeURL(value: string, origin: string): string {
  const u = new URL(value, origin);
  if (u.origin !== new URL(origin).origin || u.username || u.password || u.search || u.hash ||
      !u.pathname.startsWith('/runtime/') || !u.pathname.endsWith('.js'))
    throw new Error('Runtime adapters must be local /runtime/*.js modules configured by the site owner.');
  return u.href;
}
export class OutputBuffer {
  text = '';
  truncated = false;
  readonly capacity: number;
  constructor(capacity = RUN_LIMITS.outputChars) { this.capacity = capacity; }
  append(value: unknown): string {
    if (typeof value !== 'string') return '';
    const accepted = value.slice(0, Math.max(0, this.capacity - this.text.length));
    if (accepted.length !== value.length) this.truncated = true;
    this.text += accepted;
    return accepted;
  }
}

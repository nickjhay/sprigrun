import { parseAddress } from '../store/src/proof.ts';
import { loadSource } from '../store/examples/client.ts';
import { requireHashing } from './document.ts';
import { RUN_LIMITS } from './runtime-contract.ts';
// One resolver per run. Every fetch uses the captured store and verifies bytes.
export class ContentLoader {
  private readonly origin: string;
  private readonly cache = new Map<string, Uint8Array>();
  private total: number;
  constructor(origin: string, rootBytes: number) { this.origin = origin; this.total = rootBytes; }
  async load(address: string, signal: AbortSignal): Promise<Uint8Array> {
    const parsed = parseAddress(address);
    if (!parsed || parsed.bytes > RUN_LIMITS.sourceBytes) throw new Error('Use a canonical hash_length address within 256 KiB.');
    signal.throwIfAborted();
    const cached = this.cache.get(address);
    if (cached) return cached.slice();
    if (!this.origin) throw new Error('Set a blob store before running code that uses graft.');
    if (this.cache.size >= RUN_LIMITS.modules || this.total + parsed.bytes > RUN_LIMITS.totalSourceBytes)
      throw new Error('Run source budget reached.');
    requireHashing();
    const result = await loadSource(this.origin, address, signal);
    signal.throwIfAborted();
    this.cache.set(address, result.bytes); this.total += result.bytes.length;
    return result.bytes.slice();
  }
}

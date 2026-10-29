/** Ordered, in-memory service experiment. No clock, network or durable storage. */
import { NAME_LIMITS, NameGraph, recordAddress } from './model.ts';

export const NAME_REPLAY_POLICY = 'sprig-name-arrival-draft-1';
const MAX_SEQUENCE = (1n << 64n) - 1n;

export interface AdmissionStamp {
  sequence: string; // unsigned 64-bit, decimal on the wire; gaps are allowed
  acceptedAtMs: number; // service time, never a publisher-supplied timestamp
}
export interface ReplayOptions {
  genesisAdmission: AdmissionStamp;
  recoveryWindowMs: number; // fixed for this replay, positive safe integer
  capacity?: number; // genesis + all verified candidates, including losing ones
}
export type Decision = 'genesis' | 'advance' | 'recovery' |
  'off_branch' | 'not_stronger' | 'recovery_expired';
export interface Admission extends AdmissionStamp {
  record: string;
  decision: Decision;
  head: string; // selected head AFTER this admission; never subsequently rewritten
}

function stamp(value: AdmissionStamp): AdmissionStamp {
  if (!value || typeof value.sequence !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.sequence) ||
      BigInt(value.sequence) > MAX_SEQUENCE) throw new Error('invalid_name_sequence');
  if (!Number.isSafeInteger(value.acceptedAtMs) || value.acceptedAtMs < 0)
    throw new Error('invalid_name_time');
  return { sequence: value.sequence, acceptedAtMs: value.acceptedAtMs };
}

/** One name's projection of a service log. Callers supply authoritative stamps.
 * Concurrent calls fail explicitly rather than creating an unbounded wait queue.
 * Verification can await, but committing a decision and its stamp is synchronous.
 */
export class NameReplay {
  readonly #graph: NameGraph;
  readonly #window: number;
  readonly #admissions = new Map<string, Admission>();
  readonly #chain: string[];
  #last: Admission;
  #busy = false;

  private constructor(graph: NameGraph, genesisAdmission: AdmissionStamp, window: number) {
    this.#graph = graph;
    this.#window = window;
    this.#chain = [graph.genesis];
    this.#last = { ...genesisAdmission, record: graph.genesis, decision: 'genesis', head: graph.genesis };
    this.#admissions.set(graph.genesis, this.#last);
  }

  static async open(input: Uint8Array, expectedGenesis: string, options: ReplayOptions): Promise<NameReplay> {
    const initial = stamp(options.genesisAdmission);
    const window = options.recoveryWindowMs;
    if (!Number.isSafeInteger(window) || window <= 0) throw new Error('invalid_name_recovery_window');
    const graph = await NameGraph.open(input, expectedGenesis, options.capacity ?? NAME_LIMITS.nodes);
    return new NameReplay(graph, initial, window);
  }

  /** All entries are copies. A recovery never alters an earlier entry's head. */
  history(): Admission[] { return [...this.#admissions.values()].map(entry => ({ ...entry })); }

  view() {
    const head = this.#chain[this.#chain.length - 1]!;
    const { record } = this.#graph.get(head);
    return { policy: NAME_REPLAY_POLICY, recoveryWindowMs: this.#window,
      genesis: this.#graph.genesis, head, target: record.kind === 'update' ? record.target : null,
      chain: [...this.#chain], sequence: this.#last.sequence, acceptedAtMs: this.#last.acceptedAtMs };
  }

  async admit(input: Uint8Array, expectedUpdate: string, admission: AdmissionStamp): Promise<Admission> {
    if (this.#busy) throw new Error('name_replay_busy');
    this.#busy = true;
    try {
      const previous = this.#admissions.get(expectedUpdate);
      // A duplicate keeps its FIRST stamp. The new proposed stamp is irrelevant,
      // but even a duplicate must present bytes matching the claimed address.
      const next = previous ?? stamp(admission);
      if (!previous && BigInt(next.sequence) <= BigInt(this.#last.sequence))
        throw new Error('name_sequence_not_increasing');
      if (!previous && next.acceptedAtMs < this.#last.acceptedAtMs)
        throw new Error('name_time_went_backwards');
      if (expectedUpdate === this.#graph.genesis) {
        // Opening already admitted genesis. Check exact bytes without re-opening
        // another graph or accidentally admitting genesis as an update.
        if (await recordAddress(input) !== expectedUpdate) throw new Error('name_hash_mismatch');
        return { ...previous! };
      }
      await this.#graph.add(input, expectedUpdate);
      if (previous) return { ...previous };

      const node = this.#graph.get(expectedUpdate);
      if (node.record.kind !== 'update') throw new Error('expected_name_update');
      const parentIndex = this.#chain.indexOf(node.record.parent);
      let decision: Decision;
      if (parentIndex < 0) decision = 'off_branch';
      else if (parentIndex === this.#chain.length - 1) decision = 'advance';
      else {
        const displaced = this.#chain[parentIndex + 1]!;
        const first = this.#admissions.get(displaced)!;
        if (node.rank >= this.#graph.get(displaced).rank) decision = 'not_stronger';
        else if (next.acceptedAtMs - first.acceptedAtMs > this.#window) decision = 'recovery_expired';
        else decision = 'recovery';
      }
      if (decision === 'advance' || decision === 'recovery') {
        // Select only THIS new record, never automatically resurrect old losing
        // descendants. A continuation must be newly admitted against this head.
        this.#chain.splice(parentIndex + 1, this.#chain.length, expectedUpdate);
      }
      const entry: Admission = { sequence: next.sequence, acceptedAtMs: next.acceptedAtMs,
        record: expectedUpdate, decision, head: this.#chain[this.#chain.length - 1]! };
      this.#admissions.set(expectedUpdate, entry);
      this.#last = entry;
      return { ...entry };
    } finally {
      this.#busy = false;
    }
  }
}

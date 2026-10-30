/** Offline publication model, NOT an HTTP server, sandbox, or durable store.
 * See PATHS.md. Admission, the Sprig runner, and capability issuance belong to
 * the trusted host. This model consumes their bounded, already checked plans.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const U64_MAX = (1n << 64n) - 1n;
export const PATH_LIMITS = Object.freeze({
  pathChars: 256, bodyBytes: 4096, tasksPerWrite: 4,
  commits: 128, pendingTasks: 16, attempts: 1024,
});

export type Address =
  | { kind: 'topic' | 'count'; topic: string }
  | { kind: 'entry'; topic: string; entry: string; revision: string | null };

function decimal(value: string): bigint {
  if (typeof value !== 'string' || value.length < 1 || value.length > 20
      || /[^0-9]/.test(value) || (value.length > 1 && value[0] === '0'))
    throw new Error('noncanonical_number');
  const n = BigInt(value);
  if (n > U64_MAX) throw new Error('number_overflow');
  return n;
}
function next(value: string): string {
  const n = decimal(value);
  if (n === U64_MAX) throw new Error('number_overflow');
  return String(n + 1n);
}
function token(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[^A-Za-z0-9_]/.test(value))
    throw new Error('invalid_token');
}

/** A canonical path, not an arbitrary URL. Never decode percent escapes here. */
export function parsePath(path: string): Address {
  if (typeof path !== 'string' || path.length > PATH_LIMITS.pathChars || /[^/A-Za-z0-9_.@]/.test(path))
    throw new Error('invalid_path');
  const match = /^(\/[^.@]+)(?:\.(count|[0-9]+)(?:@([0-9]+))?)?$/.exec(path);
  if (!match) throw new Error('invalid_path');
  const topic = match[1]!;
  for (const segment of topic.slice(1).split('/')) token(segment);
  if (match[2] === undefined) return { kind: 'topic', topic };
  if (match[2] === 'count') {
    if (match[3] !== undefined) throw new Error('invalid_count_revision');
    return { kind: 'count', topic };
  }
  decimal(match[2]);
  if (match[3] !== undefined) decimal(match[3]);
  return { kind: 'entry', topic, entry: `${topic}.${match[2]}`, revision: match[3] ?? null };
}

export type Publication =
  | { kind: 'append'; topic: string; body: string; enqueue?: string[] }
  | { kind: 'advance'; entry: string; expected: string; body: string; enqueue?: string[] };
export interface Plan { publication?: Publication; finish?: string }

/** Host-owned grants; these are NOT accepted from an HTTP caller or guest. */
export interface Grant {
  id: string;
  appendUnder: string[];
  advance: string[]; // exact entries, not a whole topic's revision authority
  enqueue: string[];
  finish: string[]; // distinct from the right to submit work to a queue
}
export interface Representation {
  body: string;
  entry: string | null;
  revision: string | null;
  sequence: string;
  submittedAtMs: number;
}
export interface Task {
  id: string;
  queue: string;
  source: string; // always a pinned revision, never a moving entry
  done: boolean;
}
export interface Receipt {
  sequence: string;
  submittedAtMs: number;
  entry: string | null;
  pinned: string | null;
  tasks: string[];
  finished: string | null;
}
export type Read = { status: 200; value: Representation } | { status: 404 | 410 };

function normalize(plan: Plan): Plan {
  if (!plan || typeof plan !== 'object') throw new Error('invalid_plan');
  const result: Plan = {};
  if (plan.publication !== undefined) {
    const p = plan.publication;
    if (typeof p.body !== 'string' || p.body.length > PATH_LIMITS.bodyBytes)
      throw new Error('invalid_body');
    const bytes = encoder.encode(p.body);
    if (bytes.length > PATH_LIMITS.bodyBytes || decoder.decode(bytes) !== p.body)
      throw new Error('invalid_body');
    const tasks = p.enqueue ?? [];
    if (!Array.isArray(tasks) || tasks.length > PATH_LIMITS.tasksPerWrite || new Set(tasks).size !== tasks.length)
      throw new Error('invalid_tasks');
    tasks.forEach(token);
    if (p.kind === 'append') {
      if (parsePath(p.topic).kind !== 'topic') throw new Error('expected_topic');
      result.publication = { kind: 'append', topic: p.topic, body: p.body, enqueue: [...tasks] };
    } else if (p.kind === 'advance') {
      const path = parsePath(p.entry);
      if (path.kind !== 'entry' || path.revision !== null) throw new Error('expected_current_entry');
      decimal(p.expected);
      result.publication = { kind: 'advance', entry: p.entry, expected: p.expected, body: p.body, enqueue: [...tasks] };
    } else throw new Error('invalid_publication');
  }
  if (plan.finish !== undefined) { token(plan.finish); result.finish = plan.finish; }
  if (!result.publication && !result.finish) throw new Error('empty_plan');
  return result;
}

/** Serial in-memory authority. A backend must make the final writes ONE durable
 * transaction and flush before acknowledgement. No remote operation goes there.
 */
export class PathHost {
  readonly #routes = new Map<string, Representation>();
  readonly #counts = new Map<string, string>();
  readonly #receipts = new Map<string, { fingerprint: string; receipt: Receipt }>();
  readonly #tasks = new Map<string, Task>();
  readonly #blocked = new Set<string>();
  #pending = 0;
  #attempts = 0;
  #lastTime = 0;

  stats() { return { attempts: this.#attempts, commits: this.#receipts.size, pending: this.#pending }; }

  /** No policy callback, lazy materialization, queueing, or revision allocation. */
  get(path: string): Read {
    const parsed = parsePath(path);
    if (parsed.kind === 'entry' && this.#blocked.has(parsed.entry)) return { status: 410 };
    const value = this.#routes.get(path);
    return value ? { status: 200, value: { ...value } } : { status: 404 };
  }

  /** Trusted worker scheduling API, not a public queue listing. */
  pending(queue: string, limit = 8): Task[] {
    token(queue);
    if (!Number.isInteger(limit) || limit < 1 || limit > PATH_LIMITS.pendingTasks)
      throw new Error('invalid_limit');
    return [...this.#tasks.values()].filter(t => t.queue === queue && !t.done)
      .slice(0, limit).map(t => ({ ...t }));
  }

  /** Trusted operator action. Suppression applies to current AND historical URLs. */
  block(entry: string): void {
    const path = parsePath(entry);
    if (path.kind !== 'entry' || path.revision !== null || !this.#routes.has(entry))
      throw new Error('entry_missing');
    this.#blocked.add(entry);
  }

  commit(grant: Grant, requestId: string, input: Plan, atMs: number): Receipt {
    // Illustrative attempt cap, charged even on rejection/retry. Real admission
    // must happen BEFORE receiving a body or invoking any guest computation.
    if (this.#attempts >= PATH_LIMITS.attempts) throw new Error('attempt_limit');
    this.#attempts++;
    token(grant.id); token(requestId);
    const plan = normalize(input);
    const p = plan.publication;
    if (p?.kind === 'append' && !grant.appendUnder.some(prefix =>
      parsePath(prefix).kind === 'topic' && p.topic.startsWith(prefix + '/')))
      throw new Error('append_denied');
    if (p?.kind === 'advance' && !grant.advance.includes(p.entry)) throw new Error('advance_denied');
    if (p?.enqueue?.some(queue => !grant.enqueue.includes(queue))) throw new Error('enqueue_denied');
    const finished = plan.finish === undefined ? undefined : this.#tasks.get(plan.finish);
    if (plan.finish !== undefined && (!finished || !grant.finish.includes(finished.queue)))
      throw new Error('finish_denied');

    const key = `${grant.id}:${requestId}`;
    const fingerprint = JSON.stringify(plan);
    const previous = this.#receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('request_id_reused');
      return structuredClone(previous.receipt); // no new number, time, revision, or task
    }
    if (this.#receipts.size >= PATH_LIMITS.commits) throw new Error('commit_limit');
    if (!Number.isSafeInteger(atMs) || atMs < this.#lastTime) throw new Error('invalid_time');
    if (finished?.done) throw new Error('task_already_finished');
    const pending = this.#pending + (p?.enqueue?.length ?? 0) - (finished ? 1 : 0);
    if (pending > PATH_LIMITS.pendingTasks) throw new Error('queue_full');

    const sequence = String(this.#receipts.size + 1);
    let entry: string | null = null;
    let pinned: string | null = null;
    let revision: string | null = null;
    let count: { path: string; value: string } | null = null;
    if (p?.kind === 'append') {
      parsePath(`${p.topic}.count`);
      const n = this.#counts.get(p.topic) ?? '0';
      count = { path: p.topic, value: next(n) };
      entry = `${p.topic}.${n}`;
      revision = '0';
    } else if (p?.kind === 'advance') {
      entry = p.entry;
      if (this.#blocked.has(entry)) throw new Error('entry_blocked');
      const current = this.#routes.get(entry);
      if (!current) throw new Error('entry_missing');
      if (current.revision !== p.expected) throw new Error('revision_conflict');
      revision = next(p.expected);
    }
    if (entry) { pinned = `${entry}@${revision}`; parsePath(pinned); }
    const tasks = (p?.enqueue ?? []).map((queue, i): Task => ({
      id: `t${sequence}_${i}`, queue, source: pinned!, done: false,
    }));
    const receipt: Receipt = { sequence, submittedAtMs: atMs, entry, pinned,
      tasks: tasks.map(t => t.id), finished: finished?.id ?? null };

    // All validation and capacity checks precede this indivisible model step.
    // Prepared bytes, admission facts, and grants must be rechecked here in a
    // real backend if preparation/validation yielded to another request.
    if (p) {
      const value: Representation = { body: p.body, entry, revision, sequence, submittedAtMs: atMs };
      this.#routes.set(entry!, value);
      this.#routes.set(pinned!, value);
    }
    if (count) {
      this.#counts.set(count.path, count.value);
      this.#routes.set(`${count.path}.count`, { body: count.value + '\n', entry: null,
        revision: null, sequence, submittedAtMs: atMs });
    }
    tasks.forEach(task => this.#tasks.set(task.id, task));
    if (finished) this.#tasks.set(finished.id, { ...finished, done: true });
    this.#receipts.set(key, { fingerprint, receipt });
    this.#pending = pending;
    this.#lastTime = atMs;
    return structuredClone(receipt);
  }
}

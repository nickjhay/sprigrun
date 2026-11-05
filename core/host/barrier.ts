import { DurableObject } from 'cloudflare:workers';
import { check, nextU64, textBytes } from '../src/bytes.ts';
import { canonical, fields, validateHeader, type Header } from './archive.ts';
import { identifier, topology, same, type Topology } from './topology.ts';
import type { NativeCoordinator } from './coordinator.ts';

export type Manifest = { format: 'sprig-barrier/1'; topology: Topology; id: string; epoch: string;
  cuts: Record<string, Header> };
export function manifest(value: unknown): Manifest {
  fields(value, ['format', 'topology', 'id', 'epoch', 'cuts']);
  check(value.format === 'sprig-barrier/1', 'barrier_manifest_version');
  const t = topology(value.topology); identifier(value.id); nextU64(value.epoch);
  fields(value.cuts, Object.keys(t.shards));
  for (const name of Object.keys(t.shards)) {
    const h = validateHeader(value.cuts[name]), c = h.control;
    check(h.base === null && h.epoch === value.epoch && same(c.partition, { topology: t, shard: name })
      && same(c.barrier, { id: value.id, epoch: value.epoch, phase: 'held', manifest: null }), 'barrier_cut_mismatch');
  }
  check(textBytes(canonical(value)).length <= 128 * 1024, 'barrier_manifest_limit');
  return value as Manifest;
}
export interface BarrierEnv { CORE_TOPOLOGY: Topology; CORE_SHARDS: DurableObjectNamespace<NativeCoordinator> }
type Registry = { topology: Topology; journals: Record<string, string>; epoch: string; active: string | null };
export type Round = { id: string; epoch: string; phase: 'hold' | 'cut' | 'publish' | 'release' | 'done';
  next: number; cuts: Record<string, Header> };
/** Privileged RPC only; explicit initialization, one bounded remote step per call.
 * No public route, automatic bootstrap after data loss, or unsafe abort/release.
 */
export class NativeBarrier extends DurableObject<BarrierEnv> {
  private readonly t: Topology;
  private busy = false;
  constructor(ctx: DurableObjectState, env: BarrierEnv) {
    super(ctx, env); this.t = topology(env.CORE_TOPOLOGY);
    const sql = ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE name='barrier_registry'").toArray().length) {
      const c = this.registry(); if (c) check(same(c.topology, this.t), 'topology_changed');
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS barrier_registry (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS barrier_rounds (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  private registry(): Registry | null {
    const r = this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM barrier_registry WHERE id=1').toArray()[0];
    return r ? JSON.parse(r.value) : null;
  }
  private saveRegistry(c: Registry) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO barrier_registry VALUES(1, ?)', canonical(c)); }
  private save(r: Round) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO barrier_rounds VALUES(?, ?)', r.id, canonical(r)); }
  status(id: string): Round | null {
    identifier(id);
    const r = this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM barrier_rounds WHERE id=?', id).toArray()[0];
    return r ? JSON.parse(r.value) : null;
  }
  configuration() { return this.registry(); }
  private peer(name: string) { return this.env.CORE_SHARDS.getByName(name); }
  async initialize() {
    check(!this.busy, 'barrier_busy'); this.busy = true;
    try {
      const prior = this.registry(); if (prior) { await this.ctx.storage.sync(); return prior; }
      const journals: Record<string, string> = {};
      for (const name of Object.keys(this.t.shards).sort()) {
        const c = await this.peer(name).barrierIdentity();
        check(same(c.partition, { topology: this.t, shard: name }) && c.epoch === '0'
          && c.position === '0' && c.barrier === null, 'bootstrap_requires_empty_shards');
        identifier(c.journal); journals[name] = c.journal;
      }
      const c: Registry = { topology: this.t, journals, epoch: '0', active: null };
      this.saveRegistry(c); await this.ctx.storage.sync(); return c;
    } finally { this.busy = false; }
  }
  async start(id: string) {
    identifier(id); check(!this.busy, 'barrier_busy');
    const c = this.registry(); check(c, 'barrier_not_initialized');
    const prior = this.status(id); if (prior) { await this.ctx.storage.sync(); return prior; }
    check(c.active === null, 'barrier_in_progress'); nextU64(c.epoch);
    const r: Round = { id, epoch: c.epoch, phase: 'hold', next: 0, cuts: {} };
    this.ctx.storage.transactionSync(() => { c.active = id; this.saveRegistry(c); this.save(r); });
    await this.ctx.storage.sync(); return r;
  }
  private image(r: Round): Manifest {
    const c = this.registry(); check(c, 'barrier_not_initialized');
    const m = manifest({ format: 'sprig-barrier/1', topology: this.t, id: r.id, epoch: r.epoch, cuts: r.cuts });
    for (const name of Object.keys(this.t.shards))
      check(m.cuts[name]!.control.journal === c.journals[name], 'barrier_journal_changed');
    return m;
  }
  /** Readable only AFTER the complete manifest and release phase are durable. */
  async published(id: string): Promise<Manifest> {
    const r = this.status(id); check(r && ['release', 'done'].includes(r.phase), 'barrier_not_published');
    await this.ctx.storage.sync(); return this.image(r);
  }
  protected async afterRemote(_phase: string, _name: string): Promise<void> {}
  protected async afterCommit(_phase: string): Promise<void> {}
  async step(id: string): Promise<Round> {
    identifier(id); check(!this.busy, 'barrier_busy'); this.busy = true;
    try {
      const c = this.registry(), r = this.status(id); check(c && r, 'barrier_not_started');
      if (r.phase === 'done') { await this.ctx.storage.sync(); return r; }
      check(c.active === id && c.epoch === r.epoch, 'barrier_control_mismatch');
      const phase = r.phase, names = Object.keys(this.t.shards).sort();
      if (phase === 'publish') {
        this.image(r);
        r.phase = 'release'; r.next = 0;
      } else {
        const name = names[r.next]; check(name !== undefined, 'barrier_cursor');
        const peer = this.peer(name), journal = c.journals[name]!;
        if (phase === 'hold') {
          const ack = await peer.barrierHold(id, r.epoch, journal);
          check(ack?.id === id && ack.epoch === r.epoch && ack.phase === 'held', 'barrier_hold_ack');
        } else if (phase === 'cut') {
          const h = validateHeader(JSON.parse(await peer.barrierCut(id, r.epoch, journal)));
          check(h.control.journal === journal, 'barrier_journal_changed'); r.cuts[name] = h;
        } else {
          const ack = await peer.barrierRelease(id, journal);
          check(ack?.id === id && ack.epoch === r.epoch && ack.phase === 'released', 'barrier_release_ack');
        }
        await this.afterRemote(phase, name); // Fault injection: remote commit succeeded, local cursor did not.
        r.next++;
        if (r.next === names.length) { r.next = 0; r.phase = phase === 'hold' ? 'cut' : phase === 'cut' ? 'publish' : 'done'; }
      }
      this.ctx.storage.transactionSync(() => {
        this.save(r);
        if (r.phase === 'done') { c.active = null; c.epoch = nextU64(c.epoch); this.saveRegistry(c); }
      });
      await this.ctx.storage.sync(); await this.afterCommit(phase); return r;
    } finally { this.busy = false; }
  }
}

import { manifest, clusterPlan, type ClusterPlan, type Manifest } from './cluster.ts';
import { DurableObject } from 'cloudflare:workers';
import { check, nextU64 } from '../src/bytes.ts';
import { canonical, digest, parseLine, validateHeader, type Header } from './archive.ts';
import { identifier, topology, same, type Topology } from './topology.ts';
import type { NativeCoordinator } from './coordinator.ts';

export { manifest, type Manifest } from './cluster.ts';
export interface BarrierEnv { CORE_RESTORE_MODE?: string; SOURCES: R2Bucket; CORE_TOPOLOGY: Topology; CORE_SHARDS: DurableObjectNamespace<NativeCoordinator> }
type ClusterRestore = { phase: 'starting' | 'import' | 'verify' | 'history' | 'publish' | 'release' | 'done'; history: string; cuts: Record<string, Header>; plan: ClusterPlan; digest: string; next: number };
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
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE name='cluster_restore'").toArray().length) {
      const r = this.restoreState(); if (r) check(same(r.plan.boundary.topology, this.t), 'topology_changed');
    }
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE name='barrier_registry'").toArray().length) {
      const c = this.registry(); if (c) check(same(c.topology, this.t), 'topology_changed');
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS barrier_registry (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS barrier_rounds (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cluster_restore (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
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
  private normal() { const s = this.restoreState(); check(this.env.CORE_RESTORE_MODE !== '1' && (!s || s.phase === 'done'), 'recovery_mode'); }
  configuration() { this.normal(); return this.registry(); }
  private peer(name: string) { return this.env.CORE_SHARDS.getByName(name); }
  async initialize() {
    this.normal();
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
    this.normal();
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
    this.normal();
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
  private restoreState(): ClusterRestore | null {
    const row = this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM cluster_restore WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  private saveRestore(s: ClusterRestore) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO cluster_restore VALUES(1, ?)', canonical(s)); }
  restoreStatus() { const s = this.restoreState(); return s && { phase: s.phase, digest: s.digest, next: s.next }; }
  async restorePlan(hash: string): Promise<ClusterPlan> {
    const s = this.restoreState(); check(s && s.digest === hash && s.phase !== 'starting', 'cluster_restore_not_ready');
    await this.ctx.storage.sync(); return s.plan;
  }
  async restorePublished(hash: string) {
    const s = this.restoreState(); check(s && ['release', 'done'].includes(s.phase), 'cluster_restore_not_verified');
    return this.restorePlan(hash);
  }
  async restoreBegin(line: string, trustedDigest: string, confirmation: string) {
    check(this.env.CORE_RESTORE_MODE === '1', 'restore_mode_required');
    check(confirmation === 'old-writers-fenced', 'restore_history_confirmation');
    check(!this.busy, 'barrier_busy'); this.busy = true;
    try {
      check(await digest(line) === trustedDigest, 'cluster_trusted_digest_mismatch');
      const plan = clusterPlan(parseLine(line)); check(same(plan.boundary.topology, this.t), 'restore_partition_mismatch');
      let s = this.restoreState();
      if (s) check(s.digest === trustedDigest && same(s.plan, plan), 'different_restore_active');
      else {
        check(this.registry() === null && !this.ctx.storage.sql.exec('SELECT 1 FROM barrier_rounds LIMIT 1').toArray().length, 'restore_requires_empty_target');
        for (const name of Object.keys(this.t.shards).sort()) await this.peer(name).clusterPristine();
        s = { phase: 'starting', history: '0', cuts: {}, plan, digest: trustedDigest, next: 0 }; this.saveRestore(s); await this.ctx.storage.sync();
      }
      if (s.phase === 'starting') {
        // Exactly once for the entire shared bucket, before authorizing ANY member import.
        check((await this.env.SOURCES.list({ limit: 1 })).objects.length === 0, 'restore_requires_empty_bucket');
        s.phase = 'import'; this.saveRestore(s); await this.ctx.storage.sync();
      }
      return this.restoreStatus();
    } finally { this.busy = false; }
  }
  async restoreStep(hash: string) {
    check(this.env.CORE_RESTORE_MODE === '1', 'restore_mode_required');
    check(!this.busy, 'barrier_busy'); this.busy = true;
    try {
      const s = this.restoreState(); check(s && s.digest === hash && s.phase !== 'starting', 'cluster_restore_not_ready');
      if (s.phase === 'done') return this.restoreStatus();
      const names = Object.keys(this.t.shards).sort(), phase = s.phase;
      if (phase === 'history') {
        const name = names[s.next]!;
        const h = validateHeader(JSON.parse(await this.peer(name).clusterCut(s.history, hash)));
        check(h.control.journal === s.plan.boundary.cuts[name]!.control.journal, 'barrier_journal_changed');
        s.cuts[name] = h; await this.afterRemote('restore-history', name); s.next++;
        this.ctx.storage.transactionSync(() => {
          if (s.next === names.length) {
            const id = h.control.barrier!.id;
            const m = manifest({format:'sprig-barrier/1', topology:this.t, id, epoch:s.history, cuts:s.cuts});
            check(this.status(id) === null, 'archive_barrier_reused');
            this.save({id, epoch:s.history, phase:'done', next:0, cuts:m.cuts});
            s.history = nextU64(s.history); s.next = 0; s.cuts = {};
            if (s.history === s.plan.boundary.epoch) s.phase = 'publish';
          }
          this.saveRestore(s);
        });
      } else if (phase === 'publish') {
        const m = s.plan.boundary;
        check(this.status(m.id) === null, 'archive_barrier_reused');
        const c: Registry = { topology: this.t, epoch: m.epoch, active: m.id,
          journals: Object.fromEntries(names.map(name => [name, m.cuts[name]!.control.journal])) };
        this.ctx.storage.transactionSync(() => {
          this.saveRegistry(c); this.save({ id: m.id, epoch: m.epoch, phase: 'release', next: 0, cuts: m.cuts });
          s.phase = 'release'; s.next = 0; this.saveRestore(s);
        });
      } else {
        const name = names[s.next]!;
        let done = true;
        if (phase === 'import') await this.peer(name).clusterReady(hash);
        else if (phase === 'verify') done = (await this.peer(name).clusterVerify(hash)).done;
        else await this.peer(name).clusterRelease(hash);
        await this.afterRemote('restore-' + phase, name);
        if (done) s.next++;
        if (s.next === names.length) {
          s.next = 0; s.phase = phase === 'import' ? 'verify' : phase === 'verify' ? (s.plan.boundary.epoch === '0' ? 'publish' : 'history') : 'done';
        }
        this.ctx.storage.transactionSync(() => {
          if (s.phase === 'done') {
            const c = this.registry()!, r = this.status(s.plan.boundary.id)!;
            c.epoch = nextU64(c.epoch); c.active = null; r.phase = 'done'; r.next = 0;
            this.saveRegistry(c); this.save(r);
          }
          this.saveRestore(s);
        });
      }
      await this.ctx.storage.sync(); await this.afterCommit('restore-' + phase); return this.restoreStatus();
    } finally { this.busy = false; }
  }

}

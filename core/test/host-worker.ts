// Test-only HTTP/RPC adapter. No test routes or fault controls are deployed.
import { NativeCoordinator, type Env } from '../host/coordinator.ts';
import { orderedU64 } from '../src/bytes.ts';

export class TestCoordinator extends NativeCoordinator {
  private io: { puts: number; gets: number; failPut: string | null;
    hold: Promise<void> | null; release: (() => void) | null; waiting: number };
  constructor(ctx: DurableObjectState, env: Env) {
    const io = { puts: 0, gets: 0, failPut: null as string | null,
      hold: null as Promise<void> | null, release: null as (() => void) | null, waiting: 0 };
    const sources = {
      list: (...args: any[]) => Reflect.apply(env.SOURCES.list, env.SOURCES, args),
      get: (...args: any[]) => { io.gets++; return Reflect.apply(env.SOURCES.get, env.SOURCES, args); },
      put: async (...args: any[]) => {
        io.puts++; io.waiting++;
        try {
          await io.hold;
          const fail = io.failPut; io.failPut = null;
          if (fail === 'before') throw new Error('injected_put_failure');
          const result = await Reflect.apply(env.SOURCES.put, env.SOURCES, args);
          if (fail === 'after') throw new Error('injected_put_ambiguous');
          return result;
        } finally { io.waiting--; }
      },
    } as R2Bucket;
    super(ctx, { ...env, SOURCES: sources });
    this.io = io;
  }
  private hold: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private waiting = 0;
  private fail = false;
  protected override async prepared() {
    this.waiting++;
    try { await this.hold; } finally { this.waiting--; }
  }
  protected override committing() {
    if (this.fail) { this.fail = false; throw new Error('injected_rollback'); }
  }
  async testCommand(command: string, value: any) {
    if (command === 'io') return { puts: this.io.puts, gets: this.io.gets, waiting: this.io.waiting };
    else if (command === 'fail-put') this.io.failPut = value.when;
    else if (command === 'corrupt') await this.env.SOURCES.put('native/sea/' + value.address, value.body);
    else if (command === 'hold-put') this.io.hold = new Promise(resolve => { this.io.release = resolve; });
    else if (command === 'release-put') { this.io.release?.(); this.io.release = null; this.io.hold = null; }
    else if (command === 'hold') this.hold = new Promise(resolve => { this.release = resolve; });
    else if (command === 'release') { this.release?.(); this.release = null; this.hold = null; }
    else if (command === 'waiting') return this.waiting;
    else if (command === 'fail') this.fail = true;
    else if (command === 'head') this.db.sql.exec(
      'INSERT INTO heads VALUES (?, ?) ON CONFLICT(collection) DO UPDATE SET number=excluded.number',
      value.collection, orderedU64(value.number));
    else if (command === 'rows') return {
      heads: this.db.sql.exec('SELECT * FROM heads ORDER BY collection').toArray(),
      sources: this.db.sql.exec('SELECT * FROM sources ORDER BY address').toArray(),
      entries: this.db.sql.exec('SELECT * FROM entries ORDER BY path').toArray(),
      accepted: this.db.sql.exec('SELECT * FROM accepted ORDER BY id').toArray(),
      suppressions: this.db.sql.exec('SELECT * FROM suppressions ORDER BY path,revision').toArray(),
      cuts: this.db.sql.exec('SELECT * FROM cuts ORDER BY epoch').toArray(),
    };
    else throw new Error('invalid_test_command');
    await this.ctx.storage.sync();
    return null;
  }
}

interface TestEnv extends Env { CORE: DurableObjectNamespace<TestCoordinator> }
export default {
  async fetch(request: Request, env: TestEnv) {
    const stub = env.CORE.getByName('test');
    const path = new URL(request.url).pathname;
    try {
      if (path === '/submit' || path === '/lose-reply') {
        const receipt = await stub.submit(new Uint8Array(await request.arrayBuffer()), request.headers.get('Signature'));
        if (path === '/lose-reply') return new Response('injected_lost_reply', { status: 503 });
        return new Response(receipt);
      }
      if (path === '/stats') return Response.json(await stub.stats());
      const value = await request.json() as any;
      if (path === '/read') return new Response(await stub.read(value.path));
      if (path === '/latest') return Response.json(await stub.latest(value.path));
      if (path === '/evidence') return Response.json(await stub.evidence(value.id));
      if (path === '/suppress') { await stub.suppress(value.path, value.suppressed); return Response.json(null); }
      if (path === '/pause') { await stub.pause(value.paused); return Response.json(null); }
      if (path === '/cut') return Response.json(await stub.cut());
      if (path === '/snapshotHeader') return Response.json(await stub.snapshotHeader(value.epoch));
      if (path === '/snapshotPage') return Response.json(await stub.snapshotPage(value.epoch, value.table, value.after));
      if (path === '/snapshotRecord') return Response.json(await stub.snapshotRecord(value.epoch, value.table, value.key));
      if (path === '/restoreStatus') return Response.json(await stub.restoreStatus());
      if (path === '/restoreBegin') return Response.json(await stub.restoreBegin(value.header, value.footer));
      if (path === '/restoreRecord') return Response.json(await stub.restoreRecord(value.index, value.line));
      if (path === '/restoreFinish') return Response.json(await stub.restoreFinish());
      return Response.json(await stub.testCommand(path.slice(1), value));
    } catch (error) { return new Response((error as Error).message, { status: 409 }); }
  },
};

import { DurableObject } from 'cloudflare:workers';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config, type Config } from './config.ts';
import { full, refill, waitSeconds, type BucketState } from '../../shared/bucket.ts';
import { PROTOCOL, HEX256, HEX128, NONCE, unhex, randomHex, parseCursor, proofText, workTarget, type Challenge, type Batch } from './protocol.ts';
import { HttpError, headers, json, failure, readBody, utf8 } from './http.ts';

interface Env extends Record<string, unknown> { HUB: DurableObjectNamespace<ChannelHub>; REQUEST_LIMITER?: RateLimit }
type Channel = { address: string; epoch: string; created: number; expires: number; head: number; stamp: number; rate: string };
type Row = { seq: number; id: string; at_ms: number; text: string; digest: string; bytes: number };
type Attachment = { address: string; epoch: string; cursor: number; expires: number; receipt: string | null; sent: number; deadline: number };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const encode = (s: string) => new TextEncoder().encode(s);
const route = /^\/(?:channel\/([0-9a-f]{64})(\/create)?|challenge\/channel\/([0-9a-f]{64}))$/;
const CHANNEL_RATE = { capacity: 30, refill: 120, periodMs: 60000 };
const MAX_FRAME = 65536;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const u = new URL(request.url);
      if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new HttpError(400, 'https_required');
      if (u.pathname !== '/' && !route.test(u.pathname)) throw new HttpError(404, 'not_found');
      if (!['GET', 'POST', 'OPTIONS'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      // The Cloudflare binding is an additional edge guard, not the global quota.
      // It is deliberately absent in local Miniflare, which still runs all hub limits.
      if (env.REQUEST_LIMITER && !(await env.REQUEST_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })).success) {
        throw new HttpError(429, 'edge_rate_limit', 'Too many requests. Please wait a minute.', 60);
      }
      return await env.HUB.getByName('channels-v1').fetch(request);
    } catch (e) { return failure(e); }
  },
} satisfies ExportedHandler<Env>;

/** One bounded hub makes global admission and log mutations atomic. No guest code runs here. */
export class ChannelHub extends DurableObject<Env> {
  private c: Config;
  private sql: SqlStorage;
  private alarmAt: number | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.c = config(env); this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channels(address TEXT PRIMARY KEY, epoch TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, head INTEGER NOT NULL, stamp INTEGER NOT NULL, rate TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_expiry ON channels(expires);
      CREATE TABLE IF NOT EXISTS messages(channel TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, at_ms INTEGER NOT NULL, text TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(channel,seq), UNIQUE(channel,id));
      CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ticket_expiry ON tickets(expires);
      CREATE TABLE IF NOT EXISTS buckets(name TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
    // Recover the persisted deadline on a cold start. Rejected traffic must not
    // keep pushing an existing cleanup/connection deadline into the future.
    ctx.blockConcurrencyWhile(async () => { this.alarmAt = await ctx.storage.getAlarm(); });
  }
  private one<T extends Record<string, SqlStorageValue>>(query: string, ...params: SqlStorageValue[]): T | undefined {
    return this.sql.exec<T>(query, ...params).toArray()[0];
  }
  private count(table: 'channels' | 'tickets' | 'messages'): number { return this.one<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n; }
  private bump(name: string, amount = 1): void {
    this.sql.exec('INSERT INTO counters VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value', name, amount);
  }
  private take(name: keyof Config['policies'], amount = 1, now = Date.now()): void {
    const policy = this.c.policies[name];
    const row = this.one<{ state: string }>('SELECT state FROM buckets WHERE name=?', name);
    const state = refill(row ? JSON.parse(row.state) as BucketState : full(policy, now), policy, now);
    if (state.tokens < amount) throw new HttpError(429, `${name}_quota`, 'The service is full for now. Please try again after the indicated delay.', waitSeconds(state, policy, amount));
    state.tokens -= amount;
    this.sql.exec('INSERT INTO buckets VALUES(?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state', name, JSON.stringify(state));
  }
  private authorize(request: Request, address: string): void {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '');
    if (!m || !timingSafeEqual(unhex(hash(unhex(m[1]!))), unhex(address))) {
      throw new HttpError(403, 'posting_secret_required', 'Append or create with Authorization: Bearer <secret>. The address is SHA-256 of the 32 secret bytes, not of the hexadecimal text.');
    }
  }
  private remove(address: string): void {
    this.sql.exec('DELETE FROM messages WHERE channel=?', address);
    this.sql.exec('DELETE FROM channels WHERE address=?', address);
    for (const ws of this.ctx.getWebSockets(address)) this.close(ws, 1000, 'channel expired');
    this.bump('channels_expired');
  }
  private sweep(now: number): void {
    this.sql.exec('DELETE FROM tickets WHERE expires<=?', now);
    for (const row of this.sql.exec<{ address: string }>('SELECT address FROM channels WHERE expires<=? LIMIT 8', now)) this.remove(row.address);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || a.expires <= now || (a.receipt && a.deadline <= now)) this.close(ws, 1000, 'subscription expired or acknowledgement overdue');
    }
  }
  private channel(address: string, epoch?: string): Channel {
    const row = this.one<Channel>('SELECT * FROM channels WHERE address=?', address);
    if (!row) throw new HttpError(404, 'channel_not_found', 'This channel does not exist, or its lifetime has ended. A holder of its secret may create a new incarnation.');
    if (row.expires <= Date.now()) throw new HttpError(410, 'channel_expired');
    if (epoch !== undefined && row.epoch !== epoch) throw new HttpError(409, 'channel_replaced', 'This address now has a different incarnation. Open it again deliberately; the previous cursor or append cannot be reused.');
    return row;
  }
  private trim(address: string, now: number): void {
    this.sql.exec('DELETE FROM messages WHERE channel=? AND at_ms<=?', address, now - this.c.messageAgeMs);
    // Walk a bounded retained log backwards to find the suffix that fits both caps.
    const rows = this.sql.exec<{ seq: number; bytes: number }>('SELECT seq,bytes FROM messages WHERE channel=? ORDER BY seq DESC', address);
    let bytes = 0, count = 0, first = Number.MAX_SAFE_INTEGER;
    for (const row of rows) {
      if (count >= this.c.maxMessages || bytes + row.bytes > this.c.maxBytes) break;
      bytes += row.bytes; count++; first = row.seq;
    }
    this.sql.exec('DELETE FROM messages WHERE channel=? AND seq<?', address, first);
  }
  private batch(address: string, after: string | null, socket?: Attachment): Batch {
    const parsed = after === null ? null : parseCursor(after);
    if (after !== null && !parsed) throw new HttpError(400, 'invalid_cursor');
    const ch = this.channel(address, parsed?.epoch);
    this.trim(address, Date.now());
    const earliest = this.one<{ n: number | null }>('SELECT MIN(seq) n FROM messages WHERE channel=?', address)!.n ?? ch.head + 1;
    if (parsed && parsed.seq > ch.head) throw new HttpError(409, 'cursor_ahead');
    const from = parsed?.seq ?? earliest - 1;
    const value: Batch = { protocol: PROTOCOL, type: 'batch', epoch: ch.epoch, earliest, head: ch.head, messages: [],
      cursor: `${ch.epoch}_${Math.max(from, earliest - 1)}`, gap: parsed !== null && from < earliest - 1, has_more: false, expires_at_ms: ch.expires };
    if (socket) { value.receipt = randomHex(); value.subscription_expires_at_ms = socket.expires; }
    let size = encode(JSON.stringify(value)).byteLength + 32;
    for (const row of this.sql.exec<{ seq: number; id: string; at_ms: number; text: string }>('SELECT seq,id,at_ms,text FROM messages WHERE channel=? AND seq>? ORDER BY seq LIMIT 32', address, from)) {
      const extra = encode(JSON.stringify(row)).byteLength + 1;
      if (size + extra > MAX_FRAME) break;
      value.messages.push(row); size += extra; value.cursor = `${ch.epoch}_${row.seq}`;
    }
    value.has_more = parseCursor(value.cursor)!.seq < ch.head;
    return value;
  }
  private chargeDelivery(text: string): void {
    const bytes = Math.max(1024, encode(text).byteLength);
    this.ctx.storage.transactionSync(() => { this.take('delivery', bytes); this.take('deliveryBurst', bytes); this.bump('delivery_charged_bytes', bytes); });
  }
  private close(ws: WebSocket, code: number, reason: string): void {
    try { ws.close(code, reason); } catch { /* Already closed. */ }
  }
  private push(ws: WebSocket, a: Attachment): void {
    if (a.receipt || ws.readyState !== WebSocket.OPEN) return;
    if (a.expires <= Date.now()) { this.close(ws, 1000, 'subscription expired'); return; }
    const batch = this.batch(a.address, `${a.epoch}_${a.cursor}`, a), text = JSON.stringify(batch);
    this.chargeDelivery(text);
    a.receipt = batch.receipt!; a.sent = parseCursor(batch.cursor)!.seq; a.deadline = Date.now() + this.c.ackMs;
    ws.serializeAttachment(a); ws.send(text);
  }
  private broadcast(address: string): void {
    for (const ws of this.ctx.getWebSockets(address)) {
      try { this.push(ws, ws.deserializeAttachment() as Attachment); }
      catch { this.close(ws, 1013, 'delivery unavailable; reconnect with your cursor'); }
    }
  }
  private async schedule(): Promise<void> {
    const times: number[] = [];
    const ch = this.one<{ n: number | null }>('SELECT MIN(expires) n FROM channels')!.n;
    const ticket = this.one<{ n: number | null }>('SELECT MIN(expires) n FROM tickets')!.n;
    if (ch !== null) times.push(ch); if (ticket !== null) times.push(ticket);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment;
      times.push(a.expires); if (a.receipt) times.push(a.deadline);
    }
    const next = times.length ? Math.max(Date.now() + 1000, Math.min(...times)) : null;
    if (next === this.alarmAt || (next !== null && this.alarmAt !== null && this.alarmAt <= next)) return;
    this.alarmAt = next;
    if (next === null) await this.ctx.storage.deleteAlarm(); else await this.ctx.storage.setAlarm(next);
  }
  async alarm(): Promise<void> { this.alarmAt = null; this.sweep(Date.now()); await this.schedule(); }

  private consume(request: Request, operation: 'create' | 'append', address: string, epoch = '-', id = '-'): Challenge {
    const ticketId = request.headers.get('Channel-Ticket') ?? '', nonce = request.headers.get('Channel-Nonce') ?? '';
    if (!HEX128.test(ticketId) || !NONCE.test(nonce)) throw new HttpError(428, 'proof_required', `Request a challenge at /challenge/channel/${address}, solve it, and send Channel-Ticket and Channel-Nonce. Even zero-difficulty tickets are single use.`);
    const row = this.one<{ data: string }>('SELECT data FROM tickets WHERE id=?', ticketId);
    if (!row) throw new HttpError(409, 'ticket_spent_or_expired', 'Request a fresh challenge. This ticket is spent, unknown, or expired.');
    const t = JSON.parse(row.data) as Challenge;
    if (t.expires_at_ms <= Date.now() || t.operation !== operation || t.address !== address || t.epoch !== epoch || t.message_id !== id) throw new HttpError(409, 'ticket_scope_mismatch');
    if (hash(proofText(t, nonce)) > t.target) throw new HttpError(422, 'proof_not_solved', 'SHA-256 of the documented challenge text must be at most target (big-endian). Try another 16-digit lowercase hexadecimal nonce.');
    // Consume synchronously before awaiting the body; concurrent redemption cannot pass.
    this.sql.exec('DELETE FROM tickets WHERE id=?', ticketId);
    return t;
  }
  private async challenge(request: Request, address: string): Promise<Response> {
    this.authorize(request, address); this.take('challenges');
    let input: Record<string, unknown>;
    try { input = JSON.parse(utf8(await readBody(request, 512, this.c.uploadMs))); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'invalid_json'); }
    if (!input || typeof input !== 'object') throw new HttpError(400, 'invalid_challenge');
    const now = Date.now();
    const t: Challenge = { protocol: PROTOCOL, id: randomHex(), operation: 'create', address, epoch: '-', message_id: '-', digest: '-', bytes: 0, expires_at_ms: now + this.c.ticketMs, target: '' };
    if (input.operation === 'append') {
      if (typeof input.epoch !== 'string' || !HEX128.test(input.epoch) || typeof input.message_id !== 'string' || !HEX128.test(input.message_id) ||
          typeof input.digest !== 'string' || !HEX256.test(input.digest) || !Number.isSafeInteger(input.bytes) || Number(input.bytes) < 0 || Number(input.bytes) > this.c.maxMessage) throw new HttpError(400, 'invalid_append_challenge');
      const ch = this.channel(address, input.epoch);
      Object.assign(t, { operation: 'append', epoch: input.epoch, message_id: input.message_id, digest: input.digest, bytes: input.bytes, expires_at_ms: Math.min(t.expires_at_ms, ch.expires) });
    } else if (input.operation !== 'create') throw new HttpError(400, 'invalid_operation');
    else if (this.one('SELECT address FROM channels WHERE address=?', address)) throw new HttpError(409, 'channel_exists');
    if (this.count('tickets') >= this.c.maxTickets) throw new HttpError(429, 'ticket_capacity', 'Too many outstanding challenges. Try again shortly.', 10);
    t.target = workTarget(t.operation === 'create' ? this.c.createBits : this.c.appendBits, this.c.perByte, t.bytes);
    this.sql.exec('INSERT INTO tickets VALUES(?,?,?)', t.id, t.expires_at_ms, JSON.stringify(t));
    this.bump('challenges_issued'); return json(t, 201);
  }
  private create(request: Request, address: string): Response {
    this.authorize(request, address); this.consume(request, 'create', address);
    if (this.one('SELECT address FROM channels WHERE address=?', address)) throw new HttpError(409, 'channel_exists');
    const now = Date.now(), epoch = randomHex();
    this.ctx.storage.transactionSync(() => {
      if (this.count('channels') >= this.c.maxChannels) throw new HttpError(429, 'channel_capacity', 'All channel slots are occupied. Expired channels will free space.', 60);
      this.take('creates', 1);
      this.sql.exec('INSERT INTO channels VALUES(?,?,?,?,?,?,?)', address, epoch, now, now + this.c.lifetimeMs, 0, now, JSON.stringify(full(CHANNEL_RATE, now)));
      this.bump('channels_created');
    });
    return json({ protocol: PROTOCOL, address, epoch, cursor: `${epoch}_0`, expires_at_ms: now + this.c.lifetimeMs }, 201);
  }
  private async append(request: Request, address: string): Promise<Response> {
    this.authorize(request, address);
    const epoch = request.headers.get('Channel-Epoch') ?? '', id = request.headers.get('Channel-Message-Id') ?? '';
    if (!HEX128.test(epoch) || !HEX128.test(id)) throw new HttpError(400, 'append_identity_required', 'Send Channel-Epoch and a random 32-digit Channel-Message-Id. Reuse that message ID only when retrying the same text.');
    this.channel(address, epoch); this.trim(address, Date.now());
    const old = this.one<Row>('SELECT * FROM messages WHERE channel=? AND id=?', address, id);
    // A retained duplicate can recover a lost response even after its ticket was spent.
    const ticket = old ? null : this.consume(request, 'append', address, epoch, id);
    if (!/^text\/plain(?:;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? 'text/plain')) throw new HttpError(415, 'text_plain_required');
    const bytes = await readBody(request, this.c.maxMessage, this.c.uploadMs), text = utf8(bytes), digest = hash(bytes);
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const ch = this.channel(address, epoch); this.trim(address, now);
      const prior = this.one<Row>('SELECT * FROM messages WHERE channel=? AND id=?', address, id);
      if (prior) {
        if (prior.digest !== digest || prior.bytes !== bytes.byteLength || prior.text !== text) throw new HttpError(409, 'message_id_conflict');
        return { seq: prior.seq, duplicate: true };
      }
      if (!ticket) throw new HttpError(409, 'retry_window_expired', 'The earlier message is no longer retained. Its prior delivery cannot be deduplicated.');
      if (ticket.expires_at_ms <= now) throw new HttpError(409, 'ticket_expired');
      if (ticket.digest !== digest || ticket.bytes !== bytes.byteLength) throw new HttpError(422, 'message_does_not_match_challenge');
      const rate = refill(JSON.parse(ch.rate), CHANNEL_RATE, now);
      if (rate.tokens < 1) throw new HttpError(429, 'channel_rate_limit', 'This channel is receiving messages too quickly.', waitSeconds(rate, CHANNEL_RATE, 1));
      rate.tokens--;
      const debit = Math.max(1024, bytes.byteLength);
      this.take('ingress', debit, now); this.take('burst', debit, now);
      if (ch.head >= Number.MAX_SAFE_INTEGER - 1) throw new HttpError(409, 'sequence_exhausted');
      const seq = ch.head + 1, stamp = Math.max(ch.stamp, now);
      this.sql.exec('INSERT INTO messages VALUES(?,?,?,?,?,?,?)', address, seq, id, stamp, text, digest, bytes.byteLength);
      this.sql.exec('UPDATE channels SET head=?,stamp=?,rate=? WHERE address=?', seq, stamp, JSON.stringify(rate), address);
      this.trim(address, now); this.bump('messages_accepted'); this.bump('ingress_charged_bytes', debit);
      return { seq, duplicate: false };
    });
    if (!result.duplicate) this.broadcast(address);
    return json({ protocol: PROTOCOL, epoch, cursor: `${epoch}_${result.seq}`, ...result }, result.duplicate ? 200 : 201);
  }
  private subscribe(address: string, after: string | null): Response {
    const first = this.batch(address, after), ch = this.channel(address);
    if (this.ctx.getWebSockets().length >= this.c.maxSockets || this.ctx.getWebSockets(address).length >= this.c.channelSockets) throw new HttpError(429, 'subscription_capacity', 'There are no free subscription slots. Use a bounded history read or try again later.', 30);
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    const start = after === null ? first.earliest - 1 : parseCursor(after)!.seq;
    const a: Attachment = { address, epoch: ch.epoch, cursor: start, expires: Math.min(ch.expires, Date.now() + this.c.socketMs), receipt: null, sent: start, deadline: 0 };
    this.ctx.acceptWebSocket(server, [address]); server.serializeAttachment(a);
    try { this.push(server, a); }
    catch (e) { this.close(server, 1013, 'delivery unavailable'); throw e; }
    this.bump('subscriptions_opened'); return new Response(null, { status: 101, webSocket: client, headers });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      this.take('requests', 1);
      if (typeof message !== 'string' || message.length > 100) throw new HttpError(400, 'ack_required');
      const v = JSON.parse(message), a = ws.deserializeAttachment() as Attachment;
      if (!a || a.expires <= Date.now() || !a.receipt || a.deadline <= Date.now() || v.ack !== a.receipt || Object.keys(v).length !== 1) throw new HttpError(400, 'invalid_ack');
      a.cursor = a.sent; a.receipt = null; a.deadline = 0; ws.serializeAttachment(a);
      const ch = this.channel(a.address, a.epoch);
      if (ch.head > a.cursor) this.push(ws, a);
    } catch { this.close(ws, 1008, 'invalid acknowledgement or quota exhausted'); }
    finally { await this.schedule(); }
  }
  async webSocketClose(ws: WebSocket, code: number): Promise<void> { this.close(ws, code, ''); await this.schedule(); }
  async webSocketError(ws: WebSocket): Promise<void> { this.close(ws, 1011, 'connection failed'); await this.schedule(); }
  async fetch(request: Request): Promise<Response> {
    try {
      this.take('requests', 1); this.sweep(Date.now());
      const u = new URL(request.url), m = route.exec(u.pathname);
      if (u.pathname === '/' && request.method === 'GET') {
        const metrics = this.sql.exec<{ name: string; value: number }>('SELECT * FROM counters ORDER BY name').toArray();
        const bytes = this.one<{ n: number }>('SELECT COALESCE(SUM(bytes),0) n FROM messages')!.n;
        const rows = [`protocol ${PROTOCOL}`, `channels ${this.count('channels')}`, `stored_messages ${this.count('messages')}`, `stored_payload_bytes ${bytes}`, `outstanding_tickets ${this.count('tickets')}`, `subscriptions ${this.ctx.getWebSockets().length}`, `max_message_bytes ${this.c.maxMessage}`, `channel_bytes ${this.c.maxBytes}`, `channel_messages ${this.c.maxMessages}`, `message_age_seconds ${this.c.messageAgeMs / 1000}`, `channel_lifetime_seconds ${this.c.lifetimeMs / 1000}`, `max_channels ${this.c.maxChannels}`, `create_pow_bits ${this.c.createBits}`, `append_pow_bits ${this.c.appendBits}`, `pow_per_byte ${this.c.perByte}`, ...metrics.map(v => `${v.name} ${v.value}`)];
        return new Response(rows.join('\n') + '\n', { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      if (!m) throw new HttpError(404, 'not_found');
      if (m[3] && request.method === 'POST') return await this.challenge(request, m[3]);
      const address = m[1];
      if (!address) throw new HttpError(405, 'method_not_allowed');
      if (m[2] && request.method === 'POST') return this.create(request, address);
      if (m[2]) throw new HttpError(405, 'method_not_allowed');
      if (request.method === 'POST') return await this.append(request, address);
      if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      if (u.search.length > 100 || [...u.searchParams.keys()].some(k => k !== 'after') || u.searchParams.getAll('after').length > 1) throw new HttpError(400, 'invalid_query');
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return this.subscribe(address, u.searchParams.get('after'));
      const body = JSON.stringify(this.batch(address, u.searchParams.get('after'))); this.chargeDelivery(body); this.bump('history_reads');
      return new Response(body, { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
    } catch (e) { return failure(e); }
    finally { await this.schedule(); }
  }
}

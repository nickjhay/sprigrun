import { PROTOCOL, HEX256, HEX128, randomHex, digest, unhex, proofText, validChallenge, parseCursor, type Challenge, type Batch } from './protocol.ts';
export { randomHex, digest } from './protocol.ts';
export class ChannelError extends Error {
  status: number; code: string; retryAfter: number;
  constructor(status: number, code: string, message: string, retryAfter = 0) { super(message); this.status=status;this.code=code;this.retryAfter=retryAfter; }
}
export function serviceOrigin(value: string): string {
  const u = new URL(value);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))) throw new Error('Use an HTTPS service origin, or HTTP on localhost.');
  return u.origin;
}
export async function keys(secret = randomHex(32)): Promise<{ secret: string; address: string }> {
  if (!globalThis.crypto?.subtle) throw new Error('Channel keys require HTTPS or localhost with Web Crypto.');
  return { secret, address: await digest(unhex(secret)) };
}
async function readJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing response body.');
  const bytes = new Uint8Array(65536); let size = 0;
  try {
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      if (size + r.value.byteLength > bytes.byteLength) throw new Error('Channel response exceeds the client limit.');
      bytes.set(r.value, size); size += r.value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes.subarray(0,size)));
  } catch(e) { void reader.cancel().catch(()=>{}); throw e; } finally {reader.releaseLock();}
}
async function request(origin: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const timer = new AbortController(), id = setTimeout(()=>timer.abort(),15000);
  try {
    const response = await fetch(serviceOrigin(origin) + path, { ...init, signal:signal ? AbortSignal.any([signal,timer.signal]) : timer.signal, credentials:'omit', redirect:'error', cache:'no-store' });
    const result = await readJSON(response) as Record<string, unknown>;
    if (!response.ok) throw new ChannelError(response.status, String(result.error), String(result.message ?? result.error), Number(response.headers.get('Retry-After') ?? 0));
    return result;
  } finally { clearTimeout(id); }
}
export async function solve(c: Challenge, signal?: AbortSignal): Promise<string> {
  if (!validChallenge(c)) throw new Error('Invalid challenge.');
  const start = Date.now(), seed = BigInt('0x' + randomHex(8));
  for (let i = 0; i < 1000000; i++) {
    signal?.throwIfAborted();
    if (Date.now() >= c.expires_at_ms || Date.now() - start > 30000) throw new Error('Proof search timed out. The server may require more work than this client permits.');
    const nonce = ((seed + BigInt(i)) & ((1n<<64n)-1n)).toString(16).padStart(16,'0');
    if (await digest(new TextEncoder().encode(proofText(c,nonce))) <= c.target) return nonce;
  }
  throw new Error('Proof exceeded the client work limit.');
}
export async function challenge(origin: string, secret: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ ticket: Challenge; nonce: string; address: string }> {
  const {address}=await keys(secret);
  const ticket=await request(origin,`/challenge/channel/${address}`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(input)},signal);
  if (!validChallenge(ticket) || ticket.address!==address || ticket.operation!==input.operation ||
      (ticket.operation==='append' && ['epoch','message_id','digest','bytes'].some(k=>ticket[k as keyof Challenge]!==input[k]))) throw new Error('Challenge does not match this operation.');
  return {ticket,nonce:await solve(ticket,signal),address};
}
export async function createChannel(origin: string, secret: string, signal?: AbortSignal): Promise<{ address: string; epoch: string; expires_at_ms: number }> {
  const p=await challenge(origin,secret,{operation:'create'},signal);
  const v=await request(origin,`/channel/${p.address}/create`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Channel-Ticket':p.ticket.id,'Channel-Nonce':p.nonce}},signal) as {address:string;epoch:string;expires_at_ms:number};
  if (v.address!==p.address || !HEX128.test(v.epoch) || !Number.isSafeInteger(v.expires_at_ms)) throw new Error('Invalid creation response.');
  return v;
}
export async function appendText(origin: string, secret: string, epoch: string, text: string, messageId = randomHex(), signal?: AbortSignal): Promise<{ cursor: string; duplicate: boolean }> {
  if (!HEX128.test(epoch) || !HEX128.test(messageId)) throw new Error('Invalid append identity.');
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > 8192) throw new Error('Messages may contain at most 8 KiB of UTF-8.');
  const p=await challenge(origin,secret,{operation:'append',epoch,message_id:messageId,digest:await digest(bytes),bytes:bytes.byteLength},signal);
  const v=await request(origin,`/channel/${p.address}`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'text/plain;charset=utf-8','Channel-Epoch':epoch,'Channel-Message-Id':messageId,'Channel-Ticket':p.ticket.id,'Channel-Nonce':p.nonce},body:bytes},signal) as {cursor:string;duplicate:boolean};
  if (parseCursor(v.cursor)?.epoch!==epoch || typeof v.duplicate!=='boolean') throw new Error('Invalid append response.');
  return v;
}
export function validateBatch(value: unknown): Batch {
  if (!value || typeof value!=='object') throw new Error('Invalid channel batch.');
  const b=value as Batch, c=parseCursor(b.cursor);
  if (b.protocol!==PROTOCOL || b.type!=='batch' || !HEX128.test(b.epoch) || !c || c.epoch!==b.epoch ||
      !Number.isSafeInteger(b.head) || b.head<0 || !Number.isSafeInteger(b.earliest) || b.earliest<1 || b.earliest>b.head+1 || c.seq>b.head ||
      !Array.isArray(b.messages) || b.messages.length>32 || typeof b.gap!=='boolean' || typeof b.has_more!=='boolean' || !Number.isSafeInteger(b.expires_at_ms)) throw new Error('Invalid channel batch.');
  let prev=b.earliest-1;
  for (const m of b.messages) {
    if (!Number.isSafeInteger(m.seq) || m.seq<=prev || m.seq>b.head || !HEX128.test(m.id) || !Number.isSafeInteger(m.at_ms) || typeof m.text!=='string' || new TextEncoder().encode(m.text).byteLength>8192) throw new Error('Invalid channel message.');
    prev=m.seq;
  }
  if (b.messages.length && b.messages.at(-1)!.seq!==c.seq) throw new Error('Invalid batch cursor.');
  return b;
}
export async function readChannel(origin: string, address: string, cursor?: string, signal?: AbortSignal): Promise<Batch> {
  if (!HEX256.test(address) || (cursor!==undefined && !parseCursor(cursor))) throw new Error('Invalid address or cursor.');
  return validateBatch(await request(origin,`/channel/${address}`+(cursor?`?after=${cursor}`:''),{},signal));
}
export function subscribe(origin: string, address: string, onBatch: (batch: Batch)=>void, onClose: (reason: string)=>void, cursor?: string): { close(): void } {
  if (!HEX256.test(address) || (cursor!==undefined && !parseCursor(cursor))) throw new Error('Invalid address or cursor.');
  const u=new URL(`/channel/${address}`,serviceOrigin(origin));u.protocol=u.protocol==='https:'?'wss:':'ws:';if(cursor)u.searchParams.set('after',cursor);
  const ws=new WebSocket(u); let intentional=false, latest=cursor?parseCursor(cursor):null;
  ws.onmessage=event=>{
    if(intentional)return;
    try {
      if(typeof event.data!=='string'||event.data.length>65536)throw new Error('Invalid or oversized channel frame.');
      const b=validateBatch(JSON.parse(event.data));
      if(!b.receipt||!HEX128.test(b.receipt))throw new Error('Missing delivery receipt.');
      const next=parseCursor(b.cursor)!;
      if(latest&&(next.epoch!==latest.epoch||next.seq<latest.seq||b.messages.some(m=>m.seq<=latest!.seq)))throw new Error('Channel cursor moved backwards or changed incarnation.');
      onBatch(b); latest=next; ws.send(JSON.stringify({ack:b.receipt}));
    }catch(error){intentional=true;ws.close(1008,'invalid frame or consumer failure');onClose(error instanceof Error?error.message:String(error));}
  };
  ws.onclose=event=>{if(!intentional)onClose(event.reason||'Connection closed. Reconnect using the last cursor.');};
  return {close(){intentional=true;ws.close(1000,'leaving');}};
}

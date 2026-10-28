import { parseAddress } from '../vendor/blob-store/src/proof.ts';
export const MAX_SOURCE_BYTES = 262144;
export const INITIAL_SOURCE = `#!moss/1
# A small conversation, in a small language.
"Your name? " input
"Hello, " swap + "!" + print

: square dup * ;
7 square "Seven squared: " swap str + print
"stressed" reverse print
`;
export const WORLD_SOURCE = `#!moss/1
# Numbers and strings leave their answers on a stack.
6 7 * print
"moss" upper " grows here." + print
"A number? " input number
2 * "Twice that is " swap str + print
`;
export interface Snapshot { bytes: Uint8Array<ArrayBuffer>; revision: number; name: string }
export function decodeSource(bytes: Uint8Array): string {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Source exceeds the 256 KiB workbench limit.');
  try { return new TextDecoder('utf-8', { fatal:true, ignoreBOM:true }).decode(bytes); }
  catch { throw new Error('This file is not valid UTF-8 source.'); }
}
export function requireHashing(): void {
  if (!globalThis.crypto?.subtle) throw new Error('Hash verification and publishing require HTTPS or localhost. Open the local workbench at http://localhost:5173, or use an HTTPS deployment.');
}
export async function addressOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  requireHashing();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  return `${hash}_${bytes.length}`;
}
export function safeName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f/\\]/g,'_').slice(0,100).trim() || 'untitled.sprig';
}
export class SourceDocument {
  #bytes: Uint8Array<ArrayBuffer>;
  #revision = 0;
  name = 'hello.moss';
  originalBytes = true;
  constructor(bytes = new TextEncoder().encode(INITIAL_SOURCE)) { decodeSource(bytes); this.#bytes = new Uint8Array(bytes); }
  get revision(): number { return this.#revision; }
  get length(): number { return this.#bytes.length; }
  get text(): string { return decodeSource(this.#bytes); }
  snapshot(): Snapshot { return {bytes:this.#bytes.slice(),revision:this.#revision,name:this.name}; }
  replace(bytes: Uint8Array, name: string): void {
    decodeSource(bytes); this.#bytes = new Uint8Array(bytes); this.name = safeName(name);
    this.#revision++; this.originalBytes = true;
  }
  edit(text: string): void {
    const bytes = new TextEncoder().encode(text);
    decodeSource(bytes); this.#bytes = bytes; this.#revision++; this.originalBytes = false;
  }
  isCurrent(snapshot: Snapshot): boolean { return snapshot.revision === this.#revision; }
}
export function storeOrigin(value: string): string {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Use a store origin, such as https://blobs.example.com, without a path.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) throw new Error('Use HTTPS, or localhost for development.');
  return u.origin;
}
export type WorkbenchRoute = {kind:'home'|'workspace';address:null} | {kind:'program'|'direct';address:string};
export function workbenchRoute(url: URL): WorkbenchRoute {
  if (url.pathname === '/') return {kind:'home',address:null};
  if (url.pathname === '/workspace') return {kind:'workspace',address:null};
  const match = /^\/(r|w|run)\/([^/]+)$/.exec(url.pathname);
  const address = match?.[2], parsed = address && parseAddress(address);
  if (!match || !address || !parsed) throw new Error('This shared-source address is invalid.');
  if (parsed.bytes > MAX_SOURCE_BYTES) throw new Error('Shared source exceeds the 256 KiB workbench limit.');
  return {kind:match[1]==='run'?'direct':'program',address};
}
export function sharedAddress(url: URL): string | null {
  return workbenchRoute(url).address;
}
export function shareURL(origin: string, address: string): string {
  if (!parseAddress(address)) throw new Error('Invalid source address.');
  return new URL(`/r/${address}`,origin).href;
}
export function encodeDraft(snapshot: Snapshot): string {
  let binary = '';
  for (const byte of snapshot.bytes) binary += String.fromCharCode(byte);
  return JSON.stringify({v:1,name:snapshot.name,bytes:btoa(binary)});
}
export function decodeDraft(raw: string): {bytes:Uint8Array; name:string} {
  if (raw.length > 360000) throw new Error('Saved draft is too large.');
  const record = JSON.parse(raw);
  if (record?.v !== 1 || typeof record.bytes !== 'string' || typeof record.name !== 'string') throw new Error('Invalid saved draft.');
  const bytes = Uint8Array.from(atob(record.bytes),c=>c.charCodeAt(0));
  decodeSource(bytes);
  return {bytes,name:safeName(record.name)};
}

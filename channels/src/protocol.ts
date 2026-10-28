// Shared browser/native wire definitions. Secrets are 32 raw random bytes,
// encoded as lowercase hex for transport; addresses hash the raw bytes.
export const PROTOCOL = 'sprig-channel-v1';
export const HEX256 = /^[0-9a-f]{64}$/;
export const HEX128 = /^[0-9a-f]{32}$/;
export const NONCE = /^[0-9a-f]{16}$/;
export interface Challenge {
  protocol: typeof PROTOCOL;
  id: string;
  operation: 'create' | 'append';
  address: string;
  epoch: string;
  message_id: string;
  digest: string;
  bytes: number;
  expires_at_ms: number;
  target: string;
}
export interface Message { seq: number; id: string; at_ms: number; text: string }
export interface Batch {
  protocol: typeof PROTOCOL;
  type: 'batch';
  epoch: string;
  earliest: number;
  head: number;
  messages: Message[];
  cursor: string;
  gap: boolean;
  has_more: boolean;
  expires_at_ms: number;
  receipt?: string;
  subscription_expires_at_ms?: number;
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function unhex(value: string): Uint8Array {
  if (!HEX256.test(value)) throw new Error('Expected 64 lowercase hexadecimal digits.');
  return Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16));
}
export function randomHex(bytes = 16): string { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }
export async function digest(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}
export function parseCursor(value: string): { epoch: string; seq: number } | null {
  const m = /^([0-9a-f]{32})_(0|[1-9][0-9]{0,15})$/.exec(value);
  if (!m || !Number.isSafeInteger(Number(m[2]))) return null;
  return { epoch: m[1]!, seq: Number(m[2]) };
}
export function workTarget(bits: number, perByte: number, bytes: number): string {
  const work = (1n << BigInt(bits)) + BigInt(perByte) * BigInt(bytes);
  return (((1n << 256n) / work) - 1n).toString(16).padStart(64, '0');
}
export function proofText(c: Challenge, nonce: string): string {
  return `${PROTOCOL}\n${c.id}\n${c.operation}\n${c.address}\n${c.epoch}\n${c.message_id}\n${c.digest}\n${c.bytes}\n${c.expires_at_ms}\n${c.target}\n${nonce}\n`;
}
export function validChallenge(value: unknown): value is Challenge {
  if (!value || typeof value !== 'object') return false;
  const c = value as Challenge;
  return c.protocol === PROTOCOL && HEX128.test(c.id) && HEX256.test(c.address) && HEX256.test(c.target) &&
    Number.isSafeInteger(c.expires_at_ms) && Number.isSafeInteger(c.bytes) && c.bytes >= 0 && c.bytes <= 8192 &&
    ((c.operation === 'create' && c.epoch === '-' && c.message_id === '-' && c.digest === '-' && c.bytes === 0) ||
     (c.operation === 'append' && HEX128.test(c.epoch) && HEX128.test(c.message_id) && HEX256.test(c.digest)));
}

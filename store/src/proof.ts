export { workTarget } from '../../shared/work.ts';
// Shared wire format. No Cloudflare or Node dependencies.
export const ADDRESS = /^([0-9a-f]{64})_(0|[1-9][0-9]{0,6})$/;
export const TICKET_ID = /^[0-9a-f]{64}$/;
export const NONCE = /^[0-9a-f]{16}$/;
export const PROTOCOL = 'blob-store-upload-v1';
export interface Challenge {
  protocol: typeof PROTOCOL;
  id: string;
  address: string;
  expires_at_ms: number;
  target: string;
}

export function parseAddress(address: string): { digest: string; bytes: number } | null {
  const match = ADDRESS.exec(address);
  if (!match || Number(match[2]) > 1048576) return null;
  return { digest: match[1]!, bytes: Number(match[2]) };
}

export function validChallenge(value: unknown): value is Challenge {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Challenge;
  return c.protocol === PROTOCOL && typeof c.id === 'string' && TICKET_ID.test(c.id) &&
    typeof c.address === 'string' && parseAddress(c.address) !== null &&
    Number.isSafeInteger(c.expires_at_ms) && c.expires_at_ms > 0 &&
    typeof c.target === 'string' && TICKET_ID.test(c.target);
}

// Fields have canonical, newline-free representations. The final nonce is
// exactly 16 lowercase hexadecimal digits and is followed by one newline.
export function proofPrefix(challenge: Challenge): string {
  return `${PROTOCOL}\n${challenge.id}\n${challenge.address}\n${challenge.expires_at_ms}\n${challenge.target}\n`;
}

export async function proofDigest(challenge: Challenge, nonce: string): Promise<string> {
  const bytes = new TextEncoder().encode(proofPrefix(challenge) + nonce + '\n');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    b => b.toString(16).padStart(2, '0')).join('');
}

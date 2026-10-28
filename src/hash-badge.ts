/** Display only: the wire address remains lowercase SHA-256 hex plus decimal bytes. */
export function digestToBadge(hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Expected a canonical SHA-256 digest.');
  return BigInt('0x'+hex).toString(36).padStart(50,'0');
}
export function badgeToDigest(text: string): string {
  if (!/^[0-9a-z]{50}$/.test(text)) throw new Error('Expected 50 lowercase base36 characters.');
  let n=0n;
  for (const c of text) n=n*36n+BigInt(parseInt(c,36));
  if (n >= 1n<<256n) throw new Error('This badge exceeds 256 bits.');
  return n.toString(16).padStart(64,'0');
}
export function badgeRows(hex: string): string {
  return digestToBadge(hex).match(/.{10}/g)!.join('\n');
}

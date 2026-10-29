// Bounded SHA-256 work arithmetic shared by the independent wire protocols.
/** Success probability is approximately 1 / (2**bits + bytes*perByte). */
export function workTarget(bits: number, perByte: number, bytes: number): string {
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > 256 ||
      !Number.isSafeInteger(perByte) || perByte < 0 || perByte > 1000000000 ||
      !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1048576) throw new Error('invalid_work_parameters');
  const work = (1n << BigInt(bits)) + BigInt(bytes) * BigInt(perByte);
  const outcomes = (1n << 256n) / work;
  if (outcomes === 0n) throw new Error('work_exceeds_sha256_range');
  return (outcomes - 1n).toString(16).padStart(64, '0');
}

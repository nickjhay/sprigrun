import { workTarget } from './proof.ts';
import type { Env } from './types.ts';

// Bound the runtime even if an operator mistypes a configuration value.
// Lowering MAX_BLOB_BYTES only affects admission; older blobs remain readable.
export const HARD_MAX_BLOB_BYTES = 1024 * 1024;

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max || value?.trim() === '') {
    throw new Error('invalid_configuration');
  }
  return n;
}

export function config(env: Env) {
  const maxBytes = integer(env.MAX_BLOB_BYTES, 262144, 1, HARD_MAX_BLOB_BYTES);
  const minimumDebit = integer(env.MINIMUM_DEBIT_BYTES, 8192, 1, HARD_MAX_BLOB_BYTES);
  const longCapacity = integer(env.LONG_CAPACITY_BYTES, 209715200, 1, 2 ** 40);
  const burstCapacity = integer(env.BURST_CAPACITY_BYTES, 8388608, 1, 2 ** 40);
  if (Math.max(maxBytes, minimumDebit) > Math.min(longCapacity, burstCapacity)) {
    throw new Error('blob_size_exceeds_bucket_capacity');
  }
  const validationPolicy = env.VALIDATION_POLICY ?? 'utf8-v1';
  if (!['utf8-v1', 'ascii-v1'].includes(validationPolicy)) throw new Error('unknown_validation_policy');
  const proofOfWorkBits = integer(env.PROOF_OF_WORK_BITS, 0, 0, 256);
  const proofOfWorkPerByte = integer(env.PROOF_OF_WORK_PER_BYTE, 0, 0, 1000000000);
  workTarget(proofOfWorkBits, proofOfWorkPerByte, maxBytes);
  return {
    maxBytes, minimumDebit, validationPolicy,
    proofOfWorkBits, proofOfWorkPerByte,
    challenges: { capacity: integer(env.CHALLENGE_BURST, 30, 1, 10000), refill: integer(env.CHALLENGES_PER_MINUTE, 30, 1, 10000), periodMs: 60000 },
    challengeCapacity: integer(env.CHALLENGE_CAPACITY, 512, 1, 10000),
    challengeTtlMs: integer(env.CHALLENGE_TTL_SECONDS, 600, 1, 3600) * 1000,
    long: { capacity: longCapacity, refill: integer(env.LONG_REFILL_BYTES_PER_DAY, 104857600, 1, 2 ** 40), periodMs: 86400000 },
    burst: { capacity: burstCapacity, refill: integer(env.BURST_REFILL_BYTES_PER_HOUR, 8388608, 1, 2 ** 40), periodMs: 3600000 },
    attempts: { capacity: integer(env.ATTEMPT_CAPACITY, 30, 1, 10000), refill: integer(env.ATTEMPTS_PER_MINUTE, 30, 1, 10000), periodMs: 60000 },
    uploadTimeoutMs: integer(env.UPLOAD_TIMEOUT_MS, 10000, 100, 30000),
    browserCacheSeconds: integer(env.BROWSER_CACHE_SECONDS, 31536000, 0, 31536000),
  };
}
export type Config = ReturnType<typeof config>;

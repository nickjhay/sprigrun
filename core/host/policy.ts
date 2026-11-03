import { check, LIMITS } from '../src/bytes.ts';
import type { BucketPolicy } from '../../shared/bucket.ts';

export type Policy = {
  sourceBytes: number; chatBytes: number; minimumDebit: number;
  growth: BucketPolicy; burst: BucketPolicy; attempts: BucketPolicy;
};
const MiB = 1024 * 1024;
export const DEFAULT_POLICY: Policy = {
  sourceBytes: LIMITS.sourceBytes, chatBytes: 8192, minimumDebit: 8192,
  growth: { capacity: 200 * MiB, refill: 100 * MiB, periodMs: 86_400_000 },
  burst: { capacity: 8 * MiB, refill: 8 * MiB, periodMs: 3_600_000 },
  attempts: { capacity: 30, refill: 30, periodMs: 60_000 },
};
// An admission estimate, not a claim about SQLite's physical page accounting.
// Covers bounded headers, receipt, evidence, allocation and index overhead.
export const METADATA_ALLOWANCE = 8192;
export function policy(input: Policy = DEFAULT_POLICY): Policy {
  const p = structuredClone(input);
  for (const n of [p.sourceBytes, p.chatBytes, p.minimumDebit,
    ...Object.values(p.growth), ...Object.values(p.burst), ...Object.values(p.attempts)])
    check(Number.isSafeInteger(n) && n > 0, 'invalid_policy');
  check(p.sourceBytes <= LIMITS.sourceBytes && p.chatBytes <= LIMITS.sourceBytes,
    'invalid_policy');
  check(Math.max(Math.max(p.minimumDebit, p.sourceBytes) + Math.max(p.minimumDebit, METADATA_ALLOWANCE),
    p.chatBytes + METADATA_ALLOWANCE)
    <= Math.min(p.growth.capacity, p.burst.capacity), 'invalid_policy_capacity');
  return p;
}

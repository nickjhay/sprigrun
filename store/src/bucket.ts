// Integer token arithmetic: retain fractional refill as a numerator remainder.
// BigInt intermediates avoid rounding up admission near a quota boundary.
export interface BucketPolicy { capacity: number; refill: number; periodMs: number }
export interface BucketState { tokens: number; atMs: number; remainder: number }

export function full(policy: BucketPolicy, now: number): BucketState {
  return { tokens: policy.capacity, atMs: now, remainder: 0 };
}

export function refill(state: BucketState, policy: BucketPolicy, now: number): BucketState {
  const atMs = Math.max(state.atMs, Math.floor(now));
  const numerator = BigInt(atMs - state.atMs) * BigInt(policy.refill) + BigInt(state.remainder);
  const whole = numerator / BigInt(policy.periodMs);
  const tokens = BigInt(Math.min(state.tokens, policy.capacity)) + whole;
  if (tokens >= BigInt(policy.capacity)) return { tokens: policy.capacity, atMs, remainder: 0 };
  return { tokens: Number(tokens), atMs, remainder: Number(numerator % BigInt(policy.periodMs)) };
}

export function waitSeconds(state: BucketState, policy: BucketPolicy, debit: number): number {
  if (state.tokens >= debit) return 0;
  const remaining = BigInt(debit - state.tokens) * BigInt(policy.periodMs) - BigInt(state.remainder);
  const milliseconds = (remaining + BigInt(policy.refill) - 1n) / BigInt(policy.refill);
  return Math.max(1, Math.ceil(Number(milliseconds) / 1000));
}

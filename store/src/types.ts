import type { StoreCoordinator } from './coordinator.ts';

export interface Env {
  BLOBS: R2Bucket;
  STORE: DurableObjectNamespace<StoreCoordinator>;
  UPLOAD_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  ADMIN_TOKEN?: string;
  RESTORE_MODE?: string;
  MAX_BLOB_BYTES?: string;
  MINIMUM_DEBIT_BYTES?: string;
  LONG_REFILL_BYTES_PER_DAY?: string;
  LONG_CAPACITY_BYTES?: string;
  BURST_REFILL_BYTES_PER_HOUR?: string;
  BURST_CAPACITY_BYTES?: string;
  ATTEMPTS_PER_MINUTE?: string;
  ATTEMPT_CAPACITY?: string;
  UPLOAD_TIMEOUT_MS?: string;
  VALIDATION_POLICY?: string;
  PROOF_OF_WORK_BITS?: string;
  PROOF_OF_WORK_PER_BYTE?: string;
  CHALLENGES_PER_MINUTE?: string;
  CHALLENGE_BURST?: string;
  CHALLENGE_CAPACITY?: string;
  CHALLENGE_TTL_SECONDS?: string;
  BROWSER_CACHE_SECONDS?: string;
}

export type Failure = {
  ok: false; status: number; error: string; retryAfter?: number;
  message?: string;
  proof_of_work?: { protocol: string; target: string; message_prefix: string };
};
export type Result<T> = { ok: true; value: T } | Failure;
export type Published = { digest: string; bytes: number; created: boolean; submitted_at_ms: number | null };

export class HttpError extends Error {
  status: number;
  code: string;
  retryAfter: number | undefined;
  constructor(status: number, code: string, retryAfter?: number) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function failure(status: number, error: string, retryAfter?: number): Failure {
  return retryAfter === undefined
    ? { ok: false, status, error }
    : { ok: false, status, error, retryAfter };
}

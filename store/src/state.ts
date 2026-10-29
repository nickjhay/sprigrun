import type { BucketState } from '../../shared/bucket.ts';

export interface Control {
  schema: 2;
  paused: boolean;
  proofOfWorkBits?: number;
  proofOfWorkPerByte?: number;
  long: BucketState;
  burst: BucketState;
  attempts: BucketState;
  challenges: BucketState;
  reservedBlobs: number;
  reservedBytes: number;
  confirmedBlobs: number;
  confirmedBytes: number;
  blockedAddresses: number;
}
export interface Receipt extends Record<string, SqlStorageValue> {
  address: string;
  status: 'pending' | 'stored' | 'blocked';
  bytes: number;
  debit: number;
  submitted_at_ms: number | null;
}

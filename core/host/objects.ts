import { check, contentAddress, LIMITS, parseAddress } from '../src/bytes.ts';

export const sourceKey = (address: string) => 'native/sea/' + address;
export async function loadSource(bucket: R2Bucket, address: string): Promise<Uint8Array<ArrayBuffer>> {
  const expected = parseAddress(address, LIMITS.sourceBytes);
  const object = await bucket.get(sourceKey(address));
  check(object && object.size === expected.length, 'source_storage_unavailable');
  const bytes = new Uint8Array(await object.arrayBuffer());
  check(await contentAddress(bytes) === address, 'source_integrity_failure');
  return bytes;
}
export async function putSource(bucket: R2Bucket, address: string, bytes: Uint8Array<ArrayBuffer>) {
  const { digest } = parseAddress(address, LIMITS.sourceBytes);
  const written = await bucket.put(sourceKey(address), bytes, {
    onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: digest,
    customMetadata: { kind: 'source', sha256: digest },
  });
  if (!written) await loadSource(bucket, address);
}

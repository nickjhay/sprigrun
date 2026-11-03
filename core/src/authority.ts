import { actionId, parseAction } from './action.ts';
import { base64url, check, contentAddress, copyBytes, LIMITS, unbase64url } from './bytes.ts';
import { canonicalOrigin, parseReference } from './references.ts';
import { readRecord, writeRecord } from './records.ts';

export function keyRecordBytes(publicKey: Uint8Array): Uint8Array<ArrayBuffer> {
  check(publicKey.length === 32, 'invalid_key_size');
  return writeRecord('key/1', [['algorithm', 'ed25519'], ['public-key', base64url(publicKey)]]);
}
export function parseKeyRecord(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const [algorithm, key] = readRecord(bytes, 'key/1', ['algorithm', 'public-key']);
  check(algorithm === 'ed25519', 'unsupported_key_algorithm');
  return unbase64url(key!, 32);
}
export type PlotBinding = { origin: string; plot: string; key: string };
export function parsePlotBinding(bytes: Uint8Array, origin: string): PlotBinding {
  const [audience, plot, key] = readRecord(bytes, 'plot/1', ['origin', 'plot', 'key']);
  check(audience === canonicalOrigin(origin), 'wrong_origin');
  check(parseReference(plot!).kind === 'plot', 'invalid_plot');
  check(parseReference(key!).kind === 'sea', 'invalid_key_reference');
  return { origin, plot: plot!, key: key! };
}
/** A host allocation fact, NOT a signature or proof of control. */
export function plotBindingBytes(binding: PlotBinding): Uint8Array<ArrayBuffer> {
  const bytes = writeRecord('plot/1', [
    ['origin', binding.origin], ['plot', binding.plot], ['key', binding.key],
  ]);
  parsePlotBinding(bytes, binding.origin);
  return bytes;
}
export async function signAction(input: Uint8Array, privateKey: CryptoKey, origin: string): Promise<string> {
  const bytes = copyBytes(input);
  check(parseAction(bytes, origin).author !== null, 'author_required');
  check(privateKey.type === 'private' && privateKey.algorithm.name === 'Ed25519', 'invalid_signing_key');
  return base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, bytes)));
}
export type AuthorityEvidence = { keyRecord: Uint8Array; plotBinding?: Uint8Array };
/** Verifies supplied, pinned evidence only. Does not fetch URLs or admit writes.
 * A plot binding must come from the trusted host's retained allocation history.
 */
export async function verifyAction(input: Uint8Array, signature: string,
  evidence: AuthorityEvidence, origin: string) {
  // Snapshot all caller-owned bytes before the first await.
  const bytes = copyBytes(input);
  const keyBytes = copyBytes(evidence.keyRecord, LIMITS.recordBytes);
  const plotBytes = evidence.plotBinding === undefined ? null
    : copyBytes(evidence.plotBinding, LIMITS.recordBytes);
  const proof = unbase64url(signature, 64);
  const action = parseAction(bytes, origin);
  check(action.author !== null, 'author_required');
  const publicKey = parseKeyRecord(keyBytes);
  const key = '/sea/' + await contentAddress(keyBytes);
  let binding: string | null = null;
  const author = parseReference(action.author);
  if (author.kind === 'sea') {
    check(plotBytes === null && action.author === key, 'wrong_author_key');
  } else {
    check(author.kind === 'plot' && plotBytes !== null, 'plot_binding_required');
    const retained = parsePlotBinding(plotBytes, origin);
    check(retained.plot === action.author && retained.key === key, 'wrong_plot_binding');
    binding = await contentAddress(plotBytes);
  }
  const imported = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
  check(await crypto.subtle.verify('Ed25519', imported, proof, bytes), 'invalid_signature');
  return { action, id: await actionId(bytes, origin), key, binding };
}

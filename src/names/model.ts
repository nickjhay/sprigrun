/** Offline naming experiment. See NAMING.md before using this as a protocol. */
import { parseAddress } from '../../vendor/blob-store/src/proof.ts';

export const NAME_PROTOCOL = 'sprig-name-draft-1';
export const NAME_LIMITS = Object.freeze({ recordBytes: 8192, keys: 8, nodes: 256 });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const keyPattern = /^[0-9a-f]{64}$/;
const signaturePattern = /^[0-9a-f]{128}$/;

export interface Genesis {
  protocol: typeof NAME_PROTOCOL;
  kind: 'genesis';
  nonce: string;
  keys: string[]; // strongest first
}
export interface UpdateFields {
  genesis: string;
  parent: string;
  target: string;
  signer: string;
  keys: string[]; // authority in force AFTER this update
}
export interface Update extends UpdateFields {
  protocol: typeof NAME_PROTOCOL;
  kind: 'update';
  signature: string;
}
type NameRecord = Genesis | Update;
interface Node {
  record: NameRecord;
  depth: number;
  rank: number;
  children: string[];
}
export type Resolution =
  | { kind: 'head'; head: string; target: string | null; depth: number;
      chain: string[]; relation: 'same' | 'forward' | 'recovery' }
  | { kind: 'conflict'; at: string; chain: string[]; candidates: string[] };

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16));
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !parseAddress(value)) throw new Error('invalid_name_reference');
  return value;
}
function publicKey(value: unknown): string {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw new Error('invalid_name_key');
  return value;
}
function keys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > NAME_LIMITS.keys)
    throw new Error('invalid_name_keys');
  const result = value.map(publicKey);
  if (new Set(result).size !== result.length) throw new Error('duplicate_name_key');
  return result;
}
function normalize(value: unknown): NameRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_name_record');
  const r = value as Record<string, unknown>;
  if (r.protocol !== NAME_PROTOCOL) throw new Error('unsupported_name_protocol');
  if (r.kind === 'genesis') {
    if (typeof r.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(r.nonce)) throw new Error('invalid_name_nonce');
    return { protocol: NAME_PROTOCOL, kind: 'genesis', nonce: r.nonce, keys: keys(r.keys) };
  }
  if (r.kind !== 'update' || typeof r.signature !== 'string' || !signaturePattern.test(r.signature))
    throw new Error('invalid_name_update');
  return { protocol: NAME_PROTOCOL, kind: 'update', genesis: address(r.genesis),
    parent: address(r.parent), target: address(r.target), signer: publicKey(r.signer),
    keys: keys(r.keys), signature: r.signature };
}
function encode(record: NameRecord): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(record) + '\n');
}
function decode(bytes: Uint8Array): NameRecord {
  const record = normalize(JSON.parse(decoder.decode(bytes)));
  const canonical = encode(record);
  // Compare bytes, not decoded text: TextDecoder otherwise accepts a UTF-8 BOM.
  // This also rejects extra/duplicate keys, alternate escapes, order and whitespace.
  if (bytes.length !== canonical.length || !bytes.every((byte, i) => byte === canonical[i]))
    throw new Error('noncanonical_name_record');
  return record;
}
function snapshot(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.byteLength > NAME_LIMITS.recordBytes) throw new Error('name_record_too_large');
  return new Uint8Array(bytes);
}
function signingBytes(update: Update): Uint8Array<ArrayBuffer> {
  const { signature: _, ...unsigned } = update;
  return encoder.encode(NAME_PROTOCOL + '/update\n' + JSON.stringify(unsigned) + '\n');
}

export async function recordAddress(input: Uint8Array): Promise<string> {
  const bytes = snapshot(input);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) + '_' + bytes.length;
}
export async function publicKeyHex(key: CryptoKey): Promise<string> {
  if (key.type !== 'public' || key.algorithm.name !== 'Ed25519') throw new Error('expected_ed25519_public_key');
  return hex(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}
export function genesisBytes(keyList: string[], nonce: string): Uint8Array<ArrayBuffer> {
  return encode(normalize({ protocol: NAME_PROTOCOL, kind: 'genesis', nonce, keys: keyList }));
}
export async function signUpdate(fields: UpdateFields, privateKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  // Normalize before awaiting so later caller edits cannot change signed fields.
  const record = normalize({ ...fields, protocol: NAME_PROTOCOL, kind: 'update', signature: '0'.repeat(128) }) as Update;
  if (privateKey.type !== 'private' || privateKey.algorithm.name !== 'Ed25519') throw new Error('expected_ed25519_private_key');
  record.signature = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, signingBytes(record))));
  return encode(record);
}

/** A bounded, parent-first set of verified records, NOT a service or a freshness oracle. */
export class NameGraph {
  readonly #genesis: string;
  readonly #nodes = new Map<string, Node>();
  readonly #capacity: number;

  private constructor(genesis: string, record: Genesis, capacity: number) {
    this.#genesis = genesis;
    this.#capacity = capacity;
    this.#nodes.set(genesis, { record, depth: 0, rank: -1, children: [] });
  }
  static async open(input: Uint8Array, expectedGenesis: string, capacity = NAME_LIMITS.nodes): Promise<NameGraph> {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > NAME_LIMITS.nodes) throw new Error('invalid_name_capacity');
    const bytes = snapshot(input);
    address(expectedGenesis);
    if (await recordAddress(bytes) !== expectedGenesis) throw new Error('name_hash_mismatch');
    const record = decode(bytes);
    if (record.kind !== 'genesis') throw new Error('expected_name_genesis');
    return new NameGraph(expectedGenesis, record, capacity);
  }
  get genesis(): string { return this.#genesis; }
  get size(): number { return this.#nodes.size; }

  async add(input: Uint8Array, expectedUpdate: string): Promise<string> {
    const bytes = snapshot(input);
    address(expectedUpdate);
    if (await recordAddress(bytes) !== expectedUpdate) throw new Error('name_hash_mismatch');
    if (expectedUpdate === this.genesis) throw new Error('expected_name_update');
    if (this.#nodes.has(expectedUpdate)) return expectedUpdate;
    if (this.size >= this.#capacity) throw new Error('name_graph_full');
    const record = decode(bytes);
    if (record.kind !== 'update') throw new Error('expected_name_update');
    if (record.genesis !== this.genesis) throw new Error('wrong_name_genesis');
    const parent = this.#nodes.get(record.parent);
    if (!parent) throw new Error('name_parent_missing');
    const rank = parent.record.keys.indexOf(record.signer);
    if (rank < 0) throw new Error('unauthorized_name_key');
    // A key can rotate/revoke itself and weaker keys, never remove, reorder or
    // replace the stronger prefix that can recover from its actions.
    if (parent.record.keys.slice(0, rank).some((key, i) => record.keys[i] !== key))
      throw new Error('cannot_change_stronger_name_keys');
    const key = await crypto.subtle.importKey('raw', unhex(record.signer), 'Ed25519', false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, unhex(record.signature), signingBytes(record)))
      throw new Error('invalid_name_signature');
    // Concurrent verifications can finish after another add took the last slot.
    if (this.#nodes.has(expectedUpdate)) return expectedUpdate;
    if (this.size >= this.#capacity) throw new Error('name_graph_full');
    this.#nodes.set(expectedUpdate, { record, depth: parent.depth + 1, rank, children: [] });
    parent.children.push(expectedUpdate);
    return expectedUpdate;
  }

  resolve(anchor = this.genesis): Resolution {
    if (!this.#nodes.has(anchor)) throw new Error('name_anchor_missing');
    let head = this.genesis;
    const chain = [head];
    while (true) {
      const node = this.#nodes.get(head)!;
      if (node.children.length === 0) return { kind: 'head', head,
        target: node.record.kind === 'update' ? node.record.target : null,
        depth: node.depth, chain,
        relation: head === anchor ? 'same' : chain.includes(anchor) ? 'forward' : 'recovery' };
      const rank = Math.min(...node.children.map(child => this.#nodes.get(child)!.rank));
      const candidates = node.children.filter(child => this.#nodes.get(child)!.rank === rank);
      if (candidates.length > 1) return { kind: 'conflict', at: head, chain, candidates: candidates.sort() };
      head = candidates[0]!;
      chain.push(head);
    }
  }

  ancestorAtDepth(update: string, depth: number): string {
    let node = this.#nodes.get(update);
    if (!node || !Number.isInteger(depth) || depth < 0 || depth > node.depth) throw new Error('invalid_name_ancestor');
    while (node.depth > depth) {
      update = (node.record as Update).parent;
      node = this.#nodes.get(update)!;
    }
    return update;
  }
}

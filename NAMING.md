# Names, signed continuations and recovery

28 October 2026. **Offline design experiment, not a stable wire protocol or a
deployed naming service.** The user-approved direction is genesis-based identity,
single-parent signed updates, selected heads and stronger-key recovery. The exact
encoding, stronger-prefix restriction and conflict behavior below are concrete
draft choices made to exercise that direction.

## Objects and identities

- **C:** the content blob's `sha256_length`. Source bytes remain untouched.
- **G:** the address of a genesis record containing a protocol version, a random
  128-bit nonce and an ordered list of Ed25519 public keys. Strongest is first.
  The nonce permits separate names with the same initial key configuration.
- **U:** the address of a complete signed update identifying G, one parent P, a
  target C, its signer, and the key list in force after U. The first parent is G.

The genesis is the trust anchor selected by the caller. It does not claim a human
identity or need a self-referential signature. The update signature covers a
domain-separated canonical **unsigned** payload. Hashing the final signed bytes
then identifies U; the signature does not sign its own enclosing hash.

A valid signature establishes an authorized assertion according to a parent. It
does not establish service acceptance, freshness, target availability, safe code,
or human ownership. The model never fetches or executes a target.

## Priority and key changes

At each parent, use that parent's ordered key list. Verify a child with the key
it names, and remember the signer's rank in the **parent's** list.

1. A key may change itself and weaker keys. The stronger prefix must remain
   identical in position and value. A working key cannot remove its recovery
   key, move itself above that key, or install a new key above it.
2. The child's new key list governs children of that child. A removed key cannot
   extend that branch. The strongest key can replace the entire list.
3. At a fork, the child signed by the strongest parent-authorized key takes
   precedence. A stronger sibling supersedes the entire weaker subtree, however
   long that subtree is. A strong signature further down the weaker subtree
   cannot repair the already superseded edge at the earlier fork.
4. Two different children at the same strongest rank are an explicit conflict.
   The offline resolver stops at their common parent and returns their addresses.
   It does not choose by arrival time, lexical hash, timestamp or longest branch.
5. Apply this rule from G onward. “Selected” always means selected from the
   verified records supplied to this graph. An unseen stronger update may exist.

Records on superseded branches remain retrievable by hash and their signatures
remain checkable historical assertions. They are ineligible for the selected
continuation under the stronger evidence. The model admits them as historical
records; admission is not acceptance as the current head.

| Situation | Result |
| --- | --- |
| Working key appends to the selected tip | Forward continuation. |
| Keeper signs a stronger child of an ancestor | Weaker sibling and descendants are superseded; report recovery. |
| Working key tries to remove the keeper | Reject the key transition. |
| Working key replaces itself below the keeper | New key may continue; old key cannot extend this updated branch. |
| Two children signed at the same priority | Conflict, even if one branch is longer. |
| A higher-priority child arrives above that conflict | It can select a different continuation. |

## Recovery changes the earlier fast-forward proposal

An ordinary selected-head advance can be a fast-forward. Stronger-key recovery
can select a sibling of an earlier update, so it can change the selected ancestry
and even shorten the selected line. An anchored reader must distinguish `same`,
`forward`, `recovery`, and `conflict`. Applications decide whether to follow a
recovery, ask the holder, or continue using pinned bytes; the resolver must not
silently call recovery a descendant of the old anchor. Nothing should autorun a
new target merely because its signature verifies.

An exact `(U, ancestor-depth)` still has one immutable meaning. In contrast,
“depth 17 of whatever branch the service currently selects” can change after
recovery and must not be advertised as an immutable historical reference.

**Proposed service design, not implemented here:** keep an append-only sequence
of acceptance receipts, separate from publisher chain depth. A receipt names the
selected update, the previous receipt and the reason (`advance` or `recovery`).
Then `(service, G, receipt-sequence)` can preserve what the service selected at
that moment, while later receipts record recovery. Hash-pinned receipts can
travel as evidence; service signatures and identity must be specified if readers
are to authenticate them away from the service. A service can still equivocate;
receipts do not create global consensus.

This revises the earlier suggestion that a service revision number could simply
equal publisher depth. Another possible design is a new view epoch at recovery.
Choose one before promising numeric revision URLs. A forgotten history must not
be recreated under the same revision labels with new meanings.

## Historical keys and the remaining finality question

Branch-local key rotation is not universal retirement of a historical key. A
removed key may still produce a signature referencing an ancestor where it was
authorized. A signature does not reveal whether it was created before or after
rotation. An old root can create an equal-priority historical fork; a historical
recovery key can also override an earlier weaker edge, bypassing key changes
further down that edge's subtree. The experiment intentionally exposes this.

There is no invented timestamp or implicit 72-hour rule here. Before public use,
decide how a service fixes earlier choices: accepted-branch tie policy, recovery
windows, explicit checkpoints/new trust anchors, or another clearly specified
finality rule. Each limits some forms of historical recovery. The simple rule
“stronger always wins at an ancestor” must not be sold as both unlimited recovery
and complete retirement of every old recovery key.

An old-key conflict test is kept as a regression: future implementations must
resolve this question deliberately rather than accidentally assuming it away.

## Reference vocabulary

| Reference | Meaning |
| --- | --- |
| C | Exact content, independent of a publisher. |
| U | Exact signed assertion and parent. |
| G | Naming identity and initial authority. |
| `(U, depth)` | Exact ancestor on that update's line. |
| `(service, G)` | Service-selected current head; needs freshness and recovery rules. |
| `(service, G, receipt)` | Proposed historical service selection, not chain depth. |
| `(service, petname)` | Alias in that service's namespace. |
| `(manifest-address, path)` | An entry in an immutable project snapshot. |

Composite references are a selector plus constraints. A selected update, expected
genesis and expected target must agree; failure is explicit. Labels and retrieval
hints are not secretly alternative authorities. A follow reference can retain U
as an anchor, but must distinguish a valid recovery from forward ancestry. A
target-content pin fixes bytes, not their continuing eligibility as a live name.

The immutable genesis cannot point to future updates. A bounded reverse index can
discover candidate records mentioning G. A selected-head query answers a different
question. A channel can announce updates and encourage re-resolution; its messages
are not proof of completeness, current selection or freshness.

## Implemented experiment

`src/names/model.ts` has no Node-specific imports, service binding or network
operation. It uses Web Crypto Ed25519 and SHA-256. Tests and the demo run in Node
24; browser Ed25519 support and browser integration have not been tested here.

```sh
npm run demo:names
node --test test/names.test.mjs
```

The demo creates a name for the existing fern, extends it with a working key,
recovers at a fork using the keeper, installs a replacement working key, and
rejects the retired key's attempt to extend the recovered branch. Keys are newly
generated for each run, held in memory and never exported to disk or printed.
Targets are hashes of actual local fern source variants, but are not uploaded.

API:

- `genesisBytes(keys, nonce)` encodes a genesis.
- `publicKeyHex(publicKey)` encodes an Ed25519 public key.
- `signUpdate(fields, privateKey)` signs an update, capturing fields before any
  asynchronous operation. Graph admission still checks authorization/signature.
- `recordAddress(bytes)` calculates its bounded exact-byte address.
- `NameGraph.open(bytes, expectedGenesis, capacity?)` verifies a pinned genesis.
- `graph.add(bytes, expectedUpdate)` checks exact bytes, schema, known parent,
  genesis binding, key transition and signature before retaining an update.
- `graph.resolve(anchor?)` returns an observed head with its relation to the
  anchor, or an explicit conflict. Unknown anchors require fetching proof first.
- `graph.ancestorAtDepth(U, depth)` follows retained parents from an exact update.

Records must be supplied parent-first. Unknown parents are rejected rather than
queued. Missing branches are not inferred absent. No history is fetched, no head
is persisted, and no service is emulated. The module is not wired into Run,
Publish, the blob Worker, channels or any production route.

### Draft encoding and bounds

`sprig-name-draft-1` uses compact JSON with fixed field order and one trailing LF.
Genesis order is `protocol, kind, nonce, keys`. Update order is `protocol, kind,
genesis, parent, target, signer, keys, signature`. Unknown/duplicate fields,
alternate field order, extra whitespace, BOM, CRLF and alternate string escapes
are rejected by exact re-encoding comparison. This is canonical metadata only;
it does not normalize ordinary source blobs.

Nonce: 16 bytes as 32 lowercase hex digits. Keys: raw 32-byte Ed25519 public keys
as lowercase hex, one to eight distinct keys. Signature: 64 bytes as lowercase
hex. The signing payload is UTF-8 `sprig-name-draft-1/update`, LF, canonical JSON
of the update with `signature` omitted, and LF. The address hashes the complete
signed record's bytes. References use the existing store grammar and 1 MiB hard
length ceiling; this does not imply that a target is present or admitted.

Limit each input record to 8 KiB and each graph to at most 256 retained nodes,
including genesis. Caller buffers are copied before awaiting. Capacity is checked
again at commit after asynchronous verification, so racing admissions cannot
overfill the graph. Re-adding an already admitted address is idempotent even when
full. Results expose new arrays rather than internal mutable graph state.

These bounds cover record processing and retained graph size, not total concurrent
caller tasks, crypto CPU, a hosted service's lifetime growth or arbitrary network
traffic. A public ingress still needs bounded concurrency and global admission.
The offline graph rejects all new nodes when full, including recovery records;
it has no eviction or recovery-reserved capacity. A public service must decide
how recovery remains admissible under exhausted ordinary quotas. This prototype
does not offer that availability guarantee.
Proof completeness, checkpoints, large histories, target loading and durable
storage are deliberately outside this experiment. This has tests, not a formal
proof or an independent cryptographic audit.

## References

- [Node Web Crypto](https://nodejs.org/api/webcrypto.html): standard Ed25519 API.
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html): Ed25519 specification.
- [IPNS](https://docs.ipfs.tech/concepts/ipns/): signed mutable pointers and the
  distinction between validity, discovery and freshness.
- [Git push](https://git-scm.com/docs/git-push): fast-forward ancestry. Priority
  recovery deliberately extends beyond that rule.
- [did:plc](https://github.com/did-method-plc/did-method-plc): recovery-key precedent;
  this draft does not implement did:plc or claim its compatibility/finality rules.

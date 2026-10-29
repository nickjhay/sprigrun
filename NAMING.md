# Names, signed continuations and recovery

28 October 2026. **Offline experiments, not a stable wire protocol or a deployed
naming service.** The agreed direction is genesis-based identity, single-parent
signed updates, stronger-key recovery, and service arrival order with a bounded
recovery window. The text encoding, stronger-prefix restriction and exact deadline
boundary below are concrete draft choices made to exercise that direction.

**October 29 hosted-service direction:** [SERVICES.md](SERVICES.md) records the
one-step bytes-to-store-and-name endpoint, one selected head plus admission
metadata, a service-configured recovery duration, and default no-expiry blob
retention. These are design decisions; the code below remains an offline model.

## Objects and identities

- **C:** the content blob's `sha256_length`. Source bytes remain untouched.
- **G:** the address of a genesis containing a protocol version, a random 128-bit
  nonce and ordered Ed25519 public keys, strongest first. The nonce permits
  separate names with the same initial keys.
- **U:** the address of a complete signed update naming G, one parent P, a target
  C, its signer, and the key list in force after U. The first parent is G.

Genesis is the caller's trust anchor. It does not claim a human identity or need
a self-referential signature. An update signs a domain-separated canonical
**unsigned** payload; hashing the complete signed bytes then identifies U.
A valid signature establishes authorization according to a parent. It does not
establish service acceptance, freshness, availability, safe code or ownership.
Neither experiment fetches or executes a target.

## Hashes, admission order and indexes

| Layer | Contract |
| --- | --- |
| Blob | Exact immutable UTF-8 bytes at `hash_length`. |
| Service admission | A hash associated with an immutable sequence and service timestamp. |
| Reference index | Candidates explicitly referencing a genesis. |
| Naming view | Apply a versioned policy to verified candidates in service order. |

The pool may contain annotations, forks and unauthorized claims as well as name
updates. Mentioning G grants no authority. Index explicit fields of recognized
types, with bounded work per blob. “All” means what this service has admitted and
indexed, not a complete view of the internet.

`NameReplay` models only the verified naming subset for one genesis. It does not
implement the general blob admission log or reference index. Supplied sequence
numbers may have gaps for other service admissions. Malformed records and unknown
parents fail without reserving an order or retaining state; retry after a parent
is a new admission. A future service must specify how this fits raw blob storage
if children can be stored before parents. An unverified early arrival must not
reserve naming priority, and an old blob stamp must not silently become a new
naming admission.

## Authorization and the unordered graph

`src/names/model.ts` checks exact hashes, syntax, ancestry and signatures. Each
parent's ordered keys authorize its children:

1. A key may change itself and weaker keys, preserving the exact stronger prefix.
   A working key cannot remove, replace or outrank its recovery key.
2. The child's new keys govern its children. A removed key cannot extend that
   branch; the strongest key may replace the entire list.
3. For the **unordered graph resolver**, a stronger child at a fork supersedes the
   weaker subtree, however long it is. A strong signature further down a losing
   subtree cannot repair the earlier weak edge.
4. Equal strongest-rank siblings are an explicit conflict. The graph does not
   choose by arrival, timestamp, lexical hash or longest branch.
5. Apply this from G onward. Selection is only from the records supplied; unseen
   stronger records might exist. This resolver has no time/finality policy.

Superseded records remain checkable historical assertions. Graph admission does
not mean service acceptance as the head. The graph is a useful interpretation
when no authoritative service order has been supplied.

## Ordered replay policy

`src/names/replay.ts` layers `sprig-name-arrival-draft-1` over the graph verifier.
It **does not call the unordered graph resolver** to choose its head. Starting
at genesis, process each unique verified candidate in service admission order:

1. A child of the current head advances it (`advance`).
2. Otherwise, its parent must be on the selected chain. A child of a losing or
   superseded branch is retained but cannot change the head (`off_branch`).
3. At an ancestor, compare the new signer's rank against the first selected child
   being displaced, using that ancestor's keys. Equal or weaker priority leaves
   the head unchanged (`not_stronger`). First eligible arrival wins ties.
4. A stronger sibling replaces that child and its subtree only when admitted no
   later than `firstDisplaced.acceptedAtMs + recoveryWindowMs` (`recovery`). A
   later candidate is retained but has no effect (`recovery_expired`). The exact
   boundary is inclusive. The code compares elapsed time to avoid overflowing a
   timestamp sum. A recent descendant never renews an older edge's window.
5. Recovery selects just this new record. Previously losing candidates never
   become selected automatically when ancestry changes.

Every verified candidate gets one history entry, including candidates that leave
the head unchanged. Duplicates check supplied bytes and return their first entry,
without consuming a position or refreshing a timestamp, even at capacity. That
entry describes the original admission; use `view()` for the present head.

A sequence is a positive canonical decimal string in the u64 range, compared with
`BigInt`. Unique admissions strictly increase it; gaps are allowed, wrap is
rejected. Service time is a nonnegative safe integer in milliseconds, nondecreasing
in sequence order. Both are supplied by the caller simulating the authoritative
service, never read from publisher fields or a replay machine's wall clock.

The recovery duration is required, positive, and fixed when opening the history.
The demo chooses 72 hours, inspired by PLC; this is not a production default or a
PLC implementation. Exported histories must identify policy version and duration.
Same records, order, timestamps and policy reproduce the same result. Independent
services may choose different heads from the same pool.

API:

- `NameReplay.open(bytes, G, { genesisAdmission, recoveryWindowMs, capacity? })`.
- `admit(bytes, U, { sequence, acceptedAtMs })` returns the admission decision.
- `history()` returns copies of all admissions in order.
- `view()` returns policy, duration, genesis, head, target, selected chain and last
  processed sequence/time. It says nothing about unobserved events.

One admission may be in flight. Concurrent calls fail with `name_replay_busy`
instead of entering an unbounded queue. Caller inputs are captured before awaits;
verification precedes the synchronous decision/history commit. Failed stamps and
verification change neither history nor retained graph state. A real service
still needs a global sequencer, atomic durable commits and a clock rollback policy.
It must assign stamps at admission after verification, not when an HTTP request
starts, and recheck eligibility against the head at that atomic commit point.
This is an in-memory model, not a database transaction or signed-receipt protocol.

## Historical selection and recovery limits

Recovery may change ancestry and shorten the selected branch. The unordered graph
reports `same`, `forward`, `recovery` or `conflict` relative to a pinned update.
The ordered replay records the admission decision. A client following a name
must distinguish recovery from an ordinary descendant and choose how to respond;
a verified new target must not silently autorun.

`(U, ancestor-depth)` has an immutable meaning. “Depth 17 on whatever branch the
service selects now” can change after recovery. Each replay entry instead stores
its sequence, time, record, decision and **head after that event**. Later recovery
never rewrites that entry. `(service, G, sequence)` can therefore identify a past
selection independently of chain depth. The service sequence is not a consecutive
per-name revision count. Historical lookup endpoints are not implemented.

A future service must durably retain the acceptance history, define restart and
expiry, and decide whether to hash-chain and sign readable receipts. Hash-pinned
signed receipts could travel as evidence, but would not prove completeness,
freshness or consensus. Forgotten history must not be recreated under the same
revision labels with different meanings. Operational admission history and quota
state cannot be recovered from an unordered blob pool alone.

Branch-local rotation is not universal retirement of an old key. That key can
still sign against an ancestor where it was authorized; the signature does not
reveal when it was made. The unordered graph exposes this as conflict/recovery.
The ordered policy settles equal-priority ties and bounds stronger historical
overrides. A removed root cannot replace its own equal-rank rotation at the same
fork, but may override an earlier weak edge while that edge's window remains open.
Key retirement therefore depends on the selected ancestry, not just the tip.

Once a window closes, that earlier choice is settled under this service policy,
even if a compromise is discovered later. Authorized normal extensions remain
possible. This is a deliberate recovery/finality tradeoff. Service timing, order,
availability and durable history remain assumptions; it is not unlimited account
recovery or universal revocation of historical signatures.

## Reference vocabulary

| Reference | Meaning |
| --- | --- |
| C | Exact content, independent of a publisher. |
| U | Exact signed assertion and parent. |
| G | Naming identity and initial authority. |
| `(U, depth)` | Exact ancestor on that update's line. |
| `(service, G)` | Current service-selected head; requires freshness/recovery policy. |
| `(service, G, sequence)` | Historical service selection; modeled offline only. |
| `(service, petname)` | Alias in that service's namespace. |
| `(manifest-address, path)` | Entry in an immutable project snapshot. |

Composite references are a selector plus constraints. Expected genesis, update
and target must agree; mismatch fails explicitly. Labels/retrieval hints do not
become alternative authorities. A content pin fixes bytes, not current eligibility
as a live name. Genesis cannot point to future updates: a reverse index discovers
candidates, while a selected-head query answers a different question. A channel
can announce updates but cannot prove completeness or freshness.

## Text encoding and signing

`sprig-name-draft-2` is a small Git-like header format: one ASCII field name, one
space, one unquoted token, one LF. Every line, including the final one, ends with
LF. Repeated `key` lines encode priority. For illustration, with shortened values
that would not pass validation:

```text
protocol sprig-name-draft-2
kind update
genesis <hash_length>
parent <hash_length>
target <hash_length>
signer <public-key-hex>
key <keeper-public-key-hex>
key <working-public-key-hex>
signature <signature-hex>
```

Genesis order is `protocol, kind, nonce, key...`. Update order is shown above.
This is not YAML: no tags, aliases, nesting, comments, multiline values or implicit
typing. All currently required values are simple tokens. Unknown/repeated singleton
fields, duplicate keys, alternate field order, extra whitespace, blank lines, BOM
and CRLF are rejected by validation and exact re-encoding. No parser dependency.
Draft-1 JSON is no longer accepted; this pre-release change changes record hashes.
It does not normalize ordinary source blobs.

Nonce: 16 bytes as lowercase hex. Keys: raw 32-byte Ed25519 keys as lowercase hex,
one to eight distinct keys. Signature: 64 bytes as lowercase hex. Signing bytes
are UTF-8 `sprig-name-draft-2/update`, LF, then the exact canonical update header
with the final `signature` line omitted. The complete signed bytes define U.
References use the existing store grammar and 1 MiB hard length ceiling; a target
reference does not imply that its bytes are present or admitted.

## Running the experiments

```sh
npm run demo:names
npm run demo:replay
node --test test/names.test.mjs test/name-replay.test.mjs
```

Both demos use fresh transient keys and real signatures, without network, file
writes or workerd. They need Node 24. The graph demo grows a fern's history,
recovers using the keeper, changes the working key, then rejects the retired key.
Targets hash actual fern source variants but are not uploaded.

The replay demo prints an actual text genesis and four histories: A first, B
first, recovery at the deadline, and recovery one millisecond too late. It replays
each recorded history and asserts identical results. Its clock is simulated.

The graph API is `genesisBytes`, `publicKeyHex`, `signUpdate`, `recordAddress`,
`NameGraph.open`, `graph.add`, `graph.get`, `graph.resolve` and
`graph.ancestorAtDepth`. `get` returns copies of verified record, depth and signer
rank. Unknown parents fail; no orphan queue or automatic history fetching exists.
Both modules use Web Crypto with no Node-specific imports. Browser Ed25519 and
browser integration remain untested. Neither module is wired into Run, Publish,
the blob Worker, channels or a production route.

## Resource bounds and remaining service work

Each input is at most 8 KiB; each graph/replay retains at most 256 records including
genesis. Losing verified candidates consume capacity. Caller buffers are copied
before awaiting. The graph rechecks capacity after verification to prevent racing
admissions overfilling it; replay additionally allows only one in-flight admission.
Outputs are copies. These bounds do not meter global requests, crypto CPU or a
hosted service's lifetime growth; public admission needs those limits too.

When full, both experiments reject new recovery records as well as ordinary
records. There is no eviction or reserved recovery capacity. A hosted service
must decide how recovery remains admissible under exhausted quotas. This
prototype does not promise recovery availability, permanent history, complete
proof discovery or checkpointing. The experiments are tested, not formally proved
or independently cryptographically audited.

## References

- [Node Web Crypto](https://nodejs.org/api/webcrypto.html): Ed25519 API.
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html): Ed25519 specification.
- [IPNS](https://docs.ipfs.tech/concepts/ipns/): mutable pointers and freshness.
- [Git push](https://git-scm.com/docs/git-push): fast-forward ancestry; recovery
  intentionally permits replacing an earlier selected branch.
- [did:plc specification](https://web.plc.directory/spec/v0.1/did-plc): ordered
  recovery keys and a 72-hour window. This draft has different encoding, crypto,
  key-change rules and admission semantics; it is not a PLC implementation.

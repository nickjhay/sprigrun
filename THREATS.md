# Service threat model and safety invariants

29 October 2026. Scope: the source store proposed for first deployment, with
separate notes for channels and the unhosted naming experiment. This is a review
map and set of obligations, not an independent audit or a proof of safety.
See [store operations](store/OPERATIONS.md) for the deployment rehearsal.

## What we are protecting

1. **Recoverable data:** exact accepted source bytes, their interpretation and
   suppression metadata, and the control state that makes retries safe.
2. **Historical facts:** original service admission order/time, policy versions
   and naming decisions once we offer them. Those facts cannot be recovered by
   hashing the source again.
3. **Bounded resource use:** retained bytes, object/receipt/ticket counts, memory,
   computation, billable operations and operator time.
4. **Availability:** honest clients should not face avoidable cheap starvation;
   operator controls must remain usable, or have an independent emergency path.
5. **Authority:** anonymous uploaders cannot block others' data, overwrite bytes,
   change policy or acquire a naming/channel authority they were not given.
6. **Client safety and confidentiality:** source is inert text at the store;
   credentials and private drafts are not accidentally published or logged.

These are distinct. A matching hash detects substitution; it neither recovers
missing data nor proves publisher identity, current naming head, admission time,
permission to execute, or that source is harmless. No expiry date is an intended
retention policy, not an independent backup or a perpetual availability promise.

## Adversaries, accidents and trusted components

Assume an anonymous client can send arbitrary routes, headers, bytes and streams,
use many IP addresses, solve work, abandon tickets, race requests and retry after
disconnects. A publisher may possess a compromised working key; clients may
receive stale or malicious responses. Include operator mistakes, bad releases,
incorrect credentials/bindings, clock changes, lost acknowledgements, partial
storage failures and account compromise, not just hostile network requests.

We trust the deployed Worker and its bindings, runtime/Web Crypto, Cloudflare's
storage guarantees, deployment account, and admin credential. A hostile holder of
deployment or bucket-write authority can bypass application checks. An admin
token can refuse reads through `block` and delete private payloads through `reclaim`; its authority is
stronger than pause-only operations. None of our public cryptography prevents
deletion by those authorities. Credentials for a recovery copy should therefore
not be available to the ordinary serving Worker or its deploy credential where
the hosting arrangement permits that separation.

The browser, CLI and server verify independently where practical. Public CORS
is intentional; it is not an access-control mechanism. Content addresses are not
secrets, including for low-entropy/predictable source. A secret accidentally
published in source needs rotation; a block cannot recall downloaded copies.

## Small review boundary

Keep these existing modules visible rather than hiding their order in a generic
framework. The stateful coordinator is the most consequential part: a helper
can be pure and correct while a reordered await still breaks the protocol.

| Invariant | Owner | Evidence and limits |
| --- | --- | --- |
| **B1: exact bounded bytes.** Accept only canonical `hash_length`; count actual bytes, check digest and configured encoding, never normalize or execute source. | `store/src/bytes.ts`, `proof.ts`, `config.ts`; `coordinator.publish` | Unit tests cover malformed UTF-8, BOM/NUL/CRLF, reused buffers, oversized/stalled streams. Integration tests cover wrong digest/length and corrupt stored bodies. Headers are not evidence of actual size. |
| **B2: successful reads are verified.** GET, HEAD and 304 must first establish present, allowed bytes with the requested digest/length. | `store/src/index.ts:getBlob`, `bytes.ts:verifiedBody` | Corruption, false format labels, missing objects and blocks cannot become conditional successes. One DO metadata lookup and one R2 GET; no shared source cache. A provider/Worker compromise can deny service; a verifying client still rejects substituted bytes. |
| **A0: ticket-free admission requires work off.** An exact global attempt debit is durable before reading a bounded body; publication rechecks live work policy and pause. | `coordinator.admitOpenUpload/publish`, HTTP `POST /b` | Tests cover both work parameters, pause/attempt rejection before body pulls, policy changes during streaming, invalid bodies, concurrency and blocks. This path creates no tickets. Internal `publish` remains a trusted capability. |
| **A1: one ticket authorizes at most one body attempt.** Scope and target come from bounded server state; deletion is durable before body admission. | `coordinator.challenge/redeem`, HTTP routing, `proof.ts`, `shared/work.ts` | Concurrent solutions, expiry, wrong address, bad body, failed upload and restart tests. An invalid proof consumes attempt credit but does not consume the ticket. A valid proof remains spent on later failure. |
| **Q1: one new address reserves once.** Both buckets and its pending receipt commit together before any R2 publication. | `shared/bucket.ts`, `coordinator.publish` | Integer refill/property tests, concurrent quota tests, before/after-write faults and restart tests. Empty/tiny objects pay the minimum debit. Pending retries reuse the reservation; ambiguous writes are not automatically refunded. |
| **P1: publication cannot overwrite existing content or a block.** Reserve durably, conditionally create, verify an existing object, then confirm. | `coordinator.publish`, `exclusive` | Duplicate/concurrent uploads, corruption and held-R2 tests. Private bytes remain invisible until SQL publication. Lost replies still permit ambiguous completion, repaired without another debit. |
| **S1: suppression wins against concurrent publication.** Commit permanent refusal and flush it without waiting for R2. | `coordinator.block`, shared mutation lock, admin authentication | Block/read/publication races, held preparations, snapshot pins and restart tests. New reads consult SQL first; prior admitted responses and browser copies can remain. Physical reclamation is separate. |
| **R1: bounded individual work and retained state.** Enforce body size/deadline, ticket cap/expiry, exact global mutation budgets, fixed queue bound and client solve/read limits. | `config.ts`, `bytes.ts`, `coordinator`, browser client | Fault/stream/table-cap tests. These are not a hard bill cap, a bound on every platform buffer, or a fairness guarantee. See amplification risks below. |
| **H1: history does not change on retry, recovery or restart.** Original admission stamps and policy remain authoritative; current head is derived from them. | Future hosted naming coordinator; current `src/names/replay.ts` is an in-memory model only | Replay tests cover ties, first displaced timestamp, duplicates, exact u64 sequences and key changes. No persistent hosted naming journal or naming recovery implementation exists yet. |

The HTTP adapter, configuration, secret handling and deployment bindings remain
in the trusted boundary. Moving a function into `shared/` does not reduce its
authority. The test entrypoint (`store/test/worker.ts`) is deliberately outside
the production bundle: it exposes faults and state probes and must never deploy.

### Review the transitions, including failure

For publication, review every await in this order:

`verify bytes → reserve + pending fact → flush → private conditional R2 write / verification → SQL publication → flush → success`

For a proof: `verify stored offer → recheck expiry → delete ticket → flush → admit body`.
For a block: `commit refusal fact → flush → success` (no R2 operation).
For a barrier: `capture maintained totals/policy + seal E + advance E+1 → flush → ACK`.

Receipts retain at most one reservation, publication and permanent block fact,
each with its own immutable epoch and time. Blocking overrides visibility. A late
R2 write can leave private bytes but cannot publish over a block. Unpublished bytes
return 404. All public GET/HEAD/304 requests consult metadata before R2; failure
of either authority fails closed. An admitted read may finish after a later block.

The 32-operation live commit queue contains no R2 awaits. A separate preparation
pool holds at most eight operations, including same-address waiters. Holding R2
cannot stall block/pause/barrier behind a live write lock. Flooding short metadata
requests can still exhaust that queue; the route-level emergency stop remains
independent. Isolated restore can serialize R2 because it is not a live service.

For a sealed cut, project facts whose epoch is at most E. A later block pins its
older published body until snapshot finish, abort or 24-hour expiry. Explicit
reclaim checks the pin and permanent block before deleting outside the queue;
future cuts cannot newly need that blocked payload. A late prepare may require
another reclaim. There is no automatic GC. Export validates/fsyncs records before
finish; its complete trailer requires a durable server ACK. Lost completion replies
can be retried across restart, before another cut retires that completion receipt.

## Data and history loss

`reserved_at_ms`, `submitted_at_ms` and `blocked_at_ms` record separate service
commits in SQLite. Publication time is assigned only after verified private bytes
are prepared; retries and restoration preserve the original facts. R2 stores
intrinsic digest/encoding metadata, not publication time or epoch. The barrier can
run during a PUT, so an upload-start epoch must never stand for publication.
These are trusted host timestamps, not cryptographic attestations, monotonic time
or a total order. Epochs identify cuts, not order within a cut. Schema 3/archive v2
replace earlier undeployed local data without a compatibility path.

**Remaining gap:** naming acceptance/order is still an in-memory experiment.
Each service owns its own admission facts; object upload can precede acceptance.

Before hosting names, persist at least: service identity/epoch, record address,
original admission sequence and time, applicable policy, and the state needed
to recover the selected head. Assign the exact u64 sequence server-side in the
same atomic acceptance commit as the decision; use decimal strings across JS
boundaries. The order is that commit order, not packet arrival or upload start.
Define the scope (one service or per-name); do not imply a universal order.
Keep first blob storage and naming acceptance as different events. A duplicate
must retain its first admission; a valid losing candidate and an invalid request
must not be confused. The experiment records valid losing candidates too.

Time is service evidence, not a field the publisher chooses. Preserve the policy
used at admission. Nondecreasing time alone does not protect against a large
forward clock jump expiring recovery windows: clock anomaly handling is still a
hosted-service design task. Quota refill also uses the service clock: a forward
jump can refill credit up to its cap; a backward jump cannot mint credit. Claims
about refill over real elapsed time assume a trustworthy clock. Missing ancestors or admission facts must yield
incomplete/unavailable, not a plausible newly invented ordering. Historical facts
absent from the old schema cannot be backfilled truthfully. Quota counters remain
authoritative: live R2 objects alone omit pending reservations and suppressed bytes.

Recovery must include the control plane as well as R2 objects:

- Receipt facts, quota debits, policy and epoch identity must agree with the
  restored objects. Live balances are reset to zero, not restored. Recreating a namespace silently
  creates new authority state even if the old bucket still exists.
- Restoring a snapshot can resurrect spent tickets, restore stale quota credit,
  forget newer blocks and reuse sequence numbers. Clearing tickets addresses only
  the first of these. Preserve/reconcile the other facts before reopening writes.
- A restore must not resurrect suppressed data from an older copy. The recovery
  set needs a trustworthy suppression history newer than the restored snapshot.
- Record the recovery point and verify original metadata against a known manifest.
  A second copy of the bytes alone does not preserve order/time, and a manifest
  hash stored only beside that manifest does not defend against account compromise.
- Keep a copy outside the deletion authority being protected against. Define how
  much acknowledged data can be lost (RPO) and how long recovery may take (RTO).
  Periodic exports cannot honestly promise zero loss between exports. The bounded
  [export/restore tool](store/RECOVERY.md) and local loss drill now cover a consistent
  snapshot into fresh isolated storage. Cloud RPO/RTO and reconciliation of a newer
  suffix remain unmeasured/unimplemented.

Cloudflare SQLite DOs offer 30-day point-in-time recovery; it restores the whole
database and cannot be exercised by local Miniflare PITR. R2 durability protects
against hardware loss, not accidental/authorized deletion. These facilities do
not automatically provide a coordinated application recovery. [1][2]

Do not indiscriminately lock the live R2 bucket: retention locks can prevent
physical reclamation even though SQL blocking still refuses public reads. Consider
retention protection for an independently controlled recovery copy; decide how
suppression applies there too. It must not become another public serving path. [3]

## Cost and availability attacks

| Attack or accident | Existing bound | Remaining decision / response |
| --- | --- | --- |
| Many tiny valid uploads | 8 KiB minimum debit; both growth buckets | Receipt facts accumulate permanently. Measure SQL allocation, not just source bytes; plan capacity before saturation. |
| Abandoned challenge requests | Global issuance bucket, TTL and bounded table | Work is paid after issuance. A client can consume the public allowance without solving anything. This bounds storage but permits cheap starvation. Per-IP limits are approximate; many identities defeat fairness assumptions. |
| Invalid proofs / many valid uploads | Global attempt credit before proof hash; single-use body admission; bounded bodies | Attackers can consume shared allowance. Increasing PoW does not stop malformed-request or challenge-issuance floods. Honest availability is best effort. |
| Repeated GET/HEAD/conditional GET or nonexistent-address lookups | Canonical bounded paths, capped verified bodies | Each canonical lookup reaches metadata; allowed reads also reach R2. Byte quotas do not cover read costs. HEAD/304 still verify the body. A per-IP read limiter can reduce downstream work but is not a global dollar cap. |
| Stats, OPTIONS and rejected traffic | Stats cached briefly; cheap header/route rejection | Requests reaching the Worker still cost invocation work. Many PoPs can miss their separate stats caches. Do not add a global SQL write per read merely for accounting. |
| Slow client / storage operation | Body deadline; separate eight-operation preparation pool and 32-operation commit queue | Stalled R2 can fill preparation slots but does not hold block/barrier commits. Reads depend on SQL and R2. Disabling routes remains the broader stop. |
| Failed writes, retries and blocks | Permanent reservations, request budgets | Reservations bound new logical admission, not every physical PUT. Reconciliation and admin operations need cost headroom. |
| Oversized remote responses or excessive client solving | Client bounds/timeouts; no redirects or automatic retry storms | A remote host can still deny service. A valid hash does not imply safe execution; VM and source-graph bounds remain separate. |

Measure billable operations and CPU from the hosted environment and feed them to
`store/pricing.py`. Local elapsed time is not billable CPU. CPU caps, PoW, alerts
and a growth quota are different controls; none is by itself a total spending
ceiling. We have not chosen an automatic global spending stop. [4]

## Other important failure classes

- **Supply chain / deployment authority:** a compromised dependency, CI workflow,
  deploy token or admin device can bypass every application invariant. Keep
  credentials scoped, use account MFA, pinned dependencies/actions, explicit
  deployments and review changes to entrypoints/bindings. No production secrets
  belong in the workbench, fixtures, diagnostic output or a PR.
- **Authority confusion:** future naming writes must not expose an internal
  `publish` bypass around proof, size, quota or suppression. A channel append key,
  naming signing key and store administrator are different authorities.
- **Rollback / equivocation:** valid signed naming records do not prove that a
  resolver returned the latest head or told every reader the same history.
  Authenticated receipts/checkpoints and independent witnesses are future work;
  do not claim that blob hashes solve this problem.
- **State exhaustion denying recovery:** the naming experiment's 256-record cap
  also rejects recovery. A compromised working key must not consume the last
  admission slot needed by its stronger recovery key in a hosted implementation.
- **Intentional expiry versus loss:** channel expiry and retention gaps are part
  of its contract; archives are separate blobs. Channel message text is public,
  posting secrets are bearer credentials visible to the trusted host, and epochs
  prevent a reused channel address from silently being the same incarnation.
- **Stored content / unsafe clients:** arbitrary UTF-8 can encode anything. Serve
  it as inert text; render it without HTML interpretation and execute only under
  VM limits. Public hosting also needs a working report/block process.

## Evidence and release boundaries

Run `npm run check` from the repository root. The store suite exercises the
production entrypoint plus separate fault-injection fixtures. The new two-phase
rehearsal runs against the production entrypoint, persists local R2/SQLite, fully
restarts the runtime and checks bytes, blocks, reservations, overrides, pause and
ticket state. It tests persistence, **not** backup restoration, cloud PITR,
disaster recovery, billing, the Cloudflare edge limiter or adversarial load.

The separate recovery drill now deletes both local source databases, restores
the archive into fresh resources, verifies original timestamps, accounting and
suppression, and runs the recovered fern and its imported library. Failure tests
cover interrupted writes, invalid archives, held R2 across the barrier, later blocks,
pin expiry and lost finish replies. See [the recovery runbook](store/RECOVERY.md)
for this additional trusted boundary. The archive checksum needs an independently trusted
copy; no checksum can infer unknown post-snapshot blocks or admission history.

Before opening the experimental store: complete the isolated cloud rehearsal,
verify private R2/routing/admin controls, measure basic operation costs, and make
the limits of snapshot recovery clear. Before relying on it as the only copy:
retain independently controlled backups, rehearse cloud recovery with a chosen
RPO/RTO, and preserve/reconcile newer suppression and admission history. Before hosting names: add durable admission facts and protected
recovery capacity. These are separate gates, not a reason to deploy all features
at once.

When changing core code, identify the affected invariant and transaction/await
boundary, show the failure behavior and regression evidence, and check that
restarts/duplicates do not create a reverse transition. Preserve the source/API
version and recovery semantics explicitly when a schema changes.

References checked 29 October 2026:

1. [SQLite DO storage and PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
2. [R2 durability](https://developers.cloudflare.com/r2/reference/durability/)
3. [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
4. [Worker pricing and per-invocation CPU limits](https://developers.cloudflare.com/workers/platform/pricing/)

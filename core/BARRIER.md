# A durable barrier across local shards

Slice D1: the barrier and fixed-budget foundation, tested against two real local
SQLite-backed Durable Objects and R2. Public routing remains single-shard.
Cross-owner references, the cluster backup bundle and coordinated cluster restore
are D2, before exposing a sharded service. No production deployment or scheduler
is installed. Test adapters are privileged and must never be deployed.

```sh
npm run demo:barrier    # Stop all three objects after a lost cut reply; resume.
npm run test:barrier    # Includes missing databases and every barrier stage.
```

The demo creates disposable storage and plants one source on `fern` and one on
`moss`. It loses a cut acknowledgement, stops the controller and both participants,
reopens the same storage, completes the same barrier, verifies each closed archive
and reads both original sources. It then removes only its temporary directory.
Node 24 and a supported workerd platform are required. This is a restart drill,
not whole-cluster disaster recovery or a production latency measurement.

## Fixed configuration and identity

`CORE_TOPOLOGY` is a strict `sprig-topology/1` record containing a random cluster
ID, u64 revision, canonical origin, 1–16 named members and the global admission
policy. Names are ASCII identifiers, bounded to 32 characters. The member's
`ctx.id.name` must be in the roster; unnamed/misnamed access fails. A normal
single-shard instance has no topology and retains the existing policy path.

A participant retains its full topology and name in control state and every cut.
Changing that binding on restart fails before schema mutation. Configuration
changes and migration require a later explicit protocol; editing environment
settings is not a migration. `CORE_POLICY` cannot override a partition's budget.

For growth, burst and attempt buckets, capacity and refill are divided by the
member count. Sorted member names receive the integer remainders one at a time.
The sums equal the global values exactly. Sizes and refill periods are unchanged;
a split that cannot accommodate one maximum-sized operation rejects. There is no
quota stealing or continuously rebalanced pool.

`NativeBarrier.initialize()` is an explicit privileged operation. It registers
the journal identities of pristine participants only. A new controller cannot
bootstrap over participants with accepted history, preparations or barrier facts.
Each participant checks its immutable registration once per object lifetime
before accepting a POST. Every barrier RPC also checks the registered journal ID.
A missing participant database therefore cannot become a fresh writer with new
credits; a missing controller requires recovery rather than inferred bootstrap.
This is fixed placement, not the later dynamic single-writer migration fence.

Cloudflare exposes the name used by `getByName()` as `ctx.id.name`; missing names
are deliberately refused here. See the [ID API](https://developers.cloudflare.com/durable-objects/api/id/).

## Hold, cut, publish, release

A caller chooses a 32-hex barrier ID before starting it and retries that same ID
if acknowledgement is lost. The controller has one active round, fixed roster,
closed epoch, bounded per-member cursor and a map of acknowledged cuts. Completed
rounds remain available. Calls drive one bounded step at a time; there is no timer,
unbounded in-memory queue or implicit abort that reopens held participants.

| Phase | Durable action | Condition for advancing |
| --- | --- | --- |
| Hold | Each member journals a hold distinct from manual pause | Every member acknowledges that hold |
| Cut | Each held member closes N and advances to N+1 in one short transaction | Every exact cut header is retained by the controller |
| Publish | Validate the complete roster, topology and journal identities; persist the release phase with all cuts | Durability completes before the manifest is returned |
| Release | Each member fetches that published manifest from the trusted controller, checks its own cut, then journals release and manifest digest | Every member acknowledges release; only then may the next round start |

A cut's existence at the expected epoch makes repeated cut requests idempotent.
A release cannot use a caller-supplied partial manifest. The controller's
`published()` method refuses pre-publication rounds and waits for durability.
Each participant compares its cut to the manifest after the asynchronous fetch
and before its short release transaction. Lost replies can repeat the same step;
obsolete/conflicting IDs and wrong epochs cannot reopen or recut a member.

Members can receive release at different times. A released member may accept in
N+1 while another remains held, because the complete N manifest is already
committed. Public identifiers and signed bytes do not contain the physical shard
name or acquire a global submission order.

## What the hold covers

The durable hold stops source reservation, result acceptance, attempt-credit
updates, pause/unpause and moderation changes. Each mutation checks the hold in
its transaction. An already-running synchronous commit finishes before the hold
can be recorded. Reads and closed-prefix exports do not create durable state and
continue. Operator pause is independent: release never changes it.

Already authorized R2 writes can finish privately while held. The barrier waits
for neither network bodies nor R2. If publication encounters the hold, it returns
`barrier_held` (HTTP 503 with retry guidance); the caller retries the same action
after release. A paid source reservation survives. There is no unbounded waiting
queue, and nothing acknowledges publication before its result commits.

Each member adds two small barrier journal records and its existing cut record
per round. There are no barrier R2 operations. The controller makes three member
calls per participant; each release also reads the published manifest once.
Registry lookup adds one internal RPC per participant instance that accepts
writes, not one per POST. Repeated operator calls still cost requests. This does
not estimate multi-shard hosting prices or promise a particular outage duration.

## Recovery and format boundary

Database/archive schema 5 retains partition binding and barrier transitions.
The ordinary full/delta verifier checks legal hold/release transitions, rejects
mutations inside a held prefix, binds each cut to the held epoch, and preserves
the closed position. Later releases or rounds cannot change an older archive.
An imported shard must match its configured partition and stays quarantined.

A standalone `restoreRelease` refuses partitioned state with
`cluster_recovery_required`. There is no safe whole-cluster release yet: D2 must
verify a manifest-bound archive set, cross-owner dependencies and final suffixes,
then recover controller/participant state together. A valid barrier manifest is
a cut boundary, not proof that all bodies have been copied to independent storage.
Do not use this laboratory as a deployed cluster or hand-edit away quarantine.

Old schema/archive versions are refused before mutation, never reset. Preserve
old directories/files; PR #22's reader is commit
`380a178a419c05635a42e79e5e23c9e04b4ea5a5`. For a fresh ordinary local core:

```sh
npm run dev:core -- --state .local/native-http-v5 --operator
```

Public signed formats remain v1 and backup witnesses remain v2. The production
HTTP worker refuses `CORE_TOPOLOGY` rather than accidentally routing all requests
to one member. There are no public barrier RPC routes. The local harness addresses
participants explicitly; it does not claim to enforce logical ownership between
them or resolve a remote key, publication or chat subject.

## Evidence and the next part

Tests cover every lost member reply, restart at hold/cut/publish/release, manual
pause preservation, duplicate and obsolete calls, incomplete manifests, changed
configuration and journal identity, removal of actual controller/participant
SQLite files, a stalled paid R2 upload, immutable closed exports, full + delta
verification and refusal of standalone partition recovery release.

D2 needs trusted cross-owner facts and policy catch-up, routing that binds an
owner to exactly one registered participant, bounded raw-source intake before
routing, and a whole-cluster backup/restore bundle. A cross-shard reference must
never survive a global cut without the acceptance it depends on. Keep those
checks in the same runnable slice before enabling sharded public HTTP.

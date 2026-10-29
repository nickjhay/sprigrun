# Pause commits, seal an epoch, keep copying

29 October 2026. Revised after Nick's clarification: the desired pause covers
**commits**, including blocks, and lasts only until the epoch barrier is durable.
Copying proceeds independently. There is no deployed state or archive format to
preserve; replace the earlier design where doing so simplifies the service.

This document and `experiments/checkpoint.ts` specify the proposed replacement.
The Worker still uses the existing whole-export maintenance freeze described in
[RECOVERY.md](RECOVERY.md). `npm run demo:checkpoint` runs the revised offline
model with Node 24. It now allows blocks after the barrier without aborting the
snapshot. It has no R2, disk durability, real transaction scheduler, or cloud
latency measurement. Serialization tests model restart from committed state.

## Make the commit a short metadata transaction

Today an R2 PUT also makes bytes publicly readable, and the coordinator holds its
writer queue over that network operation. Just incrementing an epoch inside this
architecture either waits for R2 or permits visibility outside the metadata cut.
For a barrier independent of upload latency, separate private preparation from
public commitment:

1. Admit the attempt, receive and verify bounded bytes. Reserve growth credit in
   durable metadata before permitting paid R2 work.
2. Prepare the immutable payload in private R2, outside the commit queue. A
   prepared object is not yet publicly readable.
3. In a short SQL transaction, recheck the block/admission state and publish the
   reference. Assign the **current** epoch and first-publication timestamp there.
   A retry preserves the original publication facts. Flush durably before ACK.

The barrier is another short SQL transaction: capture bounded control/configuration
facts, seal E, and advance the allocation epoch to E+1. No R2 operation, full-table
scan, per-object relabelling or generation broadcast belongs inside it. Its durable
ACK completes the pause. All later publication and block commits use E+1, even
when their requests or R2 preparations started earlier.

The same coordinator assigns every commit's epoch; upload Workers do not cache
or choose it. A synchronous SQL transaction cannot be interleaved halfway through
by another commit. R2 awaits must be outside that critical section. Existing
proof verification, duplicate verification and export reads also must not leave
network awaits on a queue through which the barrier must pass.

An already committed operation stays before the cut. An operation with preparation
in flight can finish after it. A physical R2 write already issued cannot be
magically postponed, but it has no authority to publish itself. This distinction
makes the proposed pause precise rather than requiring distributed rollback.

The healthy target is well below a second, not a pause proportional to the store
or outstanding uploads. This is an engineering target, not a measured Cloudflare
latency or SLA. Database replication, overload and failure can still delay the
barrier; fail/retry rather than pretend a timed-out commit never happened. Measure
wall-clock barrier latency and queued-commit delay with actual cloud fault tests.

This is a source-store boundary, not a pause of every Sprig service. With today's
single metadata coordinator, no distributed atomic increment is needed. Future
shards or a naming checkpoint spanning services would require coordinated cuts
and dependency closure; do not introduce that machinery before it is needed.

## Keep one-way facts instead of a general undo log

Current blob semantics have at most one reservation, one publication, and one
permanent block per address. Preserve those facts rather than overwriting one
status field:

| Fact | Immutable fields |
| --- | --- |
| Reservation | Epoch, reserved-at time, bytes, growth debit. |
| Publication | Epoch, submitted-at time; refers to verified immutable payload. |
| Block | Epoch, blocked-at time. May exist without a reservation/publication. |

For snapshot E, consider only facts whose epoch is at most E. An included
publication with no included block has a source body. A reservation alone is an
intent with no promised body. A block means refusal and excludes source from
that cut. Live reads consider all committed facts, with blocking taking precedence.
No per-snapshot shadow table, per-blob version chain, or global per-upload sequence
is needed for these one-way transitions. The model's `seal` does no row scan or
clone; its other table operations use arrays for clarity, not production efficiency.

This simplification depends on permanent blocks and immutable publication facts.
Unblock, rehydration, deletion of facts, mutable user metadata, or new overwrite
semantics would need their own history rules. Naming order remains a separate
service concern; an epoch does not establish the order of events within it.

## Pending preparation is not partial publication

A reservation already committed before the barrier remains an accounting fact at
E. Its later publication belongs wholly to E+1. It can have private bytes before
or after the cut without changing the snapshot: that pending record has no body.
We cannot erase the earlier reservation from the image while claiming to preserve
already incurred quota/debit facts. Instead, make the two atomic commitments
explicit: reserve resources, then publish a blob. This is the small write-ahead
intent mechanism we already need to bound paid storage work.

Keep reservation time separate from submission time, which is assigned at the
first publication commit in the new design. Both survive retries and recovery.
Restoring a pending reservation permits exact-source resubmission without a second
growth debit; it does not invent a successful earlier publication. Conservative
fresh quota credit and invalidation of old proof tickets still apply on restore.

R2 metadata can carry intrinsic digest/validation information. Do not stamp an
upload-start epoch into R2 and treat it as the publication epoch: the barrier can
occur during the PUT. The SQL facts are the authority for commitment; the archive
joins them to payloads. Consequently, backing up R2 alone cannot recover all the
submission/block facts. Preserve the metadata store too.

## Blocks commit quickly; physical reclamation is separate

Blocks pass through the same short metadata boundary. A block after E hides the
blob from live requests while snapshot E still sees its earlier publication.
Preserve the private immutable payload while that active snapshot needs it.
Blocking does not wait for copying, and no longer invalidates a healthy snapshot.
There is no tombstone overwrite of a payload that an active cut references.

This requires the public GET/HEAD/304 path to consult current committed metadata.
A request admitted before a simultaneous block may finish; requests checked after
the block commit are refused. Prepared-but-unpublished objects are never served.
Existing browser copies remain outside the origin's recall control.

**Cost/availability tradeoff:** an uncached public read adds a coordinator/metadata
lookup before its single R2 GET. It also depends on metadata-service availability.
This changes today's R2-only read path. Keeping that bypass while also making SQL
the sole publication/block authority would be incorrect. A second R2 serving
projection would bring back cross-store commit/recovery work. Measure the added
RPC cost and latency before deployment; do not hide it in the barrier estimate.

Physical deletion respects active snapshot references. With no reference requiring
old bytes, blocked payloads can be reclaimed separately. A late prepare can leave
an orphan even after a delete; its publication must recheck the block and fail.
Reconciliation cleans such private leftovers, without refunding costs repeatedly
or allowing a stale operation to resurrect public content. Bound preparation
concurrency, reservation/reconciliation work, and retry charges independently of
the short commit queue. Control commits need admission even when upload slots are
full; do not put them behind a semaphore held by stalled preparations.

One active cut plus an explicit deadline bounds how long blocked bytes remain
pinned. Bound export bytes/records/requests and retained private-byte exposure too,
using maintained counters rather than an unbounded scan at seal. A backup that
exceeds its lease fails; it cannot keep pins indefinitely. Reclamation must
coordinate with sealing, expiry and release. Already completed backups still
contain their old state; safe public restoration needs newer suppression history.

## Durability and completion

Persist the epoch, selected cut, bounded configuration and all facts before their
respective ACKs. Production handles also need an unpredictable snapshot ID so a
restore/clone cannot accidentally reuse an old client's generation handle. An
operation's timing is determined by the authoritative transaction, not a request's
claimed epoch or timestamp. Crash before commit leaves an unpublished preparation;
crash after commit but before ACK is an idempotent retry of that committed fact.

A sealed image is not yet an independently durable backup. Copy and verify every
required body/fact, then finalize the still-valid snapshot and publish its complete
archive manifest. Finalization and retry outcomes must survive restart, including
lost replies. Release pins only through that protocol or explicit abort/expiry.
The model's `release` is cleanup only; it does not simulate durable finalization.

The existing SQL durability mechanism protects the local transaction. An
application redo journal is useful for recovering newer suppression/naming facts
beyond a completed checkpoint, provided it reaches the intended independent failure
domain. An asynchronous log copy can lose an acknowledged suffix. Decide acceptable
loss and acknowledgement durability before promising zero loss. Immutable facts
at the origin alone do not protect against losing that origin's account.

## Implementation path without legacy constraints

1. Replace the reservation/publication/block schema and visibility boundary. Keep
   R2 preparation outside short durable commits, with bounded in-flight work.
2. Replace the frozen archive/export path with epoch-filtered facts, pinned payloads,
   and resumable completion. Update the local CLI, fixtures and recovery drill to
   the new single format. No compatibility parser or old-schema migration is needed
   for this undeployed service; local disposable data can be reset/reseeded.
3. Exercise delayed R2 completion across the barrier, blocks on both sides, retries,
   restart, missing bytes, pin expiry, garbage collection races and lost ACKs. Run
   the restore into an isolated target, then the fern end-to-end check.
4. Measure actual cloud barrier/read latency and operation costs before deployment.

The updated offline tests cover held preparation across the cut, prepared bytes
remaining invisible, all 24 orderings of later publication/block/admission,
serialized restart, pinned reclamation, first-commit idempotency and stale handles.
They do not substitute for the SQL/R2 fault tests required by the implementation.

References: [Durable Object SQLite transactions and durability](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

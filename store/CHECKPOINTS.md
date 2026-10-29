# A short barrier, then a slow copy

29 October 2026. Design and **offline metadata experiment**, not a deployed
protocol. [RECOVERY.md](RECOVERY.md) remains the implemented recovery contract:
the v1 exporter holds a durable maintenance freeze throughout export. Nothing
here changes existing archives, endpoints, or retention.

Nick's proposed tranche is a **snapshot generation** (or epoch). A brief barrier
seals a logical cut, then copying proceeds while later writes use a new generation.
This needs both a stable membership boundary and preservation of old versions.
The number alone provides only the first.

Run `npm run demo:checkpoint` from the repository root with Node 24. The model in
`experiments/checkpoint.ts` exercises receipt preimages, new arrivals, serialized
restart, expiry, a history limit, and suppression. Tests enumerate all 24 orderings
of two confirmations and two admissions, checking the same cut after each write
and restart. It has no R2, network, disk durability, quota implementation, or
concurrency scheduler. Whole-state cloning is a reference-model convenience;
production SQL must touch bounded rows. Serialization checks state sufficiency,
not whether a real transaction has reached durable storage.

## The barrier

The source store already has one coordinator and a bounded writer queue spanning
reservation, R2 publication, confirmation, and blocking. Put the barrier through
that queue. Earlier mutations finish or leave their existing durable pending state.
A request still receiving its body has not published: its later commit uses the
new generation. Request arrival time does not determine membership.

In one SQL transaction, capture small control/policy facts, record the cut at
generation E, and advance allocation to E+1. Flush durably before releasing the
queue or acknowledging the barrier. Production also needs a random snapshot ID,
so restores/clones cannot reuse an old client's handle. The model uses only local
generations. No scan, R2 enumeration, or source copying belongs inside the barrier.
Its wait still depends on earlier queued R2 operations; a timeout must not release
a writer lock while a remote mutation could still complete.

New receipts get immutable `born_generation`; old receipts need no relabelling.
On the first later mutation of an old receipt, save its preimage in a shadow table
in the **same transaction** as the live mutation. Keep that first preimage through
subsequent changes. Snapshot reads use the preimage if present, otherwise the
unchanged live row, and exclude rows born after E. Today's no-receipt-deletion
rule simplifies membership. Deletion/eviction would need a preservation rule.

Extra retained history is proportional to old receipts changed during copying,
not all uploads or all prior history. Most confirmed receipts never change;
pending-to-stored transitions are the main case under today's rules. This adds
small SQL writes, not another R2 source write per ordinary publication. Export
still pays to read and copy the chosen bodies. An epoch shortens the pause; it
does not by itself make the copy incremental or reduce those transfer operations.

Migration can assign existing receipts generation 0; unknown historical timestamps
stay unknown. This is a backup boundary, not a per-object ingestion counter or a
replacement for a naming service's acceptance order.

| Fact at the cut | Preservation required |
| --- | --- |
| Confirmed immutable source | Copy and verify exact bytes later; account for deletion/overwrite. |
| Receipt and original submission time | Preserve the first preimage on later mutation. |
| Small configuration and aggregate facts | Capture in the durable descriptor at the barrier. |
| Pending reservation | Preserve original debit/time and pending status; see below. |
| Blocked address | Preserve refusal; source bytes are excluded from its archive record. |
| Tickets, live refill credit, sockets | No promise to resume them; restore conservatively. |

Exact logical fields, unknown-metadata handling and derived-counter cross-checks
need an archive v2 specification. Keep configuration needed to interpret historical
facts; deployment-only settings need not all match at the destination. See the
[simplicity review](../SERVICES.md#review-after-the-first-recovery-drill).

## Pending writes and the R2 boundary

R2 offers strong consistency and atomic conditional writes for individual objects.
It does not supply a transaction combining our SQLite records and a whole bucket.
R2 listing is not a substitute for sealed receipt membership. Hash-addressed bytes
help because ordinary successful publication never changes their content. Our
block operation *does* replace that key with a tombstone.

Proposed first online format: a **logical committed-source snapshot**. Include
bodies for receipts that were `stored` at the cut. Preserve pending reservations
without a promised body, even if an ambiguous R2 write left bytes present. Later
confirmation must not change that snapshot record. A retry after restore can
supply the exact source again without a fresh growth debit.

This is a policy proposal, not v1 behavior: v1 also copies a pending receipt's body
if R2 contains it. Consulting R2 later for a pending row would produce changing
snapshots as retries arrive. Preserving physical R2 presence at the cut would
require extra version/presence tracking, or many R2 reads during the pause. Public
reads can observe bytes before publication is confirmed, so the proposed logical
cut does not describe every byte any reader might have seen.

At each copy step, recheck snapshot identity/validity and materialize a bounded
record under the writer queue. Do not hold that lock during a slow client download.
Page by address using cut membership; new low-sorting addresses must not appear
in an old page. Bounds, cursor rules, retries and restart behavior need actual
R2 fault tests beyond the offline model.

## Suppression wins over an unfinished backup

The prototype takes a conservative policy: **any new block invalidates the active
online snapshot**, including a block for an address born after the cut. Commit
invalidation with the block refusal before the R2 tombstone attempt. Blocking
then proceeds with its existing retry/failure behavior. No backup copy can delay
it. Expiry or shadow-budget exhaustion similarly aborts the snapshot while allowing
the ordinary mutation.

The exporter may have received some records. It needs an atomic final validity
check before marking the copy complete; a partial file, cached header, or checksum
alone cannot authorize completion. A block ordered before that check invalidates
the attempt. A block after it is newer history, as with any completed snapshot.
Frequent blocks can starve this simple policy; that is its explicit tradeoff.

This does not erase downloaded or completed backups. Public replacement from an
older snapshot still needs independently recoverable later suppression facts,
applied before enabling reads. Invalidation prevents a falsely coherent export;
it is not a suppression-history backup. A future alternative can pin old source
versions privately alongside a newer block journal, but needs explicit retention,
confidentiality and durability rules.

## Where the WAL idea belongs

SQLite WAL lets a reader keep an old database view while writers append changes.
That database facility does not automatically become an online R2-plus-SQLite
backup through the Durable Object API. A SQLite PITR bookmark also is not an
independently stored copy of the source bucket.

Two application mechanisms serve different jobs:

- **A small undo journal:** the preimage table retains each changed old receipt
  once for one active snapshot. It answers “what was true at this cut?” and can
  be discarded after completion/abort. This is the smaller next step for copying
  while accepting writes.
- **An append-only redo journal:** durable admission, confirmation, suppression,
  or naming facts rebuild state from a checkpoint plus a suffix. Naming especially
  needs its own acceptance order/time. Log necessary facts, not a second copy of
  every immutable source payload.

A journal is “write-ahead” relative to a defined later effect/acknowledgement.
Reservation intent does not prove R2 success; replaying a confirmation requires
the body to be durable too. Replay must preserve original times, debits and service
order and handle ambiguous operations idempotently. A log in the same lost account
is not protection against losing that account. Asynchronous replication can lose
acknowledged decisions; zero loss requires the relevant independent durability
before the ACK.

Do not add a second database transaction log merely for the epoch flip. Existing
SQL transactions and durable flushes supply that local boundary. Specify the
application redo journal's recovery interval and failure domain, especially for
suppression and hosted names, before implementing it.

## Sealed is not backed up

The cut specifies **which state** to copy. It does not protect uncopied source
from loss of the original storage. Publish a complete manifest only after all
required bodies and metadata have been copied, verified and made durable in the
intended destination, and the coordinator has atomically approved completion of
the still-valid cut. Finalization retries must distinguish completed, invalid,
and unknown handles. Retain the completion outcome long enough to resolve a lost
reply. The model's `release` is cleanup only, not that completion protocol.

Keep one active cut initially. Bound its age, shadow rows **and bytes**, export
records/bytes/requests, and cleanup work. Real receipt fields are bounded; the
model accepts trusted test data and demonstrates only the row cap. Budget exhaustion
aborts copying rather than letting a stalled exporter cause a write outage. Use
bounded cleanup batches in production. Recover cut/shadows/finalization after
restart; no correctness-critical marker may exist only in memory. Incremental
copies can later reuse verified blobs by address; mutable facts still need capture.

One coordinator makes this a local atomic barrier. With shards there is no instant
“increment everywhere”: coordinate cuts and record per-shard positions, accounting
for in-flight cross-shard operations where relevant. Channels are separate and
ephemeral; no all-service freeze is needed to back up source. Add cross-service
consistency for actual dependencies, such as a naming checkpoint whose referenced
blobs must be available in its archive.

## Next implementation boundary

1. Specify logical archive v2 and compatibility, especially pending bodies.
2. Choose loss tolerance and independently recoverable suppression history before
   relying on periodic backups for safe public replacement.
3. Add durable generation/preimage storage and bounded export/finalization. Retain
   frozen v1 recovery while validating the new path.
4. Repeat the loss drill with concurrent writes, ambiguous R2 outcomes, blocks,
   restart, lost finalization replies, exhausted history budget and stale handles.

References: [SQLite WAL](https://www.sqlite.org/wal.html),
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[Durable Object SQLite storage and PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

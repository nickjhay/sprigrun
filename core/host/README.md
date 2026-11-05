# Native acceptance journal

This is the real SQLite-backed Durable Object, tested with local R2 through
Miniflare. It is not connected to the existing public Worker or workbench yet.
The production HTTP entrypoint and explorer live in [core/http](../HTTP.md).
No production deployment or seed key is configured. Adapters under `core/test`
are test-only and expose privileged fault controls: never deploy them.

```sh
npm run test:core        # Portable protocol tests; Node 24 only.
npm run test:acceptance  # Real SQLite/R2; needs a supported workerd platform.
npm run test:recovery    # Whole-core loss, corruption and interrupted-restore checks.
npm run demo:recovery    # Delete local SQL/R2, restore, and continue a chat.
npm run check           # Includes native recovery and all existing project checks.
```

## The short commit

`submit` receives exact action bytes and an optional detached signature over
trusted internal RPC. It bounds concurrent preparations to eight and durably
debits attempt credit before hashing, key lookup, signature verification or R2
work. HTTP uses the same acceptance path, sharing its active slots and durable
attempt debit before reading a bounded body with a total deadline. The adapter
also requires exact agreement between actual and signed HTTP destinations.

The host resolves author keys and plot bindings from registered accepted state.
Clients cannot provide substitute bindings. It rechecks ownership, referenced
source availability, suppression, pause state and anchor existence at commit.
Old and suppressed anchors count as existing entries; unknown future/gap anchors
do not. Plot control is immutable. No guest execution runs on this path.

`results` is the authoritative table keyed by result path, with a unique action
ID. It replaces the earlier `entries` and `accepted` tables. Receipts and evidence
are stored in that row, not written separately to R2. One synchronous SQLite
transaction writes:

- the unique action ID and original signature/evidence;
- one result row, plus the next collection number and head for an append;
- the acceptance timestamp;
- the metadata growth debit, receipt and recovery journal pointer;
- first publication of a prepared source, when applicable.

There is no await, crypto, R2 operation or scan of prior history inside that
transaction. A fault rolls all of it back. Success waits for `storage.sync()`
before acknowledgement. Exact retries return the retained receipt; an intentional
repeat waits for it and advances the anchor. The same bytes under different
authors are different signed actions. For source publication only, the first
committed action wins: a distinct action for the same bytes gets `already_stored`
and consumes no additional growth credit. Exact authorized retries still succeed.
A private reservation does not claim first-publication rights. Authority is resolved by key, so two plots
with the same controller can authorize that controller's publications, while
their signed author labels remain distinct.

All sequence keys are padded 20-digit decimal TEXT. Arithmetic uses BigInt;
overflow fails closed. Allocation facts survive suppression. Current heads are
an index over those facts, not the sole recovery record. There is no externally
meaningful global submission sequence.

## One R2 PUT and two different charges

For a new source, the SQL journal first reserves private storage allowance by
content address. It waits for that reservation to be durable, then performs one
conditional R2 PUT with the digest checksum. If the condition fails, it reads
and verifies the existing bytes before publication. A failed/ambiguous PUT leaves
its reservation in place; retrying the same value reuses it. A committed source
needs no new PUT for an exact retry or a rejected duplicate publication.

That reservation is necessary even when the eventual action never commits:
otherwise an attacker could fill paid private R2 with unaccepted objects for
free. It is not a public receipt and does not allocate a name. Attempts also
bound repeated failed/ambiguous R2 operations. No reservation object or receipt
object is written to R2.

The later action transaction charges its own metadata allowance. Defaults:

| Budget | Refill | Maximum credit |
| --- | --- | --- |
| Shared growth | 100 MiB/day | 200 MiB |
| Short burst | 8 MiB/hour | 8 MiB |
| Attempts | 30/minute | 30 |

Private source reservation is `max(source bytes, 8192)`. Action debit is
`max(8192, 8192 + inline body bytes)`, with no inline body charge for sea uploads.
Both storage charges draw from the **same** growth and burst buckets. A new tiny
source therefore costs 16 KiB of allowance; a publication about an existing value
or a chat message costs its metadata allowance plus its small body. Exact retries
consume attempt credit but no second storage debit. The allowance estimates
bounded metadata, evidence and index overhead; it is not a measurement of SQLite
page usage or a complete Cloudflare dollar budget. Calibrate it before launch.

The database retains exact action headers. Sea action bodies are reconstructed
from their immutable R2 values; other bodies are small and stored inline. This
avoids a second R2 PUT or a duplicate SQL copy of every large source action.
Retained key/binding bytes make the original signature independently verifiable
once the reader has a trusted plot binding. A receipt remains an unsigned host
acknowledgement, not an execution proof.

## Reads and suppression

R2 must remain private. An object's presence alone never makes it readable.
The accepted journal and current suppression gate all adapter reads, including
evidence. R2 reads check size before buffering and digest before returning; reads
recheck visibility after asynchronous I/O. Publication aliases check their source
and plot; chat messages check their subject. Hiding a key hides evidence containing
its bytes, but does not block its use for signing. Internal authority resolution
uses retained accepted facts, independently of public visibility. Blocking a key
prevents new actions through all its author aliases; historical signatures and
messages remain readable unless separately hidden. Exact authorized retries can
return their original receipt after a block, subject to content visibility.
Neither effect erases consumed action IDs.

`latest` selects the greatest committed entry and checks its visibility. It
reports unavailable if suppressed; it never quietly selects an older entry.
Suppression changes append historical facts and never delete receipt/allocation
state or refund credit. Only sea hashes can be suppressed before they exist;
numbered entries must already exist, avoiding a blocked unallocated next slot.

The public adapter adds inert text MIME, private/no-store cache policy, bounded
read traffic, useful errors, help/spec discovery and authenticated fixed operator
routes. GET creates no permanent per-view state. Listings use bounded indexed SQL
and no R2 reads. Do not expose privileged methods through a generic RPC router.

## Snapshot boundary and recovery

`checkpoint()` synchronously captures control, policy, journal identity and
position, then waits for durability. It does not mutate SQL or wait for uploads.
Pages copy immutable facts only through the captured position while publishing
continues. A source reservation appears without a body until its acceptance;
a later increment carries that body's exact bytes. Tests hold an R2 PUT while
capturing and restoring both sides of this boundary.

Full and incremental copies share one bounded stream. Restore validates each
result and its prior dependencies, rebuilds heads and commits each fact with its
resume cursor under quarantine. Historical counters and receipts survive;
spendable credits reset to zero. See [RECOVERY.md](../RECOVERY.md) for the format,
loss drill, release boundary and schema-7 transition. Physical deletion/GC is
not implemented. Do not use the older source-store recovery tool on this schema.

An old backup cannot reveal its unknown suffix. Recovering to the same public
origin requires reconciling allocation/consumption/suppression high-water marks
before reopening; otherwise numbers or signed actions could be reused.

Before public release: independent backup operations, report/takedown operations,
cost/load calibration and production seed custody. HTTP/body admission, operator
authentication and local seed installation through normal admission are implemented. Native PoW is also
not wired yet; the older store's PoW implementation remains a reference. No
private message boxes, genesis recovery, arbitrary MIME or Sprig execution are
part of this acceptance slice.

The transaction API follows Cloudflare's
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/):
`transactionSync` rolls back on an exception, and `sync` awaits pending durability.
Tests inject faults into this implementation, rather than maintaining an
independent in-memory acceptance model.

## Logical owners and local policy

`placement.owner()` maps source values to their `/sea/H_L` identity and numbered
results to their allocation collection. Receipt, action and evidence mirrors
have that same owner. `POST /sea` gets an owner after bounded intake/hashing.
Public identifiers contain no physical shard ID; all owners currently use the
single `core` Durable Object.

`moderation` retains ordered hide/block facts. Its control count and journal
pointer commit together. An index supplies the latest decision without a second
mutable projection. Repeating an unchanged decision adds nothing. The local
authority applies changes immediately; reads need no poller or durable write.
The bounded operator feed/status is `/admin/policy?after=0`.

`requiredReferences` describes retained authority, visible values/subjects and
anchors for both admission and recovery. Live admission checks current visibility
and append authority; recovery checks historical dependencies. A later hide or
key block does not invalidate an earlier signature.

Future shards may have weaker cross-shard consistency and independent backups.
Colocate relationships requiring atomicity when choosing placement. There is no
global barrier requirement or active topology/follower implementation. The earlier
cluster design and its failure tests are preserved on
[reference/epoch-core-2026-11-05](https://github.com/nickjhay/sprigrun/tree/reference/epoch-core-2026-11-05).

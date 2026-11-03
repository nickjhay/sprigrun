# Native acceptance journal

This is the real SQLite-backed Durable Object, tested with local R2 through
Miniflare. It is not connected to the existing public Worker or workbench yet.
There is deliberately no public HTTP entrypoint, deployment configuration, or
production seed key in this directory. The HTTP adapter under `core/test` is
test-only and exposes privileged fault controls: never deploy it.

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
work. A future HTTP adapter must additionally admit traffic and bound/timeout
body reception *before* calling this method. It must check that the actual HTTP
destination agrees with the signed destination.

The host resolves author keys and plot bindings from its own accepted state.
Clients cannot provide substitute bindings. It rechecks ownership, referenced
source availability, suppression, pause state and anchor existence at commit.
Old and suppressed anchors count as existing entries; unknown future/gap anchors
do not. Plot control is immutable. No guest execution runs on this path.

One synchronous SQLite transaction writes:

- the unique action ID and original signature/evidence;
- the next collection number, entry and current head;
- the acceptance timestamp and snapshot epoch;
- the metadata growth debit and receipt;
- first publication of a prepared source, when applicable.

There is no await, crypto, R2 operation or scan of prior history inside that
transaction. A fault rolls all of it back. Success waits for `storage.sync()`
before acknowledgement. Exact retries return the retained receipt; an intentional
repeat waits for it and advances the anchor. The same bytes under different
authors are different signed actions. Authority is resolved by key, so two plots
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
needs no new PUT for another action referring to it.

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
and plot; chat messages check their subject. Suppressing a key prevents new
actions using it and hides evidence containing its bytes. It does not erase
already accepted authored messages or their consumed action IDs.

`latest` selects the greatest committed entry and checks its visibility. It
reports unavailable if suppressed; it never quietly selects an older entry.
Suppression changes append historical facts and never delete receipt/allocation
state or refund credit. Only sea hashes can be suppressed before they exist;
numbered entries must already exist, avoiding a blocked unallocated next slot.

These are internal read methods, not finished HTTP responses. The public adapter
still needs inert text MIME, cache policy, bounded read traffic, useful errors,
help/spec discovery and authenticated operator routes. No HTTP GET is wired to
create state here. Do not expose privileged methods through a generic RPC router.

## Snapshot boundary and recovery

`cut()` saves the small control state at epoch N and advances to N+1 in one
transaction. It does not acquire a preparation lock or await R2. A PUT already
in flight can finish after the cut, but its publication and receipt belong to
N+1. The retained reservation records when private allowance was paid; publication
records when the value became public. Tests hold an actual R2 PUT while making
the cut. There is no claim about a particular production latency yet.

Entries, accepted actions, suppression changes and cuts retain their epochs.
Sources retain reservation and first-publication epochs separately. The exporter
projects both at the cut and copies exact bytes, action evidence, timestamps,
quota control and consumption identities. The restore target validates the archive
and rebuilds heads while quarantined; interrupted imports resume durably. Original
credits remain historical, while spendable credits reset to zero. See the
[recovery guide](../RECOVERY.md) for the format, loss drill and release boundary.
Physical deletion and pin release are not implemented. Do not use the old
source-store recovery tool on this schema.

An old backup cannot reveal its unknown suffix. Recovering to the same public
origin requires reconciling allocation/consumption/suppression high-water marks
before reopening; otherwise numbers or signed actions could be reused.

Before public release: wire public HTTP and body admission, operator
authentication, independent backup operations, report/takedown operations, cost/load
calibration and seed installation through normal admission. Native PoW is also
not wired yet; the older store's PoW implementation remains a reference. No
private message boxes, genesis recovery, arbitrary MIME or Sprig execution are
part of this acceptance slice.

The transaction API follows Cloudflare's
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/):
`transactionSync` rolls back on an exception, and `sync` awaits pending durability.
Tests inject faults into this implementation, rather than maintaining an
independent in-memory acceptance model.

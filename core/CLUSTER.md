# Cross-owner references and coordinated recovery

D2 implements fixed placement, trusted references and whole-cluster recovery in
the local SQLite/R2 adapter. Public HTTP still uses one shard; sharded ingress,
aggregate listings and operator routing are the remaining D work. Nothing is
published, scheduled or deployed by this slice.

```sh
npm run demo:cluster    # Signed garden, full + delta, loss, interrupted restore.
npm run test:cluster    # Real SQLite/R2, including missing dependencies and lost replies.
```

## One owner per collection

Topology `sprig-topology/2` fixes placement: take SHA-256 of UTF-8
`placement.owner(path)`, interpret all 32 bytes as an unsigned big-endian number,
and take its remainder modulo the lexicographically sorted member count. A
source owns its `/sea/H_L`; an append collection owns all its numbered results,
anchors, heads, receipts and evidence. The public grammar and signed bytes do
not include shard names. Existing ownership tests describe the logical mapping.

Both live acceptance and archive validation enforce the physical owner. A
misrouted write can consume attempt credit but cannot reserve source storage,
PUT R2, allocate a number or insert a result. The existing bounded, metered
intake hashes source bytes before selecting their owner. A future HTTP ingress
must preserve that ordering across routing; the public worker still refuses a
topology rather than buffering unmetered bodies at the edge.

Changing the roster, revision or placement version requires a separate migration
protocol. No dynamic moves, quota stealing or implicit ownership takeover exist.

## Trusted facts, local commits

A shard resolves dependencies itself over its configured Durable Object
namespace. The target verifies its registered journal identity and ownership,
then returns only accepted immutable fields, after durability: path, kind, epoch,
value, controller and plot binding. Neither client claims nor private R2 presence
can establish acceptance. No HTTP endpoint exposes this RPC.

The caller holds at most 12 distinct facts for one operation. It loads the bounded
publication/plot/subject closure, and the accepted key record for signatures.
Facts are not cached across requests or copied into another durable table.
Local mutable conditions and local rows are checked again after awaits, inside
the final transaction. Remote facts never change. Referenced acceptance cannot
come from a future epoch. Authority comes from the immutable plot controller,
not from whichever handle the sender supplies.

All holds complete before any cut, so a reference committed in epoch N cannot
depend on an acceptance outside the complete N cut set. A prepared operation
that reaches a held commit receives retry guidance and can commit in N+1 after
release. No upload or reference lookup keeps the barrier waiting.

## One policy stream, bounded catch-up

The lexicographically first member is the fixed hide/block authority. Followers
pull its existing ordered feed, at most 32 changes per attempt, on reads/writes
when due. The cursor and applied facts commit together and appear in archives.
The target interval is 60 seconds; more backlog allows another request to pull
the next page. Outages retain the last applied policy. There is no background
alarm or hard 60-second convergence promise: an inactive or failing shard may
lag longer. Holds stop policy application just like other recoverable mutations.

Only the authority accepts policy writes. Every read/evidence path applies the
local policy prefix to its dependencies. Key blocking gates new actions; hiding
content gates its public view. Recovery verifies that every follower event is
identical to the corresponding retained authoritative event. It preserves each
member's applied prefix rather than pretending they were synchronized at the cut.

## A small trusted plan and complete archive chains

`captureCluster(host, directory, barrierId, bases?)` copies an already-published
barrier. Each member uses the same bounded full/incremental exporter as the
single-shard core. The final `cluster.json` is published exclusively and fsynced
only after all member files complete. A partial copy is not a published bundle;
use a new destination to repeat it. Keep the original files.

`sprig-cluster-backup/1` contains the complete barrier manifest plus the final
header/footer of every member's chain. Each final header must name exactly its
cut, and each footer pins that chain's final digest. The plan is at most 256 KiB;
its SHA-256 digest must be retained independently. Its digest is not a signature
and does not prove that no later accepted history exists.

The operator verifies all member files and full-to-delta links with
`verifyCluster(plan, files, trustedDigest)` before touching the target. Files are
streamed; the helper retains bounded headers, not every record. Each chain still
has the existing 1,024-file limit. The caller supplies file paths separately from
the portable plan.

## One persistent recovery quarantine

Fence the old writers and establish a trusted final cut covering accepted history.
No software can discover an unknown accepted suffix from an older backup. The
local demo actually stops and removes its disposable old SQL/R2 storage. A real
operator must establish the equivalent fence and independently retain backups.

Set restore mode on the new controller and **every** participant. Then:

1. `controller.restoreBegin(planText, digest, 'old-writers-fenced')` pins the plan,
   verifies pristine members and checks the shared R2 bucket is empty once for
   the entire cluster. A persisted `starting` state permits a safe retry of that
   check; no member may import before it completes.
2. `importCluster(host, bundle, digest)` verifies the complete bundle, then resumes
   each member's ordinary record import. Signatures, source hashes, receipts,
   accounting, allocation and placement are checked immediately. All members stay
   quarantined. Later members may use the already-populated shared bucket.
3. Repeated `controller.restoreStep(digest)` first establishes that **every**
   member reached its pinned final digest. It then validates references in batches
   of at most 32 journal positions per member call. Cross-owner facts must belong
   to the planned journal and cut, at an epoch no later than their dependent.
   Same-owner predecessors must also have an earlier journal position. These are
   the same reference/authority rules used by single-shard restore.
4. The controller reconstructs prior barrier manifests from all members' retained
   cuts, one member call per step. Old barrier IDs remain consumed and old published
   manifests remain retrievable. Missing/inconsistent cuts cannot finish recovery.
5. Only after all checks does it publish the complete release decision. Members
   fetch that decision themselves, journal barrier release and forced pause, and
   leave quarantine idempotently. The controller then marks the round done.

Removing restore configuration early cannot bypass durable quarantine. Per-shard
`restoreRelease` remains prohibited. Missing files, references, policy history,
wrong owners, an incomplete manifest or a conflicting plan never authorize
release. Losing a reply after a page, history reconstruction, publication or
member release can repeat that step without resetting credit or duplicating facts.

Restore completion leaves writes manually paused; spendable credit starts at
zero. Remove restore mode and unpause only after the operator's reconciliation.
Receipts, signatures, original timestamps, numbers and heads retain their original
values. Refill then follows the normal configured rate; no fresh burst is granted.
A new barrier and backup can be taken after recovery.

## Cost and remaining boundaries

Normal new source publication still uses one R2 PUT. Trusted dependency lookups
add bounded internal RPC/SQL reads; key verification still reads its small accepted
source from R2. Listings inspect at most 32 local rows, with bounded reference
checks per item. Recovery's second pass reads metadata, not source bodies again.
History reconstruction costs one member call per historical cut per member.
These are operation counts, not new provider pricing or a measured monthly bill.

Public sharded routing, bounded source ingress before owner selection, aggregate
stats/listing cursors and authenticated cluster operator endpoints are still
needed. Production remains single-shard by default. Independent backup custody,
report operations, seed-key custody and the deployed preview remain launch work;
dynamic writer movement is separate. The test adapter has privileged fault hooks
and must never be deployed.

Schema/archive **6** and topology **2** deliberately reject the prior local
laboratory formats. Preserve old files; commit
`d301321b2fb3c70c63460f08506841eee3b23bd1` (PR #23) reads schema/archive 5 and topology 1.
Public action/key/plot/receipt formats remain v1; per-file witnesses remain v2.
Use a fresh local state path: `npm run dev:core -- --state .local/native-http-v6 --operator`.

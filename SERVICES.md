# Service review and next naming boundary

29 October 2026. Review of the source store, upload proofs, channel hub, clients,
local launchers, and offline naming experiments. The small refactors below are
implemented. The hosted naming API and retention classes are agreed directions,
not new deployed endpoints or a garbage collector.

The [review after the first recovery drill](#review-after-the-first-recovery-drill)
below adds two implemented cleanups and identifies the next design decisions.
It does not change the v1 archive format or the current channel proof protocol.

## One publishing request above the blob store

The naming endpoint will receive the complete genesis/update **bytes**, verify
them, ensure the same bytes exist in the backing content-addressed store, and
apply the naming operation. A client need not upload and then submit a hash in
two separate publishing calls. An already stored object is an idempotent success
for this composition, subject to verification and the store's suppression rules.
The target source referenced by an update is a separate content-addressed object.

The lower store remains responsible for exact bytes, quotas and suppression; the
naming service adds signature/parent rules and selection. Its internal storage
authority must not become a public write bypass. A proof challenge, if enabled,
is still a separate preflight; one publishing request does not make anti-replay
proof issuance disappear or allow one ticket to authorize two operations.

The implementation order should be verification, durable backing storage, then an
atomic recheck and head commit. A successful response means both storage and name
acceptance completed. An interrupted or losing update can leave an unused blob;
it must never leave a committed head whose record was not durably stored first.
R2 and the naming coordinator do not share a transaction. Retry must reconcile
both layers, rather than treating an existing blob as proof that naming succeeded.
The current public store's `already_written` response alone does not establish
availability: an externally removed object still has a permanent receipt.
The future internal ensure operation must account for that distinction. The new
direct `POST /b` path does verify stored bytes before duplicate success, so its
idempotent success has stronger availability semantics than the challenge's refusal.

## One selected head, plus admission facts

Track one mutable selected head per genesis. A mutable graph of branches, child
lists, cached ranks and competing heads is unnecessary for the hosted selector.
The immutable records already contain parents and keys. Cache the head record or
its needed fields when useful to avoid a second storage lookup on ordinary reads.
The ordered reducer is the service's only head-selection rule; the unordered
resolver remains an offline comparison experiment, not another service authority.

Head-only **selection state** does not eliminate the facts needed to validate
recovery and retries. Keep a naming acceptance time (and service sequence, if
order/historical lookup is offered) for an accepted record. A record uploaded a
month before its naming submission must not lose its recovery window merely
because it was already present in the blob store. First blob storage time and
name acceptance time are different facts. Store the latter with service admission
metadata. Historical decisions and head-after-event snapshots can be derived from
the ordered facts; they need not be an additional authoritative mutable database.

Recovery duration is a **service policy configuration constant**, captured for
the service's policy epoch. It is not a field a working key can shorten in an
update. Preserve the policy used for earlier admissions when replaying history;
changing the constant requires an explicit operator policy transition. The
offline demo's 72 hours remains an example, not a chosen deployment value.

## Retention and classes

Ordinary objects have no automatic expiration by default. This already matches
the store implementation: it has no TTL deletion job. No fixed expiry means an
unbounded lifetime, not a promise of unlimited provider capacity or availability.
Pressure-driven eviction is a later, explicit operation. Channels keep their own
bounded rolling retention and incarnation lifetime.

The store now records its own `submitted_at_ms` in the first quota reservation and
R2 metadata, preserving it through retries, duplicates and tombstoning. R2 returns
custom metadata with a GET; a separate HEAD is unnecessary. The generic store
allocates no submission sequence. Services own any sequence/acceptance facts they
need, independently of when the blob was stored. A naming metadata copy must be
repairable from its atomic acceptance record, and coordinated with blocking and
other metadata writers. Independent metadata merges are not a cross-service transaction.

Application classes such as ordinary source and naming evidence are
independent of R2's billing storage tiers. A preexisting ordinary blob used as
naming evidence needs its retention protection strengthened without changing its
bytes or pretending its naming acceptance occurred at the original upload time.
Only trusted service operations may grant that protection.

Keep the current head and the evidence needed to validate a live name protected
from ordinary pressure eviction. If we offer independently replayable historical
service revisions, their evidence also needs protection. If evidence is missing,
return unavailable/incomplete; do not silently select a different history.
The exact class schema, promotion transaction and pressure-reclamation rules are
not implemented by this pass. Administrative suppression remains a separate rule.

The existing 256-record naming cap is a local experiment bound, not a viable
lifetime cap on a public name: a compromised working key could fill it with
losing signed candidates and block recovery. Separate candidate admission from
protected recovery capacity before hosting. A bounded hot working set can cover
recent recoverable ancestry while older evidence lives in durable storage.

## Reads and separate channel storage

| Operation today | Backing-store operations |
| --- | --- |
| Uncached blob GET, HEAD or conditional GET | One R2 GET, including metadata and body; verify before returning. |
| New successful blob publication | One conditional R2 PUT, no preliminary GET. |
| Retry of an ambiguous committed write | Conditional PUT fails its absence condition, then one verified GET. |
| Already-confirmed upload refused at challenge | SQLite receipt lookup, no R2 call. |
| New ticket-free `POST /b` | One Worker request, two DO RPCs (admit/publish), one R2 PUT; no ticket or R2 GET. |
| Duplicate ticket-free `POST /b` | One R2 GET to verify availability/integrity; no R2 PUT or new storage debit. |
| Channel history or WebSocket batch | SQLite operations in the hub, zero R2 calls. |

Keep channels in their own SQLite Durable Object. Adding an R2 pointer followed
by a blob fetch would add reads and complicate atomic append/trim. Zero R2 calls
does not mean zero cost: requests, SQLite rows, delivery and active execution still
matter. A future mailbox can use the same storage approach with its own read
authority and reject-on-full retention. No mailbox is implemented yet. Public
channel caching must not leak future private mailbox contents.

If a later service uses R2 for a current-value snapshot, put the necessary
metadata and value together under a directly known key so one GET suffices. A
pointer-only object followed by fetching its target is two reads. Name resolution
and subsequently loading a program are also distinct operations unless content is
explicitly inlined in the resolution response.

## Simplifications implemented in this pass

- The workbench imports the source store's actual browser client and wire module.
  Removed the duplicate copies under `vendor/`; one repository commit pins both.
  These originated in the source-only v0.5 store and keep the same wire protocol.
- Both services import one exact-integer token bucket implementation and one
  bounded work-target calculation from `shared/`. Their ticket formats,
  authentication and domain-separated proof messages remain independent.
- Publication attempts its existing conditional R2 PUT first. A GET is needed
  only when an object already exists and must be reconciled. Fault tests preserve
  quota reservations, retry behavior, integrity checking and tombstone protection.
- Root checks now include the full store test suite and server/client typechecks,
  plus the nine existing Python pricing tests. Previously root CI ran the
  workbench's store integration but omitted the store's own suite.

The source store and channels remain separate deployment packages inside this
repository. Their builds now include `../shared/`; copying a subdirectory alone
is not a standalone source distribution. No new runtime dependency was added.

## Machinery deliberately retained and follow-up candidates

The bounded outstanding-ticket tables already solve replay without an unbounded
spent-ticket history. Keep issuance/attempt limits, ticket scope, expiration and
consume-before-body rules. One short proof hash is separate from the single body
hash. Shared arithmetic does not mean sharing tickets between services. Keep the
minimum debit and capped refill buckets: byte quotas alone do not limit tiny-object
write charges, and unbounded saved credit defeats the growth envelope.

Keep pending receipts, durable flushes, the bounded writer queue and conditional
writes. They handle the real gap between SQLite accounting and R2 commits, and
prevent a delayed upload from undoing a block. Read-side digest/length/UTF-8 checks
enforce the byte-identity promise. Body bounds and timeouts are also substantive.
Combining all of these into a generic service framework would hide their ordering.

The main remaining read-cost candidate is channel trimming: `batch()` enforces
age/count/byte retention before every delivery. Subscription setup now reuses its
initial batch, including receipt/lease fields in the frame-size budget. Count/byte
trimming could move to append, with age-aware read queries. Preserve cursor gaps, escaped frame-size bounds,
ACK backpressure, and behavior when configured retention limits are reduced.
This needs a focused change and tests; it is not changed in this pass.

Channel JSON batch validation could also be stricter about consistency between
cursor, `has_more`, message continuity and the requested cursor. The application
already bounds input and treats the host as trusted, but an adversarial-host test
suite would help before federation. Keep that separate from changing the wire
format or promising end-to-end authenticity for bearer-secret channels.

The pricing model continues to include one conservative R2 read per upload as
an allowance for reconciliation; the common new-object path now does less. Its
prices are still the documented October 27 snapshot, not newly researched rates.
Class-based retention does not alter the fact that indefinite accumulation grows
storage cost over time. No new cost ceiling or deployed billing claim is made.

References checked October 29: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and [SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Review after the first recovery drill

29 October 2026. Reviewed recovery, admission/proofs, channel delivery, naming
experiments and the workbench/runtime boundary at `12d1cdf`, then made the small
changes below. The recommendations are design proposals, not deployed behavior.

### Implemented cleanups

- **One publication-success contract in the bundled client.** A PoW-path
  `already_written` response now triggers one verified GET with browser caching
  disabled. A receipt alone can survive a missing R2 object. Both the challenge
  refusal and a racing PUT refusal use the same check; missing, blocked, corrupt
  or unavailable bytes fail explicitly. The ordinary zero-work POST remains one
  request, and normal source reads retain browser caching. This aligns the helper
  with the existing `/help` instructions. Success establishes availability at the
  check, never a promise of future retention.
- **One first channel batch.** Subscription setup prepares and sends the same
  bounded batch, instead of trimming/querying/serializing a throwaway batch and
  building another. It includes the receipt and lease in the size calculation,
  and no await separates preparation from sending. Cursor gaps, ACK backpressure,
  hibernation and later delivery remain unchanged.
- The workbench says “Publishing this source snapshot…” without claiming every
  publication needs a proof. This matches the default direct POST path.

### Keep facts, derived state and live controls distinct

| State | Role | Simplification direction |
| --- | --- | --- |
| Exact source + original receipt time/debit/status | Historical facts, including pending reservations and blocks | Preserve; bytes alone cannot reconstruct these. |
| Current refill balances | Live admission control | Keep authoritative while running. Restore still starts at zero; do not infer balances from aggregate receipts. |
| Five receipt totals | Incrementally maintained aggregates | Keep for cheap stats and consistency checks; derive/check them from receipts during recovery. They do not constitute a separate history. |
| Proof tickets | Short-lived admission rights | Keep bounded and single-use; omit from backups and invalidate on restore. |
| Naming admissions and their policy epoch | Historical service decisions | Persist before hosting names. The selected head is a projection of these facts and signed records. |
| Channel messages/cursors | Ephemeral state within an incarnation | Retention gaps are normal. Restore continuity must never silently reuse an old epoch. |
| Workspace draft / running instance | User work versus a particular execution | Keep separate lifetimes. A saved draft is not a checkpoint of a running VM. |

### 1. Make the next archive a logical store format

The v1 archive intentionally captures the whole `Control` and `Config` structures
and R2 custom/HTTP metadata. This was convenient for the first exact roundtrip,
but carries implementation details into recovery:

- Four saved balances are validated and then discarded by zero-credit restore.
- Restore requires an identical entire configuration, so changing even the
  browser cache duration or upload timeout rejects it.
- R2 HTTP metadata is copied although public serving constructs its own headers.
- `policyEnv()` maps an archive configuration back through environment variables
  to validate it. That is coupling between deployment setup and the archive.

For a future explicit format version, prefer original receipt facts, exact bytes,
per-object validation contract, needed operator policy, and integrity checkpoints.
Construct fresh paused controls separately. Keep source configuration as provenance
if useful, without requiring every operational setting to match the target.
Historical naming policy remains different: changing it can change replay results.
The stored validation policy still determines how an older blob is read, regardless
of the target's current admission policy.

Do not silently drop metadata, change v1 meanings, or reinterpret already saved
archives. Specify unknown-field/extension handling and migration first. Keep the
aggregate cross-check and ordered checksum: deliberate redundancy detects drift.
Base64 is still useful for exact bytes and a predictable size bound, including
NUL-heavy UTF-8. Reformatting source or inventing a general serialization language
would not simplify this recovery boundary.

### 2. Separate snapshot restoration from live replacement

The current restore is a fresh isolated copy of one consistent snapshot. It cannot
discover blocks or admissions acknowledged after that snapshot. Making an older
copy public needs that newer history or an explicit acceptance of the known loss.
Zeroing refill credit and clearing tickets do not recover a forgotten block.

Recommendation: retain the narrow restore contract. Before depending on periodic
backups for a public service, choose the allowed loss interval and an independently
recoverable suppression history. If zero loss of acknowledged admissions is wanted,
that requires an acknowledgement/durability design too; an extra asynchronous log
alone is insufficient. Do not introduce a universal service event framework just
to give the existing snapshot tool a broader name.

Keep the durable maintenance session and explicit `RESTORE_MODE` gate. A pause
flag alone would still allow administrative changes during export. Removing the
deployment gate during a partial restore can expose reads because ordinary blob
reads intentionally bypass the coordinator. That operator-controlled cutover is
a real boundary, not two interchangeable ways of pausing the same operation.

### 3. Decide the scale of the write-pause window

The export makes one serial HTTP/DO request per receipt, plus page requests and
one R2 GET for each non-blocked receipt. Writes and administrative changes remain
frozen while it runs. The snapshot is simple to reason about; the pause grows with
the entire store, not just that day's new data.

At steady-state saturation, 100 MiB/day divided by an 8 KiB minimum debit permits
12,800 new small-object reservations/day, about 4.67 million/year. This is an upper
envelope from the configured quota, not observed traffic. The CLI's default
100,000-record safety limit would be reached in about eight such days. At a
*hypothetical* 100 ms per record round trip, one day's receipts alone take roughly
21 minutes to export serially; neither latency nor cloud CPU has been measured.

Recommendation: use the existing drill for the bootstrap, measure a realistic
population before scheduling backups, and set record/byte/time limits explicitly.
If round trips dominate, bounded pages of full records are the first candidate.
Incremental copies or online snapshots need a change-history design and should
follow an actual recovery/pause requirement. Do not add concurrency until it has
explicit object, byte, request and interruption bounds.

Nick's subsequent epoch-barrier proposal is explored in
[CHECKPOINTS.md](store/CHECKPOINTS.md) and `npm run demo:checkpoint`. A sealed
generation fixes membership; bounded receipt preimages preserve older metadata
while writes continue. The offline model aborts a cut on suppression or history
budget exhaustion. Production v1 still freezes mutations for the full export;
pending-body semantics, durable finalization and later suppression recovery need
an explicit online protocol before that freeze can safely shrink.

### 4. Keep eviction different from suppression

Today there is no automatic eviction. A `stored` receipt with no R2 object is an
integrity/availability failure. Publication refuses to recreate it; a `blocked`
receipt is a permanent refusal. These are deliberate current rules.

Before adding pressure reclamation, decide whether an intentionally evicted blob
can be supplied again, how that affects growth debit, and which timestamps it
keeps. Record intentional eviction if it changes those rules; do not infer it
from missing bytes. A duplicate remains the same content identity even if a later
physical storage event occurs. Keep original submission time separate from any
future rehydration time. Suppression must continue to override re-upload.

### 5. Align zero-work ergonomics without merging protocols

The store defaults to direct POST with no ticket; channels still require a
challenge even when configured difficulty is zero. A prospective channel update
could allow directly authorized create/append when work is off, using existing
request/creation/ingress limits. Retain message IDs, incarnation checks, duplicate
handling, body bounds, and a policy recheck after reading the body. Zero work
removes proof ceremony, not authentication, ordering or admission control.

This is a proposed API change. Keep domain-separated challenge formats and the
different authority models: public blob submission, secret-authorized channel
append, and signed naming updates. The shared integer bucket and work arithmetic
are the useful common code already extracted. A generic coordinator would obscure
the different transaction and await boundaries.

### 6. Keep the next naming and runtime steps narrow

For hosted names, prefer parent-before-child **naming admission**, while allowing
ordinary blob uploads in any order. That avoids a persistent orphan-resolution
queue. Reuse record verification; keep the ordered selector as the sole service
head rule. The unordered graph resolver remains a useful offline experiment.
Preserve admission facts and recovery capacity; the 256-node experiment cap must
not become a permanent lifetime cap on a public name. A name can initially point
straight to root source; a project manifest is needed only when it has concrete
multi-file or metadata semantics. Hash imports already pin dependencies.

For the workbench, the useful boundary is still one trusted shell, a cancellable
execution session, and explicit input/output/verified-load operations. Add the
real Sprig adapter there. Workspace persistence, UI attachment and VM lifetime
can then grow separately. Generalizing the finite Moss worker into a scheduler,
or implementing a Sprig IDE before that adapter works, adds decisions without
testing the boundary we currently need. Keep the small visible fern as an
end-to-end check while the implementation underneath changes.

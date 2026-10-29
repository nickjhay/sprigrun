# Service review and next naming boundary

29 October 2026. Review of the source store, upload proofs, channel hub, clients,
local launchers, and offline naming experiments. The small refactors below are
implemented. The hosted naming API and retention classes are agreed directions,
not new deployed endpoints or a garbage collector.

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
age/count/byte retention before every delivery, and subscription setup builds a
batch twice. Count/byte trimming could move to append, with age-aware read queries
and reuse of the initial batch. Preserve cursor gaps, escaped frame-size bounds,
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

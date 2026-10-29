# Security review — v0.5.0, updated 29 October 2026

This release uses `hash_length` addresses and bounded outstanding challenges.
The review covers code, emulated Cloudflare integration and failure injection;
it is not an independent audit or a claim about a deployed configuration.

The October 29 [threat model](../THREATS.md) maps the critical invariants to their
implementation and distinguishes byte integrity, recoverability and history.
[OPERATIONS.md](OPERATIONS.md) supplies a disposable deployment rehearsal; local
restart checks do not establish cloud recovery or bounded bills. The store
preserves reservation, publication and block times/epochs in SQLite. R2 metadata
is intrinsic to the payload; it cannot reconstruct service history. The coordinated
[snapshot and restore tool](RECOVERY.md) now has a local loss/recovery drill;
independent backup custody, newer-history reconciliation and cloud recovery
measurement remain operational work. There is no hosted naming admission journal.

## Admission and proof invariants

- With both work parameters zero, `POST /b` needs no ticket or precomputed hash.
  It durably debits the same global attempt bucket before reading any body. The
  publication lock rechecks work policy and pause after reading. Raising either
  work parameter blocks direct POST; it returns `428 proof_required` and guidance.
  There is no permanent replay record for this path: each request spends attempt
  credit, while duplicate source reserves no additional growth. Concurrent identical
  POSTs converge on one receipt and original timestamp.
- Ticket IDs are random 256-bit values. Authoritative address, expiry and target
  live in SQLite. No client-supplied target, length override or signature is trusted.
  The proof hashes a versioned, unambiguous message including ID, address, expiry,
  target and a fixed-width nonce. It is bound to this store by the outstanding ID.
- Issuance does not claim or debit an advertised address. It only stores a small
  ticket after global issuance-rate and table-cap checks. Invalid submissions
  cannot permanently burn a legitimate content address by naming it in advance.
- All ticket mutation uses the singleton's bounded FIFO mutex. Verification uses
  the stored target, then expiry is rechecked. Successful verification deletes
  the record and explicitly flushes storage BEFORE returning admission to the
  HTTP Worker. Parallel solutions/replays cannot authorize another body.
- The ticket remains consumed on hash/length/format failure, stream timeout,
  insufficient growth quota, R2 failure or a lost response. Unknown, consumed and
  expired IDs fail closed. Failed proofs consume attempt credit but leave the
  ticket available for a correct solution. New retries require fresh challenges.
- Expiry plus a persistent token bucket bounds outstanding live records. The
  hard cap stops new issuance without evicting unexpired records. Cleanup is lazy,
  with an expiry index. Restarts retain outstanding records and consumed absence.
  A database rollback must be followed by clearing tickets before reopening
  traffic; restoring an old database can otherwise restore already-used tickets.
- Difficulty changes apply only to newly issued tickets. This avoids invalidating
  honest work underway. Pause stops all admission immediately. Previously issued
  tickets can be used after resume if still valid; wait through expiry if needed.

## Content and quota invariants

The Worker reads at most the declared address length (addressed PUT) or configured
cap (direct POST), within the deadline. The RPC boundary independently checks length,
actual SHA-256 and fatal UTF-8/ASCII. Header lengths cannot substitute for actual
counting. Compressed uploads are rejected. A fixed allocation copies each chunk
immediately, avoiding retained chunk lists or oversized backing buffers.

Only validated bytes can create a permanent pending receipt. Both growth buckets
are debited atomically, and that transaction is durably flushed before any R2
write. A failed/ambiguous write retains its reservation; a fresh-ticket retry can
complete it without a second debit. Direct POST retries get fresh attempt admission
without a ticket while work is off. No automatic refunds can create uncharged
stored data. Stored receipts refuse all recreation, including after eviction.
Direct duplicate success verifies actual stored bytes and original timestamp;
missing/corrupt storage fails closed instead of returning a receipt as availability.
Duplicates validate the stored source policy; tightening the policy for new
uploads does not reinterpret existing objects.

Reservation, publication and block are immutable facts with separate epochs and
service times. `submitted_at_ms` is assigned at first publication, after private
R2 preparation. Retries preserve both reservation and publication facts. The epoch
is assigned inside the coordinator's commit, never cached by upload Workers.
No global per-upload sequence is allocated; these clock values are not naming
acceptance, monotonic time or proof of when a client sent its bytes.

The live FIFO holds at most 32 short metadata commits. Client body reception and
R2 awaits stay outside it. A separate eight-operation pool bounds preparations,
including per-address waiters. Same-address retries serialize in that pool. Quota
reservation is durable before the one conditional R2 PUT; publication rechecks
block/pause/work state afterwards. Private bytes alone never authorize a read.

Blocks commit refusal in SQLite with no R2 operation. All live GET/HEAD/304 requests
consult current metadata before R2 and verify length, hash and stored encoding
before success. An in-flight read admitted before a block can finish. Unpublished,
blocked or incomplete-restore state fails closed. Corrupt/missing/unsupported R2
objects fail even if their receipt claims publication. Stricter new ASCII admission
does not invalidate an older valid UTF-8 contract.

The barrier seals an epoch using maintained counters, not a receipt scan. Its
active 24-hour cut pins only payloads published and unblocked at that epoch.
Later blocks refuse live reads while preserving the old snapshot body. Explicit
admin reclamation requires a permanent block and no such pin; no automatic cleanup
is implemented. A late PUT can leave private orphan bytes after deletion, but its
publication check cannot resurrect a blocked address. Repeat reclaim if needed.
Expiry/abort releases the pin and makes that unfinished snapshot unusable.

The exporter validates and fsyncs all records before authenticated finish. Finish
persists its retry outcome before releasing pins; the CLI then fsyncs its trailer.
`recover finish` handles a complete prefix after lost replies, including restart.
A new snapshot or explicit release retires the prior finish outcome. The v2 archive
validates exact bodies, logical facts, epoch membership, ordered checksum and totals.
Restore requires an isolated empty target; it clears tickets, starts credit at zero
and stays paused. Both the deployment gate and SQL session prevent partial reads.
Newer suppression history and independent backup custody remain operational duties.

The HTTP Worker is the trusted admission caller of `publish`. Durable Object RPCs
are internal binding capabilities, not public HTTP endpoints. Do not expose the
DO binding to untrusted Workers or add a public path that calls publication
without redemption or metered open admission. Test-only fault methods are
excluded from production builds.

## Other boundaries

- Admin tokens require 64 hexadecimal characters and constant-time comparison.
  Admin routes have no CORS permission; disabled/unauthenticated routes look absent.
  Upload credentials are rejected. Logs contain generic failure names only.
- Public source responses are plain text with nosniff, restrictive CSP and private
  browser caching. GET ignores shared Cache API entries. The stats cache exposes
  counters only. R2 must stay private; custom rules must not bypass verification.
- Solvers verify challenge structure, bind it to the locally computed address,
  and bound trials and elapsed time. They do not mutate source. The upload helper
  copies mutable input, bounds response bodies and verifies acknowledgements;
  the loader verifies exact bytes before decoding. No server-provided code runs.
- Schema 3 replaces earlier undeployed local state and is checked at startup.
  There is no migration or compatibility archive reader. Reset/reseed disposable
  development state; never repoint an old live bucket at a fresh coordinator.

## Practical limits

Anonymous clients can exhaust issuance, proof-attempt or growth budgets. Valid
proofs can be stolen if the ticket/solution is disclosed; use HTTPS, and don't log
them. The protocol provides resource pricing and replay protection, not publisher
identity or fair access. Issuance can fill the bounded table without solving work;
the global issuance bucket bounds this, but cannot guarantee availability.

PoW verification still costs requests and DO calls. Edge rejection still costs a
Worker invocation when it reaches the Worker. GETs and invalid traffic are not
bounded by the byte quota. The 100 ms CPU limit limits one invocation, not bills.
SQL row counts are logically bounded for tickets, but database/index/internal
metadata allocation must be measured. Permanent receipt facts grow;
this single SQLite DO eventually reaches its 10 GB limit under sustained use.

UTF-8 accepts arbitrary encoded data and is not a Sprig syntax check or moderation
filter. Runtime sandboxing and host resource limits remain necessary. A matching
hash establishes byte identity, not execution safety. Browser/downloaded copies
and already-running responses cannot be recalled after a block.

The body deadline does not cancel an issued R2 operation. A hung R2 preparation
occupies one of eight slots; same-address waiters also occupy slots. It does not
hold the live commit queue: block, pause and barrier can still run. Flooding short
metadata operations can exhaust that queue and require admin retry; provider-wide
outages can still deny service. Public reads now depend on the coordinator and R2.
The route-level emergency stop remains independent of either application's health.
Restore may serialize R2 work, but only on its fresh isolated target.

## Validation evidence

The service/client/CLI suite and both strict TypeScript targets cover
parallel redemption with different valid solutions to one ticket, wrong-body
attempts, wrong-address/weak/replayed proofs rejected before any body reads,
expiry/capacity/rate bounds, persistent tickets/consumption/overrides across restart,
new work quotations, real CLIs, and legacy-schema refusal. Previous quota, format,
stream-buffer, corruption, block-race and ambiguous-write protections remain tested.
Current validation includes five strict TypeScript configurations, the repository
suite, pricing arithmetic and a Wrangler dry run. New tests hold R2 calls across
barriers, saturate preparation slots, block while copying, expire pins, restart
finish/restore, reject incomplete archives and recover the fern after both local
stores are deleted. Test-only methods never enter the production bundle. These
checks do not establish cloud latency, provider billing or deployment safety;
no Cloudflare resource has been created or deployed during this work.

References: [DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

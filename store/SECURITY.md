# Security review — v0.5.0, 27 October 2026

This release uses `hash_length` addresses and bounded outstanding challenges.
The review covers code, emulated Cloudflare integration and failure injection;
it is not an independent audit or a claim about a deployed configuration.

## Admission and proof invariants

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

The Worker reads at most the declared address length, within the configured cap
and deadline. The RPC publication boundary independently checks exact length,
actual SHA-256 and fatal UTF-8/ASCII. Header lengths cannot substitute for actual
counting. Compressed uploads are rejected. A fixed allocation copies each chunk
immediately, avoiding retained chunk lists or oversized backing buffers.

Only validated bytes can create a permanent pending receipt. Both growth buckets
are debited atomically, and that transaction is durably flushed before any R2
write. A failed/ambiguous write retains its reservation; a fresh-ticket retry can
complete it without a second debit. No automatic refunds can create uncharged
stored data. Stored receipts refuse all recreation, including after eviction.

Publication checks permanent receipt state again under the mutation lock. R2
conditional create and serialized blocking prevent overwrites/resurrection. A
block first writes its receipt and then replaces R2 with a fresh random tombstone.
A failed R2 block is reported as failure and must be retried: the previous object
may still be readable in that interval. An empty original still gets a new ETag.

Read requests fetch R2 directly and verify both address length and digest before
returning content or 304. They also check recorded source format; raw/binary,
missing/unknown metadata, false UTF-8 labels and corrupt data fail closed. Changing
new-upload policy to ASCII does not invalidate previously stored valid UTF-8.

The HTTP Worker is the trusted admission caller of `publish`. Durable Object RPCs
are internal binding capabilities, not public HTTP endpoints. Do not expose the
DO binding to untrusted Workers or add a public path that calls publication
without redemption. Test-only fault methods are excluded from production builds.

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
- v0.4 storage schema is rejected instead of being silently reinterpreted. v0.5
  uses fresh Worker/DO/R2 names by default. Existing installations need a planned
  migration preserving block records and quota history, which is not supplied.

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
metadata allocation must be measured. Permanent receipts and tombstones grow;
this single SQLite DO eventually reaches its 10 GB limit under sustained use.

UTF-8 accepts arbitrary encoded data and is not a Sprig syntax check or moderation
filter. Runtime sandboxing and host resource limits remain necessary. A matching
hash establishes byte identity, not execution safety. Browser/downloaded copies
and already-running responses cannot be recalled after a block.

The 10-second body deadline does not abandon in-flight R2 operations. An unresolved
R2 write can stall the 32-operation mutation queue, including admin calls. Releasing
its lock on a timer could permit late publication to race a block. Public reads
remain independent; disabling the Worker route is a broader operational stop.

## Validation evidence

All 62 service/client/CLI tests and both strict TypeScript targets pass. Tests cover
parallel redemption with different valid solutions to one ticket, wrong-body
attempts, wrong-address/weak/replayed proofs rejected before any body reads,
expiry/capacity/rate bounds, persistent tickets/consumption/overrides across restart,
new work quotations, real CLIs, and legacy-schema refusal. Previous quota, format,
stream-buffer, corruption, block-race and ambiguous-write protections remain tested.
The Wrangler deployment dry run passes. All nine Python pricing tests pass separately.
No Cloudflare resource was created or deployed during this work.

References: [DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

# What this slice establishes, and what it does not

## Executable protocol obligations

1. **One spelling per reference.** Let E erase slash/dot distinctions and D
   reconstruct them with the token grammar. The path parser accepts p only if
   D(E(p)) = p. Therefore E(p) = E(q) for accepted paths implies p = q.
   Generated round-trip tests exercise the grammar; this argument is not a
   machine-checked proof of the TypeScript implementation.
2. **Exact signed intent.** The metadata, verb, origin, destination/anchor and
   payload are in the signed bytes. Copy inputs before awaits; preserve all body
   bytes. Unknown fields and versions reject rather than acquiring inferred meaning.
3. **Bounded interpretation.** Fixed metadata/record/body/path sizes, fixed
   field counts, bounded topic depth and one optional plot-to-key hop. No dynamic
   spec download, generic redirect resolver or URL fetch during verification.
4. **Stable authority evidence.** Content-address the key record, retain the
   original fixed plot binding, verify the chosen author label. A supplied binding
   is not independently authenticated by its hash.
5. **Continuation follows acknowledgement.** An identical retry keeps its action
   ID. A repeated intended append waits for its receipt and uses the actual result
   as its new anchor. Wrong actions, wrong collections and non-advancing results
   cannot pass the continuation helper.
6. **Numbers do not lose precision.** Canonical u64 strings/BigInt, explicit
   overflow, no floating-point counter representation. SQL keys can use padded
   decimal TEXT; paths use ordinary unpadded canonical decimal.

## Native-host obligations exercised by SQLite/R2 tests

- Gate attempts before crypto/storage work, bound concurrent preparations, and
  debit private source reservation before R2. Charge permanent action metadata
  in acceptance. HTTP body reception shares the eight active slots and attempt
  debit; actual byte count and total deadline bound each application reader.
- Resolve plot author bindings from trusted retained history. Check target
  authority, content visibility and author admission inside the local acceptance boundary.
  Hiding a retained key never changes its verification authority; author blocks
  only prevent new actions. Exact retries still obey receipt visibility.
- An anchor must exist in that collection. A valid old anchor allows intervening
  commits; a future/gap anchor rejects. GET creates no state.
- Atomically commit the action's unique identity, next never-reused collection
  number, one result row (unique path and action), metadata growth debit and
  immutable receipt. For source values, reject a different action after the first
  publication commit, before debiting acceptance credit. Exact authorized retries
  return the original receipt; preparations claim no public first-publication right. Private
  source storage has a separate earlier reservation so abandoned PUTs are paid.
- Admit a signature at most once per exact action; a valid signature by itself
  does not prevent replay. Preserve consumed identities through suppression
  and restore. Verify that claimed author/key evidence matches admission policy.
- Keep blob preparation outside short metadata commits. No R2 await or arbitrary
  user computation in that commit. Preserve the existing lost-reply, ambiguous
  PUT, late-preparation and bounded-preparation failure cases.
- Tag accepted immutable facts by snapshot epoch. Advance the barrier with
  bounded control state; export later. Counters and heads must be reconstructible
  or have retained historical allocation facts.
- Receipt/body suppression must not erase the consumed action ID or make old
  addresses reusable. A removed payload can make verification unavailable.

## Recovery obligations exercised by SQLite/R2 tests

- Commit a reconstruction fact, its journal pointer and monotonic u64 recovery
  position atomically. Rejected actions, retries and reads add no journal entry.
- Copy a closed epoch while later commits continue. Project private preparations
  at the cut; preserve their debit without requiring unpublished bytes.
- Restore times, numbers, accounting, key evidence, receipts, content hiding and author blocks
  together. The archived moderation count must match its contiguous history. Match every entry and published source to retained acceptance.
- Verify source hashes, exact action/receipt correspondence, signature evidence,
  authority and referenced facts before completing the import.
- Commit each imported record with its resume cursor. A repeated acknowledgement
  or ambiguous R2 write must not duplicate history or debit.
- Require an empty target, matching origin/policy and pinned final chain digest.
  Bind each increment to the exact preceding cut/digest and journal identity.
  Missing/reordered/duplicate positions or segments cannot complete the plan.
  Persist quarantine independently of environment settings; incomplete or invalid
  history cannot become readable by accidentally dropping the setting.
- Leave restored writes paused and spendable credits zero. An old snapshot cannot
  reveal its unknown suffix. Reopening the same origin with unreconciled lost
  history can replay actions or reuse numbers; release is an explicit operator
  assertion, not a proof that the suffix has been recovered.

## HTTP obligations exercised against the real runtime

- Require exact signed/actual URL agreement and explicit signed-envelope mode.
- Serve raw UTF-8 as inert text; escape all user content in trusted HTML.
- Check suppression before aliases, listings, receipts, evidence and conditional
  reads. Never return corrupt R2 bytes or rewind latest behind a hidden head.
- Examine at most 32 indexed rows per page; permit empty pages with continuation.
  Listings fetch no R2 bytes and GET writes no durable view counter.
- Admit attempts before application body reads, bound body size/time and shared
  active slots, and release slots after timeout/error. Transport may prefetch.
- Authenticate fixed operator routes, keep test faults out of the public Worker,
  and preserve persistent quarantine through the authenticated recovery adapter.

## Remaining public-host obligations

- Keep API handling ahead of static fallback. Serve untrusted bytes as inert text
  on the shared origin. Gate reads before shared caching can bypass suppression.
- Measure provider/transport cost and load beyond the application limits. The
  read bucket is volatile overload protection, not a durable billing cap.
  Wire optional PoW without penalizing the zero-work raw POST path.

The [native host](host/README.md) now implements the real acceptance transaction
with fault-injection tests, [whole-core recovery](RECOVERY.md), and a locally
tested [HTTP surface, operator transport and explorer](HTTP.md).
No guest execution, key-recovery tree, arbitrary MIME or decentralized ordering
is needed for the first public core.

Before public release, establish a recovery procedure, calibrate metadata/traffic
limits and costs, and establish report/suppression and independent backup
operations. The protocol demo and frozen fixtures make none of those claims.

## Logical-owner and policy obligations

- Result, receipt and evidence paths derive the same stable logical owner. Source
  preparation stays with that source; numbered results stay with their collection.
  This version still has one physical coordinator and no cross-shard resolver.
- Policy application and cursor updates commit together. Gaps/conflicting history
  reject; a delayed identical change cannot replace a newer decision.
- Refresh work is bounded to 32 changes per tick, coalesces concurrent calls and
  backs off unavailable upstreams. The local authority requires no poller.
- A block does not hide historical signatures. A hide does not revoke signing
  authority. Public evidence and exact-retry receipts cannot bypass hiding.
- Direct result reads use retained accepted state, never a discovery listing as
  proof of acceptance. Future cross-owner reads must retain this trust boundary.

## Fixed-roster barrier obligations (D1 laboratory)

- Partition capacity and refill sums equal the global policy, including remainders.
- Persist and check topology/member/journal identity; missing data cannot silently
  bootstrap a fresh writer. Initialize only over pristine members.
- A durable hold gates every recoverable mutation and attempt debit, with no R2
  await in the transaction. Private uploads do not postpone the boundary.
- Cut each member once; publish the complete manifest before releasing anyone.
  Fetch release evidence from the trusted controller and compare the local cut.
- Replay lost replies and restart at each stage without undoing manual pause,
  duplicating cuts or reopening an incomplete manifest.
- Preserve barrier facts in full/delta archives; refuse standalone shard recovery
  release until a whole-cluster procedure exists. Public sharded HTTP stays off.

See [BARRIER.md](BARRIER.md) for scope, failure evidence and D2 completion gates.

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
  in acceptance. Public body reception and read-traffic bounds remain ahead.
- Resolve plot author bindings from trusted retained history. Check target
  authority and current suppression inside the eventual acceptance boundary.
- An anchor must exist in that collection. A valid old anchor allows intervening
  commits; a future/gap anchor rejects. GET creates no state.
- Atomically commit the action's unique identity, next never-reused collection
  number, accepted record, metadata growth debit and immutable receipt. Private
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

## Remaining public-host obligations

- Restore times, numbers, quotas, key evidence, receipts and suppression together.
  An old snapshot cannot reveal its unknown suffix. Reopening the same origin
  with unreconciled lost history can replay actions or reuse numbers.
- Keep API handling ahead of static fallback. Serve untrusted bytes as inert text
  on the shared origin. Gate reads before shared caching can bypass suppression.
- Bound HTTP body reception, read traffic and network lifetime. Authenticate
  operator controls; expose no test hooks. Wire optional PoW without penalizing
  the zero-work raw POST path.

The [native host](host/README.md) now implements the real acceptance transaction
with fault-injection tests. Its epoch cut is not yet a backup/restore facility.
The next substantial work is whole-core recovery, then the public HTTP surface.
No guest execution, key-recovery tree, arbitrary MIME or decentralized ordering
is needed for the first public core.

Before public release, complete the recovery drill, calibrate metadata/traffic
limits and costs, and establish report/suppression and independent backup
operations. The protocol demo and frozen fixtures make none of those claims.

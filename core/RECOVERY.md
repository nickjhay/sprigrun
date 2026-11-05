# Whole-core recovery

The native core exports a committed prefix of its SQLite metadata and the
immutable R2 bodies accepted within it. Full and incremental copies share one
format and restore into an empty, quarantined target. Capturing a checkpoint is
read-only: publishing continues throughout the copy. There are no epochs, stored
cuts or global barriers in the active core.

```sh
npm run demo:recovery                    # Real local SQLite/R2 loss drill.
npm run demo:recovery -- ./garden.jsonl  # Keep an archive at a new path.
npm run verify:recovery -- ./garden.jsonl --chain SHA256_PRINTED_BY_BACKUP
npm run test:recovery                    # Full + delta loss/restart and corruption cases.
```

Node 24 is required. Offline verification and authenticated clients need no
Cloudflare runtime. Local drills/tests also need workerd. Nothing here deploys
or schedules a backup. Never expose privileged test adapters publicly.

## Capture once, copy at any pace

`checkpoint()` synchronously reads the bounded control row, policy and capture
time, then waits for `storage.sync()` before returning that header. It performs
no SQL mutation, R2 I/O or history scan and does not wait for pending uploads.
The header pins the journal identity and inclusive position P. Keep the returned
header on the client; the server does not store checkpoint rows.

The `journal` orders pointers to immutable source reservations, accepted results
and moderation decisions; pause/unpause is a small inline fact. Each fact,
pointer and position commits together. It duplicates no payload. The result
row includes its original receipt, signature evidence and submission time, so
this feed indexes every accepted object, not just source blobs. `heads` is
reconstructed from numbered results. Gaps remain gaps. Any future allocator that
reserves numbers without results must journal that reservation too.

Pages query only `after < position <= P` in the pinned journal. A new write cannot
lengthen the scan. Every accepted source points to R2 bytes whose conditional PUT
completed before its SQL acceptance. Hash-addressed bodies and historical rows
remain immutable, so a later copy still represents the captured prefix.
A paid reservation before P needs no unpublished body; if it commits after P,
its body accompanies the result in a later increment. Failed/abandoned uploads
remain paid and can be retried without a new reservation.

Attempt debits, exact retries and reads add no journal fact. The header preserves
historical quota state; recovery zeros spendable credit rather than replaying
individual admission decrements. A checkpoint at the same journal position can
therefore have different operating credits or capture time. Empty full copies
and empty increments are valid.

Export examines at most 32 positions per response with a soft 512 KiB encoded
budget; one larger bounded record is allowed. At most two exports run at once.
Each included source body needs one verified R2 GET. Metadata/inline facts need
none; increments do not reread earlier accepted sources. Normal source POST still
costs one R2 PUT. Restore normally PUTs each accepted source once; an ambiguous
write retry may add a verification GET.

## One portable stream

Canonical JSON Lines, `sprig-native-snapshot/7`: header, contiguous journal facts,
then count and SHA-256 chain. Full copies start at position zero with `base: null`.
Increments bind `{chain, checkpoint}` from the exact predecessor, including its
journal identity, control and policy. They may start from another increment.
Counters use decimal text, record positions use padded u64 text, and each
physical line is bounded to 2 MiB. Output is exclusive, mode 0600 and fsynced.

| Record | Retained information |
| --- | --- |
| Source reservation | Address, size, debit and reservation time; no body |
| Accepted result | Placement, exact action, receipt, signature evidence, acceptance time and debit; source body when applicable |
| Moderation | Contiguous hide/block decisions and submission time |
| Pause | Boolean control transition |

At the end, replayed counters, position and pause state must match the header.
There is no final cut record. Backups include suppressed content and need
appropriate custody. Physical deletion/GC is not implemented: future deletion
must account for outstanding copies and the chosen backup-retention policy.
Unaccepted R2 bytes do not belong to the recoverable public history.

## Capturing and restoring

[OPERATIONS.md](OPERATIONS.md) covers the read-only backup credential and witness
custody. Keep the trusted final digest independently from the archives and
primary service. An adjacent checksum alone is not authenticity.

With `SPRIG_ADMIN_TOKEN` supplied privately and the routed target configured with
`CORE_RESTORE_MODE=1`, restore a full copy and every successive increment:

```sh
node core/scripts/recover.mjs restore https://sprig.run --chain TRUSTED_FINAL_SHA256 \
  /backups/full.jsonl /backups/delta-1.jsonl /backups/delta-2.jsonl
```

The client verifies all files and exact base/digest links before mutating the
target. It pins the final digest, resumes after interruption and leaves quarantine
in place. A plan is bounded to 1,024 files; take periodic full copies.

Programmatic helpers in `scripts/recover.mjs` accept local or authenticated RPC:

- `backup(core, file, checkpoint?)`: copy a new or previously captured header.
- `incrementalBackup(core, file, baseFile, baseChain, checkpoint?)`: copy only
  the suffix after an independently verified predecessor.
- `verifyChain(files, finalChain)`: verify framing, bodies, accounting and links.
- `restoreChain(core, files, finalChain)`: preflight, then import or resume.
- `prepareRestoreChain(files, finalChain)`: preflight once and return bounded
  descriptors plus `restore(core)`; import still checks bytes and digests.
- `restore(core, file, fileChain, finalChain = fileChain)`: import one segment;
  pin the ultimate target when more segments must follow.

The first segment requires matching origin/policy, empty SQLite and an empty
private R2 bucket. A persistent quarantine marker precedes bucket inspection.
Normal reads, publishing, moderation, checkpoints and unpause are blocked by both
the environment fence and that marker. Dropping the flag early cannot expose
partial history.

Each result verifies its action ID, receipt, signature, key/plot authority and
already imported dependencies. Each fact, journal pointer and resume cursor
commits together. Only the identical last-record retry is accepted. Bodies are
hash/length checked before conditional PUT. Lost replies, failed PUTs and restart
cannot duplicate accepted history or debit. Changing an archive after preflight
cannot authorize different history.

`restoreFinish()` checks the completed segment in constant work. Earlier segments
enter `awaiting_delta`; only the pinned final digest enters `restored`. Completion
preserves original numbers, times, receipts and counters, pauses writes and zeros
spendable growth/burst/attempt credits. Release requires the final digest and
`history-reconciled`, then separate removal of restore mode and explicit unpause.
The forced pause becomes a new journal fact only on release, after the trusted
suffix, so it cannot consume a position needed by a later imported segment.

## What asynchronous backup promises

A successful copy recovers its entire captured prefix, including accepted R2
bodies. It does not prove that no later acknowledgements exist. Before reopening
the same numbered namespace, fence the old writer and reconcile any later
allocations, consumed actions and takedowns. Otherwise names could be reused or
signatures replayed. Keep an uncertain target quarantined; the release assertion
is an operator responsibility, not an automated proof of suffix completeness.

Cloudflare SQLite point-in-time recovery does not by itself recover R2 bodies or
provide an independent backup. Litestream needs access to SQLite/WAL files, which
this Durable Object adapter does not expose. The logical feed is our portable
backup boundary; no WAL shipper or continuous replica is installed.

Future shards may capture and recover independently, with weaker cross-shard
consistency. References across them may temporarily be unresolved. Relationships
that require an atomic commit should share a shard. Placement, reconciliation
and writer fencing will need design when sharding is implemented; a global
snapshot barrier is **not** a retained requirement.

## Schema 7 transition (before deployment)

Database schema 7, archive `sprig-native-snapshot/7`, witness
`sprig-backup-witness/3`. Old schemas are refused before mutation; old archives
fail with `archive_version`. No state is deleted, migrated or silently converted.
Public signed formats and receipts remain version 1.

Preserve old local state and explicitly choose a fresh directory:

```sh
npm run dev:core -- --state .local/native-http-v7 --operator
```

The complete epoch/cluster implementation, tests and schema-6 reader are preserved
on [reference/epoch-core-2026-11-05](https://github.com/nickjhay/sprigrun/tree/reference/epoch-core-2026-11-05)
at `c2c2ad7b7ffd62552039cc39395df0744654e714`. Use that checkout and lockfile to
read earlier data. There is no deployed-data migration or conversion tool.

# Whole-core recovery

The native core exports coherent SQLite/R2 snapshots and incremental suffixes,
then restores them into an empty, quarantined target. This is an operator
facility; [HTTP.md](HTTP.md) describes authentication. Never expose the local or
test adapters on a public Worker. Nothing here deploys or schedules a backup.

```sh
npm run demo:recovery                    # Real local SQLite/R2 loss drill.
npm run demo:recovery -- ./garden.jsonl  # Keep an archive at a new path.
npm run verify:recovery -- ./garden.jsonl --chain SHA256_PRINTED_BY_BACKUP
npm run test:recovery                    # Includes full + two-delta loss/restart drill.
```

Node 24 is required. Offline verification and authenticated backup/restore clients
need no Cloudflare runtime. The local drill/tests also need workerd. They create
fresh development keys and disposable local storage, then check exact receipts,
signatures, times, bodies, policy, accounting and continued numbering.

## The boundary and the copy

`cut()` saves bounded control state and policy at epoch N and advances to N+1
in one synchronous SQL transaction. It includes its own recovery position.
There is no R2 I/O, history scan or wait for uploads in that transaction. Success
waits for durability. This is one coordinator's cut, not a distributed snapshot.

A small `journal` index orders pointers to immutable facts. Each fact, pointer
and position commits together. Pause/unpause is a small inline fact. No source
or message body is duplicated in this live index. GETs, rejected attempts and
exact retries create no journal entry. Attempt-credit decrements need not be
replayed: restoration resets all spendable credits to zero. Cuts preserve their
historical bucket values. [INCREMENTAL.md](INCREMENTAL.md) records the design.

A full archive starts at position zero. A delta starts after an earlier cut and
binds that cut, its journal identity and the preceding archive digest. Both end
at a closed cut, regardless of later writes. A source reserved before the cut
but published afterward appears as a bodyless reservation in the earlier file;
its exact body accompanies the acceptance in the later file. Slow or ambiguous
PUTs therefore do not delay the cut or leak later publication into it.

Export examines at most 32 journal positions per response, with a soft 512 KiB
encoded-response budget (one larger bounded record is allowed). At most two
exports can be in flight. Source acceptance costs one verified R2 GET; other
facts need none. A delta does not reread bodies accepted before its base cut.
There is no history scan in the coordinator, and normal source POST still uses
one R2 PUT. Restore normally PUTs each accepted source once with its digest
checksum; an ambiguous-write retry may add a GET to verify existing bytes.

The format is canonical JSON Lines, `sprig-native-snapshot/6`: header, records
in contiguous recovery-position order, then count and SHA-256 chain. The header
contains `base: null` for a full snapshot, or `{chain, cut}` for a delta. Every
record has a padded u64 `position`. The maximum physical line is 2 MiB, allowing
escaped UTF-8. Large counters stay decimal text. Output is exclusive and fsynced;
an existing backup is never overwritten.

| Fact | Archive representation | Recovery purpose |
| --- | --- | --- |
| Source reservation | Size, debit, reservation epoch and time | Abandoned uploads remain paid |
| Result | Exact action, signature evidence, placement, receipt, acceptance time/epoch and debit | Preserve first publication, consumed actions and collection numbers |
| Published source | Exact UTF-8 body alongside its result | Verify hash/size; omit unaccepted private bytes |
| Moderation | Ordered hide/block decisions, including original issue epoch/time | Preserve policy and delayed delivery order |
| Pause | Boolean control fact | Reconstruct pause state at each cut |
| Cut | Original control, policy and time | Validate counters, epoch and closed position |

Late policy delivery cannot enter a closed journal prefix, even if its issue
epoch is older. `heads` is rebuilt from committed numbered results. Gaps remain
gaps. A future allocator that reserves numbers without results must journal
those reservations before that behavior ships. There is no public global order.

No physical deletion or cut-release facility exists yet. Every cut remains
exportable while its accepted bytes exist. Future deletion must respect backup
pins/retention and suppression policy. Backups contain suppressed accepted data;
protect them accordingly. Unaccepted private bytes need not be copied; their
reservation survives without a refund so a retry can upload them again.

## Capturing and restoring a chain

[OPERATIONS.md](OPERATIONS.md) provides the backup credential, witness custody and
commands for full and incremental capture. Keep the final trusted witness under
independent custody. A checksum beside a modified file is not authenticity.

With `SPRIG_ADMIN_TOKEN` supplied privately, and the target configured with
`CORE_RESTORE_MODE=1`, restore a full file and all successive increments:

```sh
node core/scripts/recover.mjs restore https://sprig.run --chain TRUSTED_FINAL_SHA256 \
  /backups/full.jsonl /backups/delta-1.jsonl /backups/delta-2.jsonl
```

Use a routed recovery target for that canonical origin; stop/fence the old writer
before reopening. The command verifies every file, base cut and digest link before
mutating the target. It pins the final digest for the whole plan, resumes after
restart, and **does not release quarantine**. A plan currently allows at most
1,024 files; take periodic full snapshots or use larger incremental intervals.

Programmatic helpers in `scripts/recover.mjs` accept local or authenticated RPC:

- `backup(core, file, epoch?)`: full copy of a new or existing cut.
- `incrementalBackup(core, file, baseFile, baseChain, epoch?)`: copy after the
  independently verified predecessor; the predecessor can itself be a delta.
- `verifyChain(files, finalChain)`: offline framing, source hashes, accounting and
  complete digest/cut linkage. Returns checked headers/footers, not all bodies.
- `restoreChain(core, files, finalChain)`: preflight the plan, import or resume it.
- `prepareRestoreChain(files, finalChain)`: preflight once and return checked
  final descriptors plus `restore(core)`. Cluster recovery reuses this plan
  after preflighting all members, without rescanning each complete chain.
- `restore(core, file, fileChain, finalChain = fileChain)`: import one segment;
  supply the final target when more segments must follow.

The first segment requires matching origin/policy, an empty database and an empty
private R2 bucket. A durable quarantine marker precedes the bucket inspection.
Normal reads, submissions, moderation, cuts and unpause are blocked by both the
environment setting and persistent quarantine. Dropping the setting early cannot
expose partial history.

Records are imported in dependency order. Each result verifies its action ID,
receipt, retained key/plot authority, signature and referenced predecessors before
its SQL insertion. Each imported fact, journal pointer and resume cursor commits
together. Only an identical retry of the last imported record is accepted.
Source hashes/lengths are checked before conditional R2 PUT. Failed PUTs and lost
acknowledgements are resumable; they cannot duplicate accepted history or debit.
Prepared plans retain no bodies and never replace the target's record/hash,
authority or final-digest checks. Import rechecks framing, footer and record count;
changed bytes after preflight cannot authorize different history.

`restoreFinish()` validates the completed segment in constant work. An earlier
segment enters `awaiting_delta`; only the pinned final digest enters `restored`.
A later header must match the exact previous cut and footer. The target digest
cannot be weakened mid-import. Gaps, reordered/duplicate records, foreign lineage,
truncation, broken dependencies, invalid signatures or accounting mismatches
cannot complete recovery. The old separate `verifying` phase and temporary source
validation table are gone.

Completion restores history and counters at N+1, pauses writes and zeros growth,
burst and attempt credits. Historical credit remains in the cut. Release requires
the final digest and `history-reconciled` assertion, then separate removal of
restore mode and explicit unpause. A forced pause becomes a new journal fact
only on release, after the complete trusted suffix, so it cannot occupy positions
needed by later imports. Repeated finish/release does not reset or duplicate state.

## The unknown suffix still matters

A complete supplied chain does not prove there were no later writes. The client
can detect a missing segment relative to the pinned final digest; it cannot find
an unknown later tip. Before reopening the same namespace, fence the old writer
and establish that the trusted final cut includes every accepted action,
allocation and policy decision. Otherwise old names could be reused, signatures
replayed or takedowns undone. If trusted suffix evidence is unavailable, leave
the target quarantined. The release assertion is an operator responsibility,
not an automated proof about the original service.

Public routing still uses one physical coordinator. [CLUSTER.md](CLUSTER.md)
describes fixed placement, the global barrier and coordinated cluster recovery.
Partitioned imports require a pinned cluster plan; individual release is refused.
The shared bucket is checked once cluster-wide, and remote dependencies are
validated only after every member reaches its final trusted digest.

## Schema 6 transition (before deployment)

This uses database schema 6, archive `sprig-native-snapshot/6`, and backup witness
`sprig-backup-witness/2`. Old database schemas fail before mutation. Old archives
fail with `archive_version`; old witnesses are not silently converted. No local
data is deleted or migrated. Public signed formats and receipts stay version 1.

Preserve an old state directory/archive. To try this core explicitly:

```sh
npm run dev:core -- --state .local/native-http-v6 --operator
```

Use a separate checkout of `d301321b2fb3c70c63460f08506841eee3b23bd1`
(PR #23), including its lockfile, to read schema/archive 5. There is no production
migration yet and this change includes no conversion tool.

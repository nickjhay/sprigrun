# Whole-core recovery

The native core can now export a coherent SQLite/R2 snapshot and restore it into
an empty, quarantined target. This is an operator facility; public HTTP and
operator authentication are provided by [HTTP.md](HTTP.md). Never expose the local or
test adapters on a public Worker.

```sh
npm run demo:recovery                    # Real local SQLite/R2 loss drill.
npm run demo:recovery -- ./garden.jsonl  # Keep an archive at a new path.
npm run verify:recovery -- ./garden.jsonl --chain SHA256_PRINTED_BY_BACKUP
npm run test:recovery
```

Node 24 is required. The drill also needs a platform supported by workerd, just
like `test:acceptance`. Offline archive verification uses Node alone. The drill
creates fresh development keys, removes its original database and bucket,
restores the archive, and checks exact receipts, signed author evidence, source
bytes, plot control, suppression, debit totals and continued numbering. It never
contacts or deploys to a public service. Its fast-refilling policy is only for
the drill; the normal admission defaults are unchanged.

## The boundary and the copy

`cut()` saves the bounded control record and admission policy at epoch N, then
advances to N+1 in one synchronous SQL transaction. There is no R2 I/O, history
scan, or wait for uploads in that transaction. It waits for durability before
returning. This is one coordinator's boundary, not a distributed snapshot.

Accepted facts, source reservations and suppression changes carry an epoch.
Source publication has its own epoch: a source reserved before the cut but
published afterward is exported as a private reservation, with no public body
or submission time. Thus a slow or ambiguous PUT does not delay the cut, and a
later copy cannot accidentally pull a post-cut publication into the snapshot.

The exporter reads at most 32 indexed keys per page and one bounded record at a
time. A page bounds **rows examined**, so it may contain no eligible keys and
still advance its cursor. At most two source-record exports may be in flight.
There are no full-history reads inside the coordinator. Exporting published
sources needs one R2 GET per source; exporting SQL-only facts needs none. New
admissions keep their existing one-PUT normal source path.

Restoring normally PUTs each published source once and GETs its bytes for each
retained sea action whose evidence needs reconstruction. Retries after ambiguous
PUTs may add a GET. Restored SQL rows, heads and import progress also incur writes.
These are operator costs proportional to the retained history, so backup and
restore traffic need their own operational budget and access controls.

The format is canonical JSON Lines, `sprig-native-snapshot/3`: a header, ordered
records, then an exact count and SHA-256 chain. The maximum physical line is
2 MiB, allowing escaped control characters in a maximum-sized UTF-8 source.
Every number that could exceed JavaScript integer precision stays decimal text.
The archive file is published exclusively after its contents have been fsynced;
an existing destination is never overwritten.

| Fact | Archive representation | Why it survives |
| --- | --- | --- |
| Source reservation | Original size, debit, epoch and reservation time | Failed or abandoned uploads still used allowance |
| Published source bytes | Exact UTF-8 body beside its reservation; copied only if a result exists at the cut | Hash verification survives; private preparations remain private |
| Committed result | Path, kind, placement/controller, action, body/source, epoch/time, debit, signature evidence and original receipt | One authoritative result/receipt; uniqueness, numbering and verification survive |
| Moderation | Complete ordered hide/block history through the applied position captured at the cut | Restoring cannot quietly expose hidden content or unblock an author |
| Cut/control | Origin, epoch, policy, counters and bucket state | Historical accounting and earlier boundaries remain available |

Moderation export uses the captured applied position, not just the policy issue
epoch: delayed delivery of an older policy cannot change a closed snapshot.
The contiguous history must match the header count.

`heads` is rebuilt as the maximum committed number per collection. The current
allocator changes a head only in the same transaction as its entry, so entries
are the allocation facts; gaps remain gaps. If a future allocator reserves
numbers without entries, it must add those allocation facts to the archive
before that behavior ships. Recovery progress and temporary validation indexes
are local operator state, not new public facts.

There is no physical deletion or cut-release facility yet. All retained cuts
remain exportable while their bytes exist; any future deletion system must
respect backup retention/pins and legal suppression policy. Private bytes from
an unaccepted preparation need not be copied. Their paid reservation is kept,
without refund, so a future retry can write them again. Suppressed *accepted*
bytes are in this operator archive: protect it accordingly.

## Restoring safely

The client functions in `core/scripts/recover.mjs` accept a trusted coordinator
adapter. `backup(core, file, epoch?)` either makes a new cut or copies an existing
one. `restore(core, file, trustedChain)` verifies the complete file before
mutating the target, then resumes a previous import if it matches the same
header and footer. Keep the trusted chain separately from the archive.

Restore requires `CORE_RESTORE_MODE=1`, the same canonical origin and policy as
the cut, and both an empty database and an empty private R2 bucket. It first
persists a quarantine marker. Only then does it inspect R2 and import records.
Ordinary reads, submissions, suppression changes, cuts and unpause are blocked
both by the environment setting and by persistent quarantine. Removing the
setting early cannot expose a partially restored service.

Each source is hash/size checked and conditionally written; an ambiguous PUT can
be retried and verified. Each imported SQL record and the durable progress cursor
commit together. An exact retry of the most recently acknowledged record is
idempotent. Restarting the process resumes from that cursor.

Results are imported in path order, which need not put dependencies first.
After import, `restoreFinish()` enters `verifying`: each call checks at most 32
results and a soft 512 KiB of metadata (one larger bounded row is allowed).
It saves a verification cursor after each result. Repeated calls eventually
return `restored`; the file client drives this loop and can resume after restart.
The quarantine remains active throughout. This avoids retaining a duplicate table
just to put signature checks after all dependencies arrive.

Before completion the target checks:

- exact schemas, ordering, bounds, epochs, archive count and pinned digest;
- source hashes, recorded byte/debit totals and accepted-action count;
- action IDs, receipt correspondence, signatures and retained plot authority;
- referenced sources, authors, subjects, anchors and publication ownership;
- one result per path and accepted action, exact receipt correspondence, and
  a copied body for every published source (with no orphan copied bodies);
- contiguous moderation positions and snapshot cuts.

This validates retained evidence and internal consistency. It cannot authenticate
an unsigned host receipt or reconstruct a globally ordered history inside an
epoch. A checksum stored beside a modified archive is not an authenticity proof.
The offline verifier checks framing, source hashes and accounting; signature and
cross-reference validation also occurs in the quarantined restore target.

Completion restores the original totals and history at N+1, leaves writes paused,
and resets **spendable** growth, burst and attempt credits to zero. The historical
credits remain in the cut record; old credit is not revived as new allowance.
The target stays quarantined until a separate operator release.

## The unknown suffix matters

An archive at N cannot tell us which public names, messages, signatures or
moderation actions were accepted after N. Reopening that old image at the same
origin could reuse an already-issued number, replay an accepted action, or undo
a takedown. A successful import alone is not permission to reopen.

Reconcile the missing history from surviving journals, replicas or other trusted
evidence first. The current release method requires the exact archive digest and
an explicit `history-reconciled` declaration. This is an operator assertion,
**not an automated proof or a suffix-reconciliation tool**. If reconciliation is
impossible, do not reopen the old namespace for writes under these guarantees.

After that assertion, remove the restore-mode setting, restart, and explicitly
unpause. These are intentionally separate operations. The local drill can make
the assertion because it controls the complete isolated history and knows no
post-cut acceptance occurred. An incomplete or corrupt import is never releasable.

## Implementation boundaries

- `host/archive.ts`: portable archive framing, bounds and totals.
- `host/recovery.ts`: bounded export, quarantined import and history checks.
- `host/objects.ts` / `host/placement.ts`: source integrity and action placement
  shared with live admission.
- `scripts/recover.mjs`: bounded streaming file client and offline verifier.
- `scripts/local-native.mjs`: local privileged transport for the actual native
  coordinator. It has no authentication and is never a deployable public adapter.

The [authenticated HTTP adapter](HTTP.md) now supports these operations, using
`scripts/http-client.mjs` with the same file exporter/importer. Its integration
tests cover backup and quarantined restore through the production route handlers.

The [operations guide](OPERATIONS.md) adds an executable independent-backup runner,
a restricted export credential, separate digest witnesses, batched metadata
export, and a local cost/load rehearsal. Still before launch: actually schedule
independent backups and establish trusted-digest custody, exercise an operational
suffix-reconciliation procedure, configure report/suppression handling, and set
provider protections and capacity monitoring. The old store's recovery tools do not understand this schema.

## Schema 3 transition (before deployment)

This version uses database schema 3 and archive `sprig-native-snapshot/3`.
Opening schema 1 or 2 fails before any schema changes; importing a v1/v2 archive fails
with `archive_version`. No local data is deleted or silently migrated.

Keep an old directory/archive intact. To try the new core explicitly:

```sh
npm run dev:core -- --state .local/native-http-v3 --operator
```

For the previous reader/implementation, use a separate checkout of commit
`458e572e3f435c45da37e245b6d89525ceb810b4` (PR #20), including its lockfile.
Do not feed a v1/v2 archive into the new restore target or reopen its directory with
a new identity. No production migration is needed yet; a conversion tool is not
part of this change. Public action/key/plot/receipt formats remain version 1;
the database/archive version bump does not rewrite signed bytes or old receipts.

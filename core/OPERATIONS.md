# Operating the native core

5 November 2026. Local rehearsal and operator tooling; **nothing deployed or
scheduled**. Production remains gated on backup custody, reconciliation,
report handling, seed keys and a deployed-preview check.

## Independent backups

The runner needs Node 24, but not workerd. Configure a distinct `BACKUP_TOKEN`
Worker secret: 32 random bytes encoded as 64 lowercase hex characters. Give the
runner that value through its secret manager as `SPRIG_BACKUP_TOKEN`. Keep
`ADMIN_TOKEN` elsewhere. Never pass credentials in command arguments or URLs.
The backup credential can read checkpoint headers and export retained content,
including suppressed content. It cannot mutate state, inspect arbitrary tables,
restore or release a namespace. Its holder can still consume export resources;
rotate it if compromised. This is a privileged recovery reader.

Run on a separate machine or provider, with directories already created:

```sh
# Inject SPRIG_BACKUP_TOKEN from the runner's secret manager first.
npm run backup:core -- capture https://sprig.run /backups/sprig/2026-11-03.jsonl \
  --witness /witnesses/sprig/2026-11-03.json

# Offline framing, source hashes, accounting and independently pinned digest:
npm run backup:core -- check /backups/sprig/2026-11-03.jsonl \
  --witness /witnesses/sprig/2026-11-03.json
```

Both files are created exclusively, mode 0600, synced and never overwritten.
The version-3 witness pins origin, journal identity, starting/ending
positions, predecessor digest, final digest and record count. Keep its trusted
copy under different credentials/custody from the archive and primary service.
Different directories are required to discourage accidental bundling; **they do
not establish independent custody**. No signature from the runner or host is
implied. A compromised exporter can supply a false history before you pin it.

The command prints the captured journal position before copying. A failed request
has no backup side effects to reconcile. Retry capture with fresh output paths;
the new checkpoint may include later writes. Programmatic callers can retain the
exact header and pass it to `backup`/`capture` to recopy that prefix. A witness
failure preserves the completed archive and reports
`archive_saved_but_witness_failed`; investigate and pin it through a trusted
process, or capture again to two fresh paths. A `.partial` file left by a killed
process is not a completed archive.

Set a scheduler on the independent runner, use unique paths per attempt, prevent
overlapping jobs and alert on failures/missing witnesses. Do not auto-delete old
copies yet. Choose retention and monitor physical capacity before scheduling.
Weekly full copies are a cost scenario, not a recommended recovery-point
objective. Incremental copies shorten the gap without copying every old source:

```sh
npm run backup:core -- capture https://sprig.run /backups/sprig/delta-1.jsonl \
  --witness /witnesses/sprig/delta-1.json \
  --base /backups/sprig/2026-11-03.jsonl --base-witness /witnesses/sprig/2026-11-03.json

# Next time, use delta-1 and its witness as the base; keep the entire chain.
```

The base file and independently trusted witness are checked before reading a
checkpoint. Each increment binds the exact preceding checkpoint and digest, including its
journal identity. Retain the full snapshot and every link, not merely the newest
delta. Plan periodic full copies: recovery preflight accepts at most 1,024 files.
An hourly interval with weekly full copies stays well within that bound. A failed
or missing scheduled copy must alert; this code installs no scheduler or replica.
R2 plus SQL point-in-time recovery alone is not a coherent independent backup.

The exporter reads the captured prefix while new submissions continue. Capturing
a checkpoint writes no row, advances no counter and pauses no commit.
Responses examine at most 32 ordered journal records, with a soft 512 KiB encoded-response
budget; one valid oversized record is allowed. Each included source body needs one verified R2 read; a delta includes only
newly accepted sources. Later history cannot lengthen the closed-prefix scan. The client bounds each complete HTTP response and times out
fetch/body reading after 30 seconds. Redirects are refused, so credentials do not
follow them. Export format and digest are identical with or without batching.

Run a quarantined restore drill periodically, following [RECOVERY.md](RECOVERY.md).
Offline verification is not the complete authority/cross-reference check. Never
release a restored snapshot until the unknown suffix has been reconciled; an old
image alone cannot prove later issued numbers or takedowns did not exist.

## Repeatable local rehearsal

```sh
npm run rehearse:core             # 128 actions per case
npm run rehearse:core -- 512      # maximum; fresh local storage only
npm run test:operations           # auth, export equivalence, custody and restore
```

This creates only a disposable local Miniflare instance. There is deliberately
no remote target flag. It uses the production HTTP handlers with test-only R2
counters and SQLite allocation inspection; never deploy `core/test` modules.
The throughput profile raises attempt/burst credits to finish quickly. A separate
profile retains the production 30-attempt and 120-read burst capacities, with
negligible refill for reproducibility. Existing HTTP tests cover eight concurrent
uploads and stalled-body deadlines. This is **not a production throughput test**.

Measured on Linux/Node 24.22.1 with schema 7 (5 November 2026),
128 accepted actions per case:

| Action | SQLite bytes/action | R2 PUT/action | R2 GET/action |
| --- | ---: | ---: | ---: |
| New 32 KiB source | 1,536 | 1 | 0 |
| Exact source retry | 0 | 0 | 0 |
| Anonymous 1 KiB chat | 2,400 | 0 | 0 |
| Signed 1 KiB chat, plot author | 2,368 | 0 | 1 |
| Short publication reference | 928 | 0 | 0 |
| Long publication path | 3,936 | 0 | 0 |

These are page-allocation deltas in a small local sample, not per-row billing or
worst-case bounds. Path length, message size, insertion order, page utilization,
keys, signatures and future schema changes matter. The long path uses seven
32-character topic components plus the final topic. The cost model leaves SQL
allocation estimates editable and defaults above the short-path observations.
Compared with the preceding schema-4 sample, sources and short publications
used about 96 fewer SQLite bytes per action; other sampled cases were unchanged.
The journal stores pointers, not duplicate payloads. These observations are not
fixed overhead bounds or provider row-operation measurements. The editable
model's 2 KiB source metadata and 2 KiB chat overhead defaults still exceed the
short-path samples.
The archive copies each source body once per full backup, and once when it first
appears in an increment. JSON escaping can still enlarge the file estimate.
The rehearsal also saw exactly 30 accepted/10 refused POSTs and 120 accepted/20
refused listing reads; those reads added no SQL pages or R2 operations. Retry
POSTs still consume attempt credit and request/CPU cost.

`GET /stats` includes `journal_bytes` from SQLite's `databaseSize`,
`journal_capacity_bytes` and `capacity_reached`. `CORE_CAPACITY_BYTES` defaults to
800,000,000 bytes per coordinator. Set it explicitly for the selected deployment:
Cloudflare currently documents **1 GB per SQLite object on Free, 10 GB on Paid**
([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
The conservative default fits either plan. A paid deployment could choose an
8,000,000,000-byte cutoff after reviewing measured growth and operator headroom.
This setting is operational, not part of portable quota policy or archive bytes.

Public admission, source reservation and final acceptance each check physical
SQLite size before/after their transaction. An over-limit transaction rolls back;
an in-flight request cannot bypass the later check. Operator moderation, pause,
and recovery retain access to the remaining provider capacity. Reads and
receipt GETs remain available. A private source already prepared in R2 can remain
reserved if final acceptance is refused, as for other interrupted writes.
Restore can exceed the public cutoff but remains quarantined/paused; inspect size
before reopening. This guard does not bound operator growth forever, account-wide
storage, R2 bytes or cost. It is not a replacement for monitoring. Set the cutoff
well below the provider limit and investigate growth before reaching it.

### First public preview

Use the single-database Worker. The epoch/cluster experiment and loss drills are
preserved on [reference/epoch-core-2026-11-05](https://github.com/nickjhay/sprigrun/tree/reference/epoch-core-2026-11-05).
Future shards can have weaker cross-shard consistency and independent checkpoints;
colocate relationships needing atomicity. Placement and writer movement are deferred. Before opening writes, choose and rehearse independent backup
custody/cadence, reporting operations, seed key custody and the recovery promise.
An asynchronous backup cannot reveal an unknown newer acknowledged suffix. Do
not resume old numbered collections from an uncertain prefix and silently reuse
identities. Resolving that uncertainty, choosing a new namespace after loss, or
requiring independent durable evidence before acknowledgements are different
operational promises; none is selected automatically here. No backup scheduler,
external copy destination or deployment is configured by this change.

## Editable native-core cost model

Python 3, no dependencies or Cloudflare runtime:

```sh
python3 core/costs.py
python3 core/costs.py --source-share 1 --years 0 1 3
python3 core/costs.py --backup-every-days 1 --years 0 .5
python3 core/costs.py --incremental-every-days 0.041666667 --years 0 .5
python3 core/costs.py --daily-mib 25 --reads 1000000 --json
python3 core/costs.py --extra-worker-requests 100000000 --extra-do-requests 100000000
```

Import `Scenario`, `estimate` and `Prices` to experiment. It reuses the checked
billing arithmetic in `store/pricing.py`, but models this native core's admission
and HTTP/export paths. It does **not** reuse the legacy challenge-first protocol.

Default assumptions: 100 MiB/day of **charged growth**, half going to 32 KiB
sources, half to 1 KiB chat, 3 million data reads/month (half source reads), half
of chat signed, 3 ms assumed Worker CPU/request, one always-active DO, weekly full
exports (conservatively five per month), effective metadata batches of 16, all
account allowances available. No deletion, deduplication or failed reservation
backlog; historical workload is the same as the modeled month. Saved burst credit
can be added once, at most 200 MiB, not compounded annually. Full export estimates use end-of-month inventory for every copy. Optional
increments use their interval's new growth; the model conservatively counts them
even on full-copy boundaries. Request counts allow one request per source body
plus batched pointer/inline records, although small bodies can share a batch. Source reads, signature key lookups and
full-backup source reads all contribute to R2 Class B operations.

| Service age at month's start | USD/month | Journal GB at month's end |
| --- | ---: | ---: |
| Fresh | 5.45 | 0.60 |
| Half a year | 5.75 | 4.27 |
| One year | 6.59 | 7.94 |

Costs beyond the capacity limit are hypothetical until partitioned. An all-source
scenario is about $6.53/month after one year with 2.07 GB of journal. An all-chat
scenario reaches about 7.43 GB by the end of the month starting at half a year.
At half a year, daily full exports raise the default estimate from $5.75 to about
$8.59/month, before independent storage fees. Weekly full copies plus hourly increments are about $5.75/month at that age,
with about 1.40 million backup source GETs versus 8.16 million for daily full
copies. These figures reuse the 3 November price assumptions below and exclude
independent custody. The payload budget alone does not capture repeated copying
of an ever-growing journal.

Independent storage/transfer, taxes, domains, frontend, WAF, logs and restores are
excluded by default. `--backup-gb-price` and `--backup-copies` add a rough retained
archive-storage allowance (each retained full copy plus an interval of deltas);
provider transfer/minimum charges need separate care.
Archive size is an estimate (JSON escaping can enlarge text). SQL allocation and
row operations are estimates; moderation history, large name trees and reserved-source
backlog need additional scenarios. Effective batch size depends on record sizes;
`--metadata-batch 1` is a conservative small-batch comparison. The journal-position bound excludes post-checkpoint
history without scanning it.

A quota is not a dollar cap. Public requests rejected by our Worker/DO can still
be billed; the volatile read limiter can reset when the DO restarts. Configure
provider protections, CPU limits, spend notifications and observation at launch.
Local timings do not measure billable Worker CPU or promise Internet latency.

Official references, checked 3 November 2026:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)


Policy changes and pause operations have their own small journal entries.
They do not add R2 operations to source POSTs. New signed admissions perform
indexed author-block checks. Model unusually frequent operator policy changes
separately from public growth. Backup checkpoints add no primary SQL writes or
stored journal facts; the cost model includes their read requests and archive headers.
The fixed per-action allowance is not a provider bill.

# Operating the native core

3 November 2026. Local rehearsal and operator tooling; **nothing deployed or
scheduled**. Production remains gated on backup custody, reconciliation,
report handling, seed keys and a deployed-preview check.

## Independent backups

The runner needs Node 24, but not workerd. Configure a distinct `BACKUP_TOKEN`
Worker secret: 32 random bytes encoded as 64 lowercase hex characters. Give the
runner that value through its secret manager as `SPRIG_BACKUP_TOKEN`. Keep
`ADMIN_TOKEN` elsewhere. Never pass credentials in command arguments or URLs.
The backup credential can close epochs and export all retained content, including
suppressed content. It cannot pause, suppress, inspect arbitrary tables, restore
or release a namespace. Its holder can still consume export resources and create
cuts; rotate it if compromised. This is a recovery credential, not a public reader.

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
The witness pins origin, epoch, chain digest and record count. Keep its trusted
copy under different credentials/custody from the archive and primary service.
Different directories are required to discourage accidental bundling; **they do
not establish independent custody**. No signature from the runner or host is
implied. A compromised exporter can supply a false history before you pin it.

The command prints the closed epoch before copying. If export fails after that,
use a fresh destination and `--epoch N` to copy the same cut. An ambiguous failed
cut request must be reconciled through operator inspection of `cuts`; the client
does not automatically POST another cut. A witness failure leaves the completed
archive in place and reports `archive_saved_but_witness_failed`. Investigate and
pin it through a trusted process, or export the same epoch to two fresh paths.
A `.partial` file left by a killed process is not a completed archive.

Set a scheduler on the independent runner, use unique paths per attempt, prevent
overlapping jobs and alert on failures/missing witnesses. Do not auto-delete old
copies yet. Choose retention and monitor physical capacity before scheduling.
Weekly full copies are a starting cost scenario, not a recommended recovery-point
objective: they can leave nearly a week of unreconciled accepted history. Daily
copies shorten that window but cost more. A trusted incremental journal/replica
is a separate future improvement. R2 itself plus SQL point-in-time recovery is
not a coherent independent backup of both systems.

The exporter streams a closed epoch while new submissions continue in the next.
Metadata responses examine at most 32 rows, with a soft 512 KiB encoded-response
budget; one valid oversized record is allowed. Source records remain individual
verified R2 reads. The client bounds each complete HTTP response and times out
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

Measured on Linux/Node 24.22.1 with schema 2 (4 November 2026),
128 accepted actions per case:

| Action | SQLite bytes/action | R2 PUT/action | R2 GET/action |
| --- | ---: | ---: | ---: |
| New 32 KiB source | 1,120 | 1 | 0 |
| Exact source retry | 0 | 0 | 0 |
| Anonymous 1 KiB chat | 2,240 | 0 | 0 |
| Signed 1 KiB chat, plot author | 2,208 | 0 | 1 |
| Short publication reference | 896 | 0 | 0 |
| Long publication path | 3,328 | 0 | 0 |

These are page-allocation deltas in a small local sample, not per-row billing or
worst-case bounds. Path length, message size, insertion order, page utilization,
keys, signatures and future schema changes matter. The long path uses seven
32-character topic components plus the final topic. The cost model leaves SQL
allocation estimates editable and defaults above the short-path observations.
Compared with schema 1, the paired entry/acceptance rows and index were replaced
by one result row. The model counts one inline message body and one result
metadata stream per backup; JSON escaping and page overhead remain estimates.
The rehearsal also saw exactly 30 accepted/10 refused POSTs and 120 accepted/20
refused listing reads; those reads added no SQL pages or R2 operations. Retry
POSTs still consume attempt credit and request/CPU cost.

`GET /stats` now includes `journal_bytes` from SQLite's `databaseSize`. Observe it
alongside quota debit and provider metrics. The single SQLite DO has a **10 GB
hard limit**. Investigate at 5 GB and partition or migrate well before 8 GB; these
are operational thresholds, not automatic alarms or admission gates. No hard
capacity safeguard is installed by this change. A full journal can prevent
acceptance and operator metadata writes even when R2 has ample room.

## Editable native-core cost model

Python 3, no dependencies or Cloudflare runtime:

```sh
python3 core/costs.py
python3 core/costs.py --source-share 1 --years 0 1 3
python3 core/costs.py --backup-every-days 1 --years 0 .5
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
can be added once, at most 200 MiB, not compounded annually. Export estimates use
end-of-month inventory for every copy. Source reads, signature key lookups and
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
$8.68/month, before independent storage fees. The payload budget alone does not
capture the cost of repeatedly copying an ever-growing journal.

Independent storage/transfer, taxes, domains, frontend, WAF, logs and restores are
excluded by default. `--backup-gb-price` and `--backup-copies` add a rough retained
archive-storage allowance; provider transfer/minimum charges need separate care.
Archive size is an estimate (JSON escaping can enlarge text). SQL allocation and
row operations are estimates; suppressions, large name trees and reserved-source
backlog need additional scenarios. Effective batch size depends on record sizes;
`--metadata-batch 1` is a conservative small-batch comparison. Growing post-cut
history can require extra empty filtered pages during export.

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

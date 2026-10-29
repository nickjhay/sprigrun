# Losing and finding the fern

The source store exports a coherent epoch while normal uploads, blocks and policy
changes continue. Restore goes into **fresh, isolated R2 and SQLite storage**.
This is implemented in the Worker and exercised with local Miniflare fault tests;
no cloud deployment or recovery latency has been measured. [CHECKPOINTS.md](CHECKPOINTS.md)
explains the commit boundary and why it does not wait for payload copying.

The archive preserves exact published bytes, reservation/publication/block facts,
their original service times, aggregate accounting and effective PoW settings.
It excludes channels, naming, credentials, tickets, refill balances, untracked R2
objects and history after the cut. There is no automatic backup schedule, public
cutover, continuous independent journal or general garbage collector.

## Export without a write freeze

Keep the Worker as the sole writer to its private R2 bucket. Stop out-of-band
mutations and schema-changing deployments while copying. From `store/`, supply
`BLOB_STORE_URL` as the source bare origin and `BLOB_STORE_ADMIN_TOKEN` (or
`ADMIN_TOKEN`) privately in the environment:

```sh
npm run recover -- export /private/backups/fern.jsonl
npm run recover -- verify /private/backups/fern.jsonl
```

Begin seals epoch E and advances to E+1 in a short durable SQLite commit. It copies
maintained counts and bounded policy, with no table scan, R2 operation or generation
broadcast. The pause ends at its durable acknowledgement. There is one active cut,
with a **24-hour lease** from capture; repeated begin returns the same active cut.
Uploads already preparing in R2 can publish in E+1. A reservation at E remains an
accounting fact at E but contributes no source until its publication commits.

Enumeration filters immutable facts by epoch. A block committed after E immediately
refuses new live reads while the snapshot still reads its earlier private payload.
Reclamation refuses a payload pinned by the active cut. Expiry, explicit abort or
successful finish releases that pin; expiry does not itself delete bytes.
An expired/inactive handle cannot finish or return more snapshot records.

The CLI creates a new mode-0600 file, verifies every record, and fsyncs all records
**before** asking the server to finish. The server durably records the completion
outcome and releases the pin. Only after that ACK does the CLI write and fsync the
complete trailer. Success reports the ID, count and checksum; uploads stay in their
existing pause state and outstanding tickets are unaffected.

Save the checksum independently and copy the verified archive outside the deletion
and account authority being protected against. File fsync does not ensure parent
directory durability or a later transfer. Record the reviewed Worker/CLI commit
alongside the archive. A sealed cut alone is not an independently durable backup.

If every record reached disk but the finish reply or trailer was lost:

```sh
npm run recover -- finish /private/backups/fern.jsonl
```

This verifies the entire record prefix, retries the same finish and adds the trailer.
It refuses missing records, corruption, a different source, expired active cuts and
stale handles. A completed archive is an idempotent no-op. Completion receipts survive
restart but are replaced by a new cut or explicit release; recover a lost reply
before starting another export. A torn last line is refused rather than repaired
by guessing. Run only one command against a particular archive file at a time.

Other interrupted exports can restart into a **new filename** while the same lease
is active. If abandoning an export, release it explicitly:

```sh
npm run recover -- release SNAPSHOT_ID
```

This aborts/releases the cut; it neither pauses nor resumes uploads. If begin's reply
was lost, begin again retrieves the active header. Never edit a partial archive into
apparent completeness. The administrator can block content during copying without
aborting the cut. Its older private backup may still contain that source.

## Restore

Verify offline first. Provision a separate Worker/DO namespace, an empty private
R2 bucket, a separate origin and a new admin credential. Check the bindings; a fresh
bucket with an old coordinator is not a fresh target. Set `RESTORE_MODE="1"` and do
not attach a public production route. Deployment settings may differ from the source;
archived per-object validation and effective PoW settings retain their meanings.

With the URL and credential now referring to the isolated target:

```sh
npm run recover -- restore /private/backups/fern.jsonl --empty-target
```

The CLI validates the whole archive before HTTP. The server checks the empty target,
validates each bounded record, conditionally creates any published payload, then
atomically stores its receipt and restore cursor. An ambiguous PUT retry must verify
matching bytes and intrinsic metadata. Rerun the command after interruption; the
cursor and last-record replay survive restart. No abort-and-reuse API exists: finish
the same archive or discard the isolated target.

Completion checks the ordered checksum, count and independently derived totals.
It sets the current epoch to E+1, clears tickets, initializes all four refill buckets
to **zero at completion time**, and leaves uploads paused. Credit accrues from that
time. Pending records retain their debit but no invented source or publication time;
exact-source resubmission can repair them without another growth debit. Blocks restore
as SQL refusal facts with no R2 payload or tombstone write.

An incomplete restore is refused by both the deployment gate and the metadata read
gate, even if `RESTORE_MODE` is removed early. After completion, removing the variable
exposes reads at that target's URLs; uploads remain paused until explicit resume.
Resuming retires the completed-restore marker. Route cutover is a separate operation.

Before making an old snapshot public, reconcile known newer blocks and other history.
**The tool cannot discover an unknown lost suffix.** Hash verification and zero fresh
credit do not recover a forgotten block. Choose independent suppression-history
custody and an acceptable loss interval before relying on periodic backups publicly.

## Format and bounds

`sprig-store-snapshot-v2` is JSONL transfer data, never executable input:

- Header: random snapshot ID, source origin, capture/expiry time, epoch, maintained
  receipt count and totals, effective PoW settings. No serialized deployment config.
- Ordered record per canonical `hash_length`: immutable receipt facts, plus exact
  base64 bytes and validation policy only if published and unblocked **at the cut**.
  Pending and blocked records always have `object: null`.
- Trailer: count and checksum. Start with SHA-256 of the exact compact header JSON;
  hash `previous_lowercase_hex + "\n" + record_json` for each ordered record. Every
  line ends in a newline. The header uses `JSON.stringify` encoding.

Validation checks fields, event epochs/times, ordering, aggregate totals, canonical
base64, byte length, digest and stored UTF-8/ASCII contract. R2 versions, upload times,
ETags and HTTP metadata are not historical authority. SQL holds service event times;
R2 holds intrinsic payload metadata. Backing up R2 alone loses the service history.
This undeployed revision replaces the earlier schema/archive outright; there is no
legacy parser or migration. Reset/reseed only disposable local state.

A checksum detects corruption, not replacement by someone able to rewrite both file
and checksum. Archives are plaintext and can contain later-suppressed source. Keep
them private and decide their retention/suppression policy independently.

CLI defaults: 1 GiB, 100,000 records, 30 minutes total, 30 seconds per HTTP request,
2 MiB per record and 16 KiB per header/small response. Pages hold at most 128 addresses.
`RECOVERY_MAX_BYTES`, `RECOVERY_MAX_RECORDS` and `RECOVERY_TIMEOUT_MS` allow deliberate
increases, capped at 1 TiB, 100 million records and 24 hours. Files stream one bounded
line at a time; no redirects or automatic network retries. Admin credentials never
belong in command arguments, logs or archives.

Export uses one R2 GET per published/unblocked record and approximately one HTTP/DO
request per receipt plus each page. Pending and blocked records use no R2 operation.
Restore uses one initial R2 LIST and one conditional PUT per included payload, plus
SQL receipt/progress commits; ambiguous retries add work. Archive storage/copying,
restore and explicit reclamation are separate costs, outside public upload quotas.

## Evidence and remaining work

`npm run check` at the repository root runs the integration suite and pricing checks.
The loss drill exports with the real CLI, deletes both disposable source databases,
restores fresh resources, checks times/quotas/blocks and runs the fern with its imported
library. It never deletes user development state or touches cloud resources.

Fault tests hold R2 before and after writes across the barrier, saturate preparation
slots, block during copying, interrupt export reads, expire pins, retry lost finish
replies across restart, reject damaged archives and recover ambiguous restore writes.
The barrier is proven independent of those injected waits; that is **not a measured
cloud latency guarantee**. Next: disposable cloud rehearsal, read/barrier latency and
operation measurements, independent archive custody and newer-history recovery policy.

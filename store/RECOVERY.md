# Losing and finding the fern

This first recovery slice makes a coordinated source-store snapshot and restores
it into **fresh, isolated R2 and SQLite storage**. It preserves exact source bytes,
original submission times (including unknown legacy times), pending reservations,
blocks, accounting totals and PoW overrides. It does not include channels, naming,
credentials, outstanding tickets, untracked bucket objects or a lost suffix after
the snapshot. There is no automatic rollback, cutover, backup schedule or cloud
recovery claim.

## The local loss drill

From the repository root, with Node 24 and dependencies installed:

```sh
npm --prefix store run build
cd store
node --test --test-name-pattern='lost local store' test/integration.test.mjs
```

The drill publishes the fern and its imported library, another source containing
BOM/CRLF/Unicode/NUL bytes, and suppression fixtures. It exports with the real CLI
and production Worker entrypoint, **deletes the disposable source's local R2 and
SQLite directories**, and restores into new resources. It checks timestamps,
accounting, blocks, zero initial refill credit, invalidated tickets and pause
state, then runs the fern from its recovered blobs. It never touches `.local/`,
`.wrangler/`, a user's existing database, or cloud resources.

The remaining recovery tests inject write failures on both sides of R2, restart
the runtime during restoration, exercise the maintenance freeze and reject bad
archives, occupied targets, policy drift and premature completion. Run the whole
repository's `npm run check` before release.

## Export

Use the reviewed code and keep the Worker as the sole writer to its private R2
bucket. Stop out-of-band tooling and deployments that could mutate either store.
Choose a new private archive path outside the repository. From `store/`, with
`BLOB_STORE_URL` set to the **source** bare origin and `BLOB_STORE_ADMIN_TOKEN` (or
`ADMIN_TOKEN`) supplied privately in the environment:

```sh
npm run recover -- export /private/backups/fern.jsonl
npm run recover -- verify /private/backups/fern.jsonl
```

Export acquires a durable maintenance freeze behind the existing writer queue.
It waits for preceding mutations, pauses uploads, invalidates tickets, and refuses
block/policy/resume changes until explicitly released. Uploads whose bodies were
still arriving must pass the publication pause check and are rejected. Reads
continue; there is no new coordinator call on public blob reads.

The CLI creates the file exclusively with mode `0600`, writes bounded records and
fsyncs the completed file. It refuses overwrite. Success prints the snapshot ID,
record count and final checksum. Save that checksum separately in a trusted place
and copy the archive outside the account/deletion authority being protected
against. Protect and verify the destination copy too. File fsync is not a promise
about the durability of its parent directory or a later backup transfer.
Record the reviewed CLI/Worker commit alongside the backup. Future schema or
policy changes need an explicitly tested migration; retain code that can read
the archive version you actually saved.

Export intentionally **leaves maintenance locked**, even on success. After
verification/copying, using the returned snapshot ID:

```sh
npm run recover -- release SNAPSHOT_ID
npm run admin -- resume
```

Release only unlocks maintenance; uploads stay paused. A failed export leaves an
incomplete file and the source frozen. Retry export to a **new filename** at the
same origin: begin returns the same durable snapshot. The ID is also in the
archive's first line if written. If the begin response was lost, an authenticated
`POST /admin/recovery/snapshot/begin` with `{}` retrieves the active header. Do not
edit a partial archive into apparent completeness. To block content urgently,
abandon/release the freeze, apply the block, and make a new snapshot.

## Restore

Verify the archive offline first. Provision a separate Worker/DO namespace and
an empty private bucket at a separate origin, with the **same admission policy**
as the snapshot and a new admin credential. Check every binding before proceeding.
An empty bucket bound alongside a live coordinator (or the reverse) is not fresh
storage. The server checks both; the CLI's separate-origin check alone is not proof
of isolation. Do not give the recovery deployment a public production route.

Set the target's `RESTORE_MODE` variable to the string `"1"`. All ordinary service
requests are refused while this variable exists; documentation stays available.
Only exactly `"1"` enables restore endpoints. Do not remove it while restoration
is incomplete. It is deliberately absent from normal deployment defaults.

With `BLOB_STORE_URL` and the credential now referring to the **target**:

```sh
npm run recover -- restore /private/backups/fern.jsonl --empty-target
```

The entire archive is validated before the first HTTP request. The CLI never
takes a destination from the archive. The server also validates each bounded
record, conditionally creates its R2 object, then atomically stores its receipt
and restore progress. A retry after an ambiguous R2 write must match the existing
bytes and metadata; conflicting objects are never overwritten. Rerun the same
command after interruption. It resumes at the durable cursor, including across
runtime restarts. A different archive cannot join that restore session. There is
no abort-and-reuse API: discard a failed **isolated** target or finish its archive.

Completion checks the ordered checksum, receipt count and independently recomputed
accounting totals. It restores counters and policy overrides, clears tickets and
sets all four refill buckets to **zero at completion time**. It remains paused.
Credit starts accruing normally from that time; an old snapshot cannot give back
its old balances or credit for time spent restoring. Pending reservations still
count and can be repaired without a second debit once deliberately resumed.
Blocked records contain no old source and restore as fresh tombstones.

Before any public cutover, reconcile newer blocks, reservations and other known
history from after the snapshot. **This tool cannot recover or reconcile an
unknown lost suffix.** Accepting that loss is an operational decision, not a hash
check. Preserve independent suppression history before relying on periodic
snapshots for a public service. Do not replay ordinary POSTs to invent old times.

After that review, remove `RESTORE_MODE` on the isolated deployment, verify reads,
metadata, blocks and accounting, and explicitly resume only when ready. Removing
the variable exposes reads at the deployment's URLs even while uploads remain
paused. Route cutover is separate. Resuming retires the completion marker so a
previous archive cannot be treated as an idempotent restore of an active store.

## Format, authority and bounds

The versioned JSONL format is transfer data, never executable input:

- One header: `sprig-store-snapshot-v1`, random snapshot ID, source origin, capture
  time, receipt count, exact configuration and paused control state.
- One record per receipt, sorted by canonical `hash_length`. Each includes the
  receipt and either `null` or base64 source plus custom/HTTP object metadata.
  Stored receipts require verified bytes. Pending receipts may lack an R2 object.
  Blocked receipts always omit source, even after a failed live tombstone write.
- One trailer: count and checksum. Initialize with SHA-256 of the exact compact
  header JSON. For each record, hash `previous_lowercase_hex + "\n" + record_json`
  in UTF-8, excluding the record's terminal newline. Every line, including the
  trailer, ends in a newline. Metadata and receipts are covered as well as bytes.

The header uses `JSON.stringify` encoding. Body validation checks canonical
base64, SHA-256, length, source format and agreement between R2 and receipt time.
Legacy unknown times stay `null` with no fabricated R2 timestamp. R2-assigned
upload time, version and ETag are not restored: restored objects have new physical
identities. The stable facts are the original custom metadata and logical bytes.

A checksum detects corruption; **it does not authenticate an archive** if an
attacker can replace the file and its checksum. Authenticate the independently
held checksum/copy. Archives are plaintext, not encrypted, and old copies may
contain subsequently suppressed source. Keep them private and choose an explicit
backup suppression/retention policy. They are not a second public blob endpoint.

Defaults per CLI invocation: 1 GiB archive, 100,000 receipts, 30 minutes total,
30 seconds per HTTP request, 2 MiB per record, 16 KiB per header/small response.
Server enumeration pages contain at most 128 addresses. Increase
`RECOVERY_MAX_BYTES`, `RECOVERY_MAX_RECORDS` or `RECOVERY_TIMEOUT_MS` deliberately
for larger stores (hard CLI ceilings: 1 TiB, 100 million records, 24 hours).
The byte limit includes base64 and metadata. Files stream one bounded line at a
time; there are no redirects or automatic network retries. Requests require the
existing admin bearer credential; no CORS permission or unauthenticated listing
is added. Credentials never belong in command arguments or the archive.

Normal export uses one R2 GET per non-blocked receipt, SQL receipt reads and
roughly one HTTP/DO request per record plus one per page. Restore uses one initial
R2 LIST, one conditional PUT per included object/tombstone, and a SQL receipt /
progress commit per record. Ambiguous retries add PUT/GET work. Backup file storage
and retention add their own costs; these administrator operations bypass public
growth quotas and are not covered by the upload allowance. They run serially,
so export duration is also the upload maintenance window. Measure real cloud
latency/cost before choosing a backup schedule or RPO/RTO.

## Small trusted boundary

| Invariant | Code / evidence |
| --- | --- |
| A snapshot describes one frozen logical store | `coordinator.ts` writer mutex + durable `maintenance` row; body-race and restart tests |
| Suppressed source is never exported or restored from its receipt | `recovery-store.ts` blocked branch; failed-tombstone fixture |
| Exact bytes and original metadata agree | `recovery-format.ts` validators; corrupt body/time tests; BOM/CRLF/NUL roundtrip |
| No receipt/progress acknowledgement precedes its required R2 write | Conditional PUT, then receipt + cursor transaction and flush; ambiguous-write restart test |
| No partial archive becomes a completed restore | Ordered chain + count + recomputed accounting; truncated/reordered/drift tests |
| Restore cannot quietly reopen uploads or mint old credit | Empty target + explicit deployment gate; zero balances, cleared tickets, paused completion |

These guarantees assume exclusive application write authority and correct resource
bindings. Public read behavior still trusts the deployment gate. Out-of-band R2
mutation, compromised admin/deploy authority, deletion of the archive, and missing
post-snapshot facts remain outside what this recovery slice can repair.

# First deployment and recovery boundaries

The source store deploys independently of the workbench, channels and naming.
Read [the threat model](../THREATS.md) for invariants, failure states and limits.
The cloud rehearsal, billing measurement and cloud recovery drill have **not**
been performed. [RECOVERY.md](RECOVERY.md) adds coordinated snapshot export/restore
and a local drill that deletes both original databases before recovering the fern.
Local evidence does not establish cloud recovery behavior or measured RPO/RTO.

## Check locally

Use Node 24 and Python 3. Keep the whole repository, including `shared/`:

```sh
npm ci
npm run check
cd store
npm ci
npx wrangler deploy --dry-run
npx wrangler deploy --config wrangler.rehearsal.jsonc --dry-run
```

The integration suite runs the actual rehearsal CLI against the production
entrypoint, fully restarts local R2/SQLite, and verifies persisted state. It does
not emulate TLS/DNS, billing, edge rate limits, cross-region behavior or PITR.
Fault injection stays in local tests, never a deployed route.

## Disposable cloud rehearsal

`wrangler.rehearsal.jsonc` uses a separate Worker/private bucket and the production
entrypoint. Its 128-byte source cap, 64-byte minimum debit and two 256-byte buckets
admit four small new objects. Refill is one byte per day/hour respectively. Work
is small but nonzero; tickets last an hour. Its per-IP allowance is 60/minute so
the fixed rehearsal can finish, compared with production's current 20/minute.

The CLI requires `--disposable`, a bare HTTPS origin (HTTP only on loopback), an
admin credential and that small quota profile. Prepare also checks fresh
counters, no live tickets and the expected initial work settings. These checks
reduce mistakes; they do not establish ownership of a hostname. Verify the
origin/resource names before providing credentials. Never use populated/public
production storage: this test changes global policy, fills quota and blocks a
fixture. Use fresh dedicated resource names for each new rehearsal.

From `store/`, create a private ignored credential file without printing its value:

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; import { writeFileSync } from 'node:fs'; writeFileSync('.dev.vars.rehearsal', 'ADMIN_TOKEN=' + randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });"
```

Keep it out of logs, archives and commits. The admin/rehearsal CLIs accept
`ADMIN_TOKEN` from Node's environment-file option; an exported
`BLOB_STORE_ADMIN_TOKEN` takes precedence. Check for stale exported credentials.
Only use trusted dotenv files: expansion can read process environment values.

In the intended Cloudflare account, with Workers Paid and R2 available:

```sh
npx wrangler login
npx wrangler r2 bucket create sprig-store-rehearsal
npx wrangler deploy --config wrangler.rehearsal.jsonc --secrets-file .dev.vars.rehearsal
```

Keep R2 private: no public `r2.dev`/bucket domain or lifecycle deletion. Do not
lock the live bucket against overwrites: blocking needs to replace objects with
tombstones. The secrets file installs admin access with the first deployment.
These commands create billable resources; local checks do not execute them.

Set `BLOB_STORE_URL` to the exact deployed Worker origin, then:

```sh
node --env-file=.dev.vars.rehearsal scripts/rehearse.mjs prepare first.rehearsal.json --disposable
npx wrangler deploy --config wrangler.rehearsal.jsonc
node --env-file=.dev.vars.rehearsal scripts/rehearse.mjs verify first.rehearsal.json --disposable
```

Prepare checks exact bytes, response headers/CORS, HEAD/304, duplicates, wrong
hashes, invalid UTF-8, replay, quota exhaustion, pause/resume and blocking. It
uses 20 challenge/PUT requests plus fixture reads and admin/status requests. It
leaves four reservations, three readable blobs, one block, a work override and
uploads paused. Its private state file contains the origin, seed and spent/live
tickets, not the admin secret. A live ticket is a temporary upload capability;
keep the file private. A new prepare never overwrites an existing state file.

Redeploy the **same Worker, namespace and bucket**. Verify within 58 minutes of
prepare; original tickets must still have two minutes left, because expiry
would mask lost ticket state. Verify checks persisted bytes, blocks, reservations,
pause and work override, then briefly resumes to check spent/live tickets and
quota. It tries to pause again even on failure. Verification consumes the saved
live ticket: it is a one-time phase, not a repeatable health check.

Verification allows the five-second public stats cache to expire. Requests,
response bodies, solving and total script time are bounded; writes are not
automatically retried. If interrupted, inspect the error and manually pause if
necessary: process cleanup is not guaranteed. Do not rerun prepare against
partly mutated resources. `npm run smoke` remains the small repeatable ordinary
publish/read check; the destructive rehearsal is a separate command.

## Before opening the experimental store

- Record the reviewed commit/deployment, account, Worker/class/namespace, object
  name (`global`), bucket and policy. Keep resource identity stable across releases.
  A renamed Worker is not a database migration. Use `src/index.ts`, never the
  fault-injection entrypoint, in every deployed configuration.
- Review stable production names in `wrangler.jsonc` and `store.sprig.run`. Use
  separate production resources and secret; install it with `--secrets-file`.
  Verify smoke and pause/resume. Do not transfer rehearsal state into production.
- Verify private R2, all public routes and admin controls. Disable unused
  `workers.dev`, version/preview/deployment URLs as applicable; hostname-scoped
  restrictions do not automatically cover alternate URLs. Test blocking on a
  disposable fixture and provide a working report contact.
- Measure request/CPU/error, R2 operations and SQL allocation. The script reports
  wall time, not billable CPU. Use a separate bounded workload with realistic
  limits to measure 256 KiB reads; tiny rehearsal fixtures do not establish
  production headroom. Feed measurements into `pricing.py`.
- Configure suitable usage notifications and an independent route-level stop.
  Alerts are not spending caps. Reads/rejections are outside the growth quota.
  Inspect both HTTP errors and runtime failures; caught HTTP 503 responses need
  not appear as runtime exceptions. Diagnostics must omit source and credentials.

The experimental store offers exact public source with no automatic expiry and
preserves each new reservation's `submitted_at_ms` in SQLite and R2 metadata.
Coordinated export/restore into fresh isolated storage is implemented and tested
locally; see [the recovery runbook](RECOVERY.md). Keep important originals. Before
making this the only copy, retain independently controlled backups, rehearse cloud
recovery, choose recovery-point/time objectives (RPO/RTO), and preserve a way to
reconcile newer suppression/history. Hosted names still need durable admission
facts and protected recovery capacity; they are not part of this release.

## Incident actions

With the matching URL and private environment file:

```sh
node --env-file=.dev.vars.rehearsal scripts/admin.mjs pause
node --env-file=.dev.vars.rehearsal scripts/admin.mjs pow 8 2
```

Use the production secret file for production. Raising difficulty affects new
tickets only. Pause stops admission; reads continue. A hung storage write can
stall queued admin calls. Then stop traffic using the hosting control plane,
covering every public route, instead of queueing more calls. Reopening traffic
is deliberate; do not automatically resume after errors.

`admin.mjs block HASH_LENGTH` replaces bytes with a tombstone and has no undo
API. A failure needs retry and verification with a network GET/HEAD, including
`If-None-Match`. Browser copies cannot be recalled. Admin-token compromise permits
blocking arbitrary addresses; rotate it and inspect both SQL refusals and R2.

## Code rollback is not data restoration

Rollback only to code compatible with the live schema/security policy. Do not
reset namespaces or discard quotas/blocks to make older code run. The [restore tool](RECOVERY.md) covers a consistent snapshot into a fresh isolated
target. A safe public cutover still requires:

1. Stop traffic and preserve newer state/evidence. Identify the recovery point
   and accepted loss interval; never invent missing admission stamps.
2. Restore exact objects plus control/metadata into an isolated instance. Verify
   hashes, lengths, relationships and schema against an independently held manifest.
3. Reconcile newer suppression and reservations; clear restored tickets. Do not
   restore excess quota credit or reuse sequences. Replay names with original
   admissions and the policy that applied to them.
4. Check duplicates, blocks, pending writes and relevant invariants before
   reconnecting routes. Missing history means incomplete, not a different head.

DO PITR restores one database, not R2 and SQL atomically. Normal redeployment
does not test PITR or backup restoration. Choose an independent recovery copy,
credentials, export format, RPO/RTO and suppression policy for backups before
claiming recoverability. Periodic copies leave a potentially lost suffix.

Sources checked 29 October 2026: [DO PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[R2 durability](https://developers.cloudflare.com/r2/reference/durability/),
[R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/),
[Worker metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/),
[Worker URLs](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
Secret-file support was checked against pinned Wrangler 4.153.0 help.

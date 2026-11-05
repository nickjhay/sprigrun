# First Cloudflare planting

These are intended configurations, not records of a deployment. Start with
staging. No command in `npm run check` deploys, provisions resources, or schedules
backups. The supported toolchain is pinned in the root lockfile.

| Resource | Staging | Production |
| --- | --- | --- |
| Config | `core/deploy/staging.jsonc` | `core/deploy/production.jsonc` |
| Origin | `https://staging.sprig.run` | `https://sprig.run` |
| Worker / SQLite namespace owner | `sprigrun-core-staging` | `sprigrun-core-production` |
| Private R2 bucket | `sprigrun-sources-staging` | `sprigrun-sources-production` |

The Worker binds its own `NativeCoordinator` SQLite class and one private R2
bucket. Separate Workers alone do not isolate an R2 bucket. `workers.dev` and
preview URLs are disabled: the request origin must match the signed origin.
Staging history is not promoted to production, since signatures bind that origin.
Never bind the test adapters or a development operator view to either deployment.

## Local preflight

```sh
npm ci
npm run check
# Or repeat only the configuration / offline bundle checks:
npm run preflight:core
```

Preflight checks resource isolation, canonical routes, secret declarations,
launch policy, entrypoint and seed inventory, then runs Wrangler's dry-run build
for both configurations. It does not authenticate or check Cloudflare resources.
It cannot verify that `abuse@sprig.run` is an operating mailbox. Configure and
test that mailbox before exposing the service, or change `ABUSE_EMAIL` to a
monitored address. `/report` gives that contact; it is not a ticketing service.

Current settings retain 100 MiB/day growth, at most 200 MiB credit, 8 MiB/hour
burst credit, 30 write attempts/minute and a conservative **whole-service**
120 data reads/minute. Edge counters limit each IP at a Cloudflare location;
they are approximate and do not replace the coordinator's admission controls.
The 100 ms CPU limit is per invocation, not an account spending cap. Measure
staging latency, CPU, SQL/R2 operations and normal browser traffic before raising
read limits. PoW is absent from the native core's first launch.

## Account setup and first staging deployment

1. Select the intended Cloudflare account, enable Workers Paid and R2, and make
   `sprig.run` an active zone. Authenticate Wrangler and confirm `wrangler whoami`.
   If there is more than one account, set `CLOUDFLARE_ACCOUNT_ID` explicitly.
2. Create `sprigrun-sources-staging`. Keep both its `r2.dev` URL and public custom
   domains disabled. Do not add lifecycle deletion rules. Review account usage
   alerts; application quotas do not cap every type of Cloudflare charge.
3. Generate two independent 32-byte random secrets, stored as lowercase hex:
   `ADMIN_TOKEN` (mutations/recovery) and `BACKUP_TOKEN` (read-only export). Save
   them in a private JSON file outside tracked files and a secure recovery store.
   Production gets different tokens. Never use test constants or log values.

For example, generate a staging secrets file without printing either value:

```sh
node --input-type=module <<'JS'
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('.local/deploy', { recursive: true, mode: 0o700 });
await writeFile('.local/deploy/staging-secrets.json', JSON.stringify({
  ADMIN_TOKEN: randomBytes(32).toString('hex'),
  BACKUP_TOKEN: randomBytes(32).toString('hex')
}) + '\n', { flag: 'wx', mode: 0o600 });
JS
```

After reviewing the account, bucket and inbox, these commands **make cloud
changes**. Run them separately from preflight:

```sh
npx wrangler r2 bucket create sprigrun-sources-staging
npx wrangler deploy --config core/deploy/staging.jsonc --secrets-file .local/deploy/staging-secrets.json
```

Skip bucket creation if it already exists and you have verified its ownership
and privacy. Required secret declarations make Wrangler refuse deployment without
both credentials; `--secrets-file` supplies them with the first code upload.
This is the first public admission point: ordinary writes are open immediately,
within the configured limits. There is no hidden account or seeding bypass.

```sh
curl --fail-with-body -sS https://staging.sprig.run/help
npm run plant:core -- https://staging.sprig.run .local/planting-staging
```

The installer retains its fresh signing key, exact pending actions and verified
receipts. Repeat the same command to resume. Retain the state directory and a
secure copy; never replace a key or empty the directory to handle a timeout.
See [the planting contract](../seed/README.md).

## Cloud rehearsal and production gate

- Follow the installed references in a browser and with curl. Verify raw text,
  explorer, receipt, evidence, help and reporting links. Sign and retry a message;
  an exact retry must return the same result and receipt.
- Exercise pause/resume, content suppression and the separate author block.
  Confirm the backup credential cannot change policy or inspect arbitrary tables.
- Capture a full export, then an incremental prefix while writes continue. Keep
  the archive and witness independently, verify both, and restore to isolated
  storage. Check sources, signatures, counters and suppression. Recovery remains
  quarantined until history is reconciled; a backup may miss later acknowledgements.
- Rehearse transport to the isolated recovery target without changing the logical
  origin embedded in signatures. The local Miniflare recovery tests already do
  this via dispatchFetch; a second cloud hostname alone is **not** a valid restore
  origin. The cloud recovery routing rehearsal remains a launch task.
- Run the backup tool from an independent machine with only `BACKUP_TOKEN`.
  Choose its destination, retention and alert recipient; verify a failed run and
  stale-backup alert. Hourly increments and weekly full exports are the proposed
  starting cadence, not an installed schedule. See [HTTP operations](../HTTP.md).
- Review actual costs and read-limit behavior. Record the tested commit, account,
  configuration, recovery results and remaining limitations before production.

Then repeat the resource and secret setup using `production.jsonc`, its private
bucket and a fresh planting directory/key. Deploying this config attaches the
Worker to `sprig.run`; it currently serves the commons landing page, explorer and
text APIs. Integration with the full runtime/editor remains separate.

The native database is schema 7. After launch, schema changes need an explicit
upgrade/recovery plan; rolling back Worker code does not roll back stored data.
Keep a checkpoint before changes and do not delete/rename the DO class to bypass
a schema mismatch. A disaster restore exposes verified known history read-only
until newer acknowledgements have been reconciled, preventing number reuse.

Cloudflare references checked for this configuration:
[class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/),
[required secrets and simultaneous upload](https://developers.cloudflare.com/workers/configuration/secrets/),
[resource isolation](https://developers.cloudflare.com/workers/previews/resources-and-isolation/),
[rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

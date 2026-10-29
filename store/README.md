# Bounded source blob store — v0.5.0

A small Cloudflare Worker, private R2 bucket and one SQLite Durable Object.
Source is addressed by `SHA256_length`: 64 lowercase hexadecimal hash digits,
an underscore, and the exact byte length in canonical decimal. No parsing,
compilation or execution of Sprig occurs on the server. UTF-8 validation is the
default; ASCII is optional. Assets and compiled simulator Wasm remain separate.

Uploads use expiring, single-use proof-of-work challenges. The server keeps a
bounded table of outstanding tickets. A valid proof atomically consumes its
ticket **before the Worker reads the upload body**. A failed upload needs a fresh
challenge; source bytes never need a nonce comment or other modification.

See [SECURITY.md](SECURITY.md) and the editable [pricing.py](pricing.py) model,
with assumptions in [BUDGET.md](BUDGET.md).

## Compatibility

**This is a breaking protocol/storage-format release.** The old `POST /b` and
hash-only URLs are not supported. Object and receipt keys now include length.
This project has not provisioned or deployed any Cloudflare resources for you.
For a first deployment, use the defaults below. If you deployed an older edition,
keep it running separately while planning a deliberate data/block/quota migration.
Use a fresh Worker/DO namespace **and** fresh private R2 bucket for this edition;
do not simply point it at old storage. Startup refuses a v0.4 control schema
rather than resetting or bypassing its quotas and permanent blocks. No automatic
migration is supplied. The default names have a `v05` suffix to distinguish them.

## Run and deploy

Node.js 24+ is required. Dependencies are pinned; there are no runtime npm deps.

```sh
npm ci
npm run check
python3 -m unittest discover -s test -p 'test_*.py'
npm run dev
```

In another terminal, `npm run smoke` publishes a deterministic source, fetches
it and verifies its identity. Repeated checks use the same address. Wrangler
local development uses emulated R2/DO state under `.wrangler/`.

For local admin controls, copy `.dev.vars.example` to `.dev.vars` and set your
own `ADMIN_TOKEN`. Generate a 64-hex-character token with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Cloud setup (Workers Paid, R2 Standard, SQLite DO):

1. `npx wrangler login`
2. Review Worker/bucket names in `wrangler.jsonc`. Defaults are
   `bounded-blob-store-v05` and `world-source-blobs-v05`.
3. `npx wrangler r2 bucket create world-source-blobs-v05`
4. Keep the bucket private: no public `r2.dev` URL or R2 custom domain.
5. `npm run deploy`
6. `npx wrangler secret put ADMIN_TOKEN`, supplying your own token.
7. `BLOB_STORE_URL=https://YOUR-WORKER.workers.dev npm run smoke`

Wrangler provisions the DO declaration in `exports`; there is no separate SQL
setup step. Admin routes are disabled until a valid secret is installed. If you
want maintenance during setup, use a hostname maintenance rule until ready.
For an active Cloudflare zone, add a Worker custom domain and redeploy:

```jsonc
"workers_dev": false,
"routes": [{ "pattern": "blobs.example.com", "custom_domain": true }]
```

Cloudflare manages the domain certificate. Your Netlify/GitHub frontend can stay
where it is. Public CORS allows its fetches. The included GitHub workflow checks
TypeScript, service/CLI tests, Wrangler's dry run and Python tests; it never deploys.

## Upload and read

The easiest uploader preserves exact file bytes, including BOM/CRLF:

```sh
BLOB_STORE_URL=https://blobs.example.com node scripts/upload.mjs world.sprig
# Optional final argument: maximum local hash trials (default 1,000,000).
```

It prints the `hash_length` identifier. The browser helper offers:

```ts
import { shareSource, loadSource } from './examples/client.ts';
const address = await shareSource(origin, source, {
  maxTrials: 1_000_000, timeoutMs: 30_000, signal,
});
const loaded = await loadSource(origin, address, signal);
```

`shareSourceBytes()` handles already encoded bytes. The helper copies mutable
input before asynchronous work, verifies the server's acknowledgement, and never
changes source to solve PoW. It treats `already_written` as idempotent completion;
that reports prior publication, not a guarantee that an evicted blob is readable.
A reader checks length and hash itself before decoding, with a bounded buffer.
Runtime execution/memory limits are still required when using the source.

| Request | Result |
| --- | --- |
| `POST /challenge/b/<hash_length>` with no body | `201` and challenge JSON |
| `PUT /b/<hash_length>` with proof headers and raw source body | `201` and identity JSON |
| `GET /b/<hash_length>` | Verified source bytes or error |
| `HEAD /b/<hash_length>` | Same verified headers, no response body |
| `GET /` | Plain-text stats, cached for five seconds |

Issuance checks the address syntax, size cap, pause state, challenge-rate bucket,
existing receipt and table capacity. It does not read R2, hash the source, reserve
growth credit, or claim the address. Multiple clients may obtain tickets for the
same absent address; only one new publication can commit. A stored receipt gives
`409 already_written`; a blocked receipt gives `410 blob_blocked`.

The upload uses these headers:

```http
Content-Type: text/plain; charset=utf-8
Blob-Ticket: <64 lowercase hex characters>
Blob-Nonce: <16 lowercase hex characters>
```

After consuming a valid ticket, the Worker bounds the body by the address length
and the upload deadline. It requires exactly that many bytes, checks SHA-256 and
UTF-8/ASCII, then reserves growth credit and writes R2. The response is:

```json
{"address":"<hash>_123","digest":"<hash>","bytes":123,"url":"/b/<hash>_123"}
```

`Location` contains that relative path. An empty body is allowed and has length
`0`; leading zeroes, signs and exponents in the length are rejected. The identifier
is at most 71 characters under the default 262144-byte upload cap, or 72 under
the runtime 1 MiB ceiling. Hashes cover exact bytes with no normalization. Source
may contain BOM, control characters, CRLF and NUL. Compressed uploads are rejected.

There is no public enumeration, overwrite, delete, binary-upload grant or user
identity. Hashes are references, not secrets. `Authorization` on a public write
returns `400`; admin credentials belong only on admin endpoints. Query strings
are rejected. UTF-8 is not proof of Sprig syntax or a content moderation scheme.

## Proof protocol and live policy

The server responds with:

```json
{
  "protocol": "blob-store-upload-v1",
  "id": "<random 256-bit ID as 64 hex digits>",
  "address": "<hash_length>",
  "expires_at_ms": 1800000000000,
  "target": "<unsigned 256-bit target as 64 hex digits>"
}
```

These are stored server-side. Neither an HMAC nor an issuance counter is needed:
redemption must find that exact outstanding record, and uses its stored values.
All tickets, even trivial-work tickets, are unpredictable, bound to an address,
expire, and authorize only one body-processing attempt.

Hash the UTF-8/ASCII encoding of these newline-separated fields, **including the
final newline**:

```text
blob-store-upload-v1
<id>
<address>
<expires_at_ms in decimal>
<target>
<nonce: exactly 16 lowercase hexadecimal digits>
```

Interpret SHA-256 as an unsigned big-endian integer. It must be **at most** the
stored target. No source bytes are in this per-trial message. The client hashes
source once to determine the address, then searches small fixed-size messages.
The server performs one small proof hash before body processing.

With `B = PROOF_OF_WORK_BITS`, `P = PROOF_OF_WORK_PER_BYTE`, and byte length L:

```text
work = 2^B + P * L
target = floor(2^256 / work) - 1
```

Expected trials are `2^256 / (target + 1)`, approximately `work`. `B=0,P=0`
(defaults) accepts every trial but still requires a fresh single-use ticket.
`B=16,P=8`, for example, asks for about 65,536 + 8*L small hash trials. Extreme
settings may be impractical; bounded solvers need not find a solution. Config and
admin controls reject work parameters that cannot be represented by this target.

Set environment defaults in `wrangler.jsonc`, or change live with admin controls:

```sh
npm run admin -- pow 16 8     # fixed work plus 8 expected trials per source byte
npm run admin -- pow 12       # change fixed work; retain effective per-byte value
npm run admin -- pow 0 0      # trivial work; tickets remain single-use
npm run admin -- pow default  # clear both overrides, follow config defaults
```

Live overrides persist across restarts and deployments. Each issued ticket keeps
its quoted target until expiry. Raising difficulty does not invalidate work
already underway; use `pause` for an immediate admission stop. To eliminate old
low-work tickets, remain paused through their expiry before resuming.

For other clients, the offline solver takes a saved challenge JSON file:

```sh
node scripts/pow.mjs challenge.json 1000000
```

It prints only a qualifying nonce. It makes no network calls and writes no source.
It bounds JSON input to 4096 bytes, trials to the chosen limit (maximum 100 million)
and elapsed search to 30 seconds or ticket expiry. The browser solver has the same
default limits, configurable elapsed time up to ten minutes, and supports abort.
A weak proof gets `422` with human guidance, the stored target and exact message
prefix. Solve locally; sending trials to the service spends request/attempt credit.

## Ticket bounds and failure semantics

The outstanding table is a durable map keyed by random ID. Issuance inserts a
record; valid redemption deletes it and flushes the deletion before permitting
body processing. It never needs a permanent spent-ticket history. An absent ID
means unknown, used or expired and gets the same `409 challenge_unavailable`.
Invalid proofs do not destroy a valid outstanding ticket, but use attempt credit.

Tickets survive restart; consumed tickets stay absent after restart. Two valid
solutions or simultaneous replays of the same ID cannot authorize two bodies.
A timeout, bad length/hash/UTF-8, growth rejection, queue failure, write failure,
or lost response after redemption still consumes the ticket. Retry with backoff,
a new challenge and the same source bytes. Never automatically restore a consumed
ticket. If a database backup is restored, delete all outstanding tickets before
reopening traffic so historical outstanding records cannot resurrect old proofs.

Expired rows are pruned on issuance. No alarm or timer is needed to keep the
logical table bounded. With rate r, burst b and lifetime T, live tickets are at
most `min(table_capacity, b + r*T)`. Default values give at most 330 live tickets;
the hard table cap is 512. On full tables, new issuance returns `429` rather than
evicting live tickets. Lowering a cap may leave more existing rows temporarily;
issuance stops until those records are consumed or expire. SQLite allocation and
internal metadata are platform-managed; measure database size rather than treating
this logical-row bound as an exact bound on allocated disk bytes.

A stored address cannot be uploaded again, even if its R2 object was externally
evicted. Permanent receipts enforce that history. Pending reservations from an
ambiguous write may finish with a fresh ticket without a second growth debit.
They are never automatically refunded: SQLite and R2 do not share a transaction.
The final publication checks the receipt again after validation, so an address
written or blocked since challenge issuance cannot be overwritten.

| Failure point | Outcome |
| --- | --- |
| Invalid/missing proof or expired ID | No body processing or R2 operation |
| After valid proof consumption, before reservation | Ticket spent, no growth debit |
| After reservation, before R2 write | Debit retained; fresh-ticket retry reuses it |
| R2 committed, confirmation failed | Fresh-ticket retry verifies R2 and completes receipt |
| Publication confirmed, reply lost | New challenge request reports `already_written` |
| Block receipt committed, R2 replacement failed | Publishing fenced; old bytes may remain readable until block retry |

## Resource budgets

| Setting | Default |
| --- | --- |
| `MAX_BLOB_BYTES` | 262144 (256 KiB; runtime ceiling 1 MiB) |
| `MINIMUM_DEBIT_BYTES` | 8192 |
| `LONG_CAPACITY_BYTES` | 209715200 (200 MiB) |
| `LONG_REFILL_BYTES_PER_DAY` | 104857600 (100 MiB/day) |
| `BURST_CAPACITY_BYTES` | 8388608 (8 MiB) |
| `BURST_REFILL_BYTES_PER_HOUR` | 8388608 |
| `CHALLENGE_BURST` / `CHALLENGES_PER_MINUTE` | 30 / 30 |
| `CHALLENGE_CAPACITY` | 512 outstanding rows |
| `CHALLENGE_TTL_SECONDS` | 600 (maximum 3600) |
| `ATTEMPT_CAPACITY` / `ATTEMPTS_PER_MINUTE` | 30 / 30 |
| `UPLOAD_TIMEOUT_MS` | 10000 |
| `VALIDATION_POLICY` | `utf8-v1` (or `ascii-v1`) |
| `PROOF_OF_WORK_BITS` / `PROOF_OF_WORK_PER_BYTE` | 0 / 0 |
| `BROWSER_CACHE_SECONDS` | 31536000 |

Buckets start full once, persist, refill continuously, and never exceed their
capacities even after years idle. Both growth buckets apply to each new reservation,
charged `max(actual bytes, 8192)`. In MiB, their combined envelope is:

```text
admitted(T) <= min(200 + 100*T_days, 8 + 8*T_hours)
```

That permits 8 MiB immediately, 16 MiB per rolling hour, 200 MiB per rolling day,
and 100 MiB/day sustained. These bound reservations, not the later completion
of previously reserved writes. Reducing capacity clamps credit; increasing it
does not refill it instantly. No padding is added to small blobs.

A separate approximate per-IP/per-location edge limit allows 20 challenge/upload
requests per minute combined. A normal new upload uses two of them. Never trust
X-Forwarded-For for this limiter. Global challenge and attempt limits are exact
in the coordinator; the edge limit is only an early filter. Its namespace ID
should be unique within your account. The FIFO mutation queue holds at most 32
operations. The 100 ms Worker CPU limit is per invocation, not a monthly bill cap.

Reads and rejected traffic still cost money. PoW and these quotas do not bound
total request billing, stop all denial of service, or guarantee fair distribution.
Keep budget alerts and measure usage. `pause` stops issuance/redemption/publication;
disabling the Worker route is the broader traffic stop.

## Caching, controls and stats

Successful reads use `private, max-age=31536000, immutable`, `text/plain`,
`nosniff` and ETag `"sha256-<hash_length>"`. GET/HEAD verifies size, hash and the
recorded source validation policy before any `304`. There is no shared blob cache;
stale Cache API entries cannot bypass R2. Browser copies cannot be recalled.
Errors, challenges, uploads and admin replies use `no-store`. Do not override
these rules with public/stale CDN caching or expose the bucket directly.

Set `BLOB_STORE_URL` and `BLOB_STORE_ADMIN_TOKEN` in your operator environment
(the latter matches the Worker's secret; keep it out of argv and shell history):

```sh
npm run admin -- pause
npm run admin -- resume
npm run admin -- block HASH_LENGTH
npm run admin -- pow 16 8
```

Routes are `POST /admin/pause`, `/admin/resume`, `/admin/block/<hash_length>`,
and `/admin/pow/<bits>[/<per-byte>]` or `/admin/pow/default`, using Bearer auth.
They expose no CORS permission; unauthenticated or disabled endpoints return 404.
A block permanently records the address and replaces its R2 object with a random
32-byte tombstone. Reads return 410 instead of those bytes. A failed block may
leave the old origin object readable: repeat until successful and verify an
uncached GET. Already-running responses and browser copies can remain. Retain
receipts/tombstones and avoid lifecycle rules that delete them.

`GET /` reports effective/default work settings, override state, outstanding
unexpired tickets, table/rate/lifetime limits, pause state, source limits, both
byte-bucket balances, challenge credit, attempt rates, cumulative reservations,
confirmed unblocked blob/byte counts, blocks and cache policy. It contains no
source, hashes, ticket IDs, IPs or admin tokens. The ticket count scans a bounded
indexed table; other counters are stored accounting, not an R2 inventory. External
bucket changes and pending failures can make them differ from physical storage.

## Validation

`npm run check` runs both strict TypeScript targets, Node tests using real
Miniflare R2/SQLite DOs, real uploader/admin/offline CLIs, and a Wrangler deployment
dry run. `test/worker.ts` contains fault/probe controls only; Wrangler deploys
`src/index.ts`, which exposes none of them. Python tests cover pricing arithmetic,
billing units, quota bounds and challenge traffic. No cloud deployment is tested
or performed by those commands.

## Repository integration

The workbench and service use the same client and proof definitions. Pure quota
and work-target helpers live in `../shared/`; build from this repository with that
directory present. [SERVICES.md](../SERVICES.md) records the latest review and
future naming composition. Ordinary blobs already have no automatic expiration.
A new publication now uses one conditional R2 PUT; only reconciliation of an
existing object requires a GET. The public upload protocol is unchanged.

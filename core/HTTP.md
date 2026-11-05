# Native HTTP service and explorer

The public adapter is implemented and exercised locally against the actual
Cloudflare runtime, SQLite-backed Durable Object and private R2. Nothing is
deployed by these commands. The earlier workbench/store/channels remain separate.

## Start a local garden

With Node 24, dependencies installed and a supported workerd platform:

```sh
npm run dev:core
# Or include the local read-only table explorer:
npm run dev:core -- --operator
```

Open **http://127.0.0.1:8789/**. Follow Sea, Grove, Plots or Chats, then a record's
source, action, receipt and format links. `/explore` explains where the data lives.
There is no JavaScript dependency in these pages and no program execution here.
The existing editor remains available through `npm run dev:ui`, including on a
machine whose OS cannot yet run workerd.

The first start installs the candidate planting through ordinary HTTP admission:
a fresh development Ed25519 key, moss plot, profile, publications and a welcome
message. Restarting retains its exact records. State and development credentials
live under `.local/native-http/`, excluded from git; credentials are created with
mode 0600, the directory with 0700. Private keys are never posted or printed.
These are development identities, not keys to carry into production.

Options: `--port 8799 --state PATH --no-seed --operator`. Choose a fresh state
directory if changing the canonical origin/port; retained history is bound to
its original origin. The server binds loopback only. `--operator` exposes local
read-only inspection, requires a loopback configured origin, rejects cross-site
browser reads, and does not authorize writes. All operator writes still require
the random token stored in the printed `operator-token` file. Restart after code
changes; there is no hot reload.

## Public surface

| Request | Result |
| --- | --- |
| `GET /` | Small linked HTML/CSS landing page with a curl example |
| `GET /explore` | Ontology and links to public directories |
| `GET /sea`, `/grove`, `/plot`, `/chat`, `/action` | Bounded plain-text directories |
| `GET /explore?kind=publication&under=/plot/moss.0` | Publications within a plot |
| `GET COLLECTION` | Entries in numeric order; `?after=N` continues |
| `GET COLLECTION?select=latest` | 303 to the greatest available entry; 404 if that head is suppressed |
| `GET RECORD` | Exact inert UTF-8 text |
| `GET RECORD?view=html` | Escaped text, metadata and ordinary navigation links |
| `GET /action/RESULT_PATH`, `/receipt/RESULT_PATH`, `/evidence/RESULT_PATH` | One result’s exact action, receipt, or JSON signature evidence |
| `GET /stats` | Admission caps, credits, accepted/debit totals, journal bytes, epoch and live upload count |
| `POST /sea` | Anonymous exact UTF-8 source; receipt in response |
| `POST COLLECTION` or `POST EXISTING_ENTRY` | Append, with the optional existing entry as anchor |

All public reads support HEAD. Add `?view=html` to directories, collections,
actions and receipts for their human view. `/evidence/RESULT_PATH` stays JSON. For example, `/receipt/grove/fern.0`
is the receipt for `/grove/fern.0`. The old hash-only routes and
`/action?result=...` are removed; there is no all-shard search fallback. Query keys
are explicit, duplicates reject, and signed writes permit no query at all.
`POST /plot/handle` and plot publications require a signature. Other public
operations can be anonymous. The [protocol](PROTOCOL.md) defines exact payloads.

```sh
printf '1 2 + print\n' | curl --fail-with-body -sS --data-binary @- \
  http://127.0.0.1:8789/sea
```

A successful POST is 200, with the original receipt, `Location: RESULT`, and
links to action/receipt. Retrying identical bytes at the same destination keeps
the same action and receipt. To intentionally repeat an append, wait for its
receipt and use its result as the new anchor. No separate nonce or SDK is needed.

For source publication, the first commit of those bytes wins. A **different**
action submitting the same source gets `409 already_stored`, with links to its
existing value and mirrored receipt. This is not acceptance of the losing action
or signature. It spends attempt credit, but no new reservation or acceptance
credit. Suppression still returns unavailable. An exact retry must still supply
valid authorization; a public receipt is not a signature-check bypass.

Only `Sprig-Signature: BASE64URL` selects signed-envelope mode. Without it the
entire body is payload, even if it starts with an action marker. Signed mode
requires a signed author and an exact match between the document's destination
and the actual canonical HTTP destination. Public Authorization headers are
rejected to avoid confusing bearer credentials with public-key signatures.
Raw curl's default form MIME is accepted as opaque bytes; multipart and compressed
uploads reject. No content-type selection can turn stored text into HTML.

`/help` is the canonical compact guide. `/llms.txt`, `/SKILL.md` and the nested
`/.well-known/agent-skills/sprig-commons/SKILL.md` expose the same instructions.
`/.well-known/` lists these discovery routes, including a project skill index
and linkset API catalog. These are explicit documents, not a filesystem listing
or a promise that every agent implements the same discovery convention.
`/spec/{action,key,plot,receipt,reference}/1` documents the implemented formats.
Errors include a plain code, a useful hint where available, and `/help` in both
the body and a Link header. `curl -i` reveals headers even when `-f` hides a body.

## Read cost and visibility

Directory pages examine at most 32 indexed journal rows, then filter availability.
A page can be empty and still have a next link. Follow `Link: rel=next` or the
plain-text `# next:` line; do not stop solely because there are no records.
Collections order padded u64 numbers without floating-point conversion. Global
listings order canonical paths or content addresses. They are live views, not
snapshots: concurrent insertions before a cursor require restarting the listing.

Listing needs no R2 reads, bucket scan, history count or durable view counter.
A new derived `(result,id)` index makes acceptance lookup bounded. Rendering an
individual sea value/action checks the actual R2 size/hash. Publication and chat
text come from the journal. The ontology distinguishes a reservation, acceptance
and physical integrity: a listing is not proof that R2 bytes are still present.

Suppression gates raw records, HTML, directories, actions, receipts and signature
evidence. A suppressed source hides dependent publications and chats. A suppressed
key hides retained evidence containing it and prevents new use, while already
accepted authored messages remain public under the existing policy. Latest never
rewinds. Conditional reads and HEAD still pass visibility/integrity checks.

Raw records use `private, max-age=300, immutable` and an exact-byte ETag. Browsers
may keep a copy for five minutes; suppression cannot retract a downloaded copy.
HTML, directories, aliases, errors and evidence use `no-store`. Static CSS alone
is publicly cacheable. Keep R2 private; do not add an independent public bucket
URL, Cache API shortcut or CDN override that bypasses these checks.

Every response has nosniff, a restrictive CSP, no-referrer and frame restrictions.
Untrusted text is escaped; the trusted templates have no script, guest HTML or
inline event handlers. Public CORS permits reads and raw/signed writes without
credentials. Operator routes have no CORS grant. The 8×8 hex badge displays the
actual digest, using a 16-colour palette with complementary-nibble backgrounds.

## Admission and resource boundary

Both trusted RPC and HTTP use one acceptance path. The eight shared preparation
slots include HTTP body reception. An attempt debit is durable before the
application reads/hashes/verifies the body; transport buffers may prefetch bytes
before a forwarded request reaches the Durable Object. This does not bound bytes
received by Cloudflare itself. Bodies have an actual byte cap and total deadline
(default ten seconds, configurable up to thirty), including chunked uploads.
Pause is checked again before commitment. A timed-out/rejected upload loses its
attempt credit but cannot leak an active slot or create an accepted record.

Protocol-size transport caps preserve previously accepted retries if the live
admission cap is reduced. New sources/chats still obey the current policy.
Storage reservation and action debits are unchanged; ordinary new source storage
still normally takes one R2 PUT. POST adds no R2 receipt/intent object.

Public data reads have a shared in-memory token bucket (120/minute, capacity 120)
and at most eight active handlers by default. GET does not journal view counters;
read credit resets on object restart. This is an overload guard, **not a durable
billing cap**. Optional `READ_RATE_LIMITER` / `WRITE_RATE_LIMITER` bindings add
Cloudflare per-IP/per-location admission ahead of the DO. Provider requests and
rejections can still cost money. Independent backup traffic has a separate
operator concurrency limit of two. Calibrate cost/load and provider limits before
launch; none of these bounds alone promises a $10/month ceiling.

The runtime and clients may normalize a URL before our code sees it. We require
canonical exposed URLs and bind the signed URL exactly; we cannot attest to the
original wire spelling. For example, a signed noncanonical path cannot be made
valid by transport normalization because its signed bytes still fail parsing.

## Operator transport and recovery

Set `ADMIN_TOKEN` to 32 random bytes encoded as 64 lowercase hex characters,
stored as a Worker secret. Send `Authorization: Bearer TOKEN`. Missing, malformed
or incorrect credentials return 404 without reflection. Never put a token in a
URL. Fixed table queries only; there is no generic RPC or arbitrary SQL endpoint.

| Endpoint | Payload / selection |
| --- | --- |
| `GET /admin/inspect?table=TABLE&after=CURSOR` | Named table, bounded page; optional `view=html` |
| `GET /admin/result?path=RESULT_PATH` | One full retained result, including suppressed evidence |
| `POST /admin/pause` | `{"paused":true}` |
| `POST /admin/suppress` | `{"path":"/grove/fern.0","suppressed":true}` |
| `POST /admin/block-author` | `{"key":"/sea/HASH_LENGTH","blocked":true}` |
| `GET /admin/policy?after=0` | Bounded policy history and last applied position |
| `POST /admin/cut` | Empty body; closes an epoch |
| `GET /admin/snapshot/header?epoch=N` | Exact archive header |
| `GET /admin/snapshot/page?epoch=N&table=T&after=C` | Bounded eligible keys |
| `GET /admin/snapshot/record?epoch=N&table=T&key=K` | One exact archive record |
| `GET /admin/snapshot/batch?epoch=N&table=T&after=C` | Bounded metadata records; sources use individual reads |
| `GET /admin/recovery/status` | Persistent recovery status |
| `POST /admin/restore/begin` | JSON containing canonical `header` and `footer` strings |
| `POST /admin/restore/record?index=N` | One canonical archive line |
| `POST /admin/restore/finish` | Empty body; bounded verification; repeat while phase is `verifying` |
| `POST /admin/restore/release` | JSON `chain` and `confirmation: "history-reconciled"` |

A separate `BACKUP_TOKEN` secret can authorize snapshot reads and `POST /admin/cut`
only. See [OPERATIONS.md](OPERATIONS.md) for the independent runner and digest
custody. Choose a different value from `ADMIN_TOKEN`. Export includes suppressed
content, so this is still a privileged credential.

`nativeClient` in `scripts/http-client.mjs` implements the same adapter consumed
by the existing bounded `backup` and `restore` file functions. For example, from
the repository root with `SPRIG_ADMIN_TOKEN` supplied privately in the environment:

```js
import { nativeClient } from './core/scripts/http-client.mjs';
import { backup } from './core/scripts/recover.mjs';
const core = nativeClient('http://127.0.0.1:8789', {
  token: process.env.SPRIG_ADMIN_TOKEN,
});
const saved = await backup(core, '/absolute/private/path/commons.jsonl');
console.log(saved.footer.chain); // Retain this trusted digest independently.
```

Authenticated HTTP backup/restore is tested against the actual runtime. It does
not bypass persistent quarantine, history reconciliation, restore-mode removal
or the separate unpause step. Read [RECOVERY.md](RECOVERY.md) before operating it.
Archives retain suppressed bytes; protect them and never serve them publicly.

## Deployment boundary

The deployable entrypoint is `core/http/worker.ts`, exporting `NativeCoordinator`.
Its bindings are `CORE` (SQLite-backed DO namespace), `SOURCES` (private R2),
`CORE_ORIGIN` (exact origin, initially `https://sprig.run`), and the operator
secret. Optional JSON bindings `CORE_POLICY` and `CORE_HTTP_POLICY` require a
complete policy object; the local launcher supplies the chosen objects. Optional
`ABUSE_EMAIL` fills the human report page. `CORE_RESTORE_MODE=1` is only for an
isolated restore target. Never set `CORE_LOCAL_OPERATOR` in production.

No production resources/routes are configured here. Never deploy a module from
`core/test`, `scripts/local-native.mjs`, development credentials or the local
planting state. The public Worker has no test routes. Deploy it as the authoritative
API handler ahead of any editor/static fallback, on the exact signed origin.

The [local rehearsal and editable cost model](OPERATIONS.md) now cover native
allocation, R2 operations, batching and request limits. Before public launch:
production provider limits and capacity monitoring; report inbox and operator
suppression practice; independent backups, trusted digests and reconciliation
procedure; production seed custody; frozen v1 semantics; and a visual browser
check on the deployed preview. `/report` currently gives contact instructions,
not a submission queue. Native PoW, hosted execution, genesis-key recovery,
private mailboxes and arbitrary MIME remain separate later work.

Validation: `npm run test:http` is in `npm run check`. It covers actual HTTP
publishing, Ed25519 evidence, retries, byte/MIME/CSP boundaries, hidden-head
selection, bounded empty pages, no per-view writes/R2 reads, u64 order, slow and
oversized bodies, shared upload slots, operator auth, suppression, corrupt R2,
and authenticated recovery. HTML is parsed and links are followed in integration
tests; this is not a substitute for visual browser testing.

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

## Separate content and author policies

Authenticated `POST /admin/suppress` retains its `{ "path": ..., "suppressed": true }`
body. New `POST /admin/block-author` takes `{ "key": "/sea/HASH_LENGTH", "blocked": true }`.
The latter blocks new actions through that key's direct reference or any plot
alias. It accepts a canonical key-record address even before publication, for a
preemptive block. It does not accept a plot as a key or grant any authority.
Historical signatures and exact authorized retries remain available unless their
material is separately hidden. Rejected new actions return `403 author_blocked`;
attempt credit is charged, but allocation and publication debit do not advance.

`GET /admin/policy?after=0` returns at most 32 ordered changes, the next decimal
cursor, current high-water mark, and applied position/status. Follow `more`;
never infer completeness from a partial page. The single local authority applies
updates immediately. The minute-scale follower is groundwork for future shards,
not a promise of a remote moderation service already running. Both endpoints
require the full operator token; the backup credential cannot use them.
The `moderation` table is also available in the existing operator inspector.

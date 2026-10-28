# Current design — v0.5.0

The current protocol is in [README.md](README.md). v0.5 replaces content-hash
mining with a small outstanding-ticket table, expiry and an atomic consume before
body processing. Fixed and byte-dependent work use one small hash puzzle. Stored
ticket parameters remove the need for HMAC tokens, signing keys, an issuance
counter or a spent-ticket history. The nonce never changes the source address.
There is one new pure TypeScript protocol module and one bounded SQLite table;
no new Cloudflare service, alarm, timer or external dependency is added.

This release changes addresses to hash_length and requires a fresh deployment
or a separately planned migration. The historical upgrade notes below apply
ONLY to their earlier release; they do not describe a v0.5 upgrade.

---

# Simplicity pass — 26 October 2026

Historical notes below describe the earlier source-only pass. Release 0.3.0
(27 October) returns to this design after the binary/grant experiment. It keeps
the six-module service and adds the narrowly scoped hardening documented in
[SECURITY.md](SECURITY.md), plus the standalone [pricing.py](pricing.py) model.
Current deployment/migration instructions are in [README.md](README.md).
Release 0.4.0 adds optional low-bit PoW using the existing digest, coordinator
state and admin boundary. It adds no cloud binding or new database table.

The useful reduction was removing an unused operating mode, rather than
compressing the code that protects storage invariants.

## Changes made

- Removed optional shared caching of blobs, Cloudflare purge requests, purge
  credentials, canonical cache-origin configuration and purge-specific errors.
  Blob responses always use private browser caching. Stats retain a five-second
  shared cache because they are small public counters and otherwise every poll
  would reach the coordinator.
- Applied security headers, public CORS and HEAD body removal once, at the HTTP
  response boundary. Cached stats pass through the same boundary.
- Compared the admin token bytes directly with `timingSafeEqual` after checking
  their length, instead of hashing both strings first. The required token length
  is already public; the contents are still compared in constant time.
- Removed redundant single-row transaction wrappers. These synchronous
  read/modify/UPDATE paths contain no await, so requests cannot interleave them.
  Multi-row changes retain explicit transactions, and external R2 writes still
  follow an explicit durable flush.
- Removed a duplicate tombstone check: the common verified-read function already
  rejects blocked objects.

The production TypeScript shrank from 632 to 566 lines, including comments and
blank lines. The HTTP entrypoint shrank from 202 to 154 lines. The SQLite schema,
receipt states and singleton identity were preserved. A subsequent quota update
adopted the requested 100 MiB/day refill, 200 MiB long-term credit cap, 8 MiB/hour
refill with 8 MiB short-term credit, and 8 KiB minimum debit. This uses the same
capped-bucket implementation; no new admission mechanism was added.

## Deliberately retained

- **One coordinator and private R2.** Putting all source in one SQLite object
  would remove a service but introduce a much smaller storage ceiling and make
  every GET a coordinator request. Sharding that later would add a new design.
- **Pending receipts and explicit flushes.** SQLite and R2 do not share a
  transaction. These are what prevent ambiguous failures from admitting
  uncharged data or charging a same-digest retry again.
- **The bounded mutation queue and conditional R2 writes.** A SQL transaction
  does not cover a network await. The queue orders publication and blocking;
  conditional writes also protect against delayed writes across restarts.
- **Hash verification on reads.** It is cheap at this blob size and directly
  enforces the service's central promise.
- **Integer token arithmetic, body bounds and timeout.** These are small,
  reusable mechanisms that enforce explicit resource limits.
- **A minimum quota debit.** Object count drives write charges and receipt
  growth. Removing this control would make a byte-only budget misleading.

## Upgrade notes

No database migration is needed. Existing receipts and buckets keep their state.
Remove `SHARED_CACHE_SECONDS`, `PUBLIC_ORIGIN`, `CF_ZONE_ID` and
`CF_CACHE_PURGE_TOKEN` from any existing deployment configuration/secrets.
Block responses no longer contain `cache_purge` or `shared_cache_seconds`; the
public stats no longer contain `shared_cache_seconds`.

If you had explicitly enabled shared caching in the first version, old browser
and downstream shared copies can retain their previous freshness periods. Purge
Cloudflare's old entries through the dashboard if necessary. New code does not
read the old Cache API entries. This is separate from recalling copies already
downloaded by browsers, which the service has never promised.

The checks include an old-cache-entry regression, same-length and wrong-length
bad admin tokens, concurrent admission, failed R2 writes, block races and runtime
restarts. The simplicity pass preserved default HTTP behavior; optional shared
blob caching is intentionally removed. The subsequent quota update also tests
decades of inactivity followed by sustained demand, including rolling hour/day
admission bounds.

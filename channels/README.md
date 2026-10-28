# Sprig channels 0.1

A public, bounded, expiring stream of UTF-8 strings. Anyone can make an address; anyone knowing it can read. Posting requires its secret. The first implementation is a separate Cloudflare Worker with one SQLite-backed Durable Object coordinating the bounded set of channels.

Generate 32 random bytes `secret`; `address = SHA256(secret)`. Encode both as 64 lowercase hexadecimal digits for transport. Hash the **raw secret bytes**, not their hexadecimal representation. These are bearer credentials at a trusted host, not asymmetric keys or end-to-end encryption. The server does not store the secret, but receives it in authenticated requests.

## Local use

From the parent workbench directory:

```sh
npm ci
npm run dev
```

Open http://localhost:5173/channels. Create a channel, copy a reading or participant link, and open it in another tab. The real Worker runs locally at http://127.0.0.1:8788, with persistent SQLite under `.local/channels/`. No Cloudflare login is needed. The global quotas, proof protocol, transactions and hibernation-capable WebSocket handlers are the same code used for deployment. Local workerd does not reproduce the Cloudflare network, TLS, billing or optional edge per-IP limiter.

The browser keeps posting credentials only in memory. A participant link carries the key in its URL fragment, which is removed from the address bar before API calls. Save that link or use **Save posting key** before closing/reloading the tab. Received messages render as text and are bounded to 256 messages / 256 KiB in the tab. A hidden tab disconnects, then resumes from its cursor when visible. The browser tries five reconnects with backoff after interruptions. This is a channel terminal beside Moss; guest programs do not acquire networking permissions.

## Native command-line client

Node 24.22.1 or later in Node 24; no build needed. From the workbench:

```sh
node channels/scripts/channel.mjs new http://127.0.0.1:8788 my-channel.key
node channels/scripts/channel.mjs read http://127.0.0.1:8788 ADDRESS
CHANNEL_KEY_FILE=my-channel.key node channels/scripts/channel.mjs post http://127.0.0.1:8788 EPOCH < message.txt
node channels/scripts/channel.mjs follow http://127.0.0.1:8788 ADDRESS
```

Creation prints the address, incarnation (`epoch`), expiry and initial cursor. The key file is created exclusively with mode 0600; it is written before the network operation so a lost response cannot lose the key. Set `CHANNEL_KEY_FILE` or `CHANNEL_SECRET` for posting; do not put a secret in command-line arguments. `follow` prints bounded JSON batches, acknowledges delivery, and exits on disconnect. Re-run with its last cursor to resume. It deliberately does not silently reconnect to a new incarnation.

## HTTP and WebSocket interface

All API responses use `Cache-Control: no-store`, permissive CORS without cookies, `nosniff`, and `no-referrer`. Non-loopback HTTP is rejected. Secrets go in `Authorization: Bearer <secret>`; never in API URLs.

| Method and path | Meaning |
| --- | --- |
| `GET /` | Aggregate text status, limits, PoW settings and cumulative counters; no directory of addresses |
| `POST /challenge/channel/ADDRESS` | Obtain a bounded, expiring single-use ticket; requires posting secret |
| `POST /channel/ADDRESS/create` | Create an empty channel with a fresh epoch; requires secret and solved creation ticket |
| `POST /channel/ADDRESS` | Append the raw UTF-8 body; requires secret, epoch, message ID and solved append ticket |
| `GET /channel/ADDRESS?after=EPOCH_SEQUENCE` | Read a bounded history batch |
| WebSocket upgrade at the same read URL | Catch up and then follow the live log |

Creating the address is free and local. Only the explicit create operation allocates channel records. Unknown-address reads do not allocate per-address state. Recreating an expired address requires its secret and fresh admission; it gets a fresh random epoch. All appends are bound to that epoch, including those already in flight. Reads never consume messages.

A creation challenge has body `{"operation":"create"}`. An append challenge has `operation`, `epoch`, `message_id` (32 lowercase hex digits), `digest` (SHA-256 of exact UTF-8 body bytes) and `bytes`. Asking for a challenge does not send the message body or require the server to hash it.

The returned ticket includes `protocol`, `id`, `operation`, `address`, `epoch`, `message_id`, `digest`, `bytes`, `expires_at_ms` and `target`. Creation uses `-` for epoch, message ID and digest, and zero bytes. See `src/protocol.ts` for the exact newline-delimited preimage: all those fields in order, then a 16-digit lowercase hexadecimal nonce, with a final newline. A proof succeeds when its SHA-256, interpreted as a big-endian integer, is at most `target`.

Expected work is approximately `2**bits + bytes*POW_PER_BYTE`; creation and append have separate bit settings. Send `Channel-Ticket` and `Channel-Nonce`. Append also requires `Channel-Epoch` and `Channel-Message-Id`. Both PoW bit defaults are zero, but tickets remain single-use. A valid ticket is consumed before waiting for an append body, so body failure or quota rejection requires a new ticket. Outstanding tickets have both a count cap and an expiry. The supplied client caps solving at one million trials / 30 seconds and each HTTP exchange at 15 seconds.

Each accepted append gets an atomic sequence number and server timestamp. A message ID is deduplicated **only while its message remains retained**. A retry with the same ID and exact bytes returns the old sequence, including when the original ticket was spent; different bytes give `409 message_id_conflict`. Once evicted, that ID can be accepted again with a fresh ticket. This is not an exactly-once queue. Concurrent appends are totally ordered within a channel; ordering across channels is not an API guarantee.

History batches contain `epoch`, `earliest`, `head`, `messages`, `cursor`, `gap`, `has_more` and `expires_at_ms`. Each message has `seq`, `id`, `at_ms`, `text`. Start without `after` to read the oldest retained entries. A stale cursor reports `gap: true`; a cursor from another epoch fails explicitly. Each response is at most 32 messages / 64 KiB of encoded JSON, including escaping overhead.

WebSocket batches additionally carry `receipt` and `subscription_expires_at_ms`. Reply with exactly `{"ack":"RECEIPT"}` after consuming the batch. At most one batch is outstanding per connection. Appends that arrive while a batch awaits ACK stay in the bounded log; no per-client message queue grows. An ACK triggers further catch-up when needed, which may report a retention gap. Catch-up and subscription registration run without an intervening asynchronous step, avoiding a missed-event window. The socket never accepts chat messages; append over HTTP.

## Initial limits

All settings are in `wrangler.jsonc`; raising them is an operator decision. Buckets refill continuously and start full, with accumulated credit capped.

| Resource | Default |
| --- | --- |
| One message | 8 KiB UTF-8 |
| One channel | 256 KiB / 256 messages, oldest first |
| Message visibility age | 1 hour |
| Channel lifetime | 24 hours from creation, never extended by reads or posts |
| Stored channels | 1,000 |
| Creation | 100/day, maximum credit 100 |
| Global requests including socket ACKs | 600/minute, burst 120 |
| Challenges | 60/minute, burst 60; at most 512 outstanding for 120 seconds |
| Accepted ingress | 100 MiB/day, credit cap 200 MiB; additional 8 MiB/hour bucket with cap 8 MiB |
| Ingress minimum debit | 1 KiB per message, including empty text |
| One channel's appends | 120/minute, burst 30 |
| Charged delivery | 400 MiB/day, cap 800 MiB; additional 16 MiB/hour bucket with cap 16 MiB |
| Delivery minimum debit | 1 KiB per history response / WebSocket batch |
| Live subscriptions | 256 total, 16 per channel |
| Subscription lifetime / ACK deadline | 5 minutes / 15 seconds |

Delivery charges count actual encoded JSON size, with the minimum debit. Ingress is charged even if an append evicts older messages. Minimum debits bound the operation cost of tiny messages and empty reads. A closing connection can temporarily occupy its slot. Alarms close expired/unresponsive subscriptions; event handlers also check deadlines. Alarm delivery can be delayed, so these are protocol deadlines, not promises about the exact instant a physical socket closes.

Age expiry is enforced on reads and appends even if cleanup is delayed. Physical deletion occurs on channel access or at channel expiry; the maximum channel count and per-channel limits bound otherwise quiet data. `stored_messages` and `stored_payload_bytes` describe physical payload rows, including age-expired rows not yet visited. They exclude SQLite indexes, metadata, backups and accounting overhead. Alarms delete expired channel records in bounded batches. Request-time checks do not rely on punctual alarms.

## Deployment when ready

In `channels/`:

```sh
npm ci
npm run check
npx wrangler login
npm run deploy
```

`check` includes a **dry run**, which does not deploy. Deployment is a separate explicit command. Attach `channels.sprig.run` as the custom domain when its Cloudflare zone is ready; the commented route is supplied. The browser build's `channelOrigin` in `../workbench.config.json` must match your chosen origin. Build and publish the static workbench separately through your usual Netlify/GitHub setup, including `/channels` and `/c/*` rewrites and the WebSocket CSP permissions. No R2 bucket, account directory, signing secret, or server-held master key is required for channels.

The Worker uses the same current Wrangler `exports` SQLite declaration as the existing blob service. Preserve the hub name and Durable Object namespace across normal releases. Changing them creates a different service state. Changes to protocol fields require versioning; retain old frontend release assets for open tabs.

Nothing in this archive is deployed automatically. See [DESIGN.md](DESIGN.md) for deferred choices and [SECURITY.md](SECURITY.md) for the security review and resource-accounting boundaries.

# Channel decisions and things to revisit

Decision date: 27 October 2026. Nick approved public creation, a hash-derived address/secret pair, channel-first retention, and live subscriptions. The service carries plain strings and deliberately does not interpret claims of identity, Sprig capabilities, world commands, or executable code.

## What is implemented

`/channel/address` is a public-by-link rolling log. Its secret permits append and can derive the reading address. The server authenticates possession over HTTPS, assigns ordered sequence numbers, and evicts oldest messages when bounded bytes/count/age require it. Opening a link does not create state. Creation is explicit, public, quota-admitted and optionally work-priced. Epochs distinguish successive incarnations at the same address.

The implementation uses **one SQLite Durable Object for the bounded service**, rather than the initially proposed object per channel. This makes creation quotas, total channel count, tickets, ingress, delivery and append/trim updates local and atomic. It also avoids per-object SQL schema and distributed admission leases. One busy channel shares a scheduling/throughput boundary with the others; bounded request sizes and quotas keep this appropriate for the bootstrap. An API-compatible future implementation can distribute channel logs after defining how global permits are reserved, expired and recovered. Do not add a distributed quota protocol merely to anticipate that scale.

HTTP appends and cursor reads are sufficient for native clients. Hibernating WebSockets provide the live browser path. They reuse the read cursor protocol, have a single ACK-controlled outstanding frame, and reconnect to the same epoch. No SSE endpoint is included because a response stream held open by a Durable Object cannot use its WebSocket hibernation mechanism.

## Deferred choices

1. **Mailboxes.** `/mbox/address` can reverse the secret role: address permits append; secret permits read. Reject new messages when full rather than letting strangers evict existing messages. Preserve the separate namespace and immutable kind. Age expiry and bounded lifetime remain necessary; this is not a durable inbox promise.
2. **Independent capabilities.** Separate read and append keys would permit private conversations and independently replaceable access keys without renaming a stream. Our channel secret necessarily grants both read and append. Keep separate capabilities as an explicit additional resource kind or a versioned protocol, not a silent change to existing addresses.
3. **Revocation and identity.** Everyone sharing the secret has the same authority. There is no per-person revocation, attribution, account, ownership certificate, signature, delete permission or in-place key rotation. Tarsnap's separation of authority remains a useful precedent, but this service has no Tarsnap-style encrypted archive key system.
4. **Encryption.** The trusted host sees messages and receives authentication secrets. End-to-end encryption and signatures would need established authenticated protocols and a documented key lifecycle. The SHA-256 address is not a signing key, and TLS is not protection from the host.
5. **Retention and continuity.** Defaults are intentionally short: one hour of message visibility and a fixed 24-hour incarnation. Decide from actual use whether channels should support explicit leases, owner-authorized extension, fixed lifetime versus inactivity expiry, or more kinds. A fresh epoch prevents stale cursors or delayed appends from referring to a replacement. Copying old message bodies into a fresh epoch remains possible for authorized participants.
6. **Delivery and retries.** Retained message IDs allow useful retry recovery but not permanent exactly-once semantics. A truly durable queue, acknowledgements that delete mail, or a longer deduplication horizon is a different contract with additional storage/accounting. Hibernation does not guarantee connection permanence; clients always need cursors and reconnect logic.
7. **Capacity and fairness.** Tune creation, message, request and delivery buckets using real traffic. Proof of work prices effort, not human merit or one-person-one-share; faster hardware buys more attempts. Global hard admission remains authoritative. Consider leased capacity, per-channel fair shares, abuse reports and temporary operator suppression before expanding public scale.
8. **Cost.** Measure rows read/written including indexes and accounting, CPU, wakeups, duration, WebSocket traffic, failures and alarms. A small maximum retained payload does not cap write churn or incoming-request charges. The store and channel service share account allowances. Extend the existing Python pricing model with measured channel workloads before treating a $10/month target as a guarantee. Cloudflare spending alerts are not an application admission rule.
9. **Archival.** Explicitly exporting a channel into the blob store is possible. Never silently archive. Future mailbox export into a public blob store would change its confidentiality and requires deliberate user action or encryption.
10. **Runtime integration.** Keep the native compiler/Code milestone independent. Later expose channel reads/appends through explicit host-granted capabilities with bounded decode/copy queues. A received string cannot manufacture a domain capability, regain a cancelled completion ticket, or run itself.
11. **Federation and rendezvous.** Carry ordinary textual application protocols first. Relay discovery, WebRTC signaling, independently operated services, names and cross-service identity can be added above the primitive. Keep the service origin explicit in native clients; a hash alone does not locate a server.
12. **Client usability.** Secret recovery/export, explicit invitation service origins, participant lists, transcripts, browser privacy modes, mobile testing, and broader browser coverage can improve without changing the log semantics. There is no presence or named author model today.

## Source pointers

- `src/index.ts`: authentication, SQLite log, global admission, proof tickets, subscriptions and alarms.
- `src/protocol.ts`: canonical key, cursor and proof formats.
- `src/client.ts`: bounded browser/native HTTP client and ACK subscriber.
- `src/config.ts`, `wrangler.jsonc`: bounds and operator settings.
- `test/channel.test.mjs`: real local Worker integration tests.
- `../src/channel-main.ts`: browser terminal; no guest networking integration.

Platform references consulted 27 October 2026: [hibernating WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). These describe platform behavior; they are not deployment or billing measurements for this project.

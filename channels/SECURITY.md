# Channel security review

This is a trusted-host prototype with explicit application bounds. Its tests run the actual Worker in local workerd; they are not an independent audit or a test of deployed Cloudflare behavior.

## Authority and confidentiality

The secret is 256 uniformly random bits. SHA-256 of its raw bytes is the address. A fixed-length comparison checks the recomputed address. No password-derived keys, reversible server encryption, server master secret or asymmetric crypto are used. The server receives the secret on create/challenge/append requests and can impersonate participants. It can read, omit, reorder or fabricate output. Unlike immutable blobs, the channel does not offer externally verifiable publisher authenticity. Read access is public to anyone knowing the address; the service has no public address directory.

Sharing a posting secret gives all recipients equal posting power, including the ability to fill the rolling log and evict previous messages. A channel intentionally grants that power. No participant can be individually revoked. A future mailbox must reject on full and must not alias the same stored log under reversed permissions.

HTTP APIs reject non-loopback cleartext, use no cookies and never accept a secret in the query string. CORS permits credential-free cross-origin use with explicit bearer tokens. Disable/redact body and Authorization logging in any external proxy. The provided observability setting is disabled, and application code never logs payloads, keys or IPs. Reading or posting to a different service origin is a deliberate configuration action in the UI.

## Replay, idempotency and incarnation

Proof challenges are bounded records with random 128-bit IDs and short expiry. The proof preimage binds protocol, operation, address, epoch, message ID, exact body hash/length, expiry and target. Difficulty verification costs one short SHA-256 independent of message length; checking body integrity costs one body hash, at most 8 KiB. Tickets are deleted synchronously before waiting for the append body. Bad bodies, expired deadlines or later quota failure do not restore a ticket.

Creation gives the address a random epoch. Every append, retry and cursor names it. Expiry/recreation cannot make delayed appends reach a successor. A message ID only deduplicates while its message is retained; a holder of the posting secret can intentionally append identical text under a new ID and valid ticket. Proof of work is not content uniqueness or sender identity.

## Bounds and cleanup

Global counters and bucket updates are local to one Durable Object. Append admission, sequence assignment, log insertion, retained-history trimming and ingress accounting are one synchronous SQLite transaction. Credits are capped, with exact integer refill arithmetic. Ingress is charged for every accepted new message, including those that evict previous content; tiny messages have a 1 KiB minimum debit.

Bodies have a header and streaming byte check, a retained buffer limit, and an elapsed deadline. UTF-8 decoding is fatal on malformed input and preserves BOM and line endings. Raw messages are never evaluated. JSON history/frame size includes escaping, so control characters cannot multiply outgoing frames beyond 64 KiB. At most 32 message records are read per history batch.

One channel's log is capped by bytes and record count. Channel count, creation rate, ticket count/age, global requests, per-channel posting, delivery bytes and socket counts/lifetimes are separately bounded. Constructor initialization creates only singleton hub tables; probing arbitrary addresses does not persist arbitrary channel names. Metadata expires with each fixed channel lifetime. Alarms clean expired channels in batches of eight and at most the bounded ticket/socket sets. Logical expiry is checked even when physical cleanup is late. Provider backups or point-in-time recovery may retain old database contents after live deletion; expiry is an availability promise, not secure erasure.

WebSockets are read-only and accepted using `ctx.acceptWebSocket`. Connection metadata is stored in hibernation attachments. There is no idle polling timer inside the object. A server-generated receipt permits exactly one outstanding encoded frame per socket; the server reads subsequent messages from the bounded log after ACK rather than accumulating per-reader queues. Missing ACKs and expired leases close the connection. Actual runtime/TCP buffers remain platform-managed; the application bounds what it enqueues, not every lower-layer byte. Closing sockets may occupy slots until their close event finishes.

The optional edge limiter supplements global admission. Public rejected requests and malicious socket events can still incur platform charges before the application rejects them. These limits are not a universal DDoS defense or an absolute billing ceiling. The singleton is also a throughput/failure boundary; splitting it later requires a deliberate distributed admission design.

## Browser and native clients

All received text is inserted using `textContent`, never HTML. Keys live in page memory, not localStorage, message history, API URLs or automatically published blobs. Participant-link fragments are captured and scrubbed before API calls; links and exported files intentionally contain authority. A compromised workbench origin, extension, browser or operating system can access that authority. There is no claim of isolation from the host page.

Client HTTP operations reject redirects, omit cookies, limit response bytes and time out. Proof solving is bounded. The WebSocket client checks the message shape, frame size, epoch and cursor monotonicity, and ACKs only after its consumer succeeds. The browser bounds rendered history and disconnects while hidden. Posting preserves a retry ID and draft after failure. A command-line key is stored before creation, with exclusive file creation and private mode where supported.

The channel UI is independent of guest execution. Existing Moss programs still have only terminal and source-loading host operations; adding a channel page does not grant them arbitrary HTTP, socket or credential access.

## Verification scope

The integration suite covers key encoding, canonical cursors, auth separation, nontrivial PoW, single-use tickets, malformed UTF-8, body integrity, idempotent retries, concurrent appends, byte/count/age eviction, gaps, bounded escaped JSON, persistent restart, fresh epochs, channel/ticket/ingress/delivery/subscription limits, ACK backpressure, multiple live subscribers, and timed socket closure. Workbench unit/store checks remain separate. Wrangler's deployment dry run validates the bundle and bindings without uploading a service. Cloudflare edge hibernation and billing require deployment observations.

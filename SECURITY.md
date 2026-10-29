# Security boundaries and verification

This is an implementation review of the workbench and Moss toy runtime, not a certification of a future Sprig VM.

[THREATS.md](THREATS.md) maps the service threats and core invariants to code and
evidence. [Store operations](store/OPERATIONS.md) covers deployment rehearsal and
the separate, still-unimplemented backup/restore obligations.

Release 0.4 changes host presentation and adds direct/draft routes. Both program views verify the same source bytes and require explicit Run. Invalid/unavailable links leave execution and publication disabled and do not overwrite the local draft. The digest badge encodes all 256 bits reversibly, copies the existing canonical hash_length, and is hidden for changed unpublished bytes. It is not a new store addressing or authorization scheme.

Restart advances the host run generation before canceling the old worker. The existing WorkerJob and RunSession reject stale traffic before invoking output/input hooks; an additional generation check guards terminal rendering. The editor DOM node is retained across collapse and restart. UI controls are host-owned: this prototype does not implement two Sprig UI capabilities or generic guest widget production. Its LinkeDOM tests use fake worker endpoints and emulated focus/selection, so they are controller checks, not browser sandbox or layout tests.

Release 0.3 adds a separate channel UI and service. Its authority, replay, retention, quota and WebSocket review is in [channels/SECURITY.md](channels/SECURITY.md). The shared client and actual local Worker are integration-tested; interactive browser QA of the new channel page remains pending because the available browser could not reach the local server. The channel page does not extend guest authority.

## Source, storage and identity

Source and error text are rendered with textarea/textContent, never HTML. Links load without executing. Files and edits are bounded to 256 KiB. A file's exact UTF-8 bytes survive import, draft persistence, publication and download until the first textarea edit; edits normalize line endings to LF. Hash and length are checked before loaded source is displayed or passed to an interpreter.

The content loader accepts canonical addresses only. It captures one selected store for the run, sends no credentials, rejects redirects, and caps the complete source graph. No URL or store selection is accepted from guest code. Cached bytes are copied before passing to a worker. Web Crypto is required for publishing and verification; no insecure hashing fallback is shipped.

The pinned v0.5 publisher validates challenge identity, limits each HTTP request to 15 seconds, response JSON to 4 KiB and solving to one million trials/30 seconds. A 65-second worker deadline bounds the complete publish attempt. It publishes a frozen revision; edits during publishing do not change those bytes. Cancellation may happen after a server commit, so the UI explains that a blob might already exist. There is no automatic retry loop or retention promise.

The production store source lives in this repository; its latest simplification review is in [SERVICES.md](SERVICES.md). The local launcher uses local R2 and SQLite only, retains its global quotas and proof flow, and seeds only its own local instance. The optional Cloudflare per-IP rate-limit binding is not simulated. Local persistence is excluded from packaged files and version control.

## Execution and terminal I/O

Moss has an explicit lexer/interpreter and finite values. There is no guest JavaScript evaluation, property access, object/prototype manipulation, arbitrary import, DOM access, credential access, or arbitrary network operation. Its guest words are enumerated in MOSS.md. All grafted code has the same authority as its caller and shares the same resource budgets.

The interpreter caps source, tokens, instructions, frames, definitions, values, string sizes, imports, input requests and output. These limits bound the toy's structures but are not byte-accurate JavaScript heap accounting. A browser Worker alone is not an authority boundary for trusted adapter JavaScript; adapter code remains part of the trusted computing base.

The host runs each program in a fresh Worker, permits only one correlated I/O request at a time, and has active-time, per-I/O and total-session deadlines. Stop/error/completion abort outstanding I/O. Late replies cannot enter a new session. Input is plain text, never shell input or HTML; prompts and typed replies consume the same terminal transcript budget. Terminal input is not published with source, though a running program can echo it; no secret/password mode is provided.

Neither printing nor input changes the stored program. Browser drafts are one local-storage record, not encrypted storage or backups. Another script compromised on this origin could access drafts. Download personal copies you need to keep.

## Delivery and tests

Netlify header rules restrict script/worker origins, prevent framing/MIME sniffing/referrer leakage and separate immutable release assets from HTML that revalidates. Other hosts must reproduce the headers and `/r/` rewrite. Browser code does not contain admin tokens, service workers, analytics or remote fonts.

36 workbench tests cover source fidelity, malicious/corrupt inputs, canonical addresses, complete badge encoding, copied snapshots/caches, interpreter bounds and lack of ambient JS access, cancellation, timeout behavior, stale replies, retained editor state, and direct/shared route behavior. One integration test runs the production store and real browser-worker code locally, covering nontrivial proof, publication, duplicate handling, restart persistence, verified grafts, execution and input.

Browser QA exercised terminal arithmetic and text, input replies, example selection and Stop. Publishing/verified loading in the managed HTTP preview is limited by its insecure context; the local-store integration tests cover those paths. Mobile layout and broader browser compatibility remain unverified. Nothing has been deployed or DNS-configured by this update.

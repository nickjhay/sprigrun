# Validation record for workbench 0.3 and channels 0.1

27 October 2026. Node 24.22.1, pinned TypeScript 5.9.3, Miniflare 5.20261023.0-beta, and Wrangler 4.153.0.

- Root `npm run check` passed: frontend/server TypeScript checks, 28 workbench unit tests, one real-store integration test, nine channel tests, and the production build.
- After tightening alarm scheduling to preserve an existing earlier deadline across requests and cold starts, typechecking, the two alarm/hibernation tests, and the production build passed again.
- `wrangler deploy --dry-run` passed for the channel Worker and declared bindings. No deployment command was executed without `--dry-run`.
- Native CLI smoke passed through the actual local Worker: key file creation, channel creation, posting from stdin, and history retrieval.
- At the original archive checkpoint, `store/` and `vendor/` were compared byte-for-byte. The subsequent [service review](../SERVICES.md) removes the duplicate vendor client and consolidates quota/work arithmetic; root CI now also runs the full store suite.
- Tests use no production account or remote resource bindings. Temporary keys/state are not in the archive.

Channel coverage includes exact raw-key hashing, canonical cursors, secret verification, nontrivial proof solving, ticket scope and single use, malformed UTF-8, digest/length mismatch, oversized bodies, retained duplicate recovery, concurrent ordering, byte/count/age trimming, gap reporting, encoded JSON bounds, persistence across restart, channel incarnation replacement, capacity/quota rejection, two live subscribers, ACK backpressure, server-initiated close deadlines, and forced hibernation with an outstanding receipt.

For deadline tests, observing WebSocket CLOSING proves the client received the server's close frame; full transport teardown may lag. Tests do not pretend alarms provide hard real-time TCP teardown. Logical deadline checks remain active in handlers.

Interactive browser QA of the **new channel page** remains pending. The available cloud browser could not connect to the local server, and a separate headless browser download failed. The page builds/typechecks and its shared protocol client is integration-tested; this does not establish browser layout, clipboard, visibility/reconnect or multi-tab UI behavior. Use [BROWSER-CHECK.md](BROWSER-CHECK.md) locally. The earlier Moss browser checks are recorded separately in the root README.

No load test, production hibernation measurement, or actual billing measurement has been performed. The payload/operation limits are application admission controls, not a guarantee of a monthly invoice ceiling.

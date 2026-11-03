# Sprig native core

3 November 2026. Executable protocol groundwork for the new public service at
`https://sprig.run`. The protocol and [SQLite/R2 acceptance layer](host/README.md)
and [whole-core recovery](RECOVERY.md) are implemented and tested locally.
The [public HTTP adapter and linked explorer](HTTP.md) are implemented locally;
deployment remains ahead.
The running workbench/store/channels are unchanged;
the older implementation is preserved on
[reference/pre-native-core-2026-11-02](https://github.com/nickjhay/sprigrun/tree/reference/pre-native-core-2026-11-02).

With Node 24 and the root dependencies installed:

```sh
npm run test:core
npm run demo:core
npm run seed:core
```

These commands do not need workerd, an account, or network access. The demo uses
a clearly public test key and a fixture receipt. It verifies signed intent and
shows a sender continuing from anchor 12 through an allocated entry 27.
The seed command prints a candidate inventory; it does not provision identities.

`npm run test:acceptance` exercises the real Durable Object and private R2 in
Miniflare, including on-disk restart, lost replies and injected failures. This
additional command needs a supported workerd platform; the three commands above
still work without it.

- [PROTOCOL.md](PROTOCOL.md): normative candidate v1 bytes, references and errors.
- [INVARIANTS.md](INVARIANTS.md): proof obligations, trust boundaries and next steps.
- [seed/README.md](seed/README.md): contents we can carry into the public commons.

The public-facing formats use one versioned first-line marker. An action is
metadata, a blank line, a minimal request, a blank line, and exact body bytes:

```text
#!sprig.run/spec/action/1
author: /plot/nick.0

POST https://sprig.run/chat/grove/chess.7/12

Hello from the fern.
```

There is no nonce/occurrence field. Keep a pending action unchanged across
retries. To intentionally repeat it, wait for its receipt and use the returned
entry as the next append anchor. `nextAppendAction` implements that client step
after checking that the receipt corresponds to the pending action and collection.
It cannot establish that an untrusted server really committed the record.

The same continuation works for grove publications, plot allocation and plot
publications. An anchored POST appends to the collection containing the entry;
it never overwrites that entry. For example, `POST /plot/moss.3` asks for another
plot under the handle `moss`; `POST /plot/moss.3/notes` publishes under that plot.
Source storage at `POST /sea` remains idempotent by bytes.

The host reuses these exact parsers and clients. Its acceptance transaction
commits the action identity, allocation, record, metadata debit and receipt
together. Private source preparation has its own durable quota reservation;
failed preparation does not publish anything. See the host note for the precise
cost boundary and the remaining public-release work.

The native host now includes [whole-core recovery](RECOVERY.md). Run
`npm run demo:recovery` for a real local SQLite/R2 loss-and-restore drill.

Run `npm run dev:core -- --operator` for the native local service at
http://127.0.0.1:8789/, with a small planting installed through normal HTTP
admission. This needs a supported workerd platform. `npm run test:http` covers
the public and authenticated operator transports; it is included in `check`.

# Sprig native core

5 November 2026. Executable protocol groundwork for the new public service at
`https://sprig.run`. The protocol and [SQLite/R2 acceptance layer](host/README.md)
and [full/incremental recovery](RECOVERY.md) are implemented and tested locally.
The [public HTTP adapter and linked explorer](HTTP.md) are implemented locally;
deployment remains ahead.
The first public preview uses one metadata database and read-only committed-prefix
backups. Future shards may have weaker cross-shard consistency; colocate atomic
relationships later. Epochs and the global barrier are removed from active code. Finish independent backup custody, a recovery-loss policy and an operator rehearsal before opening public writes.
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

- [OPERATIONS.md](OPERATIONS.md): independent backups, local rehearsal and editable costs.
- [PROTOCOL.md](PROTOCOL.md): normative candidate v1 bytes, references and errors.
- [host/README.md#logical-owners-and-local-policy](host/README.md#logical-owners-and-local-policy): collection ownership and independent hide/block policies.
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

Backups now copy a committed journal prefix without pausing writes or storing
snapshot epochs. The previous barrier/cluster implementation and tests remain on
[reference/epoch-core-2026-11-05](https://github.com/nickjhay/sprigrun/tree/reference/epoch-core-2026-11-05).

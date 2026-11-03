# Sprig native core: protocol slice

3 November 2026. Executable protocol groundwork for the new public service at
`https://sprig.run`. No HTTP service, database, deployment, or atomic acceptance
is implemented in this package yet. The running workbench/store/channels are
unchanged; the older implementation is preserved on
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

The first persistence slice should implement shared transactional acceptance,
rather than an independent in-memory twin. Keep parsers/crypto in this package,
add native SQLite transactions, and reuse these exact clients and test vectors.

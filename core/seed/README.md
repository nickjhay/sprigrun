# A first planting

These are real candidate contents for the public commons, kept separate from
cryptographic test fixtures. Run `npm run seed:core` to inspect their exact hashes
and publication intentions. Nothing is uploaded or allocated.

Moss is a proposed workbench resident: a profile, a first-morning note, and a
welcome beside a small program that already runs in the existing Moss/1 toy.
The words are worth keeping even before the service exists.

`inventory.txt` pins the reviewed bytes. Content edits intentionally change their
addresses; review them and run `npm run seed:core -- --write` to update the inventory.
CI checks that the files and inventory agree.

Install through the ordinary public API:

```sh
npm run plant:core -- https://staging.sprig.run .local/planting-staging
```

This sends public writes. The target must already be deployed; see the
[runbook](../deploy/README.md). Use a **different state directory** for production.
It creates a fresh Ed25519 `identity.pem` with private file permissions and retains
each exact action and signature in `planting-journal.json` **before** sending it.
It verifies and saves the receipt before sending the next request. Files are
flushed and journal replacements use rename plus a directory flush. The installer
uses returned plot/publication numbers; it never assumes `.0` belongs to Moss.

Run the same command to resume a timeout, rate limit, interruption or lost response.
Completed steps cause no HTTP requests. A distinct author's existing source is
reused only after fetching and checking its exact bytes and receipt; the journal
marks it `existing`, not an acceptance of our action. An identical anonymous
publication deliberately resolves to its existing receipt. Planting does not
force new public allocations or automatically advance an anchor.

Keep the origin, inventory and key fixed for a planting. Drift, missing keys and
corrupt journals stop before further writes. The process holds `planting.lock`;
after an unclean exit, confirm the installer is stopped before removing that lock.
Keep a secure recovery copy of the private key and journal. Do not discard them
to retry: a fresh key can allocate a different plot. Use a local durable filesystem
with atomic rename and fsync support, not a network sync folder.

The declaration file contains no signing key. Never use `core/test/vectors` keys for a seed account; their
private material is public. No production identity, ownership, or submission
time has been claimed here. The date in the note is its composition date.

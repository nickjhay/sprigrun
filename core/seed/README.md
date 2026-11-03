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

A future installer should:
1. Publish these exact values through normal admission.
2. Provision Moss's key in operator-controlled storage outside the repository,
   retaining its public key record and a recovery copy of the private key.
3. Allocate the plot and publications through the normal APIs; save the returned
   references instead of assuming any `.0` is ours.
4. Resolve declaration labels using those receipts, then append the welcome.
5. Persist each submitted action before sending, so interrupted installation
   retries the same bytes. Keep receipts as the installation journal.

The declaration file contains no signing key. It deliberately requires a future
provisioning step. Never use `core/test/vectors` keys for a seed account; their
private material is public. No production identity, ownership, or submission
time has been claimed here. The date in the note is its composition date.

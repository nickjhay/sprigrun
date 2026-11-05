# One recovery stream

One authoritative metadata database and private immutable R2 bodies. The
`journal` is a small index of all reconstruction facts: source reservations,
accepted results, moderation decisions and pause transitions. Each fact, pointer
and monotonic u64 position commits in the same SQLite transaction. The result
already contains its receipt and evidence; the index never duplicates payloads.

A read-only checkpoint captures control, policy and position P and waits for
storage durability. It adds no row or epoch and pauses no commits. Export pages
stay within that journal's `position <= P`. Immutability makes copying those rows
and their accepted R2 bodies later safe while new writes continue. Reservations
need no unpublished body. Exact retries, GETs and rejected admissions create no
journal fact; spendable quota credits reset to zero on recovery.

Full and incremental copies use the same bounded stream. A full copy starts at
zero; an increment starts after the exact previous checkpoint and binds its
archive digest. The header holds the small control snapshot and the footer
checks replayed accounting. Empty copies are valid. No stored cuts, backup pins
or coordinator-wide barrier state are needed while historical data is retained.

Restore into empty storage under persistent quarantine. Validate each bounded
record, its signature/receipt and prior dependencies; commit it with its resume
cursor. Pin the final trusted digest before import. Missing links, changed files,
gaps and conflicting retries cannot complete the plan. Release additionally
requires explicit history reconciliation, removal of the environment fence and
unpause. A supplied chain cannot reveal its unknown acknowledged suffix.

For future shards, retain local transactional order and independent checkpoints.
Accept weaker consistency across shards; colocate things needing atomicity.
Cross-shard placement and reconciliation are later work, not a reason to preserve
a global barrier now. The earlier experiments and their failure tests remain on
[reference/epoch-core-2026-11-05](https://github.com/nickjhay/sprigrun/tree/reference/epoch-core-2026-11-05).

See [RECOVERY.md](RECOVERY.md) for invariants and [OPERATIONS.md](OPERATIONS.md)
for commands, independent witness custody and the recovery promise.

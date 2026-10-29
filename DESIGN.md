# Design update: sprig.run, a store, and a terminal

[NEXT.md](NEXT.md) records the current naming, commons and UI plan. The standalone
[naming experiments](NAMING.md) exercise signed parent chains, stronger-key
recovery, and ordered replay with bounded recovery windows. They do not change
the storage, runtime or channel contracts below.

The [garden note](GARDEN.md) is our touchstone for returning from implementation to the experience of using the place. Release 0.4.1 adds a small terminal fern in self-contained and grafted forms, using the existing language and host contract.

Release 0.4 introduces a retained host editor overlay, direct-run view, and full 256-bit base36 badge. [OVERLAY.md](OVERLAY.md) records this implemented slice and distinguishes it from the proposed Sprig supervisor, overlapping independently owned surfaces, init.sprig dependency editor, naming service, and durable workspace.

Release 0.3 adds a separate public channel service and browser terminal at `/channels` and `/c/<address>`. The implemented decisions, single-hub tradeoff, and deferred mailbox/key/federation/runtime questions are recorded in [channels/DESIGN.md](channels/DESIGN.md). Existing source and runtime contracts below remain in force.

The domain choice makes the first separation concrete: **sprig.run** distributes trusted workbench/runtime releases, **store.sprig.run** serves untrusted source bytes, and **polis.place** can later host the world/community layer. No extra service is needed for the reserved names.

## Keep the store language-agnostic

The v0.5 store still handles bounded UTF-8, canonical `sha256_length` identity, single-use challenges, proof verification, admission limits, private blob caching and operator controls. Moss adds no parsing or execution to the store. This lets future Sprig code use the same publishing and retrieval path.

The source address identifies exact bytes, independently of the workbench release. Moss places its language contract in the source header `#!moss/1`; a different language or incompatible Moss version fails explicitly. Future Sprig source can retain the planned versioned imports such as `from world.v4 import *`. A header/import is interpreted by a trusted runtime, never as permission to fetch and execute arbitrary JavaScript.

## Run URLs and run authority

New share links use `/r/<hash_length>`. Old `/w/` links remain accepted and are normalized after loading. The page verifies source before enabling execution; the source editor starts collapsed. `/run/<hash_length>` uses the same verified loader with no editor, while `/workspace` opens the existing single local draft. Run is explicit; loading a link does not silently begin a program or ask for input. Invalid or unavailable source links cannot fall back to a private draft.

Each Run captures its source revision and chosen store. I/O is represented by explicit host operations: text output, terminal input and verified source loading. The runtime does not need cookies, account access or an arbitrary fetch primitive. The eventual simulator can add carefully scoped capabilities without rewriting the blob service.

Grafts share their caller's I/O authority, stack and word dictionary in this toy. This exercises loading executable dependencies without pretending to solve the real Sprig module system. Graph depth, source volume, execution steps and output all have aggregate limits.

## Interactive waiting changes time accounting

The previous two-second whole-worker timeout would kill a program while a person was typing. The host now distinguishes active execution from a pending I/O operation. It keeps a cumulative active-time allowance, an I/O-specific deadline and an overall session deadline. Cancellation aborts the pending operation and terminates the worker; a response belongs to one session and request number.

## Local and deployed systems

The local launcher builds the same frontend and runtime sources, then executes the same store Worker entrypoint in Miniflare. It reads production variables from the checked-in Wrangler configuration and supplies local R2/SQLite bindings. Demonstration blobs are uploaded through normal HTTP with the normal challenge flow. The test suite proves store data survives a runtime restart.

The deliberate local differences are the resource implementations, loopback HTTP, local state directory, development no-store headers, absence of Cloudflare's network/TLS/CDN layer, and omission of its optional edge per-IP limiter. The store's global quotas, proof rules, content verification and permanent receipts remain active. No remote Cloudflare resource binding is used.

Builds stay separate: `.dev-dist` points at the local store; `dist` points at the configured production origin. Publishing a local program does not publish it globally. The same address can be available in one store and absent from another.

## Next meaningful step

Integrate a real Sprig compiler/VM behind the runtime contract once its browser package exists. Keep its guest memory and scheduler accounting in that runtime. The existing terminal, source resolver, immutable publication snapshots and cancellation boundary can stay; Moss can remain a tiny conformance fixture for the host interface.

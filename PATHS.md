# Stored paths and bounded publication plans

30 October 2026. **Design experiment, not a deployed API or a Sprig integration.**
Run `npm run demo:paths` with Node 24. It needs no workerd, account, network, or
macOS upgrade. The TypeScript model and its tests are in
`src/experiments/paths.ts` and `test/paths.test.mjs`.

The proposed simplification: public GET returns a committed representation.
Metered writes run bounded policy and publish a small plan. The host allocates
numbers, checks update preconditions, and commits paths and background tasks
together. Guest programs do not implement arbitrary request-time GET handlers
or receive a general database interface.

## A grove, and indexes underneath

Use **grove** provisionally for the opt-in, human-facing collection of works.
`catalog` would be a plainer alternative. Keep **index** for derived lookup such
as recognized references to a hash. Neither name changes the storage ontology.

Each topic can hold multiple independently controlled entries. An early arrival
owns no exclusive right to a word or to its descendants. Slash components group
topics; they do not implicitly delegate ownership of a directory.

| Illustrative path | Stored meaning |
| --- | --- |
| `/grove/nz/fern.0` | Current materialized card for the first entry under this topic. |
| `/grove/nz/fern.0@0` | That entry's first accepted revision. |
| `/grove/nz/fern.0@1` | Its next accepted revision; revision zero keeps its old meaning. |
| `/grove/nz/fern.1@0` | Another entry under the same topic. |
| `/grove/nz/fern.count` | Number of allocated entries, including unlisted/blocked entries. |

Here `.idx` means a **numeric slot**, and `@t` means an **accepted revision
ordinal**, not a timestamp or signed-chain depth. Historical numbers do not
change after recovery selects a different naming branch. Allocated entry numbers
are not recycled. A count is not a promise that every entry remains available.

Draft syntax: ASCII `[A-Za-z0-9_]+` path components, case-sensitive, leading
digits allowed. Dots and `@` belong to the structural suffix. Numeric suffixes
are canonical decimal u64 strings: `0`, never `00`, no signs or exponent form.
Limit components to 64 characters and complete paths to 256; generated current,
pinned and count paths must all fit. Overflow rejects instead of wrapping.

The model accepts canonical paths, not arbitrary URLs. An HTTP adapter must
define and check its raw request-target spelling, including percent escapes,
encoded slashes, backslashes and dot segments, before routing; it cannot assume
a URL parser preserved the original spelling. The model rejects these forms.
No final domain-wide URL spelling or existing `/b` route has changed.

## Cards, pins and following

A grove submission explicitly opts into a versioned card format. A card references
its source rather than changing source bytes. A pinned entry fixes a card hash;
a following entry identifies a genesis and materializes the card selected by its
accepted head. Keep the selected update/card hash and policy version with that
materialization. An accepted signed head need not select a valid card: surface
unavailable/ineligible instead of silently substituting another branch.

GET never chases a live chain or invokes Sprig to produce a fresh card. Same-authority
head selection and materialization can commit together; an asynchronous follower
must expose which head it has processed. It promises the latest **materialized**
selection, not necessarily the newest upstream head. Bounded traversal and a
fixed source snapshot are work for a metered write or background task.

Reviews pin the exact source revision and card hash they assessed. Advancing the
entry does not transfer approval to new code. Unlisting controls discovery;
blocking controls direct access, including old `@revision` paths. Suppressing an
entry does not by itself suppress its source hash in the independent blob store.
This experiment implements only an operator block on stored entries; it has no
card validator, signed-name resolver, visibility policy, or live review model.

## A narrower guest interface

Give a policy invocation a bounded request and explicitly requested stored
inputs. It returns a small publication plan:

```
append(topic, representation)
advance(entry, expected_revision, representation)
enqueue(queue, pinned_publication)     # attached to that publication
finish(task)                         # may accompany a publication
```

These are conceptual operations, not new Sprig builtins. The model accepts one
append or advance per plan, optional tasks tied to its assigned revision, and an
optional task acknowledgement. This deliberately tests a smaller contract than
arbitrary transactional tables. Multi-output atomic publication may prove useful
for updating listing pages and secondary indexes; add it when a concrete service
needs it rather than inventing a query language now.

The host owns counters and assigns sequence/time at commit. Appending atomically
creates `.n@0`, the current `.n`, the stored `.count`, tasks, and a retry receipt.
Advancing atomically checks the expected revision, preserves the old pinned path,
creates the next one and replaces the current representation. A stale writer
fails without overwriting another writer. Reusing a request ID for the same plan
returns its original receipt; different content under that ID fails.

Authorization is separate: permission to append under `/grove` does not grant
permission to advance anyone else's entry, finish review tasks, or schedule paid
work. Grants originate in the host; the guest cannot submit its own grant object.
The prototype's plain TypeScript `Grant` parameter is a trusted test fixture,
**not an implemented unforgeable capability or an HTTP authentication scheme**.

Policy execution happens after bounded admission, with CPU/memory/host-operation
limits. Paying a write quota does not authorize unbounded code, compilation,
network calls, or task creation. If validation reads mutable state, the host must
record and recheck those read versions at commit; this model checks only its
explicit current-revision and task-completion conditions. Verified blob preparation
stays outside the metadata transaction. No remote R2 or model call belongs inside.

A program can reject a format or propose a change. The host checks the plan's
authority, byte/operation limits and preconditions before making it visible.
Response bytes, private credentials and object-store keys must not become a path
escape or arbitrary response-header interface. Start with plain UTF-8 text;
controlled HTML/CSS rendering can be a separate write-time presentation program.

## Reads are materialized, not necessarily free

GET may still perform host routing, authorization, suppression checks, integrity
verification, conditional-request handling and bounded native storage work.
It never runs user policy, makes a paid model request, or starts lazy indexing.
A private mailbox still needs read authorization even when its data is stored.

Small representations can be inline in a path row with their metadata. A large
body can remain in immutable blob storage. A pointer-only path row followed by
R2 is two lookups: a common GET contract does not make that one operation.
Keep the existing native blob path fast; do not wrap every blob in a second
publication layer or an extra object-store write merely for API uniformity.

Listings and reference indexes need stored, bounded pages or a separately specified
bounded native range read. The demo intentionally returns 404 for a topic root:
it does not synthesize a listing. Frequently rebuilding one ever-growing listing
on every append would introduce quadratic work; fixed-size pages or chunks avoid
that trap. Any lagging derived page should expose its processed sequence.

Current entries and counts require revalidation or a short freshness policy.
Historical bytes are fixed, but eligibility to serve them can change. Keep
suppression checks before conditional success; do not accidentally create a
shared-cache bypass. Existing browser copies cannot be recalled.

HTTP sketch: `POST /grove/nz/fern` allocates a slot; a conditional
`PUT /grove/nz/fern.0` can replace the known current representation while creating
a pinned revision. `If-Match` can carry the revision validator. A signed command
that is interpreted rather than used as the replacement representation fits POST
instead. Direct known-address blob PUT is possible separately; the existing POST
API stays intact. See [RFC 9110, PUT](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.4)
and [If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1).

## Background work and acceptance facts

Publication and task creation commit together. A worker later reads the pinned
source, computes outside the transaction, then atomically publishes a result and
finishes the task. Failed publication leaves the task pending. Lost acknowledgements
can be retried without another result. External execution remains potentially
repeated; the host cannot promise exactly-once charging by an unrelated provider.

Pending work is bounded. On overload a service may reject admission, or accept
an unreviewed card without queueing a review and discover it later from a bounded
scan. Never hide a queue-full error by accepting and pretending work was scheduled.
Task delivery priority, leases, retries, expiry and paid-effect budgets are later
policy/adapter work; the model only lists pending tasks and records completion.
Completed tasks and retry receipts also need bounds and an explicit retention
contract. The model keeps them within a fixed overall commit cap.

"First accepted commit referring to this blob" still needs a registrar-scoped
create-only claim keyed by the target, committed with acceptance. A materialized
reverse index that catches up later cannot establish that firstness. The model
does not yet include a claim operation. Neither a signature nor an unordered pool
proves absence of an earlier acceptance or references elsewhere. Preserve the
acceptance fact and its service identity through recovery before promising it.

## Hosting and recovery boundary

Keep the program contract independent of deployment:

| Host | Publication boundary | Payloads / tasks |
| --- | --- | --- |
| Cloudflare | One SQLite Durable Object transaction per initial service authority. | R2 for larger immutable bytes; durable task rows and alarms for wakeups. |
| Separate server | One SQLite transaction per initial service authority. | Blob directory/object store; durable task rows and a worker loop. |

Use Sprig VM execution limits and scoped host operations in either. A Wasm
instance or a restricted native worker can add an outer boundary. The exact VM
ABI, cancellation, startup cost and local backend remain unimplemented. No
cloud-versus-server price or performance conclusion follows from this model.

The backup boundary covers paths, counters, original acceptance stamps, retry
receipts, pending/completed tasks, suppression, operational budgets, and installed
code/policy versions. Blob bytes alone cannot reconstruct them. Keep the existing
short commit barrier idea; do not hold it while copying payloads or running policy.
Splitting authorities later requires an explicit coordination/recovery contract;
there is no cross-service atomicity merely because both services use this API.

The in-memory model has no awaits in a commit and stages all rejection checks
before changing maps. This is a way to test the ordering, **not crash durability**:
a production backend needs a real transaction and durable acknowledgement. It has
no R2 adapter, VM runner, network listener, signed grants, leases, service upgrades,
snapshot restore or first-claim register. Its small lifetime caps are experiment
bounds, not proposed public quotas. Nothing in the running services is replaced.

Next experiment: put this contract behind a real transactional backend, inject
failure around commit/ack, and then connect one bounded Sprig validator. Keep
publications and review work in separate grants. Decide multi-output publication,
required historical retention, and where synchronous derived views are necessary
from that exercise, before porting existing services.

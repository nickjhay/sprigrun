# Workbench changes to pursue

28 October 2026. Hosting notes from Nick's commons and naming discussion. This is
a plan, with the offline naming experiment identified below as implemented. It
does not promise new hosted endpoints, a Sprig WASM release, or permanent storage.

October 29 update: [SERVICES.md](SERVICES.md) records the service-wide review and
latest decisions. The naming endpoint accepts bytes and composes idempotent blob
storage with name acceptance in one publishing request. Keep one selected head
plus per-record acceptance facts, a service policy constant for recovery, and
no automatic expiry for ordinary blobs. Channels keep their separate retention.

After the first local loss/recovery drill, the [simplicity review](SERVICES.md#review-after-the-first-recovery-drill)
identifies the next decisions: logical archive facts versus deployment settings,
recoverable suppression history before public cutover, a measured backup pause
budget, eviction/re-upload semantics, and optional ticket-free channels when work
is off. The logical v2 archive and online barrier are now implemented; the channel wire
protocol remains unchanged.

The implemented recovery design is [a commit-only epoch barrier](store/CHECKPOINTS.md):
private payload preparation stays outside short metadata commits; publication and
blocking receive the current epoch at commit. One-way reservation/publication/block
facts replace the earlier preimage/abort-on-block model. Live blocks hide source
while the older cut pins its private bytes. This requires an authoritative metadata
lookup on public reads. `npm run demo:checkpoint` exercises the revised model;
the Worker and real local recovery drill now exercise the same boundary. Nothing is deployed:
replace the existing schema/archive rather than adding compatibility machinery.

## Keep the foundations small

| Primitive | Contract |
| --- | --- |
| Blob | Exact immutable UTF-8 bytes at `sha256_length`, available subject to retention. |
| Head | A service's current selected reference for a stable name, with explicit update rules. |
| Stream | An ordered, bounded, expiring sequence with cursors and explicit gaps. |

Retain the current source-only store, global growth/burst limits, bounded proof
challenges, browser-private caching, and verification of returned bytes. A naming
signature or a commons record is another text blob; the raw store need not parse
it or execute code. A reference does not itself grant a Sprig domain access.

## Names: the next primitive

The agreed direction is an immutable genesis, signed single-parent updates, and
a service-selected head. All immutable records use the existing hash/length
identity. A genesis establishes a name's initial keys; an update identifies that
genesis, its parent, and a target blob. A name can belong to one work, rather
than representing a person or an account.

Nick added ordered recovery keys: a stronger-key continuation of U supersedes
weaker-key continuations of U, including their descendants. An update can change
the keys for its continuation. [NAMING.md](NAMING.md) records the precise draft
rules, consequences for revision names, and the recovery questions still open.

Implemented here: a bounded **offline** TypeScript graph using real Ed25519
signatures, exact-byte verification, stronger-key precedence, branch-local key
rotation, explicit equal-priority conflicts, and an anchored result that tells
the caller when recovery replaced its previous branch. Run `npm run demo:names`
for the fern example. A second experiment, `npm run demo:replay`, applies service
order and a fixed recovery window to the same verified evidence. First eligible
arrival wins ties; recovery does not rewrite historical selections. Records now
use Git-like `field value` lines with repeated `key` lines, not JSON. Both demos
need Node 24 but no workerd, server, account or network. Keys are transient;
nothing is published or saved.

The general direction is hashes plus an admission log and bounded typed indexes:
explicit references to a genesis form a candidate pool; validity and ordering
rules select the naming subset and its head. The replay models only that subset,
not the general index. Service sequence/time are separate from publisher blobs;
identical blobs may have different service histories. Preserve the service log
as operational state, rather than assuming an unordered pool can reconstruct it.

Next steps before exposing names as a service:

1. Choose the deployed recovery duration and admission policy. The replay now
   exercises first-arrival ties and time-limited historical override, including
   retired keys and deadline boundaries. It has no production timing guarantee.
2. Specify service acceptance metadata, revision lookup, retention and restart
   behavior. Stronger-key recovery can change selected ancestry; old revision
   labels must not silently acquire new meanings.
3. Add bounded admission, persistence, parent retrieval and HTTP read/update APIs.
   Preserve the distinction between storing a candidate and accepting a head.
   Specify parent-before-child naming admission versus arbitrary blob order, and
   reserve a way to recover when ordinary candidate capacity is exhausted.
4. Add optional watch notifications. Re-read/verify the head after reconnect; a
   watch is not an archive and is not the authority for the selected value.
5. Offer explicit **pin** and **follow** choices in the workbench. Retain a pinned
   update as an anchor, and surface recovery or conflict instead of hiding it.

A compact URL syntax, general delegation language, DHT and federation can wait.

## Composite references and project manifests

Represent a reference as a selector plus expectations, not a list of fallback
names. Content hash, signed-update hash, genesis, service revision, path and
petname have different meanings. Every supplied expectation must agree. A
following reference may remember an anchor while accepting future descendants;
a pin fixes a particular object. A petname belongs to a specific service or local
address book and is not a new cryptographic identity.

Initially a name points to one immutable project manifest. Paths are entries in
that snapshot, so source and dependencies can be published together. Keep the
planned `init.sprig` root and friendly imported-module names in mind when the
multi-file editor arrives. Independent subprojects can get independent heads.
Public manifests may name public channel or submission endpoints; they must not
accidentally publish private reading or administrative credentials.

## Commons above the store

Useful next records are a piece description pointing to exact source, a fork
relationship, a collection, a request and an answer, and optional project journal
entries. Start with the fern: describe it, preserve its parent on “Edit a copy,”
and let another piece answer a small request. This can grow into a place where
unfinished work and returning collaborators have continuity.

Canonicalize structured metadata in the client; preserve source bytes exactly.
The server validates published records rather than silently rewriting them.
Index explicit relationship fields; a hash mentioned in prose does not become a
dependency, a retention obligation, or authority. `news` needs a service ingestion
cursor rather than trusting a publisher's clock. Keep journals and context tags
opt-in. Interface/type-directed search can begin with descriptive metadata before
it becomes a mechanically checked language.

Publishing to a remix commons and saving arbitrary source are distinct actions.
The commons license remains a decision to make explicitly; no new dedication has
been applied to existing project files or stored source by this work.

## Streams, mailboxes and named places

Keep today's public-read/secret-append channel protocol intact. A future mailbox
shares stream machinery but restricts reading and rejects new submissions when
full; strangers must not evict accepted mail. Reading is nondestructive. Any
acknowledge/delete capability, lease, age expiry and confidentiality promise must
be explicit. Independent read/append/manage capabilities belong to a separately
specified extension. The existing hash-derived bearer secret is not an Ed25519
key or end-to-end encryption scheme.

A stable project name can point to its current ephemeral channel or inbox. A
stream cursor includes its incarnation; a name watch can announce new head
hashes. Neither transport silently grants capabilities or executes received text.

## Runtime and UI collaboration

Continue toward the real Sprig VM adapter and U's shared egui/wgpu presentation
path, keeping the browser editor as the initial trusted shell. Track the design
in [issue #1](https://github.com/nickjhay/sprigrun/issues/1). Separate workspace,
runtime session and UI attachment lifetimes. The first joint exercise remains
a slow child with a slider, retained editor, chat draft and Restart, including
late replies, focus changes and stale gesture cancellation.

Maintain an explicitly authorized semantic inspection/action path for humans,
models and tests. The current finite Moss job limits are not a policy for a
long-running Sprig world; that needs the real scheduler's runnable/quiescent
information and separately granted UI, terminal, loading and messaging access.

## Run claims, distribution and operational limits

Treat a published run as a claim. Reproduction, trusted runners and checking a
particular specification are separate evidence. Arbitrary uploaded results must
not populate an authoritative execution cache. Pure runs or recorded external
inputs can support replay; live capabilities and wall-clock deadlines do not
make an execution reproducible by themselves. Hosts choose trusted runtime
implementations; a runtime's hash only identifies its bytes.

Keep binary assets, cat/chunk manifests, automated execution services and atproto
export as later work. Derived content indexes can be rebuilt; quotas, accepted
head history, suppression decisions and operational admission state still need
recovery rules. All new public APIs need bounds on operations, retained state,
traversal and output, not only payload bytes.

After a substantial implementation stretch, return to [GARDEN.md](GARDEN.md): run
something small, open and close the editor, and notice where a little care is
needed. The name-garden demo is a small exercise in that spirit, not a substitute
for the browser checks that remain pending.

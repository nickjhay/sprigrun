# Native protocol v1 candidate

This is the implemented protocol slice, not a deployed service contract.
The native SQLite/R2 acceptance layer and [HTTP adapter](HTTP.md) are implemented locally. Freeze public v1 semantics
before accepting durable public records. Older offline naming/path experiments
use different formats and are not parsed as this protocol.

## References

Canonical words match `[a-z_][a-z0-9_]*`, at most 32 ASCII characters.
Topics contain 1–8 words separated by slashes. All numbers are canonical decimal
u64: zero is `0`, no leading zeros/signs, maximum `18446744073709551615`.
Use BigInt internally; fixed-width 20-digit decimal TEXT is available for a
lossless sortable SQLite key. No unbounded u64 goes through JavaScript Number.

A sea address is 64 lowercase SHA-256 hex characters, underscore, byte length.
Source values are bounded to 256 KiB. Complete reference paths are at most 512
characters; query/fragment syntax is outside the canonical reference grammar.

```text
value       = /sea/<digest>_<length>
grove       = /grove/<topic>.<number>
plot        = /plot/<word>.<number>
publication = grove | plot/<topic>.<number>
step        = publication/step/<number>
subject     = value | plot | publication | step
chat        = /chat<subject>
message     = chat/<number>
reference   = subject | chat | message
```

The angle brackets and grammar symbols above are explanatory. A plot root is
a namespace. Runs live in publications; therefore `/plot/nick.0/step.12` is a
publication named step, while `/plot/nick.0/step/12` is invalid.
A run step's chat and a chat entry remain distinct:
`/chat/grove/chess.7/step/12` versus `/chat/grove/chess.7/12`.

Compact form drops the initial slash and replaces slashes with dots. Both forms
share one token parser. The grammatical state determines the reconstructed
punctuation. The path parser requires exact agreement with that reconstruction.
No percent decoding, case folding, whitespace trimming, repeated/trailing
slashes, dot segments, backslashes, digit-leading words or nested chats.

Pure parsing does not establish existence, authority, visibility, or an available
run service. `step` references reserve syntax; phase 0 cannot execute runs.

## POST destinations and anchors

Destinations contain the configured canonical absolute origin and one of:

| Destination | Collection/operation |
| --- | --- |
| `/sea` | Store exact source bytes |
| `/grove/<topic>` | Append a publication |
| `/plot/<word>` | Allocate a plot |
| `/plot/<word>.<number>/<topic>` | Append a plot publication |
| `/chat<subject>` | Append a chat message |

For every append operation, an existing entry in that collection can instead
be the POST destination. It supplies an anchor; the new number must be greater.
`POST /grove/fern.7` appends to `/grove/fern`, anchored at 7.
`POST /plot/moss.3` allocates another plot under `/plot/moss`, anchored at 3.
`POST /plot/moss.3/notes.7` appends to that plot's notes topic.
`POST /chat/grove/fern.7/12` appends to that chat, anchored at 12.

The anchor must already be committed, including a retained tombstone if its
body is unavailable. The host checks this in the acceptance transaction.
No requirement that it remain the current head; other writers can advance.
No waiting for future anchors, overwriting the anchor, or assigning anchor+1.
A source hash or run step is not an append destination.

A sender keeps its exact pending action until acknowledged. The receipt's
result supplies its next anchor. Two byte-identical pending actions denote one
act. Intentional identical repetition waits for a receipt. There is no occurrence
field, random request ID, client timestamp, or expiry in v1.

## Action bytes

Signed example, with no implied final newline after the body:

```text
#!sprig.run/spec/action/1
author: /plot/nick.0

POST https://sprig.run/chat/grove/chess.7/12

Hello from the fern.
```

The metadata block contains exactly the marker and, for authored actions, exactly
one `author: ` line. An anonymous action omits that line. LF LF terminates the
metadata. The next line is exactly `POST ` followed by the absolute destination,
then LF LF, then the payload to EOF. Headers are ASCII. Unknown/duplicate fields,
old request-first framing, CRLF headers and unsupported versions reject.
The marker must be first; an envelope BOM is invalid. Metadata is bounded to
1024 bytes including its delimiter; request-line scanning is bounded to 1024
bytes. Total action size is bounded to source size plus 2048 bytes.

The body is exact valid UTF-8, up to 256 KiB: no normalization, trimming, newline
insertion, or BOM stripping. NUL, CRLF, leading blank lines and nested format
markers in the body remain data. Byte length counts UTF-8 bytes, not characters.
The host may set a smaller operation-specific body cap before public launch.

The action ID is SHA-256 plus byte length of the entire unsigned action document,
including its marker. Sign that document using pure Ed25519, not an implicit
prehash variant. The detached signature is canonical unpadded base64url of 64
bytes. It is not part of the action ID. Neither is an admission ticket.

The destination must match the receiving host's configured external origin and
canonical request path. Production uses `https://sprig.run`. Canonical loopback
HTTP origins are allowed for local development; other HTTP origins reject.
No username, URL normalization aliases, query, fragment or redirect is allowed.
The HTTP adapter must preserve this boundary despite its platform URL handling.
Offline verification can use the signed production origin without executing it.

Implemented wire adapter: raw anonymous POSTs remain raw.
An explicit `Sprig-Signature` header selects the signed-envelope body mode;
a missing/bad author or proof then rejects. Without that mode, a payload starting
with an action marker is ordinary data. The adapter constructs the anonymous
action bytes itself. No `Sprig-Occurrence` header is supported.

## Keys and immutable plot bindings

The host's operation-specific payloads are deliberately small:

| Operation | Exact body |
| --- | --- |
| Sea upload | Valid UTF-8 source, currently up to 256 KiB |
| Grove or plot publication | One existing `/sea/<hash_length>` reference followed by LF |
| Plot allocation | Empty; the verified action author supplies its controller key |
| Chat append | Valid UTF-8 message, currently up to 8192 bytes |

A publication does not copy its source. Distinct publication slots remain
distinct instances even when they reference the same value. A direct key or a
plot bound to that key can authorize a plot's publications. Anyone may append
to the public chat of an available subject. Run-step subjects are not hosted yet.

```text
#!sprig.run/spec/key/1
algorithm: ed25519
public-key: <unpadded base64url of 32 raw public-key bytes>
```

This fixed record ends in one LF. Its exact content address identifies the key.
Only this algorithm is supported. Alternate base64 alphabets/padding, nonzero
unused encoding bits and malformed lengths reject.

An author is either a sea key reference or a fixed plot root. A plot's host
allocation fact is:

```text
#!sprig.run/spec/plot/1
origin: https://sprig.run
plot: /plot/nick.0
key: /sea/<key-record-address>
```

It ends in LF. Plot binding bytes, their content address and their original
allocation evidence must survive recovery. The public-key author proof never
contains private material. Plot creation must require a valid signature from
the key being granted control; merely parsing a binding grants nothing.

`verifyAction` takes pinned evidence supplied by its caller, hashes the key
record, checks the author reference and optional plot binding, then verifies
the exact action bytes. It performs no network fetch. All caller-owned buffers
are copied before any await. A direct author permits no plot binding; a plot
author requires a matching one.

**Trust boundary:** a supplied plot-binding record is a host naming claim, not
a cryptographic proof of allocation. The HTTP service must obtain it from its
own accepted history, never from a client-controlled replacement. An offline
verifier needs a trusted copy or a separately authenticated host attestation.
This signature helper alone does not authorize a write to a plot topic.

Key versions are pinned by record hashes; action versions by signed markers.
Do not resolve old actions against a mutable current profile. Social recovery
creates a new plot; key rotation/genesis authority is not implemented.

## Acceptance receipts

A receipt is an immutable, currently unsigned host claim:

```text
#!sprig.run/spec/receipt/1
action: <action-hash_length>
result: https://sprig.run/chat/grove/chess.7/27
accepted-at-ms: <canonical decimal epoch milliseconds>
key: /sea/<resolved-key-record-address>
binding: <plot-binding-hash_length>
```

Fields occur exactly in that order, followed by LF. Anonymous actions use
`key: -` and `binding: -`; direct-key actions use `binding: -`.
The timestamp is host-assigned at acceptance and preserved on retry/restore.
The result contains the allocated number, so no separate sequence field is
needed. Hashing a receipt does not turn it into a host signature.

`receiptForAction` checks action identity, authority-field shape, result
collection and the anchor lower bound. For source storage it checks the actual
payload's content address. It does not verify durable admission or the
correctness of a claimed plot binding. `nextAppendAction` uses this checked
correspondence to construct the next action without changing the old one.

Successful parsing/signature verification is not acceptance. The native host
atomically commits action-ID uniqueness, allocation, the action's metadata debit
and the receipt, then waits for durable storage before acknowledging. Source
bytes are prepaid in a separate private preparation reservation, to bound costs
even when a PUT fails or publication never completes. Replay returns the original
receipt, subject to visibility policy, without another growth debit.

Read a receipt as: “I accepted this exact action and assigned it this result at
this time.” `action` identifies the request, while `result` identifies what the
request created. `key` and `binding` pin the authority used. The receipt does not
contain the message, promise eternal availability, or prove that its host told
the truth. It lets a client reconcile a lost reply and choose its next anchor.

## Bounds and errors

Fixed record types are limited to 2048 bytes, exact fields/order, terminal LF,
no duplicates or extensions. Parsers throw small errors such as
`invalid_metadata`, `unsupported_action_version`, `wrong_origin`,
`noncanonical_reference`, `invalid_signature`, `wrong_plot_binding`,
`wrong_receipt_action`, `wrong_receipt_result`, and `u64_overflow`.
The HTTP adapter maps these to plain-text status responses with a `/help`
pointer, without reflecting credentials or raw unsanitized headers.

Frozen Ed25519 examples in `test/vectors/ed25519.json` were generated with Python
cryptography independently of this implementation. Tests cross-check them with
Web Crypto and Node crypto. Their private seed is public test data; it is never
a candidate production or seed-identity key.

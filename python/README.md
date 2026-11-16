# sprigrun — the smallest sprig

**Sprig 0.1** starts with one expression. Arithmetic, strings, comparisons, a
choice between two things. Enough to plant something and watch it run.

`sprigrun` is a Python-distributed command-line tool that evaluates this bounded
language and loads exact UTF-8 source bytes from a Sprig store. Package version
`0.1.0a1` is an alpha candidate; PyPI publication is a separate step. This package
does not yet embed the larger native Sprig VM. It has no runtime dependencies.

## Try it from this repository

Python 3.10 or newer is enough. No Node, Cloudflare runtime, or macOS upgrade is
needed for this package; your installed Python must itself support your OS.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install ./python
.venv/bin/sprigrun eval '1 + 2'
.venv/bin/sprigrun run python/examples/fern.sprig
```

These print `3` and `'room for another fern'`. Once the first release is published,
`python3 -m pip install sprigrun` will install it from PyPI instead.
`python3 -m sprigrun` is also available in the environment where it is installed.

## Sources, names and servers

```sh
sprigrun hash fern.sprig
sprigrun verify HASH_LENGTH fern.sprig
sprigrun fetch HASH_LENGTH --origin https://sprig.run -o downloaded.sprig
sprigrun run downloaded.sprig
sprigrun run-ref HASH_LENGTH --origin https://sprig.run
sprigrun run-ref /grove/fern.0 --origin https://sprig.run
sprigrun run-ref https://another.example/plot/alice.0/fern.7
```

`HASH_LENGTH` means 64 lowercase SHA-256 hex characters, `_`, then the exact
decimal UTF-8 byte length. It is a placeholder in these commands, not a live
example address. `--origin` defaults to `https://sprig.run`; availability depends
on deployment and on the requested source having been published there.
For a local native core, use `--origin http://127.0.0.1:8789`.

`run` always means a local file; `run-ref` always means remote source. A full URL
selects its own origin. A fixed publication name returns exactly `/sea/HASH_LENGTH`
followed by a newline. The client then fetches those bytes from the same server,
checks their hash and length, and reports the resolved address to stderr. It does
not follow further names, redirects, or `?select=latest` yet. Pin the reported
address if you want the same content next time. Names are trusted to the selected
server; a matching hash establishes content integrity, not publisher identity.

`fetch` verifies before opening its output file, never overwrites an existing
file, and never runs the result. A disk error can leave an incomplete new file;
remove it before retrying. `hash` and `verify` preserve line endings and any UTF-8
BOM. Text is not normalized. Hashing/fetching accepts up to 256 KiB, matching the
native core's source limit. Executable expressions have a smaller limit.

Remote access uses HTTPS, with HTTP allowed only for `localhost`, `127.0.0.1` and
`[::1]` development origins. Credentials in URLs, compressed responses, redirects,
and non-200 responses are rejected. Requests have a 10-second socket timeout and
bounded response bytes; this is not a total wall-clock deadline against a server
that trickles bytes. Network access belongs to the loader, never the expression.

## The language

A source file can begin with this version marker (optional when invoking this
explicit Sprig 0.1 evaluator):

```text
#!sprig.run/spec/sprig/0.1
"room for " + "another fern" if 1 + 2 == 3 else "winter"
```

The marker names this draft language; it does not download an interpreter.
A different leading `#!` marker is rejected. Otherwise comments and whitespace
follow Python expression syntax.

| Feature | Examples |
| --- | --- |
| Values | `123`, `'fern'`, `True`, `False`, `None` |
| Integer arithmetic | `+`, `-`, `*`, `//`, `%`, unary `+` and `-` |
| String operations | `'fern' + 's'`, `'frond ' * 3` |
| Comparisons | `==`, `!=`, `<`, `<=`, `>`, `>=`, chained comparisons |
| Conditions | `a if condition else b`, `and`, `or`, `not` |

`and`/`or` return operand values and short-circuit, as in Python. Negative integer
division rounds down; remainder follows Python's sign rule. Equality follows
Python for these scalar values (including `True == 1`); ordering requires two
integers or two strings. Booleans are not arithmetic operands. Empty strings,
zero, `False` and `None` are falsey. CLI results use `repr`, so strings are quoted
and terminal control characters are escaped.

Limits are part of this initial language:

- At most 8192 UTF-8 source bytes, 256 AST nodes including operator nodes, and
  depth 32 (the root expression has depth 0).
- Integers from `-(2**63 - 1)` through `2**63 - 1`; intermediate results also fit.
- Strings up to 4096 UTF-8 bytes, checked before concatenation or repetition.
- No variables, calls, attributes, imports, containers, indexing, loops,
  comprehensions, floats, exponentiation, assignment, or I/O.

The implementation uses Python's parser, then validates the **whole** syntax tree
and interprets an explicit allowlist. Unused branches must also be valid Sprig.
Source never goes through `eval`, `exec`, or bytecode compilation. Evaluation has
bounded tree traversal and bounded scalar operations. This is a small interpreter
inside the Python process, not an OS sandbox or a claim of complete isolation
from bugs in Python itself. It deliberately does not run arbitrary Python.

## Development and release

From `python/`:

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
python3 -m pip install build twine
python3 -m build
python3 -m twine check --strict dist/*
```

The HTTP tests run a loopback fixture, including corruption, bounds, rejected
redirects, named resolution and CLI execution. CI also installs the wheel outside
the checkout and exercises the console script. See [RELEASING.md](RELEASING.md)
for the manual PyPI Trusted Publisher setup and release workflow.

Maintainers with Node 24 and the root npm dependencies can additionally run
`node python/test-core.mjs` from the repository root. It publishes the fern to a
disposable local native HTTP core on port 18789, then loads and runs it through
the Python client by hash and name. CI runs this compatibility check too.

Next: integrate a versioned native/WASM Sprig runtime behind this CLI. Keep exact
source addressing and the distinction between loading bytes and running them.

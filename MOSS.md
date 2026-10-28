# Moss/1 — a postcard-sized language

Moss is a tiny concatenative language with a stack, named words, and grafts from a content-addressed source store. It is a testbed for the workbench and I/O interface, with deliberately limited expressiveness. It does not establish Sprig semantics.

A program begins with `#!moss/1` on its first line. UTF-8 BOM and CRLF are accepted; published bytes are still hashed exactly. Comments run from `#` to the end of the line. String literals use double quotes and JSON escapes such as `\n`, `\"`, `\\`, and `\u1234`. Decimal numbers may have a minus sign, fraction and exponent.

Read left to right. A literal pushes a value. A word consumes values from the top of the stack and leaves its results there. In the table, `a b` means b is on top.

| Word | Stack before → after | Meaning |
| --- | --- | --- |
| `+` | `a b → result` | Add two numbers or concatenate two strings; no implicit conversion |
| `- * / %` | `a b → result` | Arithmetic on two numbers, in that order; division by zero is an error |
| `= < >` | `a b → 0-or-1` | Equality, or numeric comparisons; equality distinguishes types |
| `dup` | `a → a a` | Copy the top value |
| `drop` | `a →` | Discard the top value |
| `swap` | `a b → b a` | Exchange two values |
| `over` | `a b → a b a` | Copy the second value |
| `str` | `value → text` | Format a number or retain a string |
| `number` | `text → number` | Parse a finite decimal number; whitespace around it is ignored |
| `len` | `text → number` | Count Unicode code points |
| `upper lower trim reverse` | `text → text` | Transform text; reverse uses code points, not grapheme clusters |
| `print` | `value →` | Display it followed by a newline |
| `input` | `prompt → reply` | Ask in the terminal; the reply is always a string |
| `graft` | `address →` | Load, verify and execute a source module, once per run |

Numbers use JavaScript's finite IEEE-754 binary64 values. There are no booleans, arrays, variables, loops, conditionals, objects, property access, filesystem operations or arbitrary networking. Recursive word calls are possible but bounded; without a branching construct, useful terminating recursion is generally unavailable.

## Words

```text
#!moss/1
: square dup * ;
: greet "Hello, " swap + "!" + print ;

"Who is here? " input greet
9 square print
```

A definition takes effect when execution reaches it. Its body runs when its word is called, resolving word names against the current run's dictionary. Definitions cannot nest or redefine existing words or built-ins. A fresh Run starts with a fresh stack and dictionary.

## Grafts

Make a source file defining useful words, publish it, and copy its address:

```text
#!moss/1
"<64 lowercase SHA-256 hex digits>_<decimal byte length>" graft
7 square print
```

The angle-bracket expression is a placeholder, not a real address. The launcher prints real addresses and seeds the **A grafted postcard** example.

Grafting executes the module at that point, sharing the caller's stack and dictionary. It can print, ask for input, define words, manipulate values, and graft another file. It gets the same I/O authority as its caller. A successfully grafted address runs only once in the session; repeating it is a no-op after consuming the address. Recursive grafts and conflicting definitions fail. This small shared namespace is deliberate; packages, export lists and namespaces can wait for the actual Sprig importer.

The host captures the chosen store at Run time and permits only a canonical address, not a URL. It checks both length and SHA-256 before the interpreter receives the file. Hash identity establishes which bytes execute; it does not establish that their behavior is desirable.

## Bounds

| Resource | Limit per run |
| --- | --- |
| One source file | 256 KiB |
| Total source, root included | 1 MiB |
| Distinct grafts | 32 |
| Tokens across source files | 32,768 |
| Executed instructions | 100,000 |
| Frames / defined words | 64 / 256 |
| Stack entries | 256 |
| One string / text across stack | 16,384 / 65,536 UTF-16 code units |
| Input requests | 16 |
| Printed output | 65,536 code units, 1,024 messages |

Additional host bounds cover the whole terminal transcript, I/O requests, elapsed time and cancellation. These are operational limits for this toy, not a byte-accurate cap on the JavaScript heap.

# Runtime and I/O boundary

The workbench ships the Moss/1 adapter. A future Sprig compiler/VM can implement the same explicit host operations without adopting Moss's stack or namespace rules.

```ts
export async function run({ source, emit, input, load }: {
  source: Uint8Array;
  emit: (text: string) => void;
  input: (prompt: string) => Promise<string>;
  load: (address: string) => Promise<Uint8Array>;
}): Promise<{ summary?: string }> {
  // Compile/interpret source here; use only explicit host operations for guest I/O.
}
```

A Run gets a copied source revision in a fresh module Worker. The selected adapter is trusted site-owner JavaScript, supplied at build time. The default `runtimeModule: "moss/1"` builds Moss into a content-hashed `/runtime/moss-<hash>.js` file. A custom adapter must be a same-origin `/runtime/*.js` module from `public/`; a guest program cannot select JavaScript module URLs. Never compile arbitrary guest strings with eval, Function, or dynamic JavaScript import.

`emit` sends bounded text. `input` sends a numbered request to the host and awaits a terminal reply. `load` sends a numbered content-address request to the host and awaits verified bytes. Only one I/O request is outstanding at a time. The host captures a store origin and uses a fresh bounded content cache for each run; guest code cannot choose another origin, request credentials, upload a blob, or invoke an admin endpoint through this interface.

`RunSession` owns the Worker, request sequence, abort signal and timers. Stop, error and completion end that session and abort its outstanding I/O. Late results are ignored, even after a new Run starts. Root program, grafts and terminal prompts share the same limits; importing code cannot refresh a budget.

The active elapsed-time allowance is two seconds total, including adapter startup and compilation. It pauses while the host is handling an accepted I/O request. Each input may wait up to two minutes, a source load up to 15 seconds, and the complete session up to five minutes. These are host elapsed-time watchdogs, not precise CPU accounting; browser throttling and scheduling affect wall-clock delivery. Moss also has a deterministic instruction budget. Revisit startup timing and use the real Sprig scheduler/accounting when integrating a large Wasm runtime.

The host bounds terminal text and message counts twice: in the worker bridge and in the main UI. Prompts and typed replies also count toward the displayed transcript cap. Stop can terminate a Worker without guest cleanup. There is no retained domain or dictionary between runs.

A browser Worker is not a security boundary for arbitrary JavaScript. The trusted adapter itself still has browser worker APIs. Moss's interpreter only exposes its enumerated words, so its guests have no direct JS/DOM/network access. The future Sprig adapter must enforce Sprig's memory, ownership and capability invariants. This host does not assert a browser-enforced 32 MiB heap limit; the previous placeholder grant has been removed.

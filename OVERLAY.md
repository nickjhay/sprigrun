# Corner editor and direct program view

Workbench 0.4 implements a first browser shell around the existing Moss runtime. It preserves the full home workbench and its palette; shared programs now place their source tools in a small overlay at the top-right edge.

## Routes and identity

- `/`: the full workbench, with its explanations and examples.
- `/workspace`: the current local draft, with the corner editor expanded.
- `/r/<hash_length>`: verified source, terminal, and initially collapsed editor.
- `/run/<hash_length>`: the same verified source and terminal without the editor. Run and Stop remain available. Open editor returns to `/r/` in a fresh page.
- `/w/<hash_length>`: compatibility spelling, normalized to `/r/` after verification.

Opening a source URL never executes it automatically. Invalid or unavailable links cannot run a saved local draft. These views all use the existing loader, runtime contract and exact-byte verification; there is no second interpreter.

The expanded overlay shows the current published digest as 50 lowercase base36 characters, arranged in five rows of ten. The digest is interpreted as an unsigned big-endian integer and zero-padded to 50 characters. The display preserves all 256 bits; byte length is shown separately. Copying the badge copies the canonical lowercase hexadecimal digest and decimal length. Neither the URL format nor the store API changes.

A changed draft has no published badge or direct link until those exact bytes are published. The publish card can still show an earlier snapshot, clearly labeled. A publication that finishes after more typing cannot label the newer bytes as published. Shared sources are read-only until Edit a copy, which confirms before replacing the single saved draft.

Links still identify content, not its storage origin. As before, a link is useful where those bytes are available from the recipient's configured store. The local launcher deliberately resets the store to its local service on reload; links to a custom store require explicitly configuring that store again in the full/editor view.

## Retention and restart

The original editor DOM node moves into the overlay once. Collapse only hides its parent; it does not rebuild the editor. Selection and scrolling remain associated with that node. Actual browser undo and IME behavior require browser verification.

Run captures source bytes and the selected store. While a worker is active, the same button becomes Restart. Restart invalidates the old run before starting a fresh worker with the current source; Stop cancels pending input and source loading. The run footer distinguishes a captured revision from later edits. Changing the loaded root stops the previous run; merely editing or collapsing does not.

The terminal can continue receiving output while the editor is open. A new input request does not programmatically steal focus from an editor field. The overlay is nonmodal: it covers only its own area, and ordinary browser focus routes keyboard input. Escape closes it from controls outside the source textarea. Within the textarea, Escape then Tab retains the existing way to leave indentation mode. The disclosure button has an explicit label and expanded state.

## Scope of this slice

`/workspace` currently reuses one existing local-storage draft. It does not yet save a collection of workspaces, running heaps, application checkpoints, editor cursor positions across reloads, or multiple documents. Published source, draft bytes, and a running snapshot remain distinct.

Moss still supplies terminal I/O and hash-loaded grafts. The overlay is trusted TypeScript. It is not yet a Sprig program or a compositor accepting independently owned guest UI trees. The child world with a slider and the cross-surface input/attachment trace remain joint runtime/UI work, not an implemented guarantee of this release.

The next agreed direction is an `init.sprig` root with imports by hash, friendly aliases/petnames, and a bounded dependency editor. Updateable names can later resolve to immutable hashes. They need an authenticated update policy, and `uuid.version` requires an immutable revision mapping to act as a pin. A separate project manifest is not required for the initial source-root model.

For persistence beyond drafts, the runtime collaborator recommends an application-produced data checkpoint with source/dependency hashes and a schema version. Resumption creates fresh UI/network attachments. Saving arbitrary continuations or preserving uncertain external operations is separate work. Browser persistence, application suspension, and uninterrupted remote/native execution are different facilities.

## Verification and local browser checklist

Automated controller tests use LinkeDOM, a DOM model without browser rendering. They bundle the actual frontend and exercise source edits, collapse, restart during pending input, late old-worker output, delayed publication, shared/direct verification, invalid links, and local HTTP rewrites. Focus, selection, and viewport size are emulated in these tests. Digest tests cover leading zeroes, maximum values, random round trips and overflow rejection.

Actual browser interaction and layout remain unverified in this environment: the cloud browser could not reach the local preview. To check locally after `npm ci` and `npm run dev`:

1. Open `/`, then Open overlay. Confirm the original home palette and the quieter corner panel.
2. Type several lines, select text, scroll, collapse and reopen. Verify text, selection, scroll and undo; test IME composition if available.
3. Run a program waiting for input. Type a newer source draft while it waits, then Restart. The new worker should run the newer snapshot; the editor remains intact. Complete a terminal reply and try Stop.
4. Open the seeded `/r/` link printed by the launcher. Confirm no program runs until Run. Expand the panel; the hash badge has 5 rows of 10 lowercase characters. Clicking copies the canonical hash_length.
5. Use Open directly. Confirm the editor is absent, the same source runs, and Open editor returns to the same immutable source. A new page is a fresh execution, not migration of the live worker.
6. Edit a copy, change it, and publish. Continue typing during publication; the older result must not replace the newer draft or give it the older badge.
7. Open an invalid or missing `/run/` link. Confirm Run is disabled and the previously saved draft still opens in `/workspace`.
8. Test 320px, 390px and desktop widths, browser zoom, keyboard Tab navigation, visible focus, scrolling inside the panel, copy/download, and browser Back. Verify the corner button stays reachable over both light and dark content.

The source store, channel service and vendored client/runtime support files are unchanged. No deployment is performed by this release.

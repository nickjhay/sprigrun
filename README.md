# Sprig workbench 0.4.1 — a little fern

A local and deployable source workbench: write code, run it with terminal I/O, publish its exact bytes, and load more code by `sha256_length`. The included **Moss/1** interpreter is a deliberately small test language written in TypeScript and shipped as JavaScript. It is not an implementation of Sprig.

This release gives the workbench a small resident: **A little fern**, an ordinary Moss program you can name, unfurl in three stages, and change. A second version grafts its frond vocabulary by hash. Both are in the example menu. The [garden note](GARDEN.md) keeps our design touchstone close to the code.

The **collapsible corner editor**, direct view without the editor, and 10-column by 5-row base36 digest badge from 0.4 remain. The existing moss-green palette, warm background, and full workbench stay. Collapse and Restart preserve the editor node and draft. This is a host UI prototype using Moss; it does not yet implement Sprig UI surfaces, a self-hosted IDE, or multiple parked instances. See [OVERLAY.md](OVERLAY.md) for the design, current boundaries, and browser checklist. The coloured hexadecimal badge and seasonal glyphs remain design studies.

The separate **public, expiring channel** service from 0.3 remains included: create a rolling text log, share a reading or participant link, and follow it live from another tab or native client. See [channels/README.md](channels/README.md) for the protocol and [channels/DESIGN.md](channels/DESIGN.md) for its decision record.

The next naming and commons steps are recorded in [NEXT.md](NEXT.md); [SERVICES.md](SERVICES.md) covers the store/channel review and the next naming service boundary. Two **offline naming experiments** use readable Git-like text records and real signatures. Run `npm run demo:names` for genesis hashes, recovery and key rotation; run `npm run demo:replay` for competing arrivals and recovery just inside/outside a deadline. Both need Node 24, require no Cloudflare runtime, upload nothing, and keep temporary keys only in memory. [NAMING.md](NAMING.md) explains the draft formats, ordered history and limits. No naming service or browser naming UI is deployed.

`npm run demo:paths` explores a smaller service interface: stored GET responses,
atomic `.slot@revision` publication, shared topics, and pinned background reviews.
See [PATHS.md](PATHS.md). This is an offline model with no Sprig VM or server.

## Run the editor on its own

With Node 24 and dependencies installed, this starts the browser workbench without
Cloudflare's local runtime, including on an older macOS where workerd cannot run:

```sh
npm run dev:ui
```

Open **http://localhost:5173/** or **http://localhost:5173/workspace** for the corner
editor. Choose **A little fern** from Examples and Run. Editing, terminal I/O,
downloads and browser draft saving work. Publishing and hash imports need a store;
channels need their service. This command imports no Miniflare, starts no backend,
seeds no blobs and touches no `.local/` databases. It begins with no store connected,
ignoring a previously saved store selection; you can deliberately connect one.
Your saved draft still opens normally. Use `-- --port 5174` for a different port.
Ctrl+C stops the preview; restart it after source changes.

The offline demos (`demo:names`, `demo:replay`, `demo:checkpoint`, `demo:paths`), `npm test` and
`npm run typecheck` also need no Cloudflare runtime. The full `npm run dev` and
`npm run check` below require a supported workerd platform (macOS 13.5+ for the
pinned runtime).

## Run the whole system locally

For service deployment, start with [the threat model and invariant map](THREATS.md)
and [the source-store rehearsal/runbook](store/OPERATIONS.md).
[“Losing and finding the fern”](store/RECOVERY.md) covers coordinated snapshots,
restore into fresh storage, and the local loss drill. The store can be
deployed independently; the workbench and naming experiment need not ship with it.

Use Node **24** (`.nvmrc` pins the version used by CI). With [nvm](https://github.com/nvm-sh/nvm), run:

```sh
git clone https://github.com/nickjhay/sprigrun.git
cd sprigrun
nvm install
nvm use
npm ci
npm run dev
```

Without nvm, install Node 24 and check that `node --version` reports `v24.x` before running `npm ci` and `npm run dev`. If you are using a downloaded source archive, open its project directory and follow the same Node setup and npm commands.

If startup reports `ERR_UNKNOWN_FILE_EXTENSION` for a `.ts` file, check `node --version` **in that terminal**. The local launcher imports TypeScript directly and needs a recent Node runtime; Node 21 cannot run it. `.nvmrc` does not switch Node automatically: run `nvm install` and `nvm use`, then `npm ci` again. Dependency installation now enforces the declared Node requirement, and `npm run dev` checks the version before loading the launcher.

Open **http://localhost:5173/**. Click **Run**, type a reply into the terminal, and press Enter. Everything is local; no Cloudflare account is required. The first dependency installation needs internet access.

Open **http://localhost:5173/workspace** for the corner editor around the current local draft. The top-right Sprig tab folds the tools away. During a run, **Restart** creates a fresh worker using the current source snapshot. The launcher prints shared and direct-view links to the seeded fern and postcard.

One command starts:

- The browser workbench at localhost:5173.
- The actual source-store Worker in Miniflare/workerd at 127.0.0.1:8787, with local R2 and SQLite Durable Object state.
- The actual channel Worker at 127.0.0.1:8788, with local SQLite and hibernation-capable WebSockets. Open **http://localhost:5173/channels** and create a channel.
- Four demonstration blobs, published through the same source upload API used in production (one POST with work off; challenges when enabled): the postcard and fern, each with its own library.

Choose **A grafted postcard** from the example menu and Run it. It fetches a small library by hash, checks the exact bytes, adds its words, and asks who is visiting. The launcher also prints a `/r/<hash_length>` link to that stored program. Shared links load read-only and wait for an explicit Run; “Edit a copy” creates a local draft.

For a small first visit, choose **A little fern**, click **Run**, give it a name, and press Enter at the next two prompts. It prints a bud, a young frond, then an open fern. Change `left`, `right`, or `spine` near the top of its source and Run again to grow another shape. This version works without a store. **A grafted fern** has the same conversation and picture, with its drawing words loaded by a verified source address. The launcher’s fern links open that version. Each stage waits for you; this is terminal text, not an animation or a persistent simulation. Existing drafts are still protected by the normal replacement confirmation.

Store contents persist in `.local/store/`; channels persist in `.local/channels/`. Browser source drafts persist separately in local storage. Channel posting keys stay in tab memory: save the participant link or posting key before reloading. Ctrl+C stops all three servers. There is no hot reload yet: restart `npm run dev` after source changes. To use different ports:

```sh
npm run dev -- --port 5174 --store-port 8797 --channel-port 8798
```

The development build lives in `.dev-dist/`, separate from the deployable `dist/`. It starts with the local store selected on every reload, preventing a saved production override from quietly becoming the default. You can deliberately select another store for that session.

Use **localhost**, not a plain-HTTP LAN hostname, for browser testing: content hashing requires Web Crypto in a secure context. Production uses HTTPS. The workbench explains this if hashing is unavailable.

## A taste of Moss

```text
#!moss/1
"Your name? " input
"Hello, " swap + "!" + print

: square dup * ;
7 square print
"stressed" reverse print
```

Values sit on a stack. `7 square` leaves 49; `print` consumes and displays it. `input` consumes a prompt and returns the user's text. `"<hash_length>" graft` executes another Moss source file once per run, sharing the stack and word definitions. See **MOSS.md** for the complete small language and its limits.

## Production addresses

| Address | Role |
| --- | --- |
| `sprig.run` | Static workbench and release assets |
| `sprig.run/r/<hash_length>` | A verified program with its editor folded into the corner |
| `sprig.run/run/<hash_length>` | The same program without an editor; explicit Run and Stop |
| `sprig.run/workspace` | The current local draft in the expanded corner editor |
| `store.sprig.run/b/<hash_length>` | Exact source bytes |
| `store.sprig.run/` | Existing text store statistics |
| `sprig.run/channels` | Channel terminal and public creation |
| `sprig.run/c/<address>` | Open a channel; participant links optionally carry a posting key in the fragment |
| `channels.sprig.run/channel/<address>` | Channel HTTP and WebSocket API |
| `channels.sprig.run/` | Aggregate text channel status |
| `polis.place` | Reserved for the larger project; no service is deployed here |

The old `/w/<hash_length>` route remains readable; new links use `/r/`. `workbench.config.json` already sets `https://store.sprig.run` as the production store origin. **Nothing has been deployed and no DNS records have been changed.**

For Netlify/GitHub, connect this repository with the repository root as its base directory. The included `netlify.toml` builds with `npm run build` and serves `dist/`; generated builds are not checked in. Configure sprig.run as its custom domain when ready. `public/_headers` and `_redirects` carry the security/cache rules and shared-link rewrite; other hosts need equivalent configuration.

The complete v0.5 source store is included under `store/`, with its own README, deployment setup, admin tools, tests, and pricing model. Follow that README to deploy it, and configure its custom domain as **store.sprig.run**. Its server source has not been changed by this workbench update. Keep the R2 bucket private.

The new `channels/` service has its own configuration, pinned dependencies, native CLI, tests and deployment commands. Its initial single SQLite Durable Object keeps quotas and append/trim operations atomic across the bounded channel set. Deploy it separately when ready and set `channelOrigin` in `workbench.config.json`. No service is deployed by the local launcher, tests or production frontend build.

Local development reads the store's actual `wrangler.jsonc` variables and executes its actual Worker entrypoint. Quotas, tickets, validation and blob behavior follow the same code. Local resource implementations, HTTP routing and latency differ; it does not reproduce Cloudflare's edge network, TLS, CDN behavior or the optional per-IP edge rate-limit binding. Global admission limits still apply locally. See Cloudflare's [local development documentation](https://developers.cloudflare.com/workers/local-development/).

To publish the four public demo sources to your deployed store, deliberately run:

```sh
npm run seed -- https://store.sprig.run
```

This sends the postcard, fern, and their two libraries to that store. It is not run automatically in production. The local launcher only seeds its own local instance. Without production seeding, you can still run the self-contained examples and publish any program yourself.

## Builds, caching and verification

GitHub Actions runs the same checks on pushes to `main` and on pull requests. It uses read-only repository permissions and does not deploy services or require Cloudflare secrets.

```sh
npm run check
```

This runs server/client TypeScript checks, workbench and offline naming/replay tests, the full store suite, the real-store/real-worker integration, channel tests, Python pricing tests, and the production build. The full check requires Python 3 as well as Node 24. The offline demos only need Node. The tests cover complete digest round trips, routes, retained editor nodes, restart with late output, publication while editing, and failed links protecting a saved private draft. The fern is executed both with local words and a graft; the store integration also loads and runs its published root and library through the actual worker bridge. Controller tests use LinkeDOM with emulated focus and selection; they do not establish browser rendering, IME, native undo, or layout behavior. The store and channel tests run their actual Workers locally. They never deploy or contact a production service.

Browser QA covered the example menu, arithmetic/string output, terminal replies and Stop. The managed preview is served over a non-local HTTP hostname, which lacks browser Web Crypto; browser publication and verified loading could not be exercised there. Those paths passed the actual local-store integration test, including the browser worker code through a Node worker bridge. Mobile layout and target-browser coverage remain future checks.

The new channel page builds and typechecks, and its shared client/service protocol passes integration tests. Interactive browser QA of this page remains unverified: the available cloud browser could not reach this turn's local server, and a separate browser installation was unavailable. See `channels/BROWSER-CHECK.md` for a short local check of both permission modes, reconnects and text rendering.

Interactive and visual browser QA of the new overlay also remains pending: the available browser could not reach the local preview. Its controller and route checks pass locally. Use the checklist in `OVERLAY.md` to check actual typing, selection, undo, clipboard, focus, and narrow-screen layout.

HTML revalidates; built scripts, CSS, workers and the Moss adapter use content-hashed names with immutable caching. The blob-store's private browser-cache policy stays separate. Keep old release assets when deploying if old open tabs should continue using them.

Read **DESIGN.md** for the updated architecture, **RUNTIME.md** for the runtime adapter/I/O contract, and **SECURITY.md** for precise boundaries and limits. This package keeps the future Sprig VM integration separate from the working toy language.

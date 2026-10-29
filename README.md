# Design Index

A local-first library for saving, tagging, searching, comparing, and reusing design references. The product and implementation decisions are documented in [Design Inspiration Library Implementation Plan.md](./Design%20Inspiration%20Library%20Implementation%20Plan.md).

## Repository structure

```text
apps/
  web/        Gallery and capture UI (phase 1)
  server/     Local API, job queue, and workers (phase 1)
  extension/  Browser capture client (phase 2)
  desktop/    Optional Electron tray launcher
  mcp/        Coding-agent MCP integration
packages/
  shared/     Shared types and validation schemas
  database/   SQLite schema, migrations, and repositories
  palette/    Deterministic color extraction and exports
  analysis/   Model adapters and analysis pipeline
  capture/    URL capture and extracted page facts
inbox/        Watched image drop folder (local files ignored by Git)
```

The implementation uses npm workspaces. Image/URL intake, Go analysis, prompt authoring, and model evaluation are implemented. The extension, desktop shell, and MCP integration remain reserved. See [implementation status](docs/implementation-status.md) for the current checklist, [capture and evaluation](docs/capture-evaluation.md) for the new workflows and limits, and [the Go integration notes](docs/opencode-go.md) for provider decisions.

## Agent instructions: initialize on a new machine

**For coding agents setting up this app:** follow this checklist in order. This README and the current implementation-status/Go integration documents take precedence over outdated setup assumptions in the original implementation plan. Do not treat initialization as permission to change providers, enable sharing/training, spend Go usage on test requests, reset a library, or upgrade dependencies.

### 1. Inspect the checkout and prerequisites

- If a checkout already exists, use it and inspect `git status --short` before editing. Preserve existing changes and local configuration. Otherwise clone the repository into a user-approved location:

  ```sh
  git clone https://github.com/Ikjoyce/Design-index.git
  cd Design-index
  ```

- Read this README, `package.json`, `.env.example`, and [implementation status](docs/implementation-status.md). Work from the repository root; do not assume the previous owner's Windows username or folder path.
- Verify Git, **Node.js 22.11+**, and npm are available (`node --version`, `npm --version`). Use an existing supported Node installation; ask before installing system software or changing machine-wide settings.
- URL capture and the full test suite require **Google Chrome**, not just Playwright's bundled Chromium. Install Chrome only with the owner's approval. Do not disable the Chromium sandbox, TLS checks, or network policy to make capture work. Image intake and ordinary AI processing do not need Chrome.

### 2. Install reproducibly and configure locally

Run `npm ci` in a fresh checkout to install the committed lockfile, including workspace and native SQLite/image dependencies. Do not copy `node_modules` from another machine or replace the lockfile. Stop an existing app before reinstalling dependencies; report native-build or filesystem-permission failures rather than ignoring them or changing ACLs automatically.

Create `.env` **only if it does not already exist**:

```powershell
# PowerShell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

```sh
# macOS/Linux shell
if [ ! -e .env ]; then cp .env.example .env; fi
```

- Leave `OPENCODE_GO_API_KEY` blank for a local-only setup. If AI is wanted, have the owner enter their **OpenCode Go** key directly into the ignored root `.env`. Never print the key, request it in chat, commit it, put it in `VITE_*`, or use OpenCode/Copilot credential stores. Preserve an existing `ZEN_API_KEY` alias; the preferred variable wins if both are set.
- Keep the default port `4317` unless the owner chooses another. `DESIGN_INDEX_LIBRARY_DIR` must be an absolute, machine-appropriate path; its default is the per-user app-data location listed [below](#library-location-and-backup), outside the checkout. Do not reuse another machine's absolute paths blindly.
- `DESIGN_INDEX_INBOX_DIR` defaults to this checkout's `inbox/`. An override must be an absolute directory, or `off`. Keep it separate from managed library storage. Do not copy private references into Git or use the owner's inbox as a test-fixture directory.
- Fresh clones contain **no private library, credentials, or dropped images**. An empty gallery on a new machine is expected. To restore an existing library, stop the old app and securely transfer the **whole library folder**, including SQLite and `images/`, not just the database. Back it up before the first startup: migrations run automatically. Never delete/recreate the database to solve a startup error. The local access token rotates at startup; never publish `connection.json`.
- A restored library may already have sharing consent and queued tasks. Tell the owner that starting with a configured key will automatically resume eligible work, and confirm they intend that resumption before starting it.

### 3. Verify without using real model requests

Run from the root:

```sh
npm run check
npm run test:e2e
npm audit
```

`check` covers TypeScript, unit/integration tests, production builds, native ESM imports, and isolated real-browser capture. Browser tests use temporary libraries and synthetic AI/capture providers; they do not load the owner's `.env`. Test ports `14317` and `15319` must be free. Do not seed sample references into the owner's library, enable sharing/training for a test, or make a live Go entitlement/inference call without explicit authorization.

If Chrome is unavailable, run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:runtime` individually, and clearly report that browser/capture verification is incomplete. Report audit findings separately; do not automatically run `npm audit fix` or upgrade dependencies as part of initialization.

### 4. Start and hand off

- For development, run `npm run dev` from the root and keep the process alive. For the built app, stop development, then run `npm run build` followed by `npm start`. Do not run both against the same library. Prefer graceful Ctrl+C shutdown to killing a process during work.
- Verify `GET http://127.0.0.1:4317/api/health` returns `{"status":"ok"}` (adjust for a configured API port). Open **http://localhost:5173** for development or **http://127.0.0.1:4317** for the built app. An occupied port is a blocker: identify the process and ask rather than killing unrelated work, silently changing ports, or exposing the server on `0.0.0.0`.
- Confirm the gallery connects and **Folder inbox** shows the intended path. Keep a fresh installation local-only until the owner approves sharing in **AI settings**. Preserve restored permissions and model selections; Contributor training requires separate consent. Once the key and permissions are ready, inspiration automatically runs analysis → coding-agent prompt generation. **Do not add a local allowance setting or a separate enable switch:** limits, billing, and Extra Usage belong to the [Go account](https://opencode.ai/console).
- Report the app URL, library/inbox locations, whether the server key is configured (never its value), consent/readiness state, how to stop the running process, verification results, and any remaining blockers. A loaded key is not proof of subscription access, and an isolated test pass is not proof that a real model request succeeded.

## Run it

Requires **Node.js 22.11+** and npm. A recent Node 22 LTS release is recommended. URL capture also requires installed **Google Chrome**; image intake and evaluation do not launch Chrome. The native SQLite and image dependencies normally install prebuilt Windows binaries.

```powershell
# From the cloned repository root
npm ci
npm run dev
```

Open **http://127.0.0.1:5173** or **http://localhost:5173**. The API runs on `127.0.0.1:4317`; Vite proxies its requests. Both exact development origins are allowed; arbitrary hosts/ports remain blocked. The ports are strict: an occupied port is an error, not a silent switch to a different one.

Vite's disposable development cache lives in a per-project folder under `%TEMP%/opencode/design-index-vite` (or the OS equivalent). This avoids Windows permission errors when Vite invalidates an older cache under the checkout's `node_modules`.

For the production build, stop development first, then:

```powershell
npm run build
npm start
```

Open **http://127.0.0.1:4317**. This serves the UI and API from one local process. Ctrl+C closes the listener, drains active requests, checkpoints SQLite, and closes the database.

### Try the first slice

1. Optionally fill in a title and “why I saved this”.
2. Drop a PNG/JPEG/WebP, choose a file, or paste a screenshot when focus is outside an input.
3. The detail view opens with its extracted palette. Click a swatch to copy its hex; copy or download CSS variables.
4. Edit the title/note, close the detail, and search for words in either field.
5. Reload or stop/start the app: records and originals persist. Saving identical image bytes again opens the existing item and preserves its notes.

Limits: one image per capture, 20 MB compressed, 40 megapixels decoded, no animated images. Original files are never modified. Previews are orientation-corrected WebP; palettes cluster a small sRGB sample in OKLab. Swatches represent sampled pixels, so JPEG compression/downsampling can differ slightly from the source's authored CSS.

### Automatic folder inbox

Drop PNG, JPG/JPEG, or WebP images directly into **`inbox/`** at the project root. **Folder inbox** in the site shows its exact absolute path on this machine. With the app running, the server checks every 2 seconds, waits for files to stop changing, and imports them into the same library as browser uploads. The open gallery updates automatically, even while AI is paused.

- New references automatically start analysis and a coding-agent prompt once the server key, image-sharing consent, and model permissions are ready. There is no separate enable switch or local allowance setting; usage limits and billing are managed in OpenCode Go. Your chosen models and privacy permissions are preserved.
- Source files stay untouched. Imports are copied into private library storage. Deleting a source does not delete its reference; exact duplicate bytes reuse the existing item without replacing edits or adding model jobs.
- File progress/failures are recorded in SQLite across restarts. Changed files are reconsidered as new content. Corrupt/unsupported images are not repeatedly retried; replace them or use **Retry failed imports**. Transient read/storage failures retry with backoff.
- Expand **Folder inbox** below the intake form to copy the watched path, see recent imports/errors, or retry failures. Only direct, non-hidden files are considered; subfolders and symbolic links are ignored. Limits match uploads: 20 MiB, 40 megapixels, non-animated raster images. Processing is sequential and bounded to 8 files per scan.
- The folder's contents are ignored by Git except `inbox/README.md`. For slow copies, write `image.png.part`, then rename to `.png` when finished. The quiet period is not a guarantee that another program has closed the file.

The normal source and built entrypoints both default to the project inbox, regardless of the shell's working directory. To change it, set `DESIGN_INDEX_INBOX_DIR` to an **absolute path**, or `off` to disable it, and restart. Watching is server-side: the browser need not be open, but the app must be running. Embeddable `startServer()` callers opt in with `inboxDir`; omitted/null disables watching so tests/other clients never scan the owner's folder. See [inbox instructions](inbox/README.md).

**AI requires sharing consent, off by default.** Capture, palette extraction, note editing, and search work without a key. With a loaded key and saved consent, the background worker automatically uses Go for labels, palette-role suggestions, and a coding-agent prompt whenever new inspiration arrives. Uncheck sharing to keep captures local. The detail view supports label review, manual labels, prompt revisions, and saved-only copying. Search covers titles, notes, summaries, active labels, free tags, and saved prompts; the gallery also supports one facet/label filter at a time.

### Vocabulary and prompt authoring

- Open **Vocabulary** below the capture form to add or retire controlled labels. Use lowercase kebab-case, 1–60 terms per facet, and retain `motion:unknown`. Saves create revisions and affect future analysis/re-analysis; they do not queue bulk retagging or make model calls.
- Removing a term retires it without deleting old labels. Existing retired labels can still be reviewed and filtered. Use **Rename / merge label** to create canonical aliases and update effective labels/search. Conflicting manual accept/reject decisions block a merge; saved analysis JSON and prompt text remain unchanged.
- An item's prompt panel has **Coding agent**, **Design tool**, and **Vibe** tabs. Only the coding-agent prompt is automatic. Generate the other variants explicitly through Go, using the existing privacy permissions and Go account limits. Generated vibe summaries have at most 80 words and no code blocks.
- Each tab has independent immutable revisions. **Copy prompt** copies its saved body, not an unsaved draft. Drafts remain when switching tabs, but are not autosaved when closing the item.
- **Version history** previews older bodies. **Restore** creates a new manual revision rather than overwriting history. Viewing, editing, and restoring are local and consume no model allowance. A manual variant remains selected after later model runs; stale automatic variants are hidden after a new analysis but remain in history.

Vocabulary and prompt saves use revision/version checks to reject stale edits. Existing library databases migrate transactionally. Back up the library before upgrading; the implementation session created a pre-migration SQLite snapshot under the library's `backups/` folder. Original image files are not changed by these migrations.

### Browser capture and evaluation tools

- The main intake header offers **Page URL** and **image drag-and-drop** side by side (stacked on smaller screens), with neither capture method hidden behind a drawer. Paste a public HTTP(S) URL and click **Capture URL** or press Enter. Optional title/note fields stay independent from image-upload drafts. **Capture options** holds the site's light/dark appearance and local-origin permissions; **Recent URL captures** holds job history, cancel, and retry. Capture runs locally in fresh sandboxed Chrome without your personal profile and saves desktop, bounded full-page, mobile, and preview assets plus bounded CSS facts. The detail view switches between captured views.
- Private/LAN/metadata targets are blocked. To capture a local development page, explicitly approve its exact loopback origin under **Local dev-server permissions**. The library's own ports cannot be approved. A public-page capture cannot use these local approvals. Capture visits the site and resources; it is not an offline action and GET requests can still have side effects.
- Open **Evaluation tools** to hand-label up to 30 library references. Mark which facets should be scored; no model suggestions are prefilled. Hand-label annotations stay local. Save the labels before choosing 2–4 confirmed vision models and explicitly authorizing a bake-off.
- Evaluation uses identical frozen inputs and one call per model/reference, with no validation retry or replacement of library analyses/prompts. It shares the existing Go consent and request history, not a local allowance limit. Results show schema validity, precision/recall/F1, exact facet agreement, latency, and reported input/output tokens; export summary CSV or JSON with frozen snapshots and image hashes.
- These tools do not establish the planned 80% acceptance target by themselves. Meaningful accuracy needs the owner's varied, independently hand-labeled set; prompt usefulness still requires human assessment. No real evaluation requests were made during implementation.

See [capture/evaluation details](docs/capture-evaluation.md) for network policy, limits, scoring definitions, and cancellation behavior. Live element selection, signed-in-browser capture, and the extension are not included.

### Appearance

Use the **Light/Dark** control in the top-right header to switch themes. **Auto** follows your device's appearance and updates when the system setting changes. A manual choice is remembered in this browser's local storage (per site/origin) and synchronized across its open tabs; Auto clears that override.

The theme is applied before the application renders, works without persistent storage for the current tab, and covers the gallery, forms, AI settings, prompts, dialogs, and status messages. Reference images and extracted palette colors are never inverted or changed. Appearance is a browser preference, not an AI setting; changing it does not enable analysis or send captures anywhere.

### Enable OpenCode Go

1. Put your Go API key in the repository-root `.env` as `OPENCODE_GO_API_KEY=...`. The earlier `ZEN_API_KEY` name is accepted as an alias; you do not have to move an existing key. The preferred variable wins if both are populated. Never use a `VITE_*` variable for secrets.
2. Restart this application's server to load changed environment settings.
3. Manage usage limits, billing, and **Extra Usage** directly in your [OpenCode Go account](https://opencode.ai/console). DI does not change or override those settings.
4. In the gallery, open **AI settings**. Both selectors show **confirmed image-input models only**. The reviewed catalog currently contains 24 vision models, including **DeepSeek V4.1 Flash**, Gemini 4 Argon, GPT Luna, Grok, Kimi, Qwen, GLM Flash, MiMo, and MiniMax. Haiku remains the default; adding choices does not change your selection. Sonnet/Opus and pay-as-you-go endpoints are not used.
5. Explicitly approve image sharing and save. Processing starts automatically for queued captures and future uploads/URL captures/inbox imports. No local allowance amount or separate enable step is required. Contributor models still require separate training consent.

The activation checklist distinguishes a loaded key from missing image-sharing consent, model availability, or Contributor training permission. You never paste the key into the browser. “Local” describes the library and server; Go inference still runs remotely. The key's presence is not a live entitlement test. After a server restart, the browser refreshes its expired local session and retries a rejected local request once, preserving unsaved forms; it does not retry forbidden-origin errors. Provider retry behavior is described below.

Analysis sends a normalized image (at most 768 × 768), the title/note, palette, vocabulary, manual label decisions, and captured CSS facts where available. Evaluation deliberately omits manual decisions and ground-truth annotations. Prompt writing uses the validated analysis and extracted facts without resending the image. The selected models' privacy notices appear before enablement. Haiku/GPT/Grok have documented 30-day retention; several other models offer ZDR. Muse Contributor models require **separate provider-training consent** plus any necessary Console privacy permission, including in evaluation. Training consent is off by default and is not implied by image sharing.

Go owns all allowance and billing decisions, including its 5-hour/weekly/monthly limits and account-configured Extra Usage. DI has **no local budget, financial reservation, spending cap, or monthly blocking window**. The app records call attempts and reported tokens for diagnostics; incomplete usage stays marked unknown and never blocks future inspiration. Historical dollar fields are retained only in the database archive, not used or displayed as an allowance balance.

The adapter uses only `https://opencode.ai/inference/go/...`, identifies itself as `design-index/0.2.0`, and sends the item's stable ID as `x-opencode-session`. It does not impersonate OpenCode or switch providers/endpoints. Go must accept this coding-design-assistant workload. Explicit HTTP 429 rejections respect Retry-After (or a 60-second default), with at most three library-job attempts and a bounded delay up to seven days. Evaluation trials are not retried. Authentication/provider errors or ambiguous timeouts fail that task for review, not the whole pipeline: later inspiration is attempted automatically. Unknown outcomes are never silently replayed.

The app refreshes model metadata at normal startup. **Refresh Go models** repeats the check without sending the key or an inference request: intersect the live Go inventory with reviewed exact model IDs and explicit `image` input / `text` output metadata from models.dev. Text-only, unlisted, and unknown-capability models are hidden in **both** roles. Three legacy Go IDs use their exact matching Console capability records where Go-specific records are missing. A stale selected model pauses AI instead of silently switching it. If metadata is unreachable, the UI identifies the reviewed snapshot fallback. New IDs require an adapter/capability review before appearing.

This catalog check does **not** verify your subscription or workspace permissions. DeepSeek V4.1 Flash may need **Global** region permission in Console. `deepseek-v4.1-flash-free` is not a Go catalog entry, and DeepSeek V4 Pro is currently text-only, so neither appears. Automated tests use fake transports/providers and never send private captures or consume real Go usage.

### Library location and backup

Default locations:

- Windows: `%LOCALAPPDATA%\DesignIndex\library`
- macOS: `~/Library/Application Support/DesignIndex/library`
- Linux: `$XDG_DATA_HOME/design-index/library` (or `~/.local/share/design-index/library`)

The folder contains `design-index.sqlite`, `images/`, and a private `connection.json` for future local clients. The token rotates at startup. Keep this folder private: it holds your references and local access token. On Windows, file permissions inherit the folder's ACL; Unix mode bits do not configure Windows ACLs.

To change the location or port, copy `.env.example` to `.env` at the repository root and set `DESIGN_INDEX_LIBRARY_DIR` (an absolute path) and/or `DESIGN_INDEX_PORT`. Restart the app to change these application environment settings. Do not run two app processes against the same library folder.

For a consistent backup, stop the app and copy the **whole library folder**, not just SQLite. If the process crashes between writing a file and committing its record, an unreferenced image directory can remain; orphan reconciliation is not implemented yet. Do not delete directories from a live library.

## Verification

```powershell
npm run check       # Types, unit/integration tests, builds, runtime + real capture smoke
npm run test:e2e    # Build + real Chrome UI workflows with synthetic AI/capture providers
npm audit
```

Browser tests require installed Google Chrome. UI tests use an isolated temporary library and synthetic AI/capture providers on port 14317; they do not load your `.env` or use your personal library. They cover intake, AI consent, label review, prompt revisions, saved-only copying, facet filtering, capture permissions/view switching, and hand-labeling/bake-off/export. `npm run test:capture` separately exercises the real sandboxed capturer against isolated loopback fixtures, in tsx source mode and through the built API on port 15319. Screenshots/traces go under `%TEMP%/opencode/design-index-playwright-*`.

Unit/integration tests use a bounded thread pool, avoiding Windows failures when terminating forked test workers. Authoring tests cover populated-database migration, vocabulary aliases/manual-merge conflicts, in-flight vocabulary snapshots, variant caching, stale edits, and history restore.

The runtime check imports the built server with plain Node, outside the test runner, so missing native/transitive dependencies cannot be hidden by test-runner module transforms. Stop the app before changing dependencies. If Windows reports locked/partially removed dependency directories, resolve the filesystem lock and rerun `npm install` before retrying the checks; do not ignore install errors or change system permissions automatically.

## Local-first and security boundaries

- The server binds only to `127.0.0.1`. It checks Host/Origin, rejects cross-site browser requests, and does not enable CORS.
- The gallery bootstraps a local HttpOnly, SameSite=Strict cookie. All library API calls and image downloads require that cookie or the bearer token from `connection.json`. `/api/health` and `/api/session` are the only unauthenticated API routes, and expose no library records.
- The provider key is read only from this app's server environment. Browser APIs return only `keyConfigured`, never the key. OpenCode's own stored provider/Copilot credentials are not accessed.
- Captured content is untrusted. Uploaded files accept raster images only; original filenames are never used as paths. URL pages execute only in fresh sandboxed Chrome contexts behind a per-capture authenticated DNS-pinning proxy. The saved library renders screenshots/text, not the captured site's HTML. See the [capture threat boundary](docs/capture-evaluation.md).
- Local databases, captured assets, environment files, build output, and test artifacts are excluded from Git.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness only |
| GET | `/api/session` | Same-origin browser session bootstrap |
| GET | `/api/status` | Queue count and honest analysis availability |
| GET | `/api/inbox` | Configured watched path, pending count, recent import results/errors and gallery change token; authenticated |
| POST | `/api/inbox/retry` | Reconsider failed folder imports, without re-analyzing existing references or changing the watched path |
| GET | `/api/items?q=&limit=50&offset=0&facet=style&label=minimal` | Text + optional facet/label filter; relevance then newest |
| POST | `/api/items` | Multipart `image`, optional `title` and `note`; 201 new / 200 duplicate |
| GET | `/api/items/:id` | Item detail and palette |
| PATCH | `/api/items/:id` | JSON `{ "title": "...", "note": "..." }` |
| POST | `/api/items/:id/analyze` | Explicit retry/re-analysis; requires sharing consent, a key, and available models |
| PATCH | `/api/items/:id/labels` | JSON `{ "facet": "style", "value": "minimal", "state": "accepted" }`; state can also be `rejected` |
| PATCH | `/api/items/:id/prompt` | JSON `{ "body": "...", "baseVersion": 1, "variant": "agent" }`; variant defaults to agent; stale edits return 409 |
| GET | `/api/items/:id/prompts?variant=agent&limit=20&offset=0` | Saved head and paginated immutable history for one variant |
| POST | `/api/items/:id/prompts` | JSON `{ "variant": "general" }` (or agent/vibe); explicitly queue a Go prompt job |
| POST | `/api/items/:id/prompts/:revisionId/restore` | JSON `{ "variant": "agent", "baseVersion": 2 }`; restore as a new manual revision |
| GET / PUT | `/api/vocabulary` | Current revision, terms, aliases, retired terms / JSON `{ "baseRevision": 1, "terms": { ... } }` |
| POST | `/api/vocabulary/rename` | JSON `{ "baseRevision": 1, "facet": "style", "from": "old", "to": "new" }`; rename/merge with conflict checks |
| GET / PUT | `/api/ai` | Key-presence flag, settings/consent, supported models, usage, queue state / save settings |
| POST | `/api/ai/models/refresh` | Refresh the public Go catalog, not a key test |
| GET / POST | `/api/captures` | Capture settings/recent jobs / queue a URL, title, note, and light/dark colorScheme |
| PUT | `/api/captures/settings` | Exact approved loopback origins; no wildcards or library ports |
| POST | `/api/captures/:id/cancel` | Cancel a queued/running capture |
| GET | `/api/evaluation/samples` | Saved explicit hand labels |
| PUT / DELETE | `/api/evaluation/samples/:id` | Save with baseVersion / remove with version query; preserves library item |
| GET | `/api/evaluation/samples/export` | Hand-label dataset JSON |
| GET / POST | `/api/evaluations` | Recent run summaries / explicitly confirmed 2–4-model bake-off |
| GET | `/api/evaluations/:id` | Trial results and metrics |
| POST | `/api/evaluations/:id/cancel` | Cancel queued/running trials; in-flight usage/billing remains managed by Go |
| GET | `/api/evaluations/:id/export?format=csv` | Summary CSV; omit format for JSON with frozen snapshots |
| GET | `/api/items/:id/assets/:kind` | Authenticated preview/original/full_page/viewport/mobile assets |
| GET | `/api/items/:id/assets/preview` | Authenticated WebP preview |
| GET | `/api/items/:id/assets/original` | Authenticated unchanged original download |
| GET | `/api/items/:id/palette.css` | CSS variables download; all suggested roles, including multiple roles for one color |

The embeddable server is exported as `startServer()` from `apps/server/src/server.ts` (or built `apps/server/dist/server.js`). It returns an idempotent `stopServer()` method. Future desktop/MCP clients can reuse this boundary.

## Status

**Implemented:** image, watched-folder, and isolated URL intake → persistent gallery → deterministic/CSS-first palettes → automatic consent-gated Go analysis → reviewed labels/roles → versioned design prompts; plus isolated evaluation comparisons and exports. Local authentication, call/token history, leased jobs, manual overrides, vocabulary/history, text search, a single facet filter, and light/dark mode remain intact. Go owns allowance/billing controls. Remaining: the owner's real evaluation set/results, richer multi-facet/color criteria, additional palette exports, and full acceptance review. Compare, collections, extension, MCP, similarity, and desktop packaging remain future work. See the [current checklist](docs/implementation-status.md).

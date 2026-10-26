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
```

The first implementation follows phase 1 with npm workspaces. The extension, desktop shell, MCP integration, capture package, and analysis package are reserved; they are not implemented yet. See [the implementation review](docs/implementation-review.md) for the plan corrections, phase gates, and next slices.

## Run it

Requires **Node.js 22.11+** and npm. A recent Node 22 LTS release is recommended. The native SQLite and image dependencies normally install prebuilt Windows binaries.

```powershell
cd C:\Users\Ian\Documents\_DI
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on `127.0.0.1:4317`; Vite proxies its requests. Use `127.0.0.1`, not `localhost`, for the development UI. The ports are strict: an occupied port is an error, not a silent switch to a different one.

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

**AI is not connected yet.** Items are `queued`, with a durable analysis-job record. There is no worker consuming these jobs, no label generation, no design prompt, and no model network traffic. You do not need a Zen key or Copilot subscription to use this slice.

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
npm run check       # TypeScript, unit/integration tests, builds, native ESM runtime check
npm run test:e2e    # Build + real Chrome upload/edit/search/copy/download flows
npm audit
```

Browser tests require installed Google Chrome. They run the built server with an isolated temporary library on port 14317; they do not use your personal library. Screenshots/traces are written to ignored `test-results/`.

The runtime check imports the built server with plain Node, outside the test runner, so missing native/transitive dependencies cannot be hidden by test-runner module transforms. Stop the app before changing dependencies. If Windows reports locked/partially removed dependency directories, resolve the filesystem lock and rerun `npm install` before retrying the checks; do not ignore install errors or change system permissions automatically.

## Local-first and security boundaries

- The server binds only to `127.0.0.1`. It checks Host/Origin, rejects cross-site browser requests, and does not enable CORS.
- The gallery bootstraps a local HttpOnly, SameSite=Strict cookie. All library API calls and image downloads require that cookie or the bearer token from `connection.json`. `/api/health` and `/api/session` are the only unauthenticated API routes, and expose no library records.
- Model credentials must stay server-side. None are requested or read by this implementation, including OpenCode's own Copilot credentials.
- Captured content is untrusted. The first slice accepts raster images only; it never executes HTML/SVG or fetches supplied URLs. Original filenames are never used as paths.
- Local databases, captured assets, environment files, build output, and test artifacts are excluded from Git.

## API (first slice)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness only |
| GET | `/api/session` | Same-origin browser session bootstrap |
| GET | `/api/status` | Queue count and honest analysis availability |
| GET | `/api/items?q=&limit=50&offset=0` | Plain-text title/note search, AND/prefix matching; relevance then newest |
| POST | `/api/items` | Multipart `image`, optional `title` and `note`; 201 new / 200 duplicate |
| GET | `/api/items/:id` | Item detail and palette |
| PATCH | `/api/items/:id` | JSON `{ "title": "...", "note": "..." }` |
| GET | `/api/items/:id/assets/preview` | Authenticated WebP preview |
| GET | `/api/items/:id/assets/original` | Authenticated unchanged original download |
| GET | `/api/items/:id/palette.css` | CSS variables download, numbered until roles exist |

The embeddable server is exported as `startServer()` from `apps/server/src/server.ts` (or built `apps/server/dist/server.js`). It returns an idempotent `stopServer()` method. Future desktop/MCP clients can reuse this boundary.

## Status

**Phase 1, slice 1 implemented:** local image intake → persistent gallery → deterministic palette → CSS export, with note editing/search and local API protections. Remaining phase-1 work: provider settings/consent, vocabulary/evaluation, durable analysis worker, labels/manual overrides, prompt generation/revisions, and facet filters. URL capture, compare, collections, extension, MCP, similarity, and desktop packaging remain future work.

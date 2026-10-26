# Implementation review — 2026-10-26

The plan is a sound product direction, but not a single implementation milestone. Begin with a working, offline vertical slice; add external services only after capture and persistence are dependable.

## Corrections and decisions

1. **Windows first.** The current development machine is Windows. Store the library outside the checkout in per-user application data. Defer Electron, login integration, packaging, and the macOS-specific instructions.
2. **Do not block capture on a model bake-off.** Thirty hand-labeled examples require the owner's input. Image capture, search, and deterministic palettes can ship first. Imported items remain honestly marked `queued` until a real analysis worker exists; no fabricated labels or prompts.
3. **Provider access is not transferable.** The Copilot model working in this OpenCode session does not grant a Zen API key or permission to reuse OpenCode's credentials. Do not read those credentials or spend funds automatically. Select providers and authorize image transmission explicitly in the AI slice.
4. **Verify provider claims later.** The plan's model names, pricing, retention, and unified-endpoint assumptions are not an integration contract. Confirm the chosen provider's current documentation and capabilities before implementation. Keep provider defaults configurable.
5. **Localhost is not an authentication boundary.** Validate Host/Origin, reject cross-site browser requests, disable CORS, and authenticate APIs/assets. Browser sessions use an HttpOnly SameSite=Strict cookie; future non-browser clients use the local connection token. Never make captured files a public static directory.
6. **Capture limits precede a headless browser.** Limit upload size and decoded pixels, verify actual image format, preserve originals, and generate normalized previews. Later URL capture needs a specific network policy: deny private/link-local/cloud-metadata targets by default, revalidate redirects and DNS, and explicitly approve local dev-server origins. Approved filesystem folders do not constrain URL requests. Also clarify the privacy statement: URL capture necessarily sends normal network requests to the target site and its subresources, even when no screenshot is sent to a model.
7. **Separate facts from inference.** OKLab clustering is deterministic. Palette roles stay unassigned until analysis/manual editing exists. Motion is unknown for still images, not automatically `static`. Never execute or render captured HTML.
8. **Make cost caps real.** AI work needs a durable job lease, retry policy, idempotent stages, cancellation, usage ledger for *both* analysis and prompt calls, and pre-call budget reservations. An analyses-only cost column cannot enforce a hard cap, particularly with concurrency or failed calls.
9. **Cache more than the image hash.** Exact-image deduplication is appropriate for this first slice. Later analysis cache keys also need provider/model, prompt/schema version, vocabulary revision, captured facts, and variant. Never overwrite manual labels or prompt revisions on a cache hit.
10. **Define phase gates.** The roadmap's diagrams are missing from the markdown. Use explicit acceptance criteria instead of the nine-week estimate. Similarity, smart collections, MCP writes, browser capture, and the tray stay behind the phase-1 gate.

## First slice: implemented scope

- npm/TypeScript workspaces for the existing package boundaries.
- Embeddable Hono server on `127.0.0.1`; graceful shutdown and SQLite checkpoint.
- Versioned SQLite migration, WAL, foreign keys, image/asset/palette/job records, title/note full-text search.
- PNG/JPEG/WebP file upload, drop, and clipboard intake; unchanged originals and WebP previews.
- SHA-256 duplicate detection, deterministic weighted OKLab palettes, CSS export.
- Responsive gallery, search, item detail, title/note edits, palette copy/download.
- Local authentication and tests for storage, extraction, intake, and security boundaries.

This is **the start of phase 1**, not the complete phase. AI analysis is not yet implemented. There are no paid calls, fake prompts, browser extension, URL fetching, or background worker.

## Acceptance gate for this slice

- `npm run check` passes: typecheck, automated tests, production builds.
- `npm run dev` opens an empty, usable library; a real image can be saved and browsed after restarting.
- Original bytes are preserved; duplicates do not create a second item or overwrite notes.
- Known-color fixtures produce repeatable palettes; malformed/oversize images are rejected.
- Browser clients on other origins and requests without authentication cannot read the library or mutate it.
- Capture/search/palette export work with no API key or internet connection after dependencies are installed.

## Next slices

1. Owner-approved provider setup and a small vision capability probe; versioned controlled vocabulary and labeled evaluation fixtures.
2. Durable worker with separate analysis/prompt stages, schema validation/retry, provenance, cost reservations, explicit image-sharing consent, and failure/recovery tests.
3. Labels and manual overrides, prompt revisions/copy, facet filters, and the complete phase-1 acceptance test.
4. URL capture and extension with separate URL/network and filesystem approval policies; then compare/collections/MCP and optional Windows tray packaging.

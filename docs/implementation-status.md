# Implementation status — 2026-10-29

This is the current checklist against the original implementation plan. The original plan and first-slice review remain historical documents, not claims that all listed work has shipped.

## Implemented

| Plan area | Current implementation |
| --- | --- |
| Local app foundation | TypeScript workspaces; loopback Hono API; SQLite/WAL/migrations; originals and normalized previews outside the checkout; embeddable start/stop |
| Image capture | File/drop/clipboard intake, actual-format and decoded-pixel limits, preserved originals, exact-image deduplication |
| Folder inbox | Project-root inbox/; server-side stable-file polling; startup discovery; durable fingerprints/results; unchanged sources; existing deduplication/AI queue; automatic gallery refresh; failure reporting/retry; configurable path or off |
| Palette facts | Deterministic OKLab clustering; model roles restricted to extracted colors; CSS variables export |
| AI setup | Owner-selected OpenCode Go, server-only `.env` credentials, 24 reviewed vision models across four API families, explicit image/training consent |
| Durable processing | Automatic consent-gated analysis/prompt jobs; leases and call/token history; bounded validation/explicit rate-limit retry; crash/timeout review; idempotent result caching; Go-managed allowance/billing |
| Labels | Six facets, confidence/review markers, manual add/accept/reject decisions kept separately from generated output |
| Editable vocabulary | Versioned terms; add/retire; canonical rename/merge aliases; conflict rejection for inconsistent manual decisions; provenance and cache invalidation by vocabulary revision |
| Prompt authoring | Automatic coding-agent prompt, on-demand design-tool and short vibe variants, saved-only copying, per-variant immutable versions, paginated history and restore-as-new-version |
| Gallery | Visible split URL/image intake header (stacked on smaller screens), masonry layout, notes/title editing, full-text search across current saved content, one facet/label filter at a time, original download/detail view |
| Appearance/recovery | Light/dark/system appearance, local preference persistence, native control theming, browser session recovery after server restarts, both localhost development aliases |
| URL capture | Isolated sandboxed Chrome; desktop/full-page/mobile views; bounded CSS facts and CSS-first palettes; authenticated DNS-pinning proxy; private-network denial; exact local-origin approvals; persistent jobs, cancellation/retry |
| Evaluation tools | Explicit hand-labeling of up to 30 references; 2–4-model comparisons; blind frozen inputs/image integrity checks; shared consent and request history; schema validity, precision/recall/F1/exact facet scores, latency/reported tokens; CSV/JSON reports; result isolation |

## Preservation rules in the authoring slice

- Existing prompts migrate to the `agent` variant without changing IDs, bodies, manual flags, or versions. The next revision is scoped to its item and variant.
- New analyses record the vocabulary revision used to build their input. A response already in flight is validated against that captured revision, not a later edit.
- Retiring a term does not delete suggestions or manual rows. Renaming canonicalizes effective labels and search while leaving raw analysis JSON and prompt bodies intact.
- Conflicting accepted/rejected manual rows prevent a merge. Compatible rows coalesce only after the owner explicitly requests the rename/merge.
- Only the agent variant is queued automatically after analysis. General/vibe generation is explicit and allowance-accounted; editing/history/restore stay local.
- Manual prompt heads survive model runs. Automatic optional variants based on an older analysis are hidden, not deleted; history can restore them explicitly.
- A failed optional variant does not mark a previously ready agent prompt as failed. Provider/auth/billing failures can still pause the shared AI worker.
- A consistent SQLite snapshot was taken before migrating the owner's existing library, under `library/backups/before-vocabulary-prompts-*.sqlite`. Original images were not modified.

## Remaining before the Phase 1 quality gate

- [ ] Collect the owner's 30 varied captures and hand-label the evaluation set.
- [x] Implement hand-labeling and isolated model bake-off tooling with metrics and CSV/JSON exports.
- [ ] Run the owner's explicitly authorized benchmark and assess tag acceptance, prompt utility, palette fidelity, and authoritative provider usage. No real 80% score has been claimed.
- [ ] Expand the query engine/UI to AND across facets, OR within a facet, removable filter chips, compact query syntax, and the planned source/quality/date/font criteria.
- [ ] Add OKLab palette-role/distance filtering, background lightness/text-contrast criteria, and color-distance sorting.
- [ ] Add Tailwind/token and swatch-image palette exports.
- [x] Delegate allowance and billing management to OpenCode Go; retain call/token diagnostics, not a local financial guardrail. Unknown outcomes require task review, not allowance reconciliation.
- [ ] Complete per-item model override/analysis comparison and owner acceptance of prompt usefulness and capture-to-library usability.

## Later plan slices

- [x] Safe URL capture: desktop/full-page/mobile assets, bounded page facts, SSRF/DNS/redirect policy, explicit local dev-origin approvals, timeouts, and browser lifecycle recovery. Delivered early at the owner's request; extension/live-element capture remains separate.
- [ ] Chrome MV3 capture extension with element picker, computed styles/animation facts, token pairing, and bounded offline queue.
- [ ] Two-to-four reference comparison; manual collections; smart collections using the same query engine.
- [ ] Stdio MCP read tools/resources/prompts, followed by approved-folder exports and explicitly authorized captures.
- [ ] Windows-first optional Electron tray, single-instance lock, pause/resume, start-at-login, launch protocol, packaging, and shutdown/reboot tests.
- [ ] Steward vocabulary proposals, local image embeddings, and similarity search after the earlier gates.

Scope note: Go-only and vision-only model choices follow the owner's decisions. Arbitrary external providers and automatic fallback are not introduced silently. Evaluation and browser URL capture were prioritized at the owner's request. No bulk retagging, live inference test, or real evaluation run was performed; automated model tests use synthetic providers/transports. See [capture/evaluation boundaries](capture-evaluation.md). A consistent `before-evaluation-capture-*.sqlite` snapshot was taken before migration 6; existing images, manual decisions, and prompt history are preserved.

## Verification for evaluation/capture

- 192 unit/integration tests; 16 Chrome UI workflow tests; successful typecheck, production builds, native ESM import, and source/bundled real-browser capture smoke tests.
- Dependency audit reports zero known vulnerabilities.
- Migration 5 → 6 checked on an isolated copy of the owner's backup, then verified against the migrated live library: all 12 pre-existing tables preserve their original columns/rows; foreign-key and SQLite integrity checks pass.
- The app is restored at the usual localhost URLs, with its server key loaded, AI still paused, and historical model-call records unchanged. No new Go inference calls were made.
- A separate public HTTPS smoke captured `https://example.com/` successfully without saving it to the library or invoking AI. Automated tests remain isolated/synthetic.

## Folder inbox — 2026-10-27

- Added project-root `inbox/`, with private images ignored by Git and a tracked usage README. The standard source/built entrypoints watch it independently of the working directory; an absolute `DESIGN_INDEX_INBOX_DIR` override or `off` is supported. Embeddable callers explicitly opt in.
- The bounded polling worker waits for stable metadata, reads bounded bytes with identity checks, ignores hidden/temp/nested/linked entries, preserves source files, and reuses the existing raster validation, deterministic palettes, deduplication, and consent-gated analysis → prompt queue.
- Migration 7 adds a durable import ledger, so unchanged/invalid files do not get decoded repeatedly on restart. Changed contents are reconsidered. Permanent failures wait for a file change or explicit retry; transient storage failures retry with bounded backoff.
- Authenticated status/retry endpoints power the Folder inbox panel, and the gallery refreshes on folder changes even when AI is paused. The browser cannot select arbitrary server paths. Source removal does not delete references; duplicates never replace manual work or add model jobs.
- Verification: **208 unit/integration tests and 18 real-Chrome UI tests pass**, including file-drop → live gallery with paused AI, and file-drop → analysis → saved prompt using only a synthetic provider. Typecheck, builds, native/capture smoke tests pass; dependency audit reports zero known vulnerabilities.
- A consistent `before-folder-inbox-*.sqlite` backup was taken before upgrading. An isolated migration 6 → 7 comparison preserves all rows/columns in the 18 pre-existing tables, with passing integrity/foreign-key checks. This feature does not enable AI or alter the owner's privacy/model/allowance settings.

## Automatic processing and Go-managed usage — 2026-10-29

- Removed the local monthly allowance field, monetary reservations/estimates, budget-blocked state, and separate background-AI enable switch from active settings, APIs, UI, and evaluation reports. Go account usage/billing/Extra Usage settings are authoritative and are never changed by DI.
- With the server key, saved sharing consent, and model permissions ready, uploads, URL captures, and inbox imports automatically run analysis → coding-agent prompt generation. Existing queued work resumes under the same prerequisites. Sharing/training consent, models, manual labels, prompts/history, images, and call records are preserved.
- Provider/auth failures and ambiguous timeouts fail only the affected task; they do not disable later inspiration. Explicit HTTP 429 rejections respect Retry-After (default 60 seconds, bounded 1 second–7 days), with at most three library-job attempts. Evaluation remains single-attempt, and uncertain outcomes are never silently replayed.
- Migration 8 removes only legacy `enabled`/`monthlyBudgetUsd` JSON settings. Historical dollar columns remain untouched as archived records, not active gates or new monetary estimates. UI/export diagnostics use call counts and reported tokens; incomplete usage never blocks tasks.
- Verification: **215 unit/integration tests and 18 Chrome browser tests pass**, including automatic intake without allowance/enable controls, preserved consent during migration, unknown/high historical usage not blocking work, and bounded Go-rate-limit resumption. Typecheck, builds, native/capture smoke tests pass. Automated inference remains synthetic.
- Earlier verification sections above describe their respective slices, not the current runtime's pause behavior. A pre-change `before-go-managed-usage-*.sqlite` backup was taken before upgrading.
- An isolated comparison of the owner's backup confirms migration 7 → 8 preserves all rows/columns in the 18 non-settings tables and changes only the two retired settings; integrity and foreign-key checks pass. The restored live app exposes no allowance/enable controls and automatically began its queued work with the already-saved consent and server key.
- Current dependency audit (2026-10-29) reports one moderate `@hono/node-server` advisory, GHSA-rmxm-3fg6-px4f. Dependency upgrades were not included in this behavior change; earlier zero-vulnerability results above are historical.

## Visible intake header — 2026-10-29

- URL capture and image drag-and-drop are always visible in a split header, rather than a Browser capture toggle/drawer. Smaller screens stack the two methods. Title/note drafts stay independent; URL submission also works with Enter.
- Appearance/local-origin permissions and capture job history/cancel/retry remain secondary disclosures. Capture networking, AI consent, persistence, and analysis behavior are unchanged.
- Verification: typecheck/build, **215 unit/integration tests and 20 Chrome workflow tests pass**, including desktop/mobile layout, independent drafts, existing drag/drop/paste, capture permissions, and keyboard URL submission. Light desktop and dark mobile screenshots were visually checked using isolated synthetic references.

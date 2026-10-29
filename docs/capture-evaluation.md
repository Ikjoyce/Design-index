# URL capture and evaluation

## Browser capture

The gallery header shows a **Page URL** field and an **image drag-and-drop** area side by side, stacked on smaller screens. URL capture is always visible, not inside a drawer. Submit with **Capture URL** or Enter. Optional URL title/note fields do not consume image-upload drafts. Site appearance and local-origin permissions live under **Capture options**; job history/cancel/retry live under **Recent URL captures**.

A URL request queues a local background job and does not itself call Go. Once saved, the reference follows the library's existing key/model/sharing prerequisites, automatically queueing normal analysis and prompt writing when ready.

Google Chrome must be installed. The capturer uses Playwright's `chrome` channel, headless with the Chromium sandbox explicitly enabled. It never uses the owner's existing browser profile or signed-in cookies. Each capture launches a new process; desktop and mobile use separate fresh contexts, including separate cookie jars. Local-origin approvals are persisted in SQLite, not browser settings.

Saved views:

- Desktop viewport: 1440 × 1000 PNG.
- Full page: 1440 pixels wide, at most 10,000 pixels high; does not scroll through or click lazy/interactive content.
- Mobile viewport: 390 × 844 PNG with mobile/touch emulation.
- Library preview: normalized WebP from the desktop viewport. This is the image used for AI analysis/evaluation, not all three views.
- Bounded computed facts: fonts, sampled font/spacing/radius/shadow values, opaque colors, CSS animation/transition configurations, and limited script-URL library hints. No page HTML or full text is stored.

CSS colors take precedence; a small deterministic pixel palette supplements them. Transparent CSS colors are omitted rather than guessed. CSS evidence describes configured styles, not interaction/scroll triggers. Animations are paused for screenshots. Mobile may load a different responsive layout; its styles are not merged into the desktop facts.

### Network boundary

- Only HTTP/HTTPS, with no URL-embedded credentials. Public destinations use standard ports.
- Private, link-local, reserved, mapped-private IPv6, metadata, multicast, and non-global destinations are denied. DNS checks inspect **all** returned addresses; mixed public/private records fail closed.
- Requests go through a fresh, random-password loopback forward proxy. The proxy resolves and validates a destination, then dials that checked IP directly; browser re-resolution cannot bypass the check. Redirect and subresource destinations are checked independently.
- Exact `localhost`, `127.0.0.1`, or `[::1]` origins may be explicitly approved for local development. Scheme, hostname, and port must match. No LAN origins/wildcards. Ports 4317, 5173, and the configured API port stay protected.
- A local approval is usable only by a capture initiated on that origin. Public-page captures cannot reach approved local servers. Local DNS must still resolve exclusively to loopback.
- Browser routing permits GET/HEAD only, blocks WebSockets and service workers, closes popups, and cancels downloads. The HTTP proxy independently rejects other methods; HTTPS CONNECT is an opaque pinned tunnel, so its request-method restriction relies on browser routing. GET/HEAD are not a guarantee of no site-side effects.
- Chrome receives an environment allowlist needed for platform startup, not Go keys, `NODE_OPTIONS`, arbitrary secrets, or inherited proxy configuration. No certificate bypass or sandbox-disabling fallback is enabled.

Limits: one active capture, at most 20 pending, 45-second overall timeout, bounded navigation/screenshot/DNS times, 240 proxy requests, 40 MiB accounted proxy traffic, bounded sockets, 30 MiB combined PNG storage, and 40-megapixel image decoding limits. Style sampling stops after 400 elements, and serialized facts are trimmed to roughly 18,000 characters before analysis. These are application bounds, **not an OS memory/CPU quota**; keep Chrome patched and avoid intentionally hostile pages. There is no full-site crawl, authenticated-site automation, live element picker, or signed-in extension capture.

Cancellation aborts the browser/proxy and prevents a late result from committing a new item. Expired running jobs are marked interrupted, not silently replayed; retry is explicit. Stored job history shows the latest 20 entries. Captures with identical final URL, images, and facts deduplicate without changing existing notes/prompts. Dynamic pages may yield a new reference on recapture.

## Evaluation lab

1. Pick a reference and independently choose hand labels. Model suggestions/manual library labels are not prefilled.
2. Explicitly mark scored facets. Empty labels on a scored facet mean “none applies”; unchecked facets are excluded. At least one facet is required, with up to 10 labels per facet. The set holds at most 30 references. Saves use optimistic versions.
3. Choose 1–30 saved entries and 2–4 distinct, confirmed vision models. Contributor models require separate training consent in AI settings.
4. Approve image sharing and explicitly authorize the model calls. A server key and valid model permissions are required; there is no local allowance or separate enable step. A run uses one attempt per model/reference; failed or invalid output is **not retried**.

Normal library jobs have priority over evaluation. Only one evaluation may be queued/running. Trials share consent checks, request history, provider timeouts, and reported token counts. Usage limits, billing, and Extra Usage are managed directly in the Go account; DI has no monetary reservation or spending cap. Explicit rate limits delay subsequent work according to Go's Retry-After response, but an evaluation trial itself is not replayed.

### Frozen, blind inputs and isolation

The run freezes title/note, palette/CSS facts, controlled vocabulary, expected hand labels, scored facets, hand-label version, reviewed model metadata, and system/prompt details. It records the SHA-256 of the normalized 768-pixel WebP; execution verifies the image and prompt before recording/sending a request. Image bytes remain in the library, not the report. An edited external file or changed prompt implementation causes a failed trial rather than silently changing the benchmark.

Requests omit manual library-label decisions and never include hand-label annotations or expected labels. Existing title/note and screenshot content still go to the model, so do not put answer keys in those fields. Each run/reference uses an isolated evaluation session identifier, shared across its compared models. Normal library analysis/prompt heads, manual overrides, item status, and history are never replaced by evaluation results.

### Metrics

- **Schema validity:** responses matching the analysis schema / received responses. Attempted calls and finished trials are reported separately.
- **Valid analysis:** schema plus controlled-vocabulary, duplicate-label, and palette restrictions. Evaluation does not repair motion predictions to `unknown`; scores measure the model's actual labels.
- **Micro precision:** TP / (TP + FP), over explicitly scored facets.
- **Micro recall:** TP / (TP + FN).
- **Micro F1:** 2TP / (2TP + FP + FN).
- **Exact facet agreement:** fully matching label sets / scored facets. A valid empty prediction can match an explicitly empty ground-truth facet.
- Failed/invalid finished trials count as missing predictions with no exact-match credit. Pending/cancelled trials are excluded; a partial/cancelled run is not an acceptance benchmark. Zero-denominator metrics appear as `—`, not a fabricated percentage.
- Mean elapsed trial time and reported input/output tokens are shown. Missing token usage is unknown; totals include only reported values. These are diagnostics, not an allowance balance or authoritative provider billing.

CSV exports model summaries. JSON exports results plus frozen snapshots, expected labels, vocabulary, model/system details, normalized image hashes, and returned output where available. Reports can include private reference content and labels: keep them private. Provider schema failures may yield `null` output because the SDK cannot return a usable object.

Cancelling queued trials sends nothing; an in-flight call cannot be unsent, and Go handles resulting usage/billing. Late responses cannot overwrite cancelled results. Crash-expired trials fail without automatic resending; unstarted queued trials resume automatically when key/model/consent prerequisites are met. Revoking sharing or relevant training consent interrupts an active call conservatively.

The tools are ready for an owner-authored evaluation set. **No real Go bake-off or claimed 80% acceptance score was produced during implementation.** Precision/recall and exact agreement help compare labeling; usefulness of design prompts, palette fidelity, and the plan's tag-acceptance target still require human review.

## Verification

`npm run check` includes unit/integration tests, build/native-import checks, and `npm run test:capture`. The capture smoke launches real sandboxed Chrome against isolated fixtures in both tsx source mode and the built API, checking bounded views/CSS facts, separate cookie jars, denied POSTs/private subresources/redirects, and zero AI calls. UI tests use synthetic capture/AI providers, an isolated database, and no `.env`.

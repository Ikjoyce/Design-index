# OpenCode Go integration — updated 2026-10-29

The owner selected **OpenCode Go**, replacing the implementation plan's assumed Zen/pay-as-you-go gateway. Credentials remain in the ignored `.env`. The legacy `ZEN_API_KEY` name is accepted, but all new requests use Go endpoints. The key's presence has been verified without printing its value; this does not verify subscription access.

## Sources verified before integration

- https://opencode.ai/v2/docs/console/go — endpoints, supported models, identity/session headers, allowances, retention, Extra Usage.
- https://opencode.ai/v2/docs/console/api/inference — bearer authentication and `usage.opencode.billing_source` / `allowance`.
- https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data — structured output and validation errors.
- https://opencode.ai/v2/docs/models and https://models.dev/api.json — explicit model input/output modalities and SDK-family metadata.

## Boundaries

- Both roles are vision-only. The reviewed registry contains 24 image-input/text-output models. Haiku remains the default, but is no longer an artificial one-model limit. Do not use Sonnet with a Go key.
- Four supported Go API families: Anthropic Messages, OpenAI Responses, OpenAI-compatible Chat Completions, and Google Generate Content. All use fixed `https://opencode.ai/inference/go/...` endpoints; the transport rejects other origins/paths and redirects. No configurable remote host or pay-as-you-go fallback.
- Honest identity: `User-Agent: design-index/0.2.0`; stable `x-opencode-session` is the item ID across stages, retries, and re-analysis. This is a coding-design assistant, not an impersonated harness. Go may reject traffic outside its accepted use.
- Provider errors never expose keys, payloads, or upstream error bodies through local APIs/logs. Go billing metadata does not impose a second client-side spending limit; the account's own settings govern billing.
- Images remain local until image-sharing consent is saved. With a loaded key and valid model permissions, queued and new inspiration then process automatically; no separate enable switch. Migration 8 removes only legacy enable/budget fields, preserving sharing/training permissions and model selections. Analysis transmits one bounded preview plus title/note/facts/vocabulary/manual labels; prompt writing uses validated analysis and extracted facts.
- Model-specific privacy notices are displayed in settings. Haiku/GPT/Grok retention is 30 days, not ZDR. Muse Contributor models can train on request content and require separate `allowModelTraining` consent (off by default) in addition to image sharing and upstream Console permission. The worker and transport both enforce this; adding a model never opts the owner into training. Normalized image previews omit original EXIF metadata.

## Vision catalog and routing

Refresh intersects the live Go inventory with reviewed exact IDs and models.dev records explicitly declaring `image` input and `text` output. An explicit Go capability record takes precedence, including a negative/text-only one. If a legacy ID lacks Go-specific metadata, its **exact** Console entry may confirm vision: currently Grok 4.6, Kimi K2.6, and Qwen3.6 Plus. Do not inherit a neighboring version's capabilities. Unknown/new IDs remain hidden until reviewed. Both client and server enforce vision-only selections; if a selected model disappears, readiness blocks requests until an available model is selected instead of switching it silently.

Normal app startup refreshes public metadata before queued AI work; factory tests opt out. On metadata failure the reviewed snapshot is retained with a visible warning. Public catalog membership is not proof of workspace entitlement. DeepSeek V4.1 Flash needs Global region permission in some workspaces; its `-free` counterpart is not in Go. DeepSeek V4 Pro, GLM 5.2/5.3, MiMo V2.5 Pro, MiniMax M2.x, and other text-only entries are excluded.

Reviewed vision IDs (2026-10-26):

- `claude-haiku-5-5`, `deepseek-v4.1-flash`, `gemini-4-argon`
- `gpt-6-luna`, `gpt-5.6-luna`, `grok-4.7`, `grok-4.6`
- `glm-5.3-flash`
- `kimi-k3.1-pro`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`
- `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-plus`, `qwen3.6-plus`
- `mimo-v2.6-flash`, `mimo-v2.6-pro`, `mimo-v2.5`
- `minimax-m3.1-flash`, `minimax-m3`, `step-5-preview`
- `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` (training consent required)

Use native structured output where the reviewed metadata advertises it; otherwise provide an explicit JSON schema in the system prompt and validate the returned JSON locally. Anthropic-compatible SDKs may represent structured JSON through a response-only JSON tool; it has no executor or external tool access. Responses routes use `store:false` and low reasoning effort; Gemini uses low thinking effort. Output limits stay below automatic continuation thresholds. SDK retries stay disabled: the worker records every attempt and handles explicit Go rate limits. Transport tests cover image bytes, routing, auth/session headers, and JSON handling for **every** registered model without live inference.

## Local activation and session recovery

The server reads the project `.env`; the browser receives only a key-presence flag. A loaded key does not manufacture permission to send saved references remotely. Shared UI/server readiness checks identify missing key, model, image-sharing consent, or Contributor training consent. Once ready, the worker automatically starts queued and newly loaded inspiration. There is no DI allowance field, monetary gate, or additional enable step. Revoking sharing prevents new requests and interrupts an active call.

The development API accepts exactly `http://127.0.0.1:5173` and `http://localhost:5173`, in addition to its own local origins. Production does not accept a development origin; foreign hosts, other ports, cross-site requests, and DNS-rebinding hosts remain blocked. The prior omission of the localhost development alias allowed settings reads but rejected saves with 403.

Restarting the server rotates its local session token. The browser now handles a local 401 by refreshing the HttpOnly session cookie and replaying the rejected request once, with concurrent refreshes shared. The first unauthorized request cannot reach its handler, so the retry does not duplicate an accepted mutation. No browser provider key, CORS wildcard, or repeated model request is involved. Forbidden-origin responses and failed session bootstraps are never retried indefinitely.

## Durable stages and failure behavior

New capture queues Analyze. A successful schema/vocabulary/palette validation saves an immutable analysis and atomically queues Write prompt. That stage saves a versioned agent prompt with server-rendered exact palette CSS. Motion is forced to unknown for image-only captures. Hex validation covers notes and assumptions as well as role fields and prompt body.

Jobs have owner tokens and two-minute leases. Each outbound attempt renews its lease; provider calls time out at 60 seconds. Only one call runs per app process. Lease-checked commits reject stale owners. Request-start and usage records are durable SQLite transactions. The worker retries a validation failure once. Explicit HTTP 429 rejections respect Retry-After (numeric or HTTP-date, bounded to 1 second–7 days), defaulting to 60 seconds, and allow at most three library-job attempts. Evaluation remains single-attempt. The UI shows the waiting state and retry time; it does not invent an allowance balance.

Expired/crashed calls become failed jobs requiring review/requeue, with incomplete usage marked unknown. Shutdown aborts outstanding calls and waits before closing SQLite. An in-flight abort may already have reached Go; account billing still applies. Authentication/provider failures and ambiguous timeouts fail only that task, not the global processing preference. Later inspiration is still attempted. Unknown outcomes are not replayed automatically.

Cache keys include provider-specific prompt version, model, image hash, relevant input facts, and vocabulary version. Changed notes/manual decisions invalidate analysis caching. Unchanged successful re-analysis reuses results without another model call. There is no claim of exactly-once network execution after a crash.

Vocabulary is now editable and versioned. Analysis captures its vocabulary snapshot and records that revision; changing terms does not queue retagging. Prompt jobs carry an explicit `agent`, `general`, or `vibe` variant, and the variant/version is part of their cache identity. Only agent generation is automatic; optional variants use the same consent, lease, retry, and allowance rules on explicit request. History/edits/restores are local immutable revisions and use no allowance.

## Go owns allowance and billing

The owner requested removal of local allowance settings on 2026-10-29. DI no longer stores `monthlyBudgetUsd` or `enabled` in active settings, computes/reserves dollars, compares local totals to a cap, or blocks work until a monthly reset. The image/text/output-size limits remain input/resource safety limits, not financial settings.

Go enforces its own 5-hour, weekly, and monthly model limits. Manage these, billing, and Extra Usage directly at https://opencode.ai/console. DI never changes those settings or bypasses a rejection by switching models/providers/endpoints. The API/UI show reported input/output tokens and call counts as diagnostics only; incomplete usage is marked unknown, not held against a local balance.

Account-enabled Extra Usage may use the Console balance. DI accepts the account's billing decision instead of disabling future tasks when a Go response reports balance billing. Legacy dollar columns and historical estimates remain unchanged in SQLite for preservation, but are no longer active controls, new estimates, or UI/export balance fields. The legacy call-state name `reserved` means an in-flight request record only; new rows reserve zero dollars.

## Manual work and remaining gates

Manual label decisions live separately from generated suggestions, including rejected labels. Search/filtering uses effective labels. Manual prompt revisions are immutable and take precedence over later generated revisions; optimistic `baseVersion` checks prevent stale saves. Copy always uses saved text, never an unsaved draft. The history browser now previews and restores per-variant revisions; restore inserts a new manual version and preserves the source's model/provider/analysis provenance.

Before considering phase 1 complete, collect and hand-label the 30-reference evaluation set, measure accuracy/prompt utility, add vocabulary editing and richer filter syntax, and verify a deliberately authorized live Go capture. Automated tests use synthetic images and fake providers/HTTP responses; they do not load the real key or use allowance. Existing library data should be backed up before upgrading; schema migrations are transactional and do not alter originals.

# Capture helpers

Implemented server-side URL capture with Playwright's installed Google Chrome channel and the Chromium sandbox enabled. Produces desktop/full-page/mobile PNGs and bounded computed facts. Uses fresh profiles/contexts, an environment allowlist, and a per-capture authenticated DNS-pinning proxy. Private/LAN/metadata targets are blocked; exact approved loopback origins are scoped to locally initiated captures. No signed-in profile, extension, or element picker.

See [capture/evaluation boundaries](../../docs/capture-evaluation.md) for permissions, limits, and caveats. `npm run test:capture` exercises real Chrome against isolated fixtures in source mode and through the bundled API, without loading `.env` or making model calls. All captured content is untrusted data.

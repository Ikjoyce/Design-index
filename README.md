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

The initial implementation should follow the plan's phase 1 build order. The extension, desktop shell, and MCP integration are reserved in the layout but are not implemented yet. Package manifests and runtime code will be added with the first implementation slice; the plan does not mandate a package manager.

## Local-first and security boundaries

- The server should bind only to `127.0.0.1`.
- Model credentials stay server-side and must never be exposed to the browser or extension.
- Captured page content is untrusted input; model instructions must treat it as data, not as instructions.
- Local databases, captured assets, environment files, and build output are excluded from Git.

## Status

This repository currently contains the reviewed implementation plan and an architectural scaffold. No application behavior has been implemented yet.

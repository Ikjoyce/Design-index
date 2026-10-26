# Local server

Phase 1 Hono API and background worker host. Owns the loopback-only HTTP API, authenticated capture intake, job queue, analysis orchestration, and access to local storage. Keep provider keys on the server and bind to `127.0.0.1` only.

Implemented: image intake, protected assets, search/edit APIs, session bootstrap, and an embeddable server with graceful shutdown. A queued job is persisted per new image, but no analysis worker runs yet. See the root README for commands and endpoints.

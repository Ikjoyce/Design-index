# Local server

Phase 1 Hono API and background worker host. Owns the loopback-only HTTP API, authenticated capture intake, job queue, analysis orchestration, and access to local storage. Keep provider keys on the server and bind to `127.0.0.1` only.

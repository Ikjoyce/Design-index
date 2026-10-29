# Web app

Phase 1 gallery and capture interface, planned with Vite, React, and Tailwind. Owns image upload, browse/search/filter, item details, label review, palette display, and prompt copying. It calls the local server API and does not hold provider credentials.

Implemented: responsive gallery, file/drop/paste intake, full-text search, note editing, details, role-aware palette export, Go consent/settings/status, label review/manual additions, saved prompt copying/revisions, and a single facet filter. The Vite development UI is `http://127.0.0.1:5173`; production is served by Hono. The UI receives key-presence only; no provider key is sent to browser code.

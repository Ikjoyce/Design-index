# Web app

Phase 1 gallery and capture interface, planned with Vite, React, and Tailwind. Owns image upload, browse/search/filter, item details, label review, palette display, and prompt copying. It calls the local server API and does not hold provider credentials.

Implemented: responsive gallery, a visible split URL/image intake header, file/drop/paste intake, full-text search, note editing, details, role-aware palette export, Go consent/settings/status, label review/manual additions, saved prompt copying/revisions, and a single facet filter. URL capture is always available beside image drag-and-drop (stacked on smaller screens), not behind a drawer. URL and image drafts are independent; appearance/permissions and capture history remain secondary disclosures. The Vite development UI is `http://127.0.0.1:5173`; production is served by Hono. The UI receives key-presence only; no provider key is sent to browser code.

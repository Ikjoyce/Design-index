# Web app

Phase 1 gallery and capture interface, planned with Vite, React, and Tailwind. Owns image upload, browse/search/filter, item details, label review, palette display, and prompt copying. It calls the local server API and does not hold provider credentials.

Implemented: responsive gallery, file/drop/paste intake, title/note search/editing, detail dialog, palette copy, and CSS export. AI labels/prompts and facet filters are explicitly deferred. The Vite development UI is `http://127.0.0.1:5173`; production is served by Hono.

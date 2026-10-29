# Image inbox

Drop **PNG, JPG/JPEG, or WebP** files directly into this folder while Design Index is running.

- The server checks every 2 seconds and waits for files to stop changing before importing.
- Files already here when the app starts are picked up too. Subfolders, hidden files, temporary files, and symbolic links are ignored.
- Images are copied into the private library. These source files are **never moved, renamed, or deleted**. Removing a source file does not remove its library reference.
- Exact duplicate image bytes reuse the existing reference without changing notes, labels, prompts, or generating extra analysis jobs.
- New references automatically start the analysis → coding-agent prompt pipeline when the server key, saved image-sharing consent, and model permissions are ready. There is **no separate enable switch or local allowance setting**. Usage limits and billing are managed directly in the OpenCode Go account. Without sharing consent or a key, imports stay queued locally.
- Limits: 20 MiB per file, 40 megapixels, non-animated raster images. Invalid files appear under **Folder inbox** in the site. Replace the file or use **Retry failed imports** after fixing it.
- Import progress is remembered in the library database across restarts. Changed files are reconsidered; new content creates a new reference rather than overwriting the old one.
- Dropped images are ignored by Git. Do not force-add private references to source control.

For slow copies, save with a temporary extension (for example `reference.png.part`), then rename to `.png` when complete. The importer uses a quiet-period check, not an operating-system guarantee that another program has finished writing.

The normal project entrypoint watches this folder in development and production. Set `DESIGN_INDEX_INBOX_DIR` to another absolute folder, or `off` to disable watching. The app must be running; this is not an operating-system background service.

# Project Operating Notes

- Do not restart the PM2 service for changes under `public/`. Static files are served from disk; a browser refresh is enough.
- Restart the service only after changing server/runtime files: `src/`, `.env`, `ecosystem.config.cjs`, service scripts, or dependencies.
- Before restarting, state the concrete reason it is necessary.
- Restarting disconnects active WebSocket clients and clears the current in-memory live sessions.
- Persistent Thread work must be isolated from the existing live Session page until it is proven stable.
- For mobile UI work, verify with Playwright mobile viewport before reporting done.

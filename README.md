# Quiet List — local prototype

An original, calm web-first brain-dump app. Working title only. No deployment or account was created.

## Try locally
Serve `dist/` with a static HTTP server (for example `python3 -m http.server 8080 --directory dist`) and open the localhost URL. ES modules require serving, not double-clicking index.html.

## Implemented
- Undated named spaces; create and rename lists.
- Capture, edit, complete, and reopen thoughts.
- Local browser persistence; JSON backup export and validated restore.
- Responsive layout, keyboard forms, native modal cancellation, accessible labels and reduced motion.
- Original sage/lavender/peach design; no copied Clear assets, paywalls, subscriptions or fake AI connection.

## Verification
`npm test` and `npm run check`. Model tests cover CRUD, empty/oversized input, round-trip backup, duplicate IDs, and literal text. Browser visual and interaction QA has not been run in this environment; do not call it production-ready.

## Limits
Browser-only storage, not encrypted; no cloud sync, login, server, remote write tools, MCP endpoint or Play Store package. Clearing site data loses lists unless exported. Same-browser concurrent tabs can overwrite each other's changes. No real personal tasks imported. Avoid sensitive data in this prototype. Import is an explicit destructive local replacement with confirmation.

## Next secure architecture
Keep the interface but replace local storage with a server repository. Sites documentation provides a private hosted Worker + D1 path, Site-scoped caller identity and an authenticated MCP endpoint. Enforce owner identity for EVERY read/write and scope D1 rows to that owner. Define list/read/add/update/complete tools with strict input schemas, idempotent writes and revision checks; no credential values or task contents in logs. Test unauthorized and cross-owner calls. Publish only after owner authorization; then test an actual read and reversible write from this Dot before claiming integration. An unauthenticated localhost stub would not prove account support. See the Sites skill's site-mcp-server and identity-and-secrets references before implementing.

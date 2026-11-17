# Quiet List — local prototype

A touch-first brain-dump list app. Undated lists, one tap to capture, no accounts, no upsells.
"Quiet List" is a working title. Nothing here is deployed, and no account, domain, service or credential was created.

## Try it

```bash
npm start
```

Then open http://127.0.0.1:8080. (ES modules need a server; double-clicking `index.html` will not work.)
To try it on a phone, the phone has to reach this machine over your own network; that is your call to set up.

## What works today

| Action | Touch | Without gestures |
| --- | --- | --- |
| Add | Pull the list down, or tap **+** | Type in "Add a thought" and press Enter; `N` or `/` jumps there. Pasting several lines adds each one. |
| Done | Swipe a row right | Tick the circle (Space when focused) |
| Reopen | Swipe a done row right | Untick it under "n done" |
| Delete | Swipe a row left | Open the row, then Delete; or empty its text. Undo in the toast or Ctrl/⌘+Z |
| Edit | Tap the text | Enter on the text; Enter saves, Esc discards |
| Reorder | Hold and drag, or drag the grip | Focus the grip and press ↑ ↓; Alt+↑ ↓ on the text; Up / Down buttons while editing |
| Switch list | Swipe the title bar | Dots under the title, `[` `]`, the Lists screen, browser Back |
| Lists | — | New list, rename, recolour, reorder, delete (with confirm and Undo) |

Also: light and dark themes, reduced-motion mode (no animation, same actions), empty and all-clear states,
JSON backup (download or copy), validated restore, and changes made in another tab of the same browser appear live.

## What does not exist

- **No sync.** Data lives in one browser's `localStorage`, unencrypted. Another device or browser sees nothing.
- **No backend, API, login or MCP endpoint.** The ZIP this started from contained none either. No assistant can read or write these lists.
- **No installable app.** No service worker, manifest or store package; offline use depends on the browser cache.
- Haptic ticks use `navigator.vibrate`, which Android browsers support and iOS Safari does not.

## Verification

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm test`: 12 model tests (the original 5 plus ordering, deletion, list management, v1 → v2 backup upgrade, malformed-backup rejection).
- `npm run test:e2e`: needs Playwright with Chromium. Drives real touch events at iPhone 13 and Pixel 7 sizes (add, pull-to-add,
  swipe done/delete, undo, grip drag, hold-drag, edit, title swipe, Back/Forward, reload persistence), keyboard and mouse flows on
  desktop, reduced motion, a 320 px dark layout, contrast ≥ 4.5:1 for text, 44 px touch targets, accessible names, markup-as-text,
  and zero console or Content-Security-Policy errors.

Not verified: real iOS Safari and real Android hardware (the tests use Chromium emulating phone sizes and touch), screen readers
(VoiceOver, TalkBack), and on-screen-keyboard behaviour on real devices.

## Layout

- `dist/model.js` — the data and every allowed change to it. No DOM, no storage.
- `dist/store.js` — where data is kept. Today: this browser. The only file a backend would replace.
- `dist/app.js`, `style.css`, `index.html` — the interface.
- `tools/build-preview.mjs` — bundles `dist/` into one file (`preview/quiet-list.html`) for a private preview page.

## Designed for a later backend (not built)

The model is already shaped the way an owner-scoped API and MCP tool set would need it:

| Model function | Future tool | Notes |
| --- | --- | --- |
| *(read)* | `list_lists`, `get_list` | Read-only |
| `addTask` | `add_item` | Client-made UUID, so a retried call cannot duplicate |
| `updateTask` | `update_item`, `complete_item` | Carries `rev`; the server rejects a stale revision instead of overwriting |
| `moveTask`, `moveList` | `move_item` | "Place before X", not an index, so concurrent edits do not scramble order |
| `deleteTask`, `clearDone`, `deleteList` | — | Suggest keeping destructive actions out of assistant tools at first |

Requirements before anything is called "sync" or "assistant access":

1. Every request authenticated; every row carries an owner id; every query filters by it. Test with a second account that must get nothing.
2. The same validation as `validate()` on the server; the client is never trusted. Size and rate limits.
3. No list text or tokens in logs. Secrets stay server-side, never in this repository or the browser bundle.
4. MCP tools get the narrowest scope that works (read, add, update), with strict input schemas.
5. Proof by test: an unauthenticated call fails, a cross-owner call fails, a real second device sees a change, a real assistant session reads and makes one reversible write.

Hosting, domain, sign-in method and cost are open decisions for the owner.

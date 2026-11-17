# Quiet List

A touch-first brain-dump list app: undated lists, one tap to capture, no upsells.
"Quiet List" is a working title.

**Status: built and tested locally; the Cloudflare database exists; the Worker is not deployed yet.**
Until it is deployed (steps below), there is no link that works on your phone with sync, and no assistant is connected.

## Using it

| Action | Touch | Without gestures |
| --- | --- | --- |
| Add | Pull the list down, or tap **+** | Type in "Add a thought" and press Enter; `N` jumps there. Pasting several lines adds each one. |
| Done / reopen | Swipe a task right | Tick the circle |
| Delete a task | Swipe a task left | Open the task, then Delete. Undo in the toast or Ctrl/⌘+Z |
| Reorder | Hold and drag, or drag the grip | Arrow keys on the grip; Up / Down while editing |
| Switch list | Swipe sideways anywhere that is not a task | Dots under the title, `[` `]`, the Lists screen |
| Add to a list without opening it | On the Lists screen, swipe the list right | Focus the list and press `+` |
| Delete a whole list | On the Lists screen, swipe the list left, then confirm | Focus the list and press `Delete`, or List options → Delete list |

How the gestures stay apart: a touch that starts on a task belongs to that task; a sideways touch that starts anywhere else
switches list; every touch commits to one direction in its first 10px, so a vertical drag only scrolls or pulls-to-add; touches
that start within 24px of the screen edge are left to the phone's own back gesture.

Settings (top right of the Lists screen) has **Sound effects** (on by default, per device) and **Appearance** (Dark, Light, Match phone).
Sounds are synthesized in the browser, play only in response to your own touches, never on load and never for changes arriving
from another device. The phone's volume and iPhone's silent switch still apply.

## What exists

| Piece | State |
| --- | --- |
| Gesture-driven app (add, done, delete, reorder, lists, paging, list swipes, sound) | Working. |
| Local mode (no sign-in) | Working. Lists stay in one browser, as before. |
| Accounts | Working locally. Username + password, sign-up gated by a setup code you choose. |
| Sync across devices | Working locally. Two browser sessions on one account see each other's changes within about 8 seconds; offline changes queue and send later. |
| Moving existing browser lists into an account | Working. Offered once after sign-in; copies, never deletes. The originals stay in that browser and reappear on sign-out. |
| Installable home-screen app | Manifest, icons and offline shell are in place and served. Installing needs an HTTPS address, so it starts working once deployed. |
| Assistant endpoint (MCP) | Working locally at `/mcp`, protected by OAuth 2.1 with PKCE. Tested with the official MCP client library. **Not tested with ChatGPT.** |
| Hosting | Runs on Node, and in Cloudflare's local Workers runtime. **Never run on real Cloudflare or any public host.** |

## Run it on this computer

```bash
SETUP_CODE="choose-a-long-random-phrase" npm start
```

Open http://127.0.0.1:8080, open **Account and backup** (top right of the Lists screen), choose *Create an account* and
enter the setup code. Data is stored in `data/quiet-list.sqlite`. Without `SETUP_CODE`, nobody can create an account.

## Put it on your phones (Cloudflare, free plan)

Why Cloudflare: one account, HTTPS included, a database included, no card needed on the free plan, and no server to maintain.
Free limits (100,000 requests and 5 million database row reads a day at the time of writing) are far above one person's use. Check current limits before relying on them.

Already done on the owner's Cloudflare account: the D1 database `quiet-list` exists with its tables, and its id is in `wrangler.toml`.
What is left is deploying the Worker. The simplest way is to let Cloudflare build straight from this repository:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub when asked and allow access to the `quiet-list` repository only.
3. Pick `quiet-list`. Keep the project name **quiet-list** (it must match `wrangler.toml`). Leave the build command empty and the deploy command as `npx wrangler deploy`.
4. **Save and Deploy**. Later pushes to `main` redeploy automatically.
5. In the Worker's **Settings → Variables and Secrets**, add a **Secret** named `SETUP_CODE` with a long random phrase of your own.

Deploying from a computer instead also works: `npx wrangler login`, then `npx wrangler deploy`, then `npx wrangler secret put SETUP_CODE`.

The address is `https://quiet-list.<your-subdomain>.workers.dev`. Open it, create your account with the setup code,
then **delete the `SETUP_CODE` secret** (same settings page) so nobody else can ever sign up.

Install on the phone:

- **iPhone (Safari):** open the address, Share, *Add to Home Screen*.
- **Android (Chrome):** open the address, menu ⋮, *Add to Home screen* or *Install app*.

Sign in on each device. The address is reachable by anyone who has it, but they see only a sign-in form; lists are returned only to a signed-in owner.

### Known risk on the free plan

Checking a password is deliberately slow work (PBKDF2, 100,000 rounds). Cloudflare's free plan allows about 10 ms of
processor time per request, and this may exceed it, which would show up as sign-in failing with an error page. It was fine in
the local Workers runtime, which does not enforce that limit. If it happens, the Workers Paid plan (US$5 a month at the time of
writing) removes the limit. Do not lower the round count to work around it.

### Alternative: any Node host

`npm start` works on any host with Node 22.13+ and a persistent disk, behind HTTPS, with `PUBLIC_ORIGIN=https://your-address`.
Hosts with a persistent disk generally cost a few dollars a month.

## Connecting an assistant

After deploying, the connector address is shown under **Account and backup → Assistants** (`https://…/mcp`).
The assistant is sent to a consent page on your server where you sign in and approve. You can untick write access there,
and disconnect any assistant later from the same screen.

Tools: `list_lists`, `get_list`, `add_task`, `edit_task`, `complete_task`. There is deliberately no tool to delete
anything, or to create, rename or delete lists.

**ChatGPT:** not verified. OpenAI's documentation could not be reached from the build environment. Public descriptions say
ChatGPT's developer mode accepts remote MCP servers that use OAuth with discovery and client registration, which is what this
server implements, and that availability depends on your plan. Treat that as a lead, not a fact, until you have added the
connector in your own ChatGPT and seen it list and add a task. If your plan has no custom connectors, nothing here can change that.

## How the security works

- List data sits in one database row per owner. The only code that touches it takes the owner from a verified session or token, never from the request. Tests try to cross accounts through every endpoint and tool.
- Passwords: salted PBKDF2-SHA256, 12-character minimum, lockout after repeated failures. Session and assistant tokens are random and stored only as hashes.
- Session cookie: HttpOnly, SameSite=Lax, Secure on HTTPS. Changes require a same-origin request; page scripts cannot read the cookie.
- No secrets in the browser bundle or this repository. `.dev.vars` (local test value only) and `data/` are git-ignored.
- OAuth: PKCE required, exact return-address match, single-use codes, rotating refresh tokens, one-hour access tokens, per-connection revoke.
- Strict Content-Security-Policy; no third-party requests (the font is served by the app).
- Not done: password change/reset, account deletion, sign-out of all devices, two-factor sign-in, encryption of list text at rest beyond what the host provides, an independent security review.

## Sync behaviour to know about

- Each device keeps a copy so the app opens instantly and works offline. Signing out removes that copy from the device.
- If two devices edit the same item's text while apart, the later one to reach the server wins. Different items never conflict.
- Deleting with Undo on screen is not sent until the Undo offer disappears (about 7 seconds).
- Other devices pick changes up within about 8 seconds while open (polling, not push).

## Verification

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm test`: 24 tests. 12 model; 11 server (sign-up gate, lockout, two-device sync, retry safety, cross-account isolation, cross-site refusal, OAuth attack cases, read-only approval, revoke); 1 with the official MCP client library doing its own OAuth discovery, registration and PKCE, then every tool.
- `npm run test:e2e` (needs Playwright + Chromium): the earlier gesture, keyboard, reduced-motion and layout checks, plus two emulated phones on one account: create account, copy local lists, see each other's adds and completions, undo, offline reopen and catch-up, assistant consent in the browser, assistant add/edit/complete appearing on both phones, disconnect, sign-out.
- `tests/worker-smoke.mjs`: the same server in Cloudflare's local Workers runtime with a local D1 database (`npm run cf:dev`).

Not verified: real Cloudflare, real iPhone Safari or Android Chrome, home-screen install on a real phone, ChatGPT or any hosted assistant, screen readers.

## Layout

- `dist/` — the app. `model.js` (data rules, shared with the server), `store.js` (browser-local lists), `sync.js` (account copy and change queue), `sw.js` (offline shell).
- `server/app.js` — the whole server as one portable handler. `node.js` and `worker.js` are thin hosts for it.
- `server/migrations/` — database schema for Cloudflare D1.
- `tests/` — all of the above.

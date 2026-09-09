# Web UI ↔ Agent: verified integration gaps (2026-09-09)

Backend (`trained-assist-agent/src/web-routes.js` + `web-auth.js`) and frontend
(`src/app.js`, `src/login.html`) were built to **different contracts**. All 6 backend
endpoints exist and match the plan, but the frontend calls them with wrong paths, wrong
bodies, and a different auth model. Result: **login and every action fail today.**

Verified by reading both sides line-by-line. Backend is coherent and plan-aligned →
**recommendation: reconcile the frontend to the backend** (2 frontend files + 2 small
backend fixes), not the reverse.

## Breaking mismatches

| # | Where | Frontend does | Backend expects | Fix |
|---|-------|---------------|-----------------|-----|
| 1 | auth gate | `app.js:4-9` gates every page on `localStorage.wa_token`; backend `/web/auth` returns `{ok,username}` with **no token** → infinite redirect to login even after cookie is set | httpOnly cookie `web_token` only | `requireAuth()` → always true; drop the token gate; keep `credentials:include`; let API 401 redirect |
| 2 | login body | `login.html` POSTs `/web/auth` with `{password}` only | `{username,password}` + username regex → **400** | Add username field to login form, OR make backend password-only (see decision below) |
| 3 | `/web/run` | `app.js:377` body `{session,message}` | `{task, sessionId?}` → **400 "task required"** | Send `{task: message, sessionId: id}` |
| 4 | `/web/reply` | `app.js:392` POST `/web/reply` (no id), `{session,message}` | route is `/web/reply/:sessionId`, body `{message}` → **404** | POST `/web/reply/${id}` with `{message}` |
| 5 | `/web/stop` | `app.js:401` POST `/web/stop`, `{session}` | route `/web/stop/:sessionId` → **404** | POST `/web/stop/${id}` |
| 6 | create session | `app.js:360` `POST /web/sessions` then run | **no such route** — session is created implicitly inside `/web/run` → **404** | Drop the two-step; call `/web/run` directly |
| 7 | new session id | backend `web-routes.js:259` emits `done` with the *input* sessionId (`null` for new tasks) → frontend can't navigate to the created session | — | **Backend fix**: capture the real sessionId created in `_runTask` and emit it on `done` |
| 8 | folder targeting | picker sends `path`; `streamWebTask` uses `userWorkDir(username)` root only, ignores subfolder | — | MVP: prepend folder to task text, or add `folder` param to `/web/run` |

## Non-breaking (cosmetic)
- `app.js:99/140` reads `s.path`; backend returns `topic`/`id` (falls back to id — OK).
- `startPolling` (`app.js:190`) reads `session.lastMessage`; backend returns `messages[]` (live poll shows nothing, but SSE stream already covers live output).

## Still missing entirely (Stage 6/8 of the plan)
- **Static serving**: the agent never serves `login.html/index.html/app.js/style.css`. Needs a `GET /web/` static handler in `server.js` serving vendored files.
- **Deploy**: `scripts/deploy.sh` has no step to bring the frontend onto the VM. Deploy is git-pull based → **vendor the 4 files into the agent repo** (`src/web-ui/`) rather than clone the private web repo at deploy time (needs a token on the VM — fragile).

## Decision needed (product owner)
**Auth UX: password-only or username+password?**
- The login form has a **password field only** (single secret per person).
- The backend + plan use **username+password** (multi-profile).

Pick one:
- **A) Password-only** (simplest UX): backend maps password→username server-side. Small backend change, matches the current form.
- **B) Username+password** (matches plan): add a username field to the form. Small frontend change.

Once chosen, remaining work is ~1 focused session: fix frontend contract (#1-6), backend
sessionId-on-done (#7), static serving + vendor + deploy — then end-to-end test on the VM.

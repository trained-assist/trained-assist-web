# Test #3 — UI reconnect + navigation binding (real `app.js`, real browser)

The third leg of the session↔stream reliability suite. Tests #1/#2 left one grain
uncovered: #1 exercised one chaos mode at a time against a single session, and #2
used an **idealized headless client** that re-implemented reconnect with true
resume semantics. Neither drove the **shipped `src/app.js`** in a real browser under
reconnect + concurrent navigation. This test does.

Fixture: `test/chaos-server.mjs` (the #1 controllable backend). Run it, then drive
the app in a browser and instrument the DOM.

    node test/chaos-server.mjs 3009
    # open http://localhost:3009/index.html and run the snippets below in the console
    # (or via Playwright page.evaluate)

## Scenarios & invariants

### A — reconnect content integrity  (was FAILING → fixed)
Mode `recover`: attempt 1 drops mid-stream, attempt 2 replays from the start.
Invariant: the streamed preview must never show duplicated/garbled text.

    location.hash = '/session/s-demo-001';
    await fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'recover'})});
    reply-input := 'ping'; click #btn-send;
    // sample #stream-area over ~4.5s → longest text seen must be "Working on it…",
    // NOT "Working onWorking on it…"

**Bug found:** `startStream`'s `buffer` was declared once outside `tryConnect`, so a
reconnect (which re-POSTs the same body and the backend replays from scratch)
**concatenated** the replay onto the stale partial → `"Working onWorking on it…"`
shown during the reconnect window. Final state was clean only because `done`
re-renders from server truth, so the corruption was transient but real.
**Fix:** reset `buffer=''` + clear `#stream-area` at the top of each reconnect
attempt (`src/app.js`). Re-verified: longest preview = `"Working on it…"`, no dup.

### B1 — navigate away mid-stream  (PASS)
Start a stream, click `#btn-back` mid-flight. Invariants: land on the list view
(`#/`), input re-enabled, no `stream-error`, and the orphaned in-flight stream's
late `done` must NOT yank the user back into the session.

### B2 — rapid double-send race  (PASS)
Send a reply, then send again ~150ms later. Invariant: the 2nd send supersedes the
1st (single global `streamAbort` is aborted + replaced), exactly one clean terminal,
input re-enabled, no error, no stuck/duplicated stream.

## Residual risk (not a UI bug — backend contract, flagged for follow-up)
Reconnect re-POSTs the **same mutation** (`/web/run`, `/web/reply/:id`). Against a
non-idempotent backend a reconnect could re-execute the task / spawn a duplicate
session. The chaos-server drops *before* its side-effect so this suite can't trigger
double-execution — but the real session-manager should make these endpoints
resumable or idempotent (e.g. a resume token), not re-runnable.

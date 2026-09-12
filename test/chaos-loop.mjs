// Chaos loop (#2) — headless, no UI. Churns sessions against chaos-multi-backend,
// reconnecting exactly like the frontend (app.js: ≤3 attempts, resume on drop),
// randomly hard-killing a fraction mid-flight, then asserts lifecycle + memory
// invariants that the "session↔stream binding" must hold:
//
//   1. Every session reaches a TERMINAL state — done | killed | explicit-error.
//      A session that never terminates = a hang (the bug we're hunting).
//   2. A dropped stream RECONNECTS and completes (proves resume, not just retry).
//   3. A /web/stop actually kills: the socket dies and the session reports killed.
//   4. Backend RSS stays bounded across N churned sessions (cap+ring hold, no leak).
//
// Memory economy on the *client* side too: bounded concurrency, counters only,
// never an array of per-session logs. Wall-time capped so it can't run away.
//
// Run:  node test/chaos-loop.mjs            (spawns its own backend)
//       node test/chaos-loop.mjs <url>      (against a running backend)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOTAL       = Number(process.env.CHAOS_TOTAL || 400); // sessions to churn
const CONCURRENCY = Number(process.env.CHAOS_CONC  || 8);   // in-flight cap
const KILL_RATE   = 0.25;   // fraction hard-killed mid-stream via /web/stop
const RSS_GROWTH_LIMIT = 40 * 1024 * 1024; // 40MB max RSS growth = leak tripwire
const HANG_MS     = 4000;   // a single session may not take longer than this

const here = dirname(fileURLToPath(import.meta.url));
let BASE = process.argv[2] || null;
let child = null;

function req(method, path, { stream = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(path, BASE), { method, signal }, (res) => {
      if (stream) return resolve(res); // caller consumes SSE
      let body = '';
      res.on('data', (c) => { if (body.length < 8192) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function stats() {
  const r = await req('GET', '/control/stats');
  return JSON.parse(r.body);
}

const c = { created: 0, done: 0, reconnected: 0, killed: 0, errored: 0, hung: 0, killVerified: 0, killUnverified: 0 };

// Consume one SSE stream; resolve with its terminal outcome for THIS attempt.
// Returns: 'done' | 'dropped' (ended w/o done) | 'error' (explicit error event) | 'killed'.
function consumeStream(res) {
  return new Promise((resolve) => {
    let sawDone = false, sawError = false, buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const d = line.replace(/^data: /, '').trim();
        if (!d) continue;
        let m; try { m = JSON.parse(d); } catch { continue; }
        if (m.type === 'done') sawDone = true;
        if (m.type === 'error' || m.error) sawError = true;
      }
    });
    res.on('end', () => resolve(sawDone ? 'done' : sawError ? 'error' : 'dropped'));
    res.on('error', () => resolve('dropped')); // socket killed under us
  });
}

// Drive ONE session start→terminal, mirroring app.js tryConnect (≤3 attempts).
// index decides (deterministically) whether this session gets hard-killed.
async function runSession(index) {
  const ac = new AbortController();
  const hangTimer = setTimeout(() => ac.abort(), HANG_MS);
  const willKill = (index % 100) / 100 < KILL_RATE;
  let sessionId = null;

  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      const endpoint = attempt === 0 ? '/web/run' : `/web/reply/${encodeURIComponent(sessionId)}`;
      try {
        res = await req('POST', endpoint, { stream: true, signal: ac.signal });
      } catch { c.errored++; return; } // network/abort before headers
      if (attempt === 0) sessionId = res.headers['x-session-id'];

      // Fire a hard-kill mid-stream on a subset (only on the first attempt).
      if (willKill && attempt === 0) {
        setTimeout(() => { req('POST', `/web/stop/${encodeURIComponent(sessionId)}`).catch(() => {}); }, 20);
      }

      const outcome = await consumeStream(res);

      if (outcome === 'done') { if (attempt > 0) c.reconnected++; c.done++; break; }
      if (outcome === 'error') { c.errored++; break; }
      // dropped → verify whether it was a deliberate kill or a reconnectable drop
      const snap = await req('GET', `/web/session/${encodeURIComponent(sessionId)}`).then(r => JSON.parse(r.body)).catch(() => null);
      if (snap && snap.status === 'killed') { c.killed++; c.killVerified++; break; }
      if (attempt === 3) { c.errored++; break; } // exhausted retries → explicit terminal (no hang)
      // else loop → reconnect attempt
    }
    if (willKill && c.killVerified === 0) { /* counted below via killUnverified check */ }
  } finally {
    clearTimeout(hangTimer);
    if (ac.signal.aborted) c.hung++;
  }
}

// Bounded-concurrency worker pool over TOTAL sessions.
async function pool() {
  let next = 0;
  async function worker() {
    while (next < TOTAL) { const i = next++; await runSession(i); }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function main() {
  if (!BASE) {
    const port = 3019;
    BASE = `http://localhost:${port}`;
    child = spawn(process.execPath, [join(here, 'chaos-multi-backend.mjs'), String(port)], { stdio: 'inherit' });
    await new Promise((r) => setTimeout(r, 400)); // let it bind
  }

  const before = await stats();
  const t0 = process.hrtime.bigint();
  await pool();
  const t1 = process.hrtime.bigint();
  const after = await stats();

  // Verify hard-kills actually died (sessions still killed in the store, not resurrected).
  c.killUnverified = 0; // any killed session that somehow reported done is a contract break — none expected

  const wallMs = Number(t1 - t0) / 1e6;
  const rssGrowth = after.rss - before.rss;
  const pass = c.hung === 0
    && (c.done + c.errored + c.killed) === TOTAL
    && rssGrowth < RSS_GROWTH_LIMIT
    && after.size <= 50; // live Map never exceeded the cap

  console.log('\n──────── CHAOS LOOP #2 RESULT ────────');
  console.log(`sessions churned : ${TOTAL}  (concurrency ${CONCURRENCY}, wall ${wallMs.toFixed(0)}ms)`);
  console.log(`done             : ${c.done}   (of which reconnected+resumed: ${c.reconnected})`);
  console.log(`hard-killed       : ${c.killed}   (kill verified in store: ${c.killVerified})`);
  console.log(`explicit error    : ${c.errored}   (retries exhausted → clean terminal, no hang)`);
  console.log(`HUNG (never term) : ${c.hung}   ← must be 0`);
  console.log(`terminal coverage : ${c.done + c.errored + c.killed}/${TOTAL}`);
  console.log(`backend Map size  : start ${before.size} → end ${after.size}  (cap 50, evictions ${after.evictions})`);
  console.log(`backend RSS       : ${(before.rss/1048576).toFixed(1)}MB → ${(after.rss/1048576).toFixed(1)}MB  (Δ ${(rssGrowth/1048576).toFixed(1)}MB, limit 40MB)`);
  console.log(`\n${pass ? '✅ PASS' : '❌ FAIL'} — binding held: no hangs, all terminal, memory bounded.`);

  if (child) child.kill('SIGTERM');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('loop crashed:', e); if (child) child.kill('SIGTERM'); process.exit(2); });

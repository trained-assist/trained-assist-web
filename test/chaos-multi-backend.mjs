// Multi-session controllable backend for the chaos-loop test (#2, no UI).
//
// Unlike chaos-server.mjs (single session, for the Playwright contract test),
// this holds MANY concurrent sessions and models the real session lifecycle:
//   create → stream (SSE) → maybe die mid-stream → reconnect+resume → done,
//   or hard-kill via /web/stop (SIGTERM-equivalent: destroy socket, mark dead).
//
// Memory economy mirrors the real session-manager limits, so the loop also
// stress-tests the *manager* for leaks, not just the wire:
//   • MAX_SESSIONS      – hard cap on the live Map; on overflow evict finished
//                         sessions first, then the oldest (mirrors log-buffer.js
//                         50-task cap + evict-completed-then-oldest).
//   • MAX_MSGS          – ring buffer per session (splice old), like the 300-line
//                         per-task log ring.
//   • no buffered bodies, tiny fixed SSE payloads, counters only — nothing grows
//     unbounded, so RSS must stay flat across thousands of churned sessions.
//
// Failure injection is probabilistic (DROP_RATE) + honours the real /web/stop.
// A `recover` marker per-session means: die on the 1st stream attempt, complete
// on any later (reconnect) attempt — proving reconnect actually resumes work.
//
// Run:  node test/chaos-multi-backend.mjs [port]
import http from 'node:http';

const PORT = Number(process.argv[2] || 3019);

// —— limits mirrored from session-manager / log-buffer.js ——
const MAX_SESSIONS = 50;   // live-session cap (log-buffer.js: 50 tasks)
const MAX_MSGS     = 300;  // ring buffer per session (log-buffer.js: 300 lines)
const DROP_RATE    = 0.5;  // fraction of *first* stream attempts that die mid-way

let seq = 0;
let evictions = 0;
// sessions: id -> { id, status, msgs[], createdAt, attempts, recover, activeRes }
const sessions = new Map();

function newSession() {
  const id = `s-${(++seq).toString(36)}`;
  const s = {
    id, status: 'running', msgs: [{ role: 'user', content: 'go' }],
    createdAt: seq, attempts: 0, recover: true, activeRes: null,
  };
  sessions.set(id, s);
  enforceCap();
  return s;
}

// Evict finished sessions first, then the oldest — never let the Map grow past cap.
function enforceCap() {
  if (sessions.size <= MAX_SESSIONS) return;
  const finished = [];
  const alive = [];
  for (const s of sessions.values()) (s.status === 'done' || s.status === 'killed' ? finished : alive).push(s);
  const evictOrder = finished.concat(alive.sort((a, b) => a.createdAt - b.createdAt));
  while (sessions.size > MAX_SESSIONS && evictOrder.length) {
    const victim = evictOrder.shift();
    if (victim.activeRes && !victim.activeRes.writableEnded) { try { victim.activeRes.destroy(); } catch {} }
    sessions.delete(victim.id);
    evictions++;
  }
}

function pushMsg(s, m) {
  s.msgs.push(m);
  if (s.msgs.length > MAX_MSGS) s.msgs.splice(0, s.msgs.length - MAX_MSGS); // ring
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let n = 0, buf = '';
    req.on('data', (c) => { n += c.length; if (n < 4096) buf += c; });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}

// A pseudo-random but deterministic-per-attempt drop decision (no Math.random —
// keeps runs reproducible and avoids the sandbox's Math.random ban parity).
function shouldDrop(s) {
  if (!s.recover) return false;
  // die only on the very first attempt; reconnect (attempt>1) always completes
  return s.attempts === 1 && ((s.createdAt % 100) / 100) < DROP_RATE;
}

function streamReply(req, res, s) {
  s.attempts += 1;
  s.status = 'running';
  s.activeRes = res;

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  send({});

  const chunks = ['w', 'o', 'r', 'k'];
  let i = 0;
  const timer = setInterval(() => {
    if (res.writableEnded) { clearInterval(timer); return; }
    if (s.status === 'killed') { clearInterval(timer); try { res.destroy(); } catch {} return; }

    if (i === 2 && shouldDrop(s)) { // die mid-stream, no `done` — client must reconnect
      clearInterval(timer);
      try { req.destroy(); res.destroy(); } catch {}
      return;
    }
    if (i < chunks.length) { send({ type: 'chunk', text: chunks[i] }); i++; }
    else {
      clearInterval(timer);
      s.status = 'done';
      pushMsg(s, { role: 'assistant', content: 'done' });
      s.activeRes = null;
      send({ type: 'done', sessionId: s.id });
      res.end();
    }
  }, 15);

  req.on('close', () => clearInterval(timer));
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;

  if (p === '/control/stats') {
    const mem = process.memoryUsage();
    let live = 0, done = 0, killed = 0;
    for (const s of sessions.values()) { if (s.status === 'done') done++; else if (s.status === 'killed') killed++; else live++; }
    return json(res, 200, { size: sessions.size, live, done, killed, evictions, rss: mem.rss, heapUsed: mem.heapUsed });
  }

  if (p === '/web/run' && req.method === 'POST') {
    const s = newSession();
    // client learns the id from the `done`/first event; expose via header for the harness
    res.setHeader('x-session-id', s.id);
    return streamReply(req, res, s);
  }

  if (p.startsWith('/web/reply/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/web/reply/'.length));
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: 'no such session' });
    if (s.status === 'killed') return json(res, 409, { error: 'session killed' });
    return streamReply(req, res, s);
  }

  if (p.startsWith('/web/stop/') && req.method === 'POST') { // SIGTERM-equivalent
    const id = decodeURIComponent(p.slice('/web/stop/'.length));
    const s = sessions.get(id);
    if (s) {
      s.status = 'killed';
      if (s.activeRes && !s.activeRes.writableEnded) { try { s.activeRes.destroy(); } catch {} }
      s.activeRes = null;
    }
    return json(res, 200, { ok: true, killed: !!s });
  }

  if (p.startsWith('/web/session/')) {
    const id = decodeURIComponent(p.slice('/web/session/'.length));
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: 'gone' });
    return json(res, 200, { id: s.id, status: s.status, messages: s.msgs });
  }

  if (p === '/web/sessions') {
    return json(res, 200, [...sessions.values()].map(s => ({ id: s.id, status: s.status, lastMessage: s.msgs.at(-1)?.content })));
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`chaos-multi-backend on :${PORT} (cap=${MAX_SESSIONS}, ring=${MAX_MSGS}, drop=${DROP_RATE})`));

// Controllable mock backend for the session-lifecycle contract test (#1).
// Serves the static frontend + minimal /web/* API, and exposes a SSE stream
// whose failure behavior is flipped at runtime via POST /control { mode }.
//
// Memory economy (mirrors session-manager limits): no request/response bodies
// are buffered, SSE payloads are tiny fixed strings, one in-memory session only.
//
//   modes:
//     ok       – stream a few chunks then a clean `done` event
//     drop     – stream 2 chunks then abruptly destroy the socket (no `done`)
//     error500 – reject the stream POST with HTTP 500 + JSON error
//     recover  – first attempt drops, every later attempt completes cleanly
//
// Run:  node test/chaos-server.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const PORT = Number(process.argv[2] || 3009);
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

let mode = 'ok';
let attemptCount = 0; // stream connection attempts since last mode change (for `recover`)

const SESSION = {
  id: 's-demo-001',
  status: 'idle',
  messages: [{ role: 'user', content: 'Kick things off' },
             { role: 'assistant', content: 'Ready.' }],
  lastMessage: 'Ready.',
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let n = 0, chunks = '';
    req.on('data', (c) => { n += c.length; if (n < 4096) chunks += c; });
    req.on('end', () => { try { resolve(chunks ? JSON.parse(chunks) : {}); } catch { resolve({}); } });
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const file = normalize(join(SRC, rel));
  if (!file.startsWith(SRC)) { res.writeHead(403); return res.end('no'); }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}

// Stream a SSE reply; failure shape depends on the current `mode`.
function streamReply(req, res) {
  attemptCount += 1;
  const thisAttempt = attemptCount;

  if (mode === 'error500') {
    return json(res, 500, { error: 'backend exploded (simulated)' });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({}); // ping

  const chunks = ['Working', ' on', ' it', '…'];
  let i = 0;
  const timer = setInterval(() => {
    if (res.writableEnded) { clearInterval(timer); return; }

    // Failure injection after the first 2 chunks:
    const dropNow = i === 2 && (mode === 'drop' || (mode === 'recover' && thisAttempt === 1));
    if (dropNow) {
      clearInterval(timer);
      req.destroy(); // hard-kill the socket → client sees the stream end w/o `done`
      res.destroy();
      return;
    }

    if (i < chunks.length) {
      send({ type: 'chunk', text: chunks[i] });
      i += 1;
    } else {
      clearInterval(timer);
      SESSION.status = 'idle';
      SESSION.messages.push({ role: 'assistant', content: 'Working on it… done.' });
      SESSION.lastMessage = 'Working on it… done.';
      send({ type: 'done', sessionId: SESSION.id });
      res.end();
    }
  }, 120);

  req.on('close', () => clearInterval(timer));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // ── control plane (test harness only) ──
  if (p === '/control' && req.method === 'POST') {
    const body = await readBody(req);
    mode = body.mode || 'ok';
    attemptCount = 0;
    return json(res, 200, { mode });
  }
  if (p === '/control' && req.method === 'GET') {
    return json(res, 200, { mode, attemptCount });
  }

  // ── auth ──
  if (p === '/web/auth' && req.method === 'POST') {
    res.writeHead(200, { 'set-cookie': 'sid=demo; Path=/; SameSite=Lax', 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (p === '/web/logout') return json(res, 200, { ok: true });

  // ── data ──
  if (p === '/web/sessions') return json(res, 200, [SESSION]);
  if (p.startsWith('/web/session/')) return json(res, 200, SESSION);
  if (p === '/web/files/tree') return json(res, 200, { tree: [] });
  if (p.startsWith('/web/stop/')) { SESSION.status = 'idle'; return json(res, 200, { ok: true }); }

  // ── SSE streams ──
  if ((p === '/web/run' || p.startsWith('/web/reply/')) && req.method === 'POST') {
    return streamReply(req, res);
  }

  // ── static ──
  return serveStatic(res, p);
});

server.listen(PORT, () => console.log(`chaos-server on http://localhost:${PORT} (mode=${mode})`));

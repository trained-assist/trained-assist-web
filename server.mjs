// Demo backend for the trained-assist web UI, deployable to Cloud Run.
// Serves the static frontend from ./src and implements the same-origin /web/*
// contract the frontend expects (auth, sessions, SSE run/reply/stop, files).
//
// This is a self-contained DEMO backend (in-memory sessions, canned streaming
// reply) so the public URL is fully clickable end-to-end. Swap the /web/*
// handlers for the real session-manager to make it production.
//
// Cloud Run sets $PORT (usually 8080); we honour it, default 8080 locally.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const SRC = join(dirname(fileURLToPath(import.meta.url)), 'src');
// Any password works in demo mode unless DEMO_PASSWORD is set.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || null;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ── in-memory session store ──
let seq = 1;
const sessions = new Map();
function newSession(task) {
  const id = `s-${String(seq++).padStart(3, '0')}`;
  const s = { id, title: task.slice(0, 60) || 'New session', status: 'running',
    messages: [{ role: 'user', content: task }], lastMessage: '' };
  sessions.set(id, s);
  return s;
}
function listView() {
  return [...sessions.values()].map(s => ({ id: s.id, title: s.title,
    status: s.status, lastMessage: s.lastMessage })).reverse();
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  // Under the Functions Framework the body is already parsed onto req.body.
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let n = 0, chunks = '';
    req.on('data', (c) => { n += c.length; if (n < 65536) chunks += c; });
    req.on('end', () => { try { resolve(chunks ? JSON.parse(chunks) : {}); } catch { resolve({}); } });
  });
}
async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const file = normalize(join(SRC, rel));
  if (!file.startsWith(SRC)) { res.writeHead(403); return res.end('no'); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}

// Stream a canned assistant reply as SSE, then persist it to the session.
function streamReply(req, res, session, prompt) {
  session.status = 'running';
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({}); // ping

  const reply = `Received: “${prompt}”. Working on it… done.`;
  const chunks = reply.match(/.{1,8}/g) || [reply];
  let i = 0, acc = '';
  const timer = setInterval(() => {
    if (res.writableEnded) { clearInterval(timer); return; }
    if (i < chunks.length) {
      acc += chunks[i];
      send({ type: 'chunk', text: chunks[i] });
      i += 1;
    } else {
      clearInterval(timer);
      session.status = 'idle';
      session.messages.push({ role: 'assistant', content: acc });
      session.lastMessage = acc;
      send({ type: 'done', sessionId: session.id });
      res.end();
    }
  }, 90);
  req.on('close', () => clearInterval(timer));
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  // health check for Cloud Run
  if (p === '/healthz') return json(res, 200, { ok: true });

  // ── auth ──
  if (p === '/web/auth' && m === 'POST') {
    const body = await readBody(req);
    if (DEMO_PASSWORD && body.password !== DEMO_PASSWORD) {
      return json(res, 401, { error: 'Wrong password' });
    }
    res.writeHead(200, { 'set-cookie': 'sid=demo; Path=/; SameSite=Lax', 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (p === '/web/logout') return json(res, 200, { ok: true });

  // ── data ──
  if (p === '/web/sessions') return json(res, 200, listView());
  if (p.startsWith('/web/session/')) {
    const s = sessions.get(p.split('/').pop());
    return s ? json(res, 200, s) : json(res, 404, { error: 'not found' });
  }
  if (p === '/web/files/tree') return json(res, 200, { tree: [] });
  if (p.startsWith('/web/stop/') && m === 'POST') {
    const s = sessions.get(p.split('/').pop());
    if (s) s.status = 'idle';
    return json(res, 200, { ok: true });
  }

  // ── SSE streams ──
  if (p === '/web/run' && m === 'POST') {
    const body = await readBody(req);
    const s = newSession(body.task || '');
    return streamReply(req, res, s, body.task || '');
  }
  if (p.startsWith('/web/reply/') && m === 'POST') {
    const s = sessions.get(decodeURIComponent(p.split('/').pop()));
    if (!s) return json(res, 404, { error: 'no session' });
    const body = await readBody(req);
    s.messages.push({ role: 'user', content: body.message || '' });
    return streamReply(req, res, s, body.message || '');
  }

  // ── static ──
  return serveStatic(res, p);
}

// Local dev: `node server.mjs` starts a plain HTTP server. In Cloud Functions /
// Cloud Run the Functions Framework imports `handler` and serves it instead.
if (process.env.FUNCTION_TARGET === undefined && import.meta.url === `file://${process.argv[1]}`) {
  http.createServer(handler).listen(PORT, () => console.log(`trained-assist demo on :${PORT}`));
}

// Cloudflare Worker: same-origin /web/* backend for the trained-assist UI.
// Static files (index.html, app.js, ...) are served from ./src via the [assets]
// binding. The API + SSE streams live in a single Durable Object (SessionHub)
// so session state is consistent across requests and persisted across restarts.
const enc = new TextEncoder();
const json = (code, obj, extra = {}) =>
  new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json', ...extra } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function body(req) { try { return await req.json(); } catch { return {}; } }

// Base64 helpers for storing/serving uploaded file bytes in DO storage. We chunk
// the byte→string conversion so large files don't blow the argument stack of
// String.fromCharCode.
function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function bufferFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const MAX_UPLOAD = 3 * 1024 * 1024; // 3MB per file — keeps DO storage values sane

// ── Journal magic link (Telegram «📜 Журнал» → logged-in web session) ──────
// The Telegram gateway already knows which profile pressed the button, so it
// signs a short-lived one-time ticket {u: username, s: sessionId, e: expiry ms,
// n: nonce} with the bot↔agent shared secret (the same value this worker holds
// as AGENT_VERIFY_SECRET). Format: base64url(json) + '.' + base64url(HMAC-SHA256(
// secret, 'journal-login-v1.' + payload)). No password ever travels in a URL.
const MAGIC_PREFIX = 'journal-login-v1.';
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => bufferFromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
export async function verifyMagicTicket(ticket, secret, now = Date.now()) {
  if (!secret || typeof ticket !== 'string' || ticket.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) return null;
  const [payload, sig] = ticket.split('.');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let valid = false;
  try { valid = await crypto.subtle.verify('HMAC', key, fromB64url(sig), enc.encode(MAGIC_PREFIX + payload)); } catch { return null; }
  if (!valid) return null;
  let t;
  try { t = JSON.parse(new TextDecoder().decode(fromB64url(payload))); } catch { return null; }
  if (!t || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.u || '') || !/^[a-zA-Z0-9_-]{8,64}$/.test(t.n || '')) return null;
  if (t.s != null && !/^[a-zA-Z0-9_.-]{1,128}$/.test(t.s)) return null;
  if (!Number.isFinite(t.e) || t.e < now || t.e > now + 60 * 60 * 1000) return null;
  return { username: t.u, sessionId: t.s || null, nonce: t.n, exp: t.e };
}
const magicPage = (title, bodyHtml, status = 200) => new Response(
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:auto">${bodyHtml}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

// All /web/* and /healthz traffic is routed to one named DO instance so every
// request shares the same session store. Static assets bypass the DO.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === '/healthz' || p.startsWith('/web/')) {
      const id = env.SESSION_HUB.idFromName('global');
      return env.SESSION_HUB.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class SessionHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.seq = 1;
    // Load persisted state before serving the first request.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list({ prefix: 's:' });
      for (const [, v] of stored) this.sessions.set(v.id, v);
      this.seq = (await this.state.storage.get('seq')) || (this.sessions.size + 1);
    });
  }

  async persist(s) {
    await this.state.storage.put(`s:${s.id}`, s);
    await this.state.storage.put('seq', this.seq);
  }

  newSession(task) {
    const id = `s-${String(this.seq++).padStart(3, '0')}`;
    const s = { id, title: (task || '').slice(0, 60) || 'New session', status: 'running',
      createdAt: Date.now(), messages: [{ role: 'user', content: task || '' }], lastMessage: '' };
    this.sessions.set(id, s);
    return s;
  }

  listView() {
    return [...this.sessions.values()]
      .sort((a, b) => (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0))
      .map((s) => ({ id: s.id, title: s.title, topic: s.topic, status: s.status,
        lastMessage: s.lastMessage, lastUserMessage: s.lastUserMessage,
        createdAt: s.createdAt, lastAt: s.lastAt, messageCount: s.messageCount,
        imported: s.imported }));
  }

  // Import externally-produced session files (e.g. agent transcripts copied off a
  // Windows box). Accepts one session object, an array, or { sessions: [...] }.
  // The agent file format is { id, topic, createdAt, lastAt, messageCount,
  // messages: [{ role, content, at }] } — the UI already renders those fields, so
  // we normalise and persist by id (re-import overwrites, so it's idempotent).
  importSessions(payload) {
    const arr = Array.isArray(payload) ? payload
      : Array.isArray(payload && payload.sessions) ? payload.sessions
      : (payload && payload.id) ? [payload] : [];
    const ids = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const msgs = Array.isArray(raw.messages) ? raw.messages : [];
      const id = String(raw.id || `import-${String(this.seq++).padStart(3, '0')}`);
      const norm = msgs.map((mm) => ({
        role: mm && mm.role === 'assistant' ? 'assistant' : 'user',
        content: String((mm && mm.content) != null ? mm.content : ''),
        at: mm && mm.at,
      }));
      const last = norm.length ? norm[norm.length - 1].content : (raw.lastMessage || '');
      const s = {
        id,
        title: String(raw.title || raw.topic || raw.lastUserMessage || id).slice(0, 60),
        topic: raw.topic || raw.title || '',
        status: raw.status || 'completed',
        createdAt: raw.createdAt || Date.now(),
        lastAt: raw.lastAt || raw.createdAt || Date.now(),
        messageCount: raw.messageCount || norm.length,
        messages: norm,
        lastMessage: last,
        lastUserMessage: raw.lastUserMessage || '',
        imported: true,
      };
      this.sessions.set(id, s);
      ids.push(id);
    }
    return ids;
  }

  streamReply(session, prompt) {
    session.status = 'running';
    const reply = `Received: “${prompt}”. Working on it… done.`;
    const chunks = reply.match(/.{1,8}/g) || [reply];
    const self = this;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (o) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        send({}); // ping
        let acc = '';
        for (const c of chunks) { acc += c; send({ type: 'chunk', text: c }); await sleep(90); }
        session.status = 'idle';
        session.messages.push({ role: 'assistant', content: acc });
        session.lastMessage = acc;
        await self.persist(session);
        send({ type: 'done', sessionId: session.id });
        controller.close();
      },
    });
    return new Response(stream, { headers: {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  }

  // Read the session token from the request cookies.
  cookieToken(request) {
    const raw = request.headers.get('cookie') || '';
    const m = raw.match(/(?:^|;\s*)web_token=([^;]+)/);
    return m ? m[1] : null;
  }
  // A request is authed iff it carries a token we issued (and haven't revoked).
  async isAuthed(request) {
    const t = this.cookieToken(request);
    if (!t) return false;
    return !!(await this.state.storage.get(`t:${t}`));
  }
  // The profile that owns this request's token (for delegating session reads).
  async tokenUser(request) {
    const t = this.cookieToken(request);
    if (!t) return null;
    const rec = await this.state.storage.get(`t:${t}`);
    return (rec && rec.username) || this.env.AGENT_USERNAME || 'trained-assist-product-owner';
  }

  // Delegate to the agent's stateless bearer endpoints for the REAL per-profile
  // sessions (the ones the bot writes on every Telegram turn). AGENT_VERIFY_URL
  // points at /web/verify; we swap the suffix. Returns [] / null on any failure
  // so the UI degrades to just the local (imported/demo) sessions, never errors.
  async agentSessions(username) {
    const base = this.env.AGENT_VERIFY_URL, secret = this.env.AGENT_VERIFY_SECRET;
    if (!base || !secret) return { ok: false, status: 503, error: 'agent delegation not configured', sessions: [] };
    try {
      const r = await fetch(base.replace(/\/web\/verify$/, '/web/sessions-list'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ username, limit: 50 }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status !== 200) return { ok: false, status: r.status, error: data.error || 'agent sessions unavailable', sessions: [] };
      return { ok: true, status: 200, sessions: Array.isArray(data.sessions) ? data.sessions : [] };
    } catch {
      return { ok: false, status: 503, error: 'agent unavailable', sessions: [] };
    }
  }
  async agentSession(username, id) {
    const base = this.env.AGENT_VERIFY_URL, secret = this.env.AGENT_VERIFY_SECRET;
    if (!base || !secret) return { ok: false, status: 503, error: 'agent delegation not configured', session: null };
    try {
      const r = await fetch(base.replace(/\/web\/verify$/, '/web/session-get'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ username, id }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status !== 200) return { ok: false, status: r.status, error: data.error || 'agent session unavailable', session: null };
      return { ok: true, status: 200, session: data.session || null };
    } catch {
      return { ok: false, status: 503, error: 'agent unavailable', session: null };
    }
  }

  // Copy browser-uploaded bytes from Durable Object storage into the agent's
  // durable intake store before starting real work. The resulting hex ids are
  // the fileRefs contract the agent materializes into media/intake.
  async agentFileRefs(username, attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return { ok: true, fileRefs: [] };
    const base = this.env.AGENT_VERIFY_URL, secret = this.env.AGENT_VERIFY_SECRET;
    if (!base || !secret) return { ok: false, status: 503, error: 'agent delegation not configured' };
    const target = base.replace(/\/web\/verify$/, '/web/intake-file-bearer');
    const fileRefs = [];
    for (const a of attachments) {
      const stored = a && a.id ? await this.state.storage.get(`f:${a.id}`) : null;
      if (!stored || !stored.b64) return { ok: false, status: 400, error: 'attachment bytes missing' };
      const bytes = bufferFromB64(stored.b64);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const id = [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
      let r;
      try {
        r = await fetch(target, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secret}`,
            'x-username': username,
            'x-file-id': id,
            'x-filename': encodeURIComponent(stored.name || a.name || 'file'),
            'content-type': stored.type || a.type || 'application/octet-stream',
          },
          body: bytes,
        });
      } catch {
        return { ok: false, status: 503, error: 'agent attachment upload unavailable' };
      }
      if (r.status !== 200) {
        const data = await r.json().catch(() => ({}));
        return { ok: false, status: r.status || 502, error: data.error || 'agent attachment upload rejected' };
      }
      fileRefs.push({ id, name: stored.name || a.name || 'file', mime: stored.type || a.type || 'application/octet-stream' });
    }
    return { ok: true, fileRefs };
  }

  // Write-side delegation. Never turn an upstream failure into a local demo
  // success when agent delegation is configured: the user must know the real
  // task did not start. Non-200 status/body are preserved as a JSON error.
  async agentTaskStream(username, agentPath, payload) {
    const base = this.env.AGENT_VERIFY_URL, secret = this.env.AGENT_VERIFY_SECRET;
    if (!base || !secret) return { ok: false, status: 503, error: 'agent delegation not configured' };
    const target = base.replace(/\/web\/verify$/, agentPath);
    let r;
    try {
      r = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ username, ...payload }),
      });
    } catch {
      return { ok: false, status: 503, error: 'agent unavailable' };
    }
    if (r.status !== 200 || !r.body) {
      const data = await r.json().catch(() => ({}));
      return { ok: false, status: r.status || 502, error: data.error || 'agent task rejected', data };
    }
    return { ok: true, response: new Response(r.body, { headers: {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } }) };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    const PW = this.env.DEMO_PASSWORD || null;
    // Delegate login to the agent's per-profile password store when configured,
    // so ANY password the bot generates works here automatically — no manual
    // DEMO_PASSWORD sync. AGENT_VERIFY_URL points at the agent's /web/verify;
    // AGENT_VERIFY_SECRET is the shared bearer it checks.
    const AGENT_VERIFY = this.env.AGENT_VERIFY_URL || null;
    const AGENT_VERIFY_SECRET = this.env.AGENT_VERIFY_SECRET || null;
    const agentDelegation = !!(AGENT_VERIFY && AGENT_VERIFY_SECRET);

    if (p === '/healthz') return json(200, { ok: true, buildSha: this.env.BUILD_SHA || null });

    // Fail closed: a deploy with NO way to verify a password (neither a local
    // DEMO_PASSWORD nor agent delegation) is LOCKED, never open. This is a
    // powerful tool behind a public URL — better a broken login than a back door.
    if (!PW && !agentDelegation) {
      if (p === '/web/auth' && m === 'POST') return json(503, { error: 'Auth not configured' });
      return json(503, { error: 'Locked: server password not configured' });
    }

    // GET only renders a page that auto-POSTs the ticket: Telegram's link-preview
    // crawler and other prefetchers issue GETs, so a GET must never burn the
    // one-time ticket. The POST consumes it (nonce stored once), mints a normal
    // web_token for the ticket's profile — replacing whichever profile was
    // logged in before — and redirects straight into the dialog.
    if (p === '/web/magic' && m === 'GET') {
      const t = url.searchParams.get('t') || '';
      if (!/^[A-Za-z0-9_.-]{1,1024}$/.test(t)) return magicPage('Ссылка недействительна', '<h2>Ссылка недействительна</h2><p>Нажми «📜 Журнал» в Telegram ещё раз.</p>', 400);
      return magicPage('Открываю журнал…',
        `<form method="post" action="/web/magic"><input type="hidden" name="t" value="${t}">` +
        `<p>Открываю журнал…</p><noscript><button type="submit">Открыть журнал</button></noscript></form>` +
        `<script>history.replaceState(null,'','/web/magic');document.forms[0].submit()</script>`);
    }
    if (p === '/web/magic' && m === 'POST') {
      let t = '';
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('application/json')) t = (await body(request)).t || '';
      else { try { t = (await request.formData()).get('t') || ''; } catch { t = ''; } }
      const ticket = await verifyMagicTicket(String(t), AGENT_VERIFY_SECRET);
      const expired = '<h2>Ссылка устарела или уже использована</h2><p>Нажми «📜 Журнал» в Telegram ещё раз — придёт новая ссылка.</p>';
      if (!ticket) return magicPage('Ссылка устарела', expired, 403);
      const nonceKey = `m:${ticket.nonce}`;
      if (await this.state.storage.get(nonceKey)) return magicPage('Ссылка устарела', expired, 403);
      await this.state.storage.put(nonceKey, ticket.exp);
      // Opportunistic cleanup of spent nonces whose tickets have expired anyway.
      const spent = await this.state.storage.list({ prefix: 'm:', limit: 200 });
      const stale = [...spent].filter(([, exp]) => exp < Date.now()).map(([k]) => k);
      if (stale.length) await this.state.storage.delete(stale);
      const old = this.cookieToken(request);
      if (old) await this.state.storage.delete(`t:${old}`);
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
      await this.state.storage.put(`t:${token}`, { at: Date.now(), username: ticket.username, via: 'journal-link' });
      const cookie = `web_token=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=2592000`;
      const location = ticket.sessionId ? `/#/session/${encodeURIComponent(ticket.sessionId)}` : '/';
      return new Response(null, { status: 303, headers: { location, 'set-cookie': cookie, 'cache-control': 'no-store' } });
    }

    if (p === '/web/auth' && m === 'POST') {
      const b = await body(request);
      let ok = false;
      // Primary path: ask the agent to validate against its password store.
      if (agentDelegation && b.password) {
        const username = (b.username && /^[a-zA-Z0-9_-]{1,64}$/.test(b.username))
          ? b.username
          : (this.env.AGENT_USERNAME || 'trained-assist-product-owner');
        try {
          const r = await fetch(AGENT_VERIFY, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_VERIFY_SECRET}` },
            body: JSON.stringify({ username, password: b.password }),
          });
          ok = r.status === 200;
        } catch { ok = false; }
      }
      // DEMO_PASSWORD is only for a demo deploy WITHOUT agent delegation. With
      // delegation the agent's per-profile store is the sole authority: a shared
      // password that accepted any `username` let anyone who knew it log in as
      // every profile. Agent unreachable → login fails closed.
      if (!ok && !agentDelegation && PW && b.password === PW) ok = true;
      if (!ok) return json(401, { error: 'Wrong password' });
      // Issue a fresh random session token, persist it, hand it back as an
      // httpOnly+Secure cookie the browser JS can't read or forge.
      // Resolve which profile logged in, so /web/sessions can pull THAT
      // profile's real Telegram sessions from the agent. Falls back to the
      // configured default profile when the form omits a username.
      const loggedUser = (agentDelegation && b.username && /^[a-zA-Z0-9_-]{1,64}$/.test(b.username))
        ? b.username
        : (this.env.AGENT_USERNAME || 'trained-assist-product-owner');
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
      await this.state.storage.put(`t:${token}`, { at: Date.now(), username: loggedUser });
      const cookie = `web_token=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=2592000`;
      return json(200, { ok: true }, { 'set-cookie': cookie });
    }
    if (p === '/web/logout') {
      const t = this.cookieToken(request);
      if (t) await this.state.storage.delete(`t:${t}`);
      const cookie = 'web_token=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0';
      return json(200, { ok: true }, { 'set-cookie': cookie });
    }

    // Every other /web/* endpoint requires a valid session token. Without this
    // the login screen is cosmetic — the API would answer anyone with curl.
    if (p.startsWith('/web/') && !(await this.isAuthed(request))) {
      return json(401, { error: 'Unauthorized' });
    }
    // Who am I: the profile that owns this request's token. The UI shows it in
    // the header so the operator always knows which profile's sessions they're
    // looking at (several profiles can share this URL behind their own password).
    if (p === '/web/me') {
      return json(200, { username: await this.tokenUser(request) });
    }
    // Unified list: the profile's REAL Telegram/agent sessions (delegated) merged
    // with any local imported/demo sessions in this DO, into ONE sorted list.
    // Agent sessions are tagged origin:'agent' so /web/session/:id knows to
    // delegate; local ones fall through to the DO map. Dedupe by id (DO wins on
    // collision — an imported copy shadows the remote). No conflict with the
    // existing web-created sessions: those keep origin:'local'.
    if (p === '/web/sessions') {
      const username = await this.tokenUser(request);
      const remoteResult = await this.agentSessions(username);
      if (agentDelegation && !remoteResult.ok) {
        return json(remoteResult.status === 401 || remoteResult.status === 403 ? 502 : remoteResult.status,
          { error: remoteResult.error || 'Unable to load agent sessions' });
      }
      const remote = (remoteResult.sessions || []).map((s) => ({
        id: s.id,
        title: s.summary?.title || s.title || s.topic || s.lastUserMessage || s.id,
        summary: s.summary || null,
        projectId: s.projectId || null,
        topic: s.topic,
        status: s.status,
        lastMessage: '',
        lastUserMessage: s.lastUserMessage,
        createdAt: s.createdAt,
        lastAt: s.lastAt,
        messageCount: s.messageCount,
        origin: 'agent',
      }));
      const local = this.listView().map((s) => ({ ...s, origin: 'local' }));
      const byId = new Map();
      for (const s of remote) byId.set(s.id, s);
      for (const s of local) byId.set(s.id, s); // local shadows remote on id clash
      const merged = [...byId.values()].sort(
        (a, b) => (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0));
      return json(200, merged);
    }
    if (p.startsWith('/web/session/')) {
      const id = decodeURIComponent(p.split('/').pop());
      const s = this.sessions.get(id);
      if (s) return json(200, s); // local (imported/demo/web-created) session
      // Not local → it's an agent/Telegram session: delegate to the agent.
      const username = await this.tokenUser(request);
      const remote = await this.agentSession(username, id);
      if (!remote.ok) {
        const status = remote.status === 401 || remote.status === 403 ? 502 : remote.status;
        return json(status || 502, { error: remote.error || 'agent session unavailable' });
      }
      return remote.session ? json(200, remote.session) : json(404, { error: 'not found' });
    }
    // Project list for the New Session picker. The projects live in the agent's
    // per-profile projects/ model (single source of truth) — we delegate to its
    // /web/projects endpoint rather than keeping a second list here, which would
    // drift from the bot exactly like the password store did (see [028]). Flat,
    // linear list — no tree. Falls back to [] (picker shows "No folders") if the
    // agent is unreachable or the profile hasn't opted into projects yet.
    if (p === '/web/files/tree') {
      if (!agentDelegation) return json(503, { error: 'Project service unavailable' });
      const projectsUrl = AGENT_VERIFY.replace(/\/web\/verify$/, '/web/projects');
      // Must be the LOGGED-IN profile's projects, not the default — otherwise every
      // profile sees trained-assist-product-owner's folders (same fix as /web/me).
      const username = await this.tokenUser(request);
      try {
        const r = await fetch(projectsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_VERIFY_SECRET}` },
          body: JSON.stringify({ username }),
        });
        if (r.status !== 200) return json(502, { error: 'Unable to load projects' });
        const data = await r.json();
        const tree = (data.projects || []).map(pr => ({
          path: pr.id,
          name: pr.label ? `${pr.label}: ${pr.name}` : pr.name,
        }));
        return json(200, { tree });
      } catch {
        return json(502, { error: 'Unable to load projects' });
      }
    }
    // Create a project. Delegates to the agent's /web/project-create (single source
    // of truth — same projects/ model the bot uses). Creating the first project also
    // opts the profile into the projects model. Body: {name, type?}. Returns the new
    // {project}. 503 if the agent isn't reachable — we never create a local shadow
    // project, or it would drift from the bot like the old password store did ([028]).
    if (p === '/web/project-create' && m === 'POST') {
      if (!agentDelegation) return json(503, { error: 'agent unavailable' });
      const createUrl = AGENT_VERIFY.replace(/\/web\/verify$/, '/web/project-create');
      // Create under the LOGGED-IN profile, not the default — a project made by efi
      // must land in efi's projects/, not trained-assist-product-owner's.
      const username = await this.tokenUser(request);
      let bodyIn = {};
      try { bodyIn = await request.json(); } catch { return json(400, { error: 'bad json' }); }
      const name = (bodyIn.name || '').trim();
      if (!name) return json(400, { error: 'name required' });
      try {
        const r = await fetch(createUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_VERIFY_SECRET}` },
          body: JSON.stringify({ username, name, type: bodyIn.type || undefined }),
        });
        const data = await r.json().catch(() => ({}));
        return json(r.status, data);
      } catch {
        return json(503, { error: 'agent unavailable' });
      }
    }
    // Project restructuring ("⟳ Переструктурировать") — proxy to the agent's
    // /web/reproject-* bearer endpoints (single source of truth = reproject.js).
    // Four operations, all on the LOGGED-IN profile, same delegation pattern as
    // project-create: preview (cheap-model proposal), adjust (manual edit of the
    // saved plan), apply (re-tag sessions, reversible), revert (undo last apply).
    // The agent runs the cheap classification itself and streams nothing — these
    // are plain JSON responses (preview can take 10-60s; the UI shows a spinner).
    if (p.startsWith('/web/reproject-') && m === 'POST') {
      if (!agentDelegation) return json(503, { error: 'agent unavailable' });
      const endpoint = p.slice('/web'.length); // e.g. /reproject-preview
      const target = AGENT_VERIFY.replace(/\/web\/verify$/, endpoint);
      const username = await this.tokenUser(request);
      let bodyIn = {};
      try { bodyIn = await request.json(); } catch { return json(400, { error: 'bad json' }); }
      try {
        const r = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_VERIFY_SECRET}` },
          body: JSON.stringify({ username, ...bodyIn }),
        });
        const data = await r.json().catch(() => ({}));
        return json(r.status, data);
      } catch {
        return json(503, { error: 'agent unavailable' });
      }
    }
    // Voice input: proxy raw audio to Deepgram and return the transcript. The API
    // key lives only server-side (env.DEEPGRAM_KEY); the browser never sees it.
    // Returns { transcript, confidence, empty } — the client retries when empty
    // (Deepgram occasionally swallows a short/quiet clip) and lets the user edit
    // the draft before sending. Russian-first (language=ru), smart punctuation on.
    if (p === '/web/transcribe' && m === 'POST') {
      const key = this.env.DEEPGRAM_KEY;
      if (!key) return json(500, { error: 'Deepgram key not configured' });
      const audio = await request.arrayBuffer();
      if (!audio || audio.byteLength < 512) return json(200, { transcript: '', empty: true });
      const ct = request.headers.get('content-type') || 'audio/webm';
      const dgUrl = 'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true&punctuate=true';
      try {
        const dg = await fetch(dgUrl, {
          method: 'POST',
          headers: { Authorization: `Token ${key}`, 'content-type': ct },
          body: audio,
        });
        if (!dg.ok) {
          const t = await dg.text().catch(() => '');
          return json(502, { error: `Deepgram ${dg.status}`, detail: t.slice(0, 200) });
        }
        const data = await dg.json();
        const alt = data?.results?.channels?.[0]?.alternatives?.[0] || {};
        const transcript = (alt.transcript || '').trim();
        return json(200, { transcript, confidence: alt.confidence ?? null, empty: !transcript });
      } catch (e) {
        return json(502, { error: 'Deepgram request failed', detail: String(e).slice(0, 200) });
      }
    }
    // File attachments (drag-drop / paste in the UI). Upload holds the bytes in
    // DO storage keyed by id; the reply/run body then references {id,name,type,size}
    // and the message renders the attachment. Bytes are served back via /web/file/:id.
    if (p === '/web/upload' && m === 'POST') {
      const name = decodeURIComponent(request.headers.get('x-filename') || 'file');
      const type = request.headers.get('content-type') || 'application/octet-stream';
      const buf = await request.arrayBuffer();
      const size = buf.byteLength;
      if (!size) return json(400, { error: 'Empty file' });
      if (size > MAX_UPLOAD) return json(413, { error: 'File too large (max 3MB)' });
      const id = `f-${String(this.seq++).padStart(4, '0')}`;
      await this.state.storage.put(`f:${id}`, { id, name, type, size, b64: b64FromBuffer(buf) });
      await this.state.storage.put('seq', this.seq);
      return json(200, { id, name, type, size, url: `/web/file/${id}` });
    }
    if (p.startsWith('/web/file/') && m === 'GET') {
      const f = await this.state.storage.get(`f:${p.split('/').pop()}`);
      if (!f) return json(404, { error: 'not found' });
      return new Response(bufferFromB64(f.b64), { headers: {
        'content-type': f.type,
        'content-disposition': `inline; filename="${encodeURIComponent(f.name)}"`,
        'cache-control': 'public, max-age=31536000' } });
    }
    if (p === '/web/import' && m === 'POST') {
      const b = await body(request);
      const ids = this.importSessions(b);
      for (const id of ids) await this.persist(this.sessions.get(id));
      await this.state.storage.put('seq', this.seq);
      return json(200, { ok: true, imported: ids.length, ids });
    }
    if (p.startsWith('/web/stop/') && m === 'POST') {
      const id = decodeURIComponent(p.split('/').pop());
      const s = this.sessions.get(id);
      if (s) {
        // Local (imported / demo / web-created) session → just flip local state.
        s.status = 'idle';
        await this.persist(s);
        return json(200, { ok: true });
      }
      // Not local → it's a REAL agent/Telegram session. Without this delegation
      // the "Остановить выполнение" button silently did nothing for every real
      // session (this.sessions never had them), so SIGTERM never reached the
      // agent. Same fallback shape as /web/reply's delegation below.
      if (AGENT_VERIFY && AGENT_VERIFY_SECRET) {
        const username = await this.tokenUser(request);
        const target = AGENT_VERIFY.replace(/\/web\/verify$/, '/web/stop-bearer');
        try {
          const r = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_VERIFY_SECRET}` },
            body: JSON.stringify({ username, id }),
          });
          const data = await r.json().catch(() => ({}));
          return json(r.status, data);
        } catch {
          return json(503, { error: 'agent unavailable; task was not confirmed stopped' });
        }
      }
      return json(503, { error: 'agent stop delegation unavailable' });
    }
    if (p === '/web/run' && m === 'POST') {
      const b = await body(request);
      // Delegate a brand-new session to the REAL agent so the web "New" button
      // starts an actual agent task (streamed live), not a demo echo. Falls back to
      // the local demo session if delegation is off or the agent is unreachable.
      const username = await this.tokenUser(request);
      const attachments = Array.isArray(b.attachments) ? b.attachments : [];
      const uploaded = agentDelegation ? await this.agentFileRefs(username, attachments) : { ok: true, fileRefs: [] };
      if (!uploaded.ok) return json(uploaded.status || 503, { error: uploaded.error || 'attachment upload failed' });
      const delegated = await this.agentTaskStream(username, '/web/run-bearer', {
        task: b.task || '',
        projectId: b.projectId || null,
        fileRefs: uploaded.fileRefs,
        requestId: b.requestId || null,
      });
      if (delegated.ok) return delegated.response;
      if (agentDelegation) return json(delegated.status || 503, { ...(delegated.data || {}), error: delegated.error || 'agent unavailable' });
      const s = this.newSession(b.task);
      if (Array.isArray(b.attachments) && b.attachments.length) s.messages[0].attachments = b.attachments;
      await this.persist(s);
      return this.streamReply(s, b.task || '');
    }
    if (p.startsWith('/web/reply/') && m === 'POST') {
      const id = decodeURIComponent(p.split('/').pop());
      const b = await body(request);
      const s = this.sessions.get(id);
      if (s) {
        // Local (imported / demo / web-created) session → local demo echo.
        const um = { role: 'user', content: b.message || '' };
        if (Array.isArray(b.attachments) && b.attachments.length) um.attachments = b.attachments;
        s.messages.push(um);
        await this.persist(s);
        return this.streamReply(s, b.message || '');
      }
      // Not local → it's a REAL agent/Telegram session (only ever read before, so a
      // reply 404'd and the message vanished). Delegate the write to the agent.
      const username = await this.tokenUser(request);
      const attachments = Array.isArray(b.attachments) ? b.attachments : [];
      const uploaded = await this.agentFileRefs(username, attachments);
      if (!uploaded.ok) return json(uploaded.status || 503, { error: uploaded.error || 'attachment upload failed' });
      const delegated = await this.agentTaskStream(username, '/web/reply-bearer', {
        id,
        message: b.message || '',
        fileRefs: uploaded.fileRefs,
        requestId: b.requestId || null,
      });
      if (delegated.ok) return delegated.response;
      return json(delegated.status || 503, { ...(delegated.data || {}), error: delegated.error || 'agent unavailable' });
    }
    return json(404, { error: 'not found' });
  }
}

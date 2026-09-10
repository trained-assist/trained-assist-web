// Cloudflare Worker: same-origin /web/* backend for the trained-assist UI.
// Static files (index.html, app.js, ...) are served from ./src via the [assets]
// binding. The API + SSE streams live in a single Durable Object (SessionHub)
// so session state is consistent across requests and persisted across restarts.
const enc = new TextEncoder();
const json = (code, obj, extra = {}) =>
  new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json', ...extra } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function body(req) { try { return await req.json(); } catch { return {}; } }

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

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    const PW = this.env.DEMO_PASSWORD || null;

    if (p === '/healthz') return json(200, { ok: true });

    if (p === '/web/auth' && m === 'POST') {
      const b = await body(request);
      if (PW && b.password !== PW) return json(401, { error: 'Wrong password' });
      return json(200, { ok: true }, { 'set-cookie': 'sid=demo; Path=/; SameSite=Lax' });
    }
    if (p === '/web/logout') return json(200, { ok: true });
    if (p === '/web/sessions') return json(200, this.listView());
    if (p.startsWith('/web/session/')) {
      const s = this.sessions.get(p.split('/').pop());
      return s ? json(200, s) : json(404, { error: 'not found' });
    }
    if (p === '/web/files/tree') return json(200, { tree: [] });
    if (p === '/web/import' && m === 'POST') {
      const b = await body(request);
      const ids = this.importSessions(b);
      for (const id of ids) await this.persist(this.sessions.get(id));
      await this.state.storage.put('seq', this.seq);
      return json(200, { ok: true, imported: ids.length, ids });
    }
    if (p.startsWith('/web/stop/') && m === 'POST') {
      const s = this.sessions.get(p.split('/').pop());
      if (s) { s.status = 'idle'; await this.persist(s); }
      return json(200, { ok: true });
    }
    if (p === '/web/run' && m === 'POST') {
      const b = await body(request); const s = this.newSession(b.task);
      await this.persist(s);
      return this.streamReply(s, b.task || '');
    }
    if (p.startsWith('/web/reply/') && m === 'POST') {
      const s = this.sessions.get(decodeURIComponent(p.split('/').pop()));
      if (!s) return json(404, { error: 'no session' });
      const b = await body(request); s.messages.push({ role: 'user', content: b.message || '' });
      await this.persist(s);
      return this.streamReply(s, b.message || '');
    }
    return json(404, { error: 'not found' });
  }
}

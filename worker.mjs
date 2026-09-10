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
      const s = this.sessions.get(p.split('/').pop());
      if (s) { s.status = 'idle'; await this.persist(s); }
      return json(200, { ok: true });
    }
    if (p === '/web/run' && m === 'POST') {
      const b = await body(request); const s = this.newSession(b.task);
      if (Array.isArray(b.attachments) && b.attachments.length) s.messages[0].attachments = b.attachments;
      await this.persist(s);
      return this.streamReply(s, b.task || '');
    }
    if (p.startsWith('/web/reply/') && m === 'POST') {
      const s = this.sessions.get(decodeURIComponent(p.split('/').pop()));
      if (!s) return json(404, { error: 'no session' });
      const b = await body(request);
      const um = { role: 'user', content: b.message || '' };
      if (Array.isArray(b.attachments) && b.attachments.length) um.attachments = b.attachments;
      s.messages.push(um);
      await this.persist(s);
      return this.streamReply(s, b.message || '');
    }
    return json(404, { error: 'not found' });
  }
}

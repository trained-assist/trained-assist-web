// «🔀 Какая модель ответила» (web channel) — the model ladder's per-call trace.
//
// (1) worker: GET /web/session/:id/ladder delegates to the agent's bearer
//     /web/session-ladder with {username, id}; a local (imported) session has no
//     ladder trace and says so instead of pretending;
// (2) UI: the button sits next to the other three toggles; a click shows which model
//     answered, in what order the others were tried, and why each was skipped.
//
// The UI deliberately never says «лестница» — the user does not know the word, and
// the question they actually have is "which model wrote this".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SessionHub } from '../worker.mjs';

const CALLS = { count: 2, calls: [
  { ladder: 'deepseek', ok: true, model: 'opencode-go/mimo-v2.6-flash', ms: 1844, tokens_in: 97, tokens_out: 42,
    attempts: [
      { model: 'opencode-go/mimo-v2.6-flash', outcome: 'error', error: 'fetch failed: no first token in time' },
      { model: 'opencode-go/space-bunny-free', outcome: 'ok' },
    ] },
  { ladder: 'deepseek', ok: false, model: null, ms: 61000, tokens_in: null, tokens_out: null,
    attempts: [
      { model: 'opencode-go/longcat-2.5-preview-free', outcome: 'error', error: 'HTTP 500: Endpoint is unavailable' },
      { model: 'opencode-zen/big-pickle', outcome: 'ok' },
    ] },
] };
const failures = [];

// ── (1) worker delegation ───────────────────────────────────────────────────
try {
  const savedFetch = globalThis.fetch;
  const state = { blockConcurrencyWhile: fn => fn(), storage: { list: async () => new Map(), get: async () => undefined, put: async () => {} } };
  const hub = new SessionHub(state, { AGENT_VERIFY_URL: 'https://agent.example/web/verify', AGENT_VERIFY_SECRET: 'fixture' });
  hub.isAuthed = async () => true;
  hub.tokenUser = async () => 'owner';
  let called = null, ladderDelegations = 0;
  globalThis.fetch = async (url, opts) => { called = { url, auth: opts.headers.authorization, body: JSON.parse(opts.body) }; ladderDelegations++; return Response.json(CALLS); };
  try {
    const res = await hub.fetch(new Request('https://web.example/web/session/real-session/ladder'));
    assert.equal(res.status, 200);
    assert.equal(called.url, 'https://agent.example/web/session-ladder');
    assert.equal(called.auth, 'Bearer fixture');
    assert.deepEqual(called.body, { username: 'owner', id: 'real-session' });
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.equal(body.calls[0].attempts.length, 2, 'the rung trace survives the delegation');
    // A local (imported) session never reached the agent → say so, do not invent a model list.
    hub.sessions.set('imported', { id: 'imported', title: 'импорт', messages: [] });
    const local = await hub.fetch(new Request('https://web.example/web/session/imported/ladder'));
    assert.equal((await local.json()).error, 'no-ladder-local');
    assert.equal(ladderDelegations, 1, 'a local session must not hit the agent at all');
  } finally { globalThis.fetch = savedFetch; }
} catch (e) { failures.push(`worker: ${e.message.split('\n').slice(0, 3).join(' ')}`); }

// ── (2) UI click-through ───────────────────────────────────────────────────
const ladderHits = [];
const session = { id: 'real-session', title: 'Ромашка', status: 'completed', messageCount: 2, messages: [
  { role: 'user', content: 'Разбери клиента', at: 500 },
  { role: 'assistant', content: 'Готово', at: 1000 },
] };
const server = createServer(async (req, res) => {
  const json = (d, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.url === '/web/me') return json({ username: 'ux-test' });
  if (req.url === '/web/sessions') return json([session]);
  if (req.url === '/web/files/tree') return json({ tree: [] });
  if (req.url.startsWith('/web/session/')) {
    if (req.url.includes('/ladder')) { ladderHits.push(req.url); return json(CALLS); }
    if (req.url.endsWith('/trace')) return json({ ok: false, error: 'no-opencode-session', engine: null });
    return json(session);
  }
  try {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    const data = await readFile(new URL('../src/' + file, import.meta.url));
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.marked={parse:s=>s};' }));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByTestId('session-item').first().click();
    await page.getByTestId('show-models').first().waitFor({ timeout: 10000 });

    const btns = page.getByTestId('show-models');
    assert.equal(await btns.count(), 1, 'one «Какая модель ответила» per assistant answer');
    const label = await btns.first().innerText();
    assert.match(label, /Какая модель ответила/);
    assert.ok(!/лестниц/i.test(label), 'the UI never calls it a «лестница»');

    await btns.first().click();
    const body = page.getByTestId('models-body').first();
    await body.waitFor({ timeout: 5000 });
    // The loading state is already visible, so wait for the RENDERED rows, not the div.
    await page.waitForFunction(
      () => /модельных вызовов/.test(document.querySelector('[data-testid="models-body"]')?.textContent || ''),
      null, { timeout: 5000 });
    const text = await body.innerText();
    assert.match(text, /2 модельных вызовов/);
    assert.match(text, /space-bunny-free/, 'the model that actually answered is named');
    assert.match(text, /ответила/);
    assert.match(text, /Endpoint is unavailable/, 'and why a skipped one did not');
    assert.match(text, /big-pickle/);
    assert.match(text, /нет ответа/, 'a failed call is marked as such, not hidden');
    assert.match(text, /97→42/, 'tokens in→out');
    assert.match(text, /61\d\d мс|61000 мс/, 'duration is shown');

    // Toggle reuses the loaded DOM (one request, like the sibling panels).
    await btns.first().click(); assert(await body.isHidden());
    await btns.first().click(); assert(await body.isVisible());
    assert.equal(ladderHits.length, 1, 'load-once-then-toggle');
    assert.deepEqual(errors, []);
  } catch (e) { failures.push(`ui: ${e.message.split('\n').slice(0, 3).join(' ')}`); }
  if (failures.length) { console.error('FAIL web-model-ladder:\n  ' + failures.join('\n  ')); process.exitCode = 1; }
  else console.log('PASS: worker ladder delegation; «🔀 Какая модель ответила» shows who answered + why the others did not; cached toggle; no «лестница» in the UI');
} finally {
  await browser.close();
  server.close();
}

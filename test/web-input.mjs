// US-INPUT-01, web channel — «📥 Посмотреть input» under an agent answer.
// (1) worker: GET /web/session/:id/input?at= delegates to the agent's bearer
//     /web/session-input with {username, id, at}; local sessions → no-input-local;
// (2) UI: the button sits next to «🧠 Полный лог» / «📋 Сжатый лог»; a click shows
//     the REAL input of THIS answer (its `at`) verbatim — text only, no markdown/HTML
//     rendering and no commentary inside the text; download = same bytes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SessionHub } from '../worker.mjs';

const RAW = 'SYSTEM PROMPT\n<b>not html</b>\n# not a heading\n\nЗадача: разбери клиента';
const failures = [];

// ── (1) worker delegation ───────────────────────────────────────────────────
try {
  const savedFetch = globalThis.fetch;
  const state = { blockConcurrencyWhile: fn => fn(), storage: { list: async () => new Map(), get: async () => undefined, put: async () => {} } };
  const hub = new SessionHub(state, { AGENT_VERIFY_URL: 'https://agent.example/web/verify', AGENT_VERIFY_SECRET: 'fixture' });
  hub.isAuthed = async () => true;
  hub.tokenUser = async () => 'owner';
  let called = null;
  globalThis.fetch = async (url, opts) => { called = { url, auth: opts.headers.authorization, body: JSON.parse(opts.body) }; return Response.json({ ok: true, taskId: 't1', at: 900, input: RAW }); };
  try {
    const res = await hub.fetch(new Request('https://web.example/web/session/real-session/input?at=1000'));
    assert.equal(res.status, 200);
    assert.equal(called.url, 'https://agent.example/web/session-input');
    assert.equal(called.auth, 'Bearer fixture');
    assert.deepEqual(called.body, { username: 'owner', id: 'real-session', at: 1000 });
    assert.equal((await res.json()).input, RAW, 'input passes through untouched');
  } finally { globalThis.fetch = savedFetch; }
} catch (e) { failures.push(`worker: ${e.message.split('\n').slice(0, 3).join(' ')}`); }

// ── (2) UI click-through ───────────────────────────────────────────────────
const inputHits = [];
const session = { id: 'real-session', title: 'Ромашка', status: 'completed', messageCount: 4, messages: [
  { role: 'user', content: 'Разбери клиента', at: 500 },
  { role: 'assistant', content: 'Готово', at: 1000 },
  { role: 'user', content: 'Ещё', at: 1500 },
  { role: 'assistant', content: 'Сделал', at: 2000 },
] };
const server = createServer(async (req, res) => {
  const json = (d, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.url === '/web/me') return json({ username: 'ux-test' });
  if (req.url === '/web/sessions') return json([session]);
  if (req.url === '/web/files/tree') return json({ tree: [] });
  if (req.url.startsWith('/web/session/')) {
    if (req.url.includes('/input')) {
      const at = new URL(req.url, 'http://x').searchParams.get('at');
      inputHits.push(at);
      return at === '1000' ? json({ ok: true, taskId: 't1', at: 900, input: RAW }) : json({ ok: false, error: 'no-input' });
    }
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
    await page.getByTestId('show-trace').first().waitFor({ timeout: 10000 });

    const btns = page.getByTestId('show-input');
    assert.equal(await btns.count(), 2, 'one «Посмотреть input» per assistant answer');
    assert.match(await btns.first().innerText(), /Посмотреть input/);

    // First answer (at=1000) → its run's input, verbatim.
    await btns.first().click();
    const text = page.getByTestId('input-text');
    await text.waitFor({ timeout: 5000 });
    assert.equal(await text.evaluate(el => el.textContent), RAW, 'input shown byte-for-byte');
    assert.equal(await text.evaluate(el => el.querySelector('b')), null, 'no HTML rendering of the input');
    const bodyText = await page.getByTestId('input-body').first().innerText();
    assert.ok(!/модель получает|вход \d+ токенов|Файлы:/.test(bodyText), 'no gateway commentary');
    assert.equal(await page.getByTestId('input-download').getAttribute('download'), 'agent-input.txt');
    assert.deepEqual(inputHits, ['1000'], 'asks for THIS answer by its at');

    // Toggle reuses the loaded DOM.
    await btns.first().click(); assert(await page.getByTestId('input-body').first().isHidden());
    await btns.first().click(); assert(await page.getByTestId('input-body').first().isVisible());
    assert.equal(inputHits.length, 1);

    // Second answer without a snapshot → honest message, not a retelling.
    await btns.nth(1).click();
    await page.waitForFunction(() => /не сохранён/.test(document.querySelectorAll('[data-testid="input-body"]')[1]?.textContent || ''));
    assert.deepEqual(errors, []);
  } catch (e) { failures.push(`ui: ${e.message.split('\n').slice(0, 3).join(' ')}`); }
  if (failures.length) { console.error('FAIL web-input:\n  ' + failures.join('\n  ')); process.exitCode = 1; }
  else console.log('PASS: worker input delegation (at); «Посмотреть input» per answer, verbatim text, download, cached toggle, honest no-input');
} finally {
  await browser.close();
  server.close();
}

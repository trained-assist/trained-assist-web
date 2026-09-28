// «📋 Сжатый лог» — sandbox for trained-assist-agent#1777 (plan 4d331bae), web side.
// (1) worker: GET /web/session/:id/digest delegates to the agent's bearer twin
//     /web/session-digest exactly like trace does;
// (2) UI: the second button sits next to «🧠 Полный лог», shows «Собираю…» on the
//     first click, then renders summary → activities with minutes → artifacts
//     grouped (PI separate), and the second click reuses the loaded DOM.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SessionHub } from '../worker.mjs';

const digestPayload = {
  ok: true, engine: 'opencode', sessionId: 'real-session', cached: false, degraded: false, ttlMs: 604800000,
  summary: 'Разобрал бриф клиента «Ромашка». Проверил компанию и прогнал тесты.',
  activities: [
    { family: 'web', label: 'Проверка компании в интернете', minutes: 30 },
    { family: 'files', label: 'Работа с файлами', minutes: 20 },
  ],
  artifacts: {
    pi: [{ type: 'contact', kind: 'phone', value: '+79161234567' }, { type: 'contact', kind: 'email', value: 'ivan@romashka.ru' }],
    attributes: [{ type: 'url', value: 'https://checko.ru/company/romashka' }],
    other: [],
  },
};

// Both halves always run so one failure never hides the other.
const failures = [];
// ── (1) worker delegation ───────────────────────────────────────────────────
try {
  const savedFetch = globalThis.fetch;
  const state = { blockConcurrencyWhile: fn => fn(), storage: { list: async () => new Map(), get: async () => undefined, put: async () => {} } };
  const hub = new SessionHub(state, { AGENT_VERIFY_URL: 'https://agent.example/web/verify', AGENT_VERIFY_SECRET: 'fixture' });
  hub.isAuthed = async () => true;
  hub.tokenUser = async () => 'owner';
  let called = null;
  globalThis.fetch = async (url, opts) => { called = { url, auth: opts.headers.authorization, body: JSON.parse(opts.body) }; return Response.json(digestPayload); };
  try {
    const res = await hub.fetch(new Request('https://web.example/web/session/real-session/digest'));
    assert.equal(res.status, 200);
    assert.ok(called, 'worker must call the agent for a digest');
    assert.equal(called.url, 'https://agent.example/web/session-digest');
    assert.equal(called.auth, 'Bearer fixture');
    assert.deepEqual(called.body, { username: 'owner', id: 'real-session' });
    assert.equal((await res.json()).summary, digestPayload.summary);
  } finally { globalThis.fetch = savedFetch; }
} catch (e) { failures.push(`worker: ${e.message.split('\n').slice(0, 3).join(' ')}`); }

// ── (2) UI click-through ───────────────────────────────────────────────────
let digestHits = 0;
const session = { id: 'real-session', title: 'Ромашка', status: 'completed', messageCount: 2, messages: [
  { role: 'user', content: 'Разбери клиента' },
  { role: 'assistant', content: 'Готово', at: 1000 },
] };
const server = createServer(async (req, res) => {
  const json = (d, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.url === '/web/me') return json({ username: 'ux-test' });
  if (req.url === '/web/sessions') return json([session]);
  if (req.url === '/web/files/tree') return json({ tree: [] });
  if (req.url.startsWith('/web/session/')) {
    if (req.url.endsWith('/digest')) { digestHits++; await new Promise(r => setTimeout(r, 600)); return json(digestPayload); }
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
  await page.getByTestId('show-trace').waitFor({ timeout: 10000 });

  const btn = page.getByTestId('show-digest');
  assert.equal(await btn.count(), 1, '«📋 Сжатый лог» next to «🧠 Полный лог»');
  assert.match(await btn.innerText(), /Сжатый лог/);
  const body = page.getByTestId('digest-body');
  assert(await body.isHidden(), 'digest starts collapsed');

  await btn.click();
  await page.waitForFunction(() => /Собираю/.test(document.querySelector('[data-testid="digest-body"]')?.textContent || ''));
  await page.waitForFunction(() => /Ромашка/.test(document.querySelector('[data-testid="digest-body"]')?.textContent || ''));
  const text = await body.innerText();
  assert.match(text, /Проверка компании в интернете[\s\S]*30 мин/, 'activities with minutes');
  assert.ok(text.indexOf('Разобрал бриф') < text.indexOf('Проверка компании'), 'summary first, then activities');
  assert.match(await page.getByTestId('digest-pi').innerText(), /\+79161234567/, 'PI rendered in its own group');
  assert.match(await page.getByTestId('digest-attributes').innerText(), /checko\.ru/);

  await btn.click(); assert(await body.isHidden(), 'toggle collapses');
  await btn.click(); assert(await body.isVisible());
  assert.equal(digestHits, 1, 'second open reuses the loaded digest');
  assert.deepEqual(errors, []);
  } catch (e) { failures.push(`ui: ${e.message.split('\n').slice(0, 3).join(' ')}`); }
  if (failures.length) { console.error('FAIL web-digest:\n  ' + failures.join('\n  ')); process.exitCode = 1; }
  else console.log('PASS: worker digest delegation; «📋 Сжатый лог» button, «Собираю…», summary → minutes → grouped artifacts (PI separate), cached reopen');
} finally {
  await browser.close();
  server.close();
}

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Regression: a long, space-less session title (e.g. a file path used as the
// title fallback) plus a wide project badge used to squeeze `.convo-title` to a
// few pixels, wrapping it one character per line into a tall vertical ribbon.
// The header must keep the title to at most two lines with a sane width.
const LONG_TITLE = '[Файл сохранён: /home/vova/users/mbk_luda_recruiter/media/intake/a6e46c1a7f22ebf';
const LONG_PROJECT = 'generic-нам-нужно-разработать-единыи-документ-по';
const session = {
  id: 's-5283576795-1790658168860',
  topic: LONG_TITLE,
  projectId: LONG_PROJECT,
  status: 'running',
  messageCount: 1,
  summary: { title: LONG_TITLE, gist: '' },
  messages: [{ role: 'user', content: 'привет' }],
};

const server = createServer(async (req, res) => {
  const json = (d, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.url === '/web/me') return json({ username: 'mbk_luda_recruiter' });
  if (req.url === '/web/sessions') return json([session]);
  if (req.url === '/web/files/tree') return json({ tree: [{ path: LONG_PROJECT, name: 'Разработка операционной модели и поиск кандидатов' }] });
  if (req.url.startsWith('/web/session/')) return json(session);
  try {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    const data = await readFile(new URL('../src/' + file, import.meta.url));
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const width of [1440, 1280, 1024]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.marked={parse:s=>s};' }));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByTestId('session-item').first().click();
    await page.getByTestId('session-title').waitFor();
    await page.waitForFunction(() => document.getElementById('session-title').textContent.length > 10);

    const box = await page.getByTestId('session-title').boundingBox();
    const lines = await page.evaluate(() => {
      const el = document.getElementById('session-title');
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
      return el.getBoundingClientRect().height / lh;
    });
    assert(box.width > 120, `@${width}px: title keeps a usable width (got ${box.width}px, was ~70px before the fix)`);
    assert(lines <= 2.2, `@${width}px: title is at most two lines (got ${lines.toFixed(1)} lines)`);
    await page.close();
  }
  console.log('PASS: convo-header keeps a long session title to <=2 lines at 1440/1280/1024px (no vertical ribbon)');
} finally {
  await browser.close();
  server.close();
}

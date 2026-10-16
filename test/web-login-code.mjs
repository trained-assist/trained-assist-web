import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  let posted;
  const html = await readFile(new URL('../src/login.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  await page.route('https://app.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/login.html') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname === '/web/auth') {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto('https://app.test/login.html');
  await page.locator('#toggle-login').click();
  assert.equal(await page.locator('#telegram-code').isVisible(), true);
  await page.getByTestId('login-telegram-code').fill('23456789ABCD');
  await page.getByTestId('login-submit').click();
  await page.waitForFunction(() => location.pathname.endsWith('/index.html'), null, { timeout: 5000 });
  assert.deepEqual(posted, { telegram_code: '23456789ABCD' });
  console.log('PASS: Telegram login code is posted to the same-origin web auth route');
} finally {
  await browser.close();
}

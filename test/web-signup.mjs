import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const html = await readFile(new URL('../src/signup.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  let posted;
  let telegramTarget;
  await page.route('https://app.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/signup.html') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname === '/web/signup/start') {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        reference: 'r'.repeat(43), expires_in_seconds: 1800,
        telegram_url: `https://t.me/sample_assist_bot?start=signup_${'r'.repeat(43)}`,
      }) });
    }
    if (url.pathname === '/web/signup/status') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'pending' }) });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.route('https://t.me/**', async route => {
    telegramTarget = route.request().url();
    return route.fulfill({ status: 200, contentType: 'text/html', body: 'Telegram handoff' });
  });

  await page.goto('https://app.test/signup.html');
  assert.equal(await page.getByTestId('signup-form').isVisible(), true);
  await page.getByTestId('signup-email').fill('alice@example.com');
  await page.getByTestId('signup-name').fill('Alice Example');
  await page.getByTestId('signup-nickname').fill('alice');
  await page.getByTestId('signup-submit').click();
  await page.waitForURL('https://t.me/**');
  assert.deepEqual(posted, { email: 'alice@example.com', display_name: 'Alice Example', nickname: 'alice' });
  assert.match(telegramTarget, /start=signup_r{43}$/);
  await page.goBack();
  await page.waitForURL('https://app.test/signup.html');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ta.signup.reference')), 'r'.repeat(43));
  console.log('PASS: signup collects email/name/nickname and redirects with only an opaque Telegram reference');
} finally {
  await browser.close();
}

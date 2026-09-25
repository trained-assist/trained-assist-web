// Journal magic link: the Telegram gateway signs a one-time ticket; the worker
// must turn it into a web_token for THAT profile (replacing a different logged-in
// profile), open the dialog, never burn the ticket on a GET (link previews), and
// reject replays, forgeries and expired tickets.
import assert from 'node:assert/strict';
import { SessionHub, verifyMagicTicket } from '../worker.mjs';

const SECRET = 'shared-agent-secret';
const enc = new TextEncoder();
const b64url = b => Buffer.from(b).toString('base64url');
async function sign(payload, secret = SECRET) {
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${p}.${b64url(await crypto.subtle.sign('HMAC', key, enc.encode('journal-login-v1.' + p)))}`;
}
function makeHub() {
  const map = new Map();
  const storage = {
    list: async ({ prefix = '' } = {}) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
    get: async k => map.get(k), put: async (k, v) => { map.set(k, v); },
    delete: async k => { for (const x of [].concat(k)) map.delete(x); },
  };
  const hub = new SessionHub({ blockConcurrencyWhile: fn => fn(), storage },
    { AGENT_VERIFY_URL: 'https://agent.example/web/verify', AGENT_VERIFY_SECRET: SECRET });
  return { hub, map };
}
const post = (hub, t, cookie) => hub.fetch(new Request('https://app.example/web/magic', {
  method: 'POST', body: new URLSearchParams({ t }),
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) } }));
const ticket = (over = {}) => ({ u: 'alice', s: 's-5501536471-1790028499699', e: Date.now() + 600000, n: 'nonce' + Math.random().toString(36).slice(2, 12), ...over });

// 1. Valid ticket → 303 into the dialog + cookie for alice, replacing bob's login.
{
  const { hub, map } = makeHub();
  map.set('t:bobtoken', { username: 'bob' });
  const t = await sign(ticket());
  const res = await post(hub, t, 'web_token=bobtoken');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/#/session/s-5501536471-1790028499699');
  const tok = res.headers.get('set-cookie').match(/web_token=([^;]+)/)[1];
  assert.equal(map.get(`t:${tok}`).username, 'alice');
  assert.equal(map.has('t:bobtoken'), false, 'previous profile session must be revoked');
  const me = await hub.fetch(new Request('https://app.example/web/me', { headers: { cookie: `web_token=${tok}` } }));
  assert.deepEqual(await me.json(), { username: 'alice' });
  // 2. Replay of the same ticket is rejected.
  assert.equal((await post(hub, t)).status, 403);
}
// 3. GET (link preview / prefetch) renders an auto-submit page and does NOT consume.
{
  const { hub, map } = makeHub();
  const t = await sign(ticket());
  const res = await hub.fetch(new Request(`https://app.example/web/magic?t=${t}`));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /method="post" action="\/web\/magic"/);
  assert.equal([...map.keys()].some(k => k.startsWith('m:') || k.startsWith('t:')), false);
  assert.equal((await post(hub, t)).status, 303, 'ticket still usable after a GET');
}
// 4. Forged, wrong-secret, expired, too-far-future and malformed tickets are rejected.
{
  const { hub } = makeHub();
  const good = await sign(ticket());
  const [p, s] = good.split('.');
  const forgedPayload = b64url(enc.encode(JSON.stringify(ticket({ u: 'root' }))));
  for (const bad of [`${forgedPayload}.${s}`, await sign(ticket(), 'other'), await sign(ticket({ e: Date.now() - 1 })),
    await sign(ticket({ e: Date.now() + 2 * 3600e3 })), await sign(ticket({ u: '../etc' })), `${p}`, '"><script>', '']) {
    assert.equal((await post(hub, bad)).status, 403, `must reject ${bad.slice(0, 30)}`);
  }
  const html = await hub.fetch(new Request('https://app.example/web/magic?t=%22%3E%3Cscript%3E'));
  assert.equal(html.status, 400);
  assert.doesNotMatch(await html.text(), /<script>"/);
}
// 5. Ticket without a session id logs in and lands on the list.
{
  const { hub } = makeHub();
  const res = await post(hub, await sign(ticket({ s: undefined })));
  assert.equal(res.headers.get('location'), '/');
}
// 6. Verifier contract matches the gateway's signer exactly.
assert.equal((await verifyMagicTicket(await sign(ticket()), SECRET)).username, 'alice');
assert.equal(await verifyMagicTicket(await sign(ticket()), ''), null);
console.log('PASS: journal magic link logs into the right profile, one-time, preview-safe, forgery-proof');

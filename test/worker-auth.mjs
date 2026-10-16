// /web/auth: with agent delegation configured, the agent's per-profile password
// store is the only authority — a shared DEMO_PASSWORD must never log anyone in
// (it used to accept any `username`, i.e. a login-as-any-profile back door).
// Without delegation (pure demo deploy) DEMO_PASSWORD still works, but only
// for the default profile.
import assert from 'node:assert/strict';
import { SessionHub } from '../worker.mjs';

function makeHub(env) {
  const map = new Map();
  const storage = {
    list: async ({ prefix = '' } = {}) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
    get: async k => map.get(k), put: async (k, v) => { map.set(k, v); },
    delete: async k => { for (const x of [].concat(k)) map.delete(x); },
  };
  return { hub: new SessionHub({ blockConcurrencyWhile: fn => fn(), storage }, env), map };
}
const auth = (hub, b) => hub.fetch(new Request('https://app.example/web/auth', {
  method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }));
const realFetch = globalThis.fetch;
const DELEGATED = { AGENT_VERIFY_URL: 'https://agent.example/web/verify', AGENT_VERIFY_SECRET: 's', DEMO_PASSWORD: 'demo' };

try {
  // 1. Delegation on: agent rejects → DEMO_PASSWORD must NOT open any profile.
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  {
    const { hub, map } = makeHub(DELEGATED);
    assert.equal((await auth(hub, { username: 'victim', password: 'demo' })).status, 401);
    assert.equal([...map.keys()].some(k => k.startsWith('t:')), false);
  }
  // 2. Delegation on, agent unreachable → fails closed, even with DEMO_PASSWORD.
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  {
    const { hub } = makeHub(DELEGATED);
    assert.equal((await auth(hub, { username: 'victim', password: 'demo' })).status, 401);
  }
  // 3. Delegation on, agent accepts → token for exactly that profile.
  globalThis.fetch = async (_u, init) => {
    const { username, password } = JSON.parse(init.body);
    return new Response('{}', { status: username === 'alice' && password === 'pw' ? 200 : 401 });
  };
  {
    const { hub, map } = makeHub(DELEGATED);
    const res = await auth(hub, { username: 'alice', password: 'pw' });
    assert.equal(res.status, 200);
    const tok = res.headers.get('set-cookie').match(/web_token=([^;]+)/)[1];
    assert.equal(map.get(`t:${tok}`).username, 'alice');
  }
  // 4. Demo deploy (no delegation): DEMO_PASSWORD works but ignores `username`.
  {
    const { hub, map } = makeHub({ DEMO_PASSWORD: 'demo', AGENT_USERNAME: 'demo-profile' });
    const res = await auth(hub, { username: 'victim', password: 'demo' });
    assert.equal(res.status, 200);
    const tok = res.headers.get('set-cookie').match(/web_token=([^;]+)/)[1];
    assert.equal(map.get(`t:${tok}`).username, 'demo-profile');
    assert.equal((await auth(hub, { password: 'wrong' })).status, 401);
  }
  // 5. Telegram identity code is redeemed server-to-server and mints the same
  // HttpOnly web session, bound to the identity's legacy agent profile.
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://identity.example/v1/links/telegram/redeem');
    assert.equal(init.headers.authorization, 'Bearer web-client-secret');
    assert.deepEqual(JSON.parse(init.body), { code: '23456789ABCD' });
    return Response.json({ user_id: 'usr_0123456789abcdef0123456789abcdef', agent_username: 'alice' }, { status: 201 });
  };
  {
    const { hub, map } = makeHub({ IDENTITY_API_URL: 'https://identity.example', IDENTITY_WEB_CLIENT_TOKEN: 'web-client-secret' });
    const res = await auth(hub, { telegram_code: '23456789ABCD' });
    assert.equal(res.status, 200);
    const token = res.headers.get('set-cookie').match(/web_token=([^;]+)/)[1];
    assert.deepEqual(map.get(`t:${token}`), {
      at: map.get(`t:${token}`).at,
      username: 'alice',
      userId: 'usr_0123456789abcdef0123456789abcdef',
      via: 'telegram-identity',
    });
    assert.equal(res.headers.get('set-cookie').includes('HttpOnly'), true);
  }
  {
    const { hub } = makeHub({ IDENTITY_API_URL: 'https://identity.example', IDENTITY_WEB_CLIENT_TOKEN: 'web-client-secret' });
    assert.equal((await auth(hub, { telegram_code: 'not-a-valid-code' })).status, 401);
  }
  // 6. Self-service signup starts with server-side Identity exchange; PII and the
  // Identity bearer never appear in the Telegram URL or browser response.
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://identity.example/v1/signups/start');
    assert.equal(init.headers.authorization, 'Bearer web-client-secret');
    assert.deepEqual(JSON.parse(init.body), { email: 'a@example.com', display_name: 'Alice Example', nickname: 'alice' });
    return Response.json({ reference: 'a'.repeat(43), status: 'pending', expires_in_seconds: 1800 }, { status: 201 });
  };
  {
    const { hub } = makeHub({ IDENTITY_API_URL: 'https://identity.example', IDENTITY_WEB_CLIENT_TOKEN: 'web-client-secret', IDENTITY_TELEGRAM_BOT_USERNAME: 'sample_assist_bot' });
    const response = await hub.fetch(new Request('https://app.example/web/signup/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', display_name: 'Alice Example', nickname: 'alice' }),
    }));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      reference: 'a'.repeat(43), expires_in_seconds: 1800,
      telegram_url: `https://t.me/sample_assist_bot?start=signup_${'a'.repeat(43)}`,
    });
  }
  // 7. Confirmation polling mints the normal HttpOnly web cookie only after
  // Telegram confirmation and binds the session to the account nickname.
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://identity.example/v1/signups/status');
    assert.equal(init.headers.authorization, 'Bearer web-client-secret');
    assert.deepEqual(JSON.parse(init.body), { reference: 'b'.repeat(43) });
    return Response.json({ status: 'confirmed', user_id: 'usr_0123456789abcdef0123456789abcdef', nickname: 'alice' });
  };
  {
    const { hub, map } = makeHub({ IDENTITY_API_URL: 'https://identity.example', IDENTITY_WEB_CLIENT_TOKEN: 'web-client-secret' });
    const response = await hub.fetch(new Request('https://app.example/web/signup/status', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: 'b'.repeat(43) }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready', ok: true });
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    const token = response.headers.get('set-cookie').match(/web_token=([^;]+)/)[1];
    assert.equal(map.get(`t:${token}`).username, 'alice');
    assert.equal(map.get(`t:${token}`).via, 'telegram-signup');
  }
} finally { globalThis.fetch = realFetch; }
console.log('worker-auth: ok');

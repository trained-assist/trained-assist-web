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
} finally { globalThis.fetch = realFetch; }
console.log('worker-auth: ok');

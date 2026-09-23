// Regression test: POST /web/stop/:id used to only ever look at the worker's
// own local (demo/imported) session map — a real agent/Telegram session isn't
// in there, so "Остановить выполнение" silently no-op'd for every real
// session instead of reaching the agent's SIGTERM. Fixed by delegating to the
// agent's /web/stop-bearer, same fallback shape as /web/reply's delegation.
import assert from 'node:assert/strict';
import { SessionHub } from '../worker.mjs';

const savedFetch = globalThis.fetch;
const state = { blockConcurrencyWhile: fn => fn(), storage: { list: async () => new Map(), get: async () => undefined, put: async () => {} } };

function makeHub() {
  const hub = new SessionHub(state, { AGENT_VERIFY_URL: 'https://agent.example/web/verify', AGENT_VERIFY_SECRET: 'fixture' });
  hub.isAuthed = async () => true;
  hub.tokenUser = async () => 'owner';
  return hub;
}

try {
  // Local session → flips status, never touches the network.
  {
    const hub = makeHub();
    const s = hub.newSession('demo task');
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return new Response('{}'); };
    const res = await hub.fetch(new Request(`https://web.example/web/stop/${s.id}`, { method: 'POST' }));
    assert.equal(res.status, 200);
    assert.equal(hub.sessions.get(s.id).status, 'idle');
    assert.equal(fetchCalled, false, 'local session stop must not call the agent');
  }

  // Real (non-local) session → delegates to the agent's /web/stop-bearer.
  {
    const hub = makeHub();
    let calledWith = null;
    globalThis.fetch = async (url, opts) => {
      calledWith = { url, body: JSON.parse(opts.body) };
      return Response.json({ ok: true });
    };
    const res = await hub.fetch(new Request('https://web.example/web/stop/real-session-42', { method: 'POST' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.clone().json(), { ok: true });
    assert.equal(calledWith.url, 'https://agent.example/web/stop-bearer');
    assert.deepEqual(calledWith.body, { username: 'owner', id: 'real-session-42' });
  }

  // Agent unreachable → falls back to ok:true (old no-op behaviour), doesn't 500.
  {
    const hub = makeHub();
    globalThis.fetch = async () => { throw new Error('offline'); };
    const res = await hub.fetch(new Request('https://web.example/web/stop/real-session-99', { method: 'POST' }));
    assert.equal(res.status, 200);
  }

  console.log('PASS: /web/stop delegates real sessions to the agent, leaves local sessions alone');
} finally {
  globalThis.fetch = savedFetch;
}

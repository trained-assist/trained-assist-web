import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionHub } from '../worker.mjs';
import { formatLogLine, logError } from '../src/log.js';
import {
  createErrorPublisher,
  resolveErrorPublisher,
  getDroppedCount,
  getSpool,
} from '../src/error-publisher.js';

const c12Event = (over = {}) => ({
  schemaVersion: 1,
  eventId: 'E-1',
  occurredAt: '2026-10-07T00:00:00.000Z',
  source: { service: 'trained-assist-web', release: 'abc123', environment: 'production' },
  scope: { kind: 'platform', tenantId: null, profileId: null },
  correlation: { userTaskId: null, runId: null, traceId: null, requestId: 'req-1' },
  replyContext: { channel: 'web', destinationRef: null, status: 'web_only' },
  error: {
    code: 'AGENT_UNAVAILABLE',
    operation: '/web/run-bearer',
    severity: 'error',
    retryable: true,
    outcome: 'failed',
    safeSummary: 'fetch failed',
    privateDetailsRef: null,
  },
  origin: { kind: 'application', incidentId: null, diagnosticDepth: 0 },
  ...over,
});

test('formatLogLine: valid JSON line with service defaults and redacted sensitive fields', () => {
  const line = formatLogLine({
    event: 'SESSION_FETCH_FAILED',
    reason: 'offline',
    requestId: 'req-1',
    token: 'raw-token',
    authorization: 'Bearer raw-authorization',
    apikey: 'raw-apikey',
    secret: 'raw-secret',
    password: 'raw-password',
    text: 'raw-text',
    answer: 'raw-answer',
    payload: { nested: true, keep: 'visible' },
    headers: { password: 'raw-nested-password', retry: 3 },
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.service, 'trained-assist-web');
  assert.equal(parsed.environment, 'production');
  assert.equal(parsed.level, 'error');
  assert.ok(parsed.ts, 'ts present');
  assert.equal(parsed.event, 'SESSION_FETCH_FAILED');
  assert.equal(parsed.reason, 'offline');
  assert.equal(parsed.requestId, 'req-1');
  assert.equal(parsed.token, '[redacted]');
  assert.equal(parsed.authorization, '[redacted]');
  assert.equal(parsed.apikey, '[redacted]');
  assert.equal(parsed.secret, '[redacted]');
  assert.equal(parsed.password, '[redacted]');
  assert.equal(parsed.text, '[redacted]');
  assert.equal(parsed.answer, '[redacted]');
  assert.deepEqual(parsed.payload, '[redacted]');
  assert.equal(parsed.headers.password, '[redacted]');
  assert.equal(parsed.headers.retry, 3);
  for (const secret of ['raw-token', 'raw-authorization', 'raw-apikey', 'raw-secret', 'raw-password', 'raw-text', 'raw-answer', 'raw-nested-password']) {
    assert.ok(!line.includes(secret), `${secret} must not leak into the log line`);
  }

  const overridden = JSON.parse(formatLogLine({ service: 'other', environment: 'sandbox', level: 'warn' }));
  assert.equal(overridden.service, 'other');
  assert.equal(overridden.environment, 'sandbox');
  assert.equal(overridden.level, 'warn');
});

test('logError: writes the formatted line through the sink (stderr by default)', () => {
  let captured = null;
  const line = logError({ event: 'REPLY_FETCH_FAILED', reason: 'busy' }, (written) => { captured = written; });
  assert.equal(captured, line);
  const parsed = JSON.parse(captured);
  assert.equal(parsed.event, 'REPLY_FETCH_FAILED');
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.service, 'trained-assist-web');
});

test('publishError: POSTs the C12 ErrorEvent to the watcher /errors endpoint', async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"reasonCode":"EVENT_ACCEPTED"}', { status: 202 });
  };
  try {
    const publishError = createErrorPublisher({ watcherUrl: 'https://watcher.test', watcherKey: 'wk-1', environment: 'production' });
    await publishError(c12Event());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://watcher.test/errors');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.equal(calls[0].init.headers['x-watcher-key'], 'wk-1');
    assert.equal(calls[0].init.headers['x-watcher-scopes'], 'error:write');
    assert.ok(calls[0].init.signal, 'publish carries an abort signal');

    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, c12Event());
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.eventId, 'E-1');
    assert.equal(body.source.service, 'trained-assist-web');
    assert.equal(body.source.environment, 'production');
    assert.equal(body.scope.kind, 'platform');
    assert.equal(body.correlation.requestId, 'req-1');
    assert.equal(body.replyContext.status, 'web_only');
    assert.equal(body.error.code, 'AGENT_UNAVAILABLE');
    assert.equal(body.error.severity, 'error');
    assert.equal(body.error.outcome, 'failed');
    assert.equal(body.error.retryable, true);
    assert.ok(body.error.safeSummary.length <= 240);
    assert.equal(body.origin.kind, 'application');
    assert.equal(body.origin.diagnosticDepth, 0);

    await createErrorPublisher({ watcherUrl: 'https://watcher.test/errors', watcherKey: 'wk-1', environment: 'production' })(c12Event());
    assert.equal(calls[1].url, 'https://watcher.test/errors', 'an /errors URL is not doubled');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('publishError: fetch failure spools the event, bumps the dropped count and never throws', async () => {
  const savedFetch = globalThis.fetch;
  const droppedBefore = getDroppedCount();
  const publishError = createErrorPublisher({ watcherUrl: 'https://watcher.test', watcherKey: 'wk-1', environment: 'production' });
  try {
    globalThis.fetch = async () => { throw new Error('network down'); };
    await assert.doesNotReject(() => publishError(c12Event({ eventId: 'E-drop-net' })));
    assert.equal(getDroppedCount(), droppedBefore + 1);
    assert.equal(getSpool().at(-1).eventId, 'E-drop-net');

    globalThis.fetch = async () => new Response('unavailable', { status: 500 });
    await assert.doesNotReject(() => publishError(c12Event({ eventId: 'E-drop-http' })));
    assert.equal(getDroppedCount(), droppedBefore + 2);
    assert.equal(getSpool().at(-1).eventId, 'E-drop-http');
    assert.ok(getSpool().length <= 100, 'spool is bounded at 100 events');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('resolveErrorPublisher: null without the configured URL+key pair', () => {
  assert.equal(resolveErrorPublisher({}), null);
  assert.equal(resolveErrorPublisher(undefined), null);
  assert.equal(resolveErrorPublisher({ ERROR_WATCHER_URL: 'https://watcher.test' }), null);
  assert.equal(resolveErrorPublisher({ ERROR_WATCHER_KEY: 'wk-1' }), null);
  assert.equal(resolveErrorPublisher({ ERROR_WATCHER_URL: '   ', ERROR_WATCHER_KEY: 'wk-1' }), null);
  assert.equal(typeof resolveErrorPublisher({ ERROR_WATCHER_URL: 'https://watcher.test', ERROR_WATCHER_KEY: 'wk-1' }), 'function');
});

const hubFixture = (env = {}) => {
  const state = {
    blockConcurrencyWhile: (fn) => fn(),
    storage: { list: async () => new Map(), get: async () => undefined, put: async () => {} },
  };
  const hub = new SessionHub(state, {
    AGENT_VERIFY_URL: 'https://agent.example/web/verify',
    AGENT_VERIFY_SECRET: 'fixture',
    ...env,
  });
  hub.isAuthed = async () => true;
  hub.tokenUser = async () => 'alice';
  return hub;
};

const withCapturedLogs = async (fn) => {
  const lines = [];
  const saved = console.error;
  console.error = (line) => lines.push(line);
  try {
    await fn();
  } finally {
    console.error = saved;
  }
  return lines.filter((l) => typeof l === 'string' && l.startsWith('{')).map((l) => JSON.parse(l));
};

test('worker.mjs: key delegation failures emit structured error log lines', async () => {
  const savedFetch = globalThis.fetch;
  const hub = hubFixture();
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const sessionLines = await withCapturedLogs(async () => {
      const res = await hub.fetch(new Request('https://web.example/web/session/real-1'));
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'agent unavailable');
    });
    const sessionLine = sessionLines.find((l) => l.event === 'SESSION_FETCH_FAILED');
    assert.ok(sessionLine, 'SESSION_FETCH_FAILED log line emitted');
    assert.equal(sessionLine.service, 'trained-assist-web');
    assert.equal(sessionLine.environment, 'production');
    assert.equal(sessionLine.level, 'error');
    assert.equal(sessionLine.operation, 'agent_session');
    assert.equal(sessionLine.reason, 'offline');
    assert.equal(sessionLine.requestId, null);

    const runLines = await withCapturedLogs(async () => {
      const res = await hub.fetch(new Request('https://web.example/web/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'hi', requestId: 'req-run-1' }),
      }));
      assert.equal(res.status, 503);
      assert.equal(hub.sessions.size, 0, 'a failed run must not fall back to a local demo session');
    });
    const agentLine = runLines.find((l) => l.event === 'AGENT_UNAVAILABLE');
    assert.ok(agentLine, 'AGENT_UNAVAILABLE log line emitted on the write path');
    assert.equal(agentLine.operation, '/web/run-bearer');
    assert.equal(agentLine.requestId, 'req-run-1');
    assert.equal(agentLine.reason, 'offline');
    assert.equal(runLines.find((l) => l.event === 'RUN_FETCH_FAILED'), undefined, 'transport failure is reported once');

    globalThis.fetch = async () => Response.json({ error: 'busy' }, { status: 409 });
    const rejectLines = await withCapturedLogs(async () => {
      const res = await hub.fetch(new Request('https://web.example/web/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'hi', requestId: 'req-run-2' }),
      }));
      assert.equal(res.status, 409);
    });
    const runLine = rejectLines.find((l) => l.event === 'RUN_FETCH_FAILED');
    assert.ok(runLine, 'RUN_FETCH_FAILED log line emitted on upstream rejection');
    assert.equal(runLine.requestId, 'req-run-2');
    assert.equal(runLine.reason, 'busy');
    assert.equal(runLine.level, 'error');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('worker.mjs: reply vs supplement failures are told apart and carry requestId', async () => {
  const savedFetch = globalThis.fetch;
  const hub = hubFixture();
  globalThis.fetch = async () => Response.json({ error: 'session busy' }, { status: 409 });
  try {
    const supplementLines = await withCapturedLogs(async () => {
      const res = await hub.fetch(new Request('https://web.example/web/reply/real-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'continue', requestId: 'req-sup-1' }),
      }));
      assert.equal(res.status, 409);
    });
    const supplementLine = supplementLines.find((l) => l.event === 'SUPPLEMENT_FETCH_FAILED');
    assert.ok(supplementLine, 'message+requestId body without attachments is the supplement flow');
    assert.equal(supplementLine.requestId, 'req-sup-1');
    assert.equal(supplementLine.operation, 'supplement');
    assert.equal(supplementLine.reason, 'session busy');

    const replyLines = await withCapturedLogs(async () => {
      const res = await hub.fetch(new Request('https://web.example/web/reply/real-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'continue', attachments: [], requestId: 'req-reply-1' }),
      }));
      assert.equal(res.status, 409);
    });
    const replyLine = replyLines.find((l) => l.event === 'REPLY_FETCH_FAILED');
    assert.ok(replyLine, 'a reply with attachments is the reply flow');
    assert.equal(replyLine.requestId, 'req-reply-1');
    assert.equal(replyLine.operation, 'reply');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('worker.mjs: reported failures are published to the Error Watcher as C12 events', async () => {
  const savedFetch = globalThis.fetch;
  const calls = [];
  const hub = hubFixture({ ERROR_WATCHER_URL: 'https://watcher.test', ERROR_WATCHER_KEY: 'wk-1' });
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://watcher.test')) {
      calls.push({ url, init });
      return new Response('{"reasonCode":"EVENT_ACCEPTED"}', { status: 202 });
    }
    return Response.json({ error: 'session busy' }, { status: 409 });
  };
  try {
    await withCapturedLogs(async () => {
      const res = await hub.fetch(new Request('https://web.example/web/reply/real-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'continue', attachments: [], requestId: 'req-pub-1' }),
      }));
      assert.equal(res.status, 409);
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(calls.length, 1, 'one fire-and-forget publish per failure');
    assert.equal(calls[0].url, 'https://watcher.test/errors');
    assert.equal(calls[0].init.headers['x-watcher-key'], 'wk-1');
    assert.equal(calls[0].init.headers['x-watcher-scopes'], 'error:write');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.source.service, 'trained-assist-web');
    assert.equal(body.source.environment, 'production');
    assert.equal(body.scope.kind, 'platform');
    assert.equal(body.correlation.requestId, 'req-pub-1');
    assert.equal(body.replyContext.status, 'web_only');
    assert.equal(body.error.code, 'REPLY_FETCH_FAILED');
    assert.equal(body.error.severity, 'error');
    assert.equal(body.error.outcome, 'failed');
    assert.equal(body.error.retryable, true);
    assert.equal(body.origin.kind, 'application');
    assert.equal(body.origin.diagnosticDepth, 0);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

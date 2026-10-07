import { redactValue } from './log.js';

const DEFAULT_SERVICE = 'trained-assist-web';
const DEFAULT_ENVIRONMENT = 'production';
const WATCHER_SCOPES = 'error:write';
const PUBLISH_TIMEOUT_MS = 5000;
const SPOOL_MAX_ENTRIES = 100;

let spool = [];
let droppedCount = 0;

export function getDroppedCount() {
  return droppedCount;
}

export function getSpool() {
  return [...spool];
}

export function resolveErrorPublisher(env) {
  const watcherUrl = String((env && env.ERROR_WATCHER_URL) || '').trim();
  const watcherKey = String((env && env.ERROR_WATCHER_KEY) || '').trim();
  if (!watcherUrl || !watcherKey) return null;
  return createErrorPublisher({ watcherUrl, watcherKey, environment: DEFAULT_ENVIRONMENT });
}

export function createErrorPublisher({ watcherUrl, watcherKey, environment = DEFAULT_ENVIRONMENT }) {
  const endpoint = toEndpoint(watcherUrl);
  return async function publishError(event) {
    let payload = event;
    try {
      payload = redactValue({
        ...event,
        source: { service: DEFAULT_SERVICE, ...(event && event.source), environment },
      });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-watcher-key': watcherKey,
          'x-watcher-scopes': WATCHER_SCOPES,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      if (response.ok) return;
    } catch {
      // Transport/timeout/serialization failure — the event is spooled below.
    }
    spoolEvent(payload);
  };
}

function toEndpoint(watcherUrl) {
  const base = String(watcherUrl).replace(/\/+$/, '');
  return base.endsWith('/errors') ? base : `${base}/errors`;
}

function spoolEvent(event) {
  spool.push(event);
  if (spool.length > SPOOL_MAX_ENTRIES) spool.shift();
  droppedCount += 1;
}

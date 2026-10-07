const DEFAULT_SERVICE = 'trained-assist-web';
const DEFAULT_ENVIRONMENT = 'production';

const SENSITIVE_KEYS = new Set(['token', 'secret', 'password', 'authorization', 'apikey', 'text', 'answer', 'payload']);

export function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[redacted]' : redactValue(entry);
    }
    return out;
  }
  return value;
}

export function formatLogLine(fields = {}) {
  const { level = 'error', service = DEFAULT_SERVICE, environment = DEFAULT_ENVIRONMENT, ...rest } = fields || {};
  return JSON.stringify({ ts: new Date().toISOString(), service, environment, level, ...redactValue(rest) });
}

export function logError(fields = {}, sink = null) {
  const line = formatLogLine(fields);
  if (typeof sink === 'function') sink(line);
  else if (sink && typeof sink.write === 'function') sink.write(line);
  else console.error(line);
  return line;
}

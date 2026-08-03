const SECRET_KEY = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie|set-cookie)/i;
const BEARER_VALUE = /^\s*(?:bearer|basic)\s+\S+/i;

export const REDACTED = '[REDACTED]';

export function redactTranscriptValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return BEARER_VALUE.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map(item => redactTranscriptValue(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactTranscriptValue(childValue, childKey);
    }
    return out;
  }
  return value;
}

import { errorText } from '../redact.js';

// Project diagnostics only; assistant content and durable checkpoints stay intact.
export function errorMessage(message, env) {
  if (!message || typeof message !== 'object') return errorText(message, env);
  return { ...message,
    ...(message.errorMessage !== undefined ? { errorMessage: errorText(message.errorMessage, env) } : {}),
    ...(message.error ? { error: errorRecord(message.error, env) } : {}) };
}

export function errorRecord(value, env) {
  if (typeof value === 'string') return errorText(value, env);
  if (Array.isArray(value)) return value.map(item => errorRecord(item, env));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, errorRecord(item, env)]));
}

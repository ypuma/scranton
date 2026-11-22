import { createHash, randomUUID } from 'node:crypto';
import { googleBody } from './google-generative.js';
import { protocolError } from './errors.js';

export const ANTIGRAVITY_USER_AGENT = 'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)';
export function antigravityRequest(model, context, options, auth) {
  if (auth.type !== 'oauth' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(auth.projectId ?? '')) throw Object.assign(protocolError(), { code: 'AUTH_REQUIRED' });
  const level = model.thinkingLevelMap?.[options.reasoning] ?? (['minimal', 'low', 'off', undefined].includes(options.reasoning) ? 'low' : 'high');
  return { url: `${model.baseUrl.replace(/\/$/, '')}/v1internal:streamGenerateContent?alt=sse`,
    headers: { Authorization: `Bearer ${auth.access}`, 'User-Agent': ANTIGRAVITY_USER_AGENT },
    body: { project: auth.projectId, model: model.wireModels?.[level] ?? model.id,
      requestType: 'agent', userAgent: 'antigravity', requestId: `agent-${randomUUID()}`,
      request: { ...googleBody(model, context, options), sessionId: `scranton-${createHash('sha256').update(JSON.stringify(context.messages.find(m => m.role === 'user') ?? [])).digest('hex').slice(0, 32)}` } } };
}

import { googleBody } from './google-generative.js';
import { protocolError } from './errors.js';

export function vertexRequest(model, context, options, auth) {
  if (auth.type !== 'api_key') throw Object.assign(protocolError(), { code: 'AUTH_REQUIRED' });
  return { url: `${model.baseUrl.replace(/\/$/, '')}/publishers/google/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
    headers: { 'x-goog-api-key': auth.key }, body: googleBody(model, context, options) };
}

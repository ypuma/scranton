import { resolveModel, chatgptModels, isChatGPT } from './catalogue.js';
import { Blocks, createResultStream } from './stream.js';
import { jsonEvents } from './sse.js';
import { protocolError, httpError } from './errors.js';
import { reasoningLevel } from './reasoning.js';
import { anthropicRequest, anthropicEvents } from './anthropic-messages.js';
import { responsesRequest, responsesEvents } from './openai-responses.js';
import { completionsRequest, completionsEvents } from './openai-completions.js';
import { googleRequest, googleEvents } from './google-generative.js';
import { vertexRequest } from './google-vertex.js';
import { antigravityRequest } from './google-antigravity.js';

export { createScriptedProvider } from './scripted.js';
export { models, getModel, resolveModel, calculateCost } from './catalogue.js';
export { classifyError } from './errors.js';
export { parseSSE } from './sse.js';

const clients = {
  'anthropic-messages': [anthropicRequest, anthropicEvents],
  'openai-responses': [responsesRequest, responsesEvents],
  'openai-completions': [completionsRequest, completionsEvents],
  'google-generative': [googleRequest, googleEvents],
  'google-vertex': [vertexRequest, googleEvents],
  'google-generative-ai': [googleRequest, googleEvents],
  'google-antigravity': [antigravityRequest, (events, blocks, output) => googleEvents(events, blocks, output, { envelope: true })]
};

async function resolveWithSignal(resolve, provider, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => resolve(provider)), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function createLLM({ resolveAuth = () => undefined, fetcher = (...args) => fetch(...args) } = {}) {
  const stream = (ref, context, options = {}) => {
    let model;
    try { model = resolveModel(ref); } catch { model = { ...ref, api: 'unknown' }; }
    return createResultStream(model, options, async function* (output, signal) {
      const client = clients[model.api];
      if (!client) throw protocolError('Unsupported provider API');
      const auth = options.auth ?? await resolveWithSignal(resolveAuth, model.provider, signal);
      signal.throwIfAborted();
      if (model.provider === 'openai' && isChatGPT(auth)) {
        const supported = chatgptModels.find(m => m.id === model.id);
        if (!supported) throw Object.assign(protocolError(), { code: 'MODEL_NOT_AVAILABLE' });
        model = { ...model, ...supported, baseUrl: model.baseUrl };
      }
      const token = auth?.type === 'api_key' ? auth.key : auth?.type === 'oauth' ? auth.access : null;
      if (typeof token !== 'string' || !token || /[\x00-\x20\x7f]/.test(token)) throw Object.assign(protocolError(), { code: 'AUTH_REQUIRED' });
      const [request, map] = client;
      const { url, headers, body } = request(model, context, { ...options, reasoning: reasoningLevel(model, options.reasoning) }, auth);
      const target = new URL(url);
      if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) || target.username || target.password) throw protocolError('Invalid provider URL');
      const response = await fetcher(url, { method: 'POST', redirect: 'error', signal,
        headers: { ...model.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers }, body: JSON.stringify(body) });
      if (!response.ok) throw await httpError(response);
      try {
        yield* map(jsonEvents(response.body, { signal }), new Blocks(output), output, context);
      } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    });
  };
  return { stream, complete: (model, context, options) => stream(model, context, options).result() };
}

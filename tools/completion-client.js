import { createCredentials } from '../src/core/credentials/index.js';
import { createLLM, getModel } from '../src/core/llm/index.js';
import { protocolError } from '../src/core/llm/errors.js';
import { errorTail } from '../src/core/redact.js';

export function completionError(error, env = process.env) {
  return errorTail(error?.message ?? error, env);
}

export function completionModel(credentials, ref) {
  const provider = credentials.store.read().providers[ref.provider];
  if (!provider) {
    const model = getModel(ref.provider, ref.model);
    if (!model) throw protocolError('Unknown completion model');
    return model;
  }
  const model = provider.models.find((m) => m.id === ref.model);
  if (!model) throw protocolError('Unknown completion model');
  return { contextWindow: 128000, maxTokens: 8192, ...model, provider: provider.id, api: provider.api, baseUrl: provider.baseUrl };
}

export function validateCompletionPayload(api, payload, limit) {
  if (api === 'google-antigravity') payload = payload.request;
  const caps = api === 'anthropic-messages' ? [payload.max_tokens]
    : api === 'openai-completions' ? [payload.max_tokens, payload.max_completion_tokens].filter((v) => v !== undefined)
    : api === 'openai-responses' ? [payload.max_output_tokens]
    : ['google-generative', 'google-generative-ai', 'google-antigravity'].includes(api) ? [payload.generationConfig?.maxOutputTokens] : [];
  if (limit !== undefined && (!caps.length || caps.some((v) => !Number.isInteger(v) || v < 1 || v > limit)) ||
      [payload.tools, payload.config?.tools, payload.toolConfig?.tools].some((v) => v !== undefined && (!Array.isArray(v) || v.length))) throw protocolError();
}

export async function createCompletionClient(ref, limit, { credentialsFactory = createCredentials, fetcher = (...args) => fetch(...args) } = {}) {
  const credentials = await credentialsFactory();
  try {
    const model = completionModel(credentials, ref);
    const llm = createLLM({ resolveAuth: credentials.resolveAuth, fetcher: (url, init) => {
      validateCompletionPayload(model.api, JSON.parse(init.body), limit);
      return fetcher(url, init);
    } });
    return { model, llm, close: () => credentials.close() };
  } catch (error) { await credentials.close(); throw error; }
}

export function completionUsage(u) {
  if (!u || !['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => Number.isSafeInteger(u[k] ?? 0) && (u[k] ?? 0) >= 0)) return null;
  const inputTokens = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return inputTokens || u.output ? { inputTokens, outputTokens: u.output } : null;
}

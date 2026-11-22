import { getModel, resolveModel } from '../llm/index.js';

export const AUTOMATIC_MODELS = Object.freeze([
  ['anthropic', 'claude-sonnet-4-5'],
  ['openai', 'gpt-5.3-codex'],
  ['google', 'gemini-2.5-pro'],
  ['google-antigravity', 'gemini-3-pro'],
].map(([provider, model]) => Object.freeze({ provider, model })));

export function selectModel(config, credentials) {
  if (config.provider || config.model) {
    if (!config.provider || !config.model) throw new Error('Both agent provider and model are required');
    const custom = credentials?.store.read().providers?.[config.provider];
    if (custom) {
      const model = custom.models.find(m => m.id === config.model);
      if (!model) throw new Error('Unknown custom provider model');
      return { ...model, provider: custom.id, api: custom.api, baseUrl: custom.baseUrl,
        contextWindow: model.contextWindow ?? 128000, maxTokens: model.maxTokens ?? 8192 };
    }
    return resolveModel(config);
  }
  const accounts = credentials?.listAccounts() ?? [];
  const ref = AUTOMATIC_MODELS.find(ref => accounts.some(a => a.id === ref.provider && a.status === 'signed_in'));
  if (!ref) throw new Error('Automatic model selection requires a signed-in supported provider');
  const model = getModel(ref.provider, ref.model);
  if (!model) throw new Error('Pinned Automatic model is missing from the catalogue');
  return model;
}

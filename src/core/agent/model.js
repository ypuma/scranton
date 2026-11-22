import { resolveModel } from '../llm/index.js';
import { accountModels, newestModels, isChatGPT } from '../llm/catalogue.js';

export const AUTOMATIC_MODELS = Object.freeze([
  ...['anthropic', 'openai', 'google', 'google-antigravity', 'google-vertex'].map(provider => [provider, newestModels[provider]]),
].map(([provider, model]) => Object.freeze({ provider, model })));

export function selectModel(config, credentials) {
  if (config.provider || config.model) {
    if (!config.provider || !config.model) throw new Error('Both agent provider and model are required');
    const custom = credentials?.store?.read().providers?.[config.provider];
    if (custom) {
      const model = custom.models.find(m => m.id === config.model);
      if (!model) throw new Error('Unknown custom provider model');
      return { ...model, provider: custom.id, api: custom.api, baseUrl: custom.baseUrl,
        contextWindow: model.contextWindow ?? 128000, maxTokens: model.maxTokens ?? 8192 };
    }
    const account = credentials?.listAccounts?.().find(a => a.id === config.provider);
    if (config.provider === 'openai' && isChatGPT(account)) {
      const model = accountModels('openai', account).find(m => m.id === config.model);
      if (!model) throw new Error('ChatGPT model unavailable; select a model offered for your signed-in account');
      return model;
    }
    return resolveModel(config);
  }
  const accounts = credentials?.listAccounts() ?? [];
  const ref = AUTOMATIC_MODELS.find(ref => accounts.some(a => a.id === ref.provider && a.status === 'signed_in'));
  if (!ref) throw new Error('Automatic model selection requires a signed-in supported provider');
  const account = accounts.find(a => a.id === ref.provider);
  const model = accountModels(ref.provider, account).find(m => m.id === ref.model);
  if (!model) throw new Error('Pinned Automatic model is missing from the catalogue');
  return model;
}

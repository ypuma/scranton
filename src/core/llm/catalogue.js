import snapshot from './models.json' with { type: 'json' };
import accounts from './account-models.json' with { type: 'json' };

function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const chatgptModels = freeze(accounts.chatgpt);
export const models = freeze([...snapshot, ...accounts.vertex, ...accounts.openai, ...['gemini-3.8-flash'].map(id => ({ id, name: `${id} (Antigravity)`, provider: 'google-antigravity', api: 'google-antigravity', baseUrl: 'https://daily-cloudcode-pa.googleapis.com', contextWindow: 1048576, maxTokens: 65536, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { minimal: 'low', low: 'low', medium: id === 'gemini-3.8-flash' ? 'medium' : 'high', high: 'high' }, ...(id === 'gemini-3.8-flash' ? { wireModels: { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' } } : {}) }))]);
export const newestModels = freeze({ anthropic: 'claude-opus-5-5', openai: 'gpt-6.2-sol', google: 'gemini-4-argon', 'google-antigravity': 'gemini-3.8-flash', 'google-vertex': 'gemini-4-argon' });
export const isChatGPT = auth => auth?.mode === 'chatgpt';
export const accountModels = (provider, auth) => provider === 'openai' && isChatGPT(auth) ? chatgptModels : models.filter(m => m.provider === provider);
export const getModel = (provider, id) => models.find(m => m.provider === provider && m.id === id);
export function resolveModel(ref) {
  if (ref?.id && ref?.api && ref?.baseUrl) return ref;
  const model = getModel(ref?.provider, ref?.model ?? ref?.id);
  if (!model) throw new Error('Unknown provider/model reference');
  return model;
}

export function calculateCost(model, usage) {
  let rates = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, threshold = -1;
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  for (const tier of rates.tiers ?? []) {
    if (input > tier.inputTokensAbove && tier.inputTokensAbove > threshold) { threshold = tier.inputTokensAbove; rates = tier; }
  }
  const long = usage.cacheWrite1h ?? 0;
  const cost = { input: rates.input * usage.input / 1e6, output: rates.output * usage.output / 1e6,
    cacheRead: rates.cacheRead * usage.cacheRead / 1e6, cacheWrite: (rates.cacheWrite * (usage.cacheWrite - long) + rates.input * 2 * long) / 1e6 };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  cost.totalFromProvider = false;
  usage.cost = cost;
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return cost;
}

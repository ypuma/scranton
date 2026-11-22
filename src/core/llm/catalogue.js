import snapshot from './models.json' with { type: 'json' };

function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const models = freeze([...snapshot, ...['gemini-3-pro', 'gemini-3-flash'].map(id => ({ id, name: `${id} (Antigravity)`, provider: 'google-antigravity', api: 'google-antigravity', baseUrl: 'https://daily-cloudcode-pa.googleapis.com', contextWindow: 1048576, maxTokens: 65536, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { minimal: 'low', low: 'low', medium: 'high', high: 'high' } }))]);
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

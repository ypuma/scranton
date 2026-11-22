import { models as catalogue, getModel } from './llm/catalogue.js';
import { createProviderStore } from './providers.js';
import { LIMITS } from './context/limits.js';

const valid = (value) => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f-\x9f]/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const registry = () => ({ getAllModels: () => catalogue, getModel });
const providerStore = () => createProviderStore();

export function modelId(ref) {
  try {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !valid(ref.model) || ref.provider != null && !valid(ref.provider)) return null;
    return ref.provider == null ? ref.model : `${ref.provider}/${ref.model}`;
  } catch { return null; }
}

export function createModelWindows({ providers, runtime } = {}) {
  let loaded;
  const load = () => loaded ??= Promise.resolve().then(() => runtime === undefined ? registry() : typeof runtime === 'function' ? runtime() : runtime).catch(() => null);
  const windowOf = (models) => {
    if (!models.length || models.some((m) => !positive(m.contextWindow))) return null;
    const windows = new Set(models.map((m) => m.contextWindow));
    return windows.size === 1 ? models[0].contextWindow : null;
  };
  return { warm() { void load(); }, async resolve(ref) {
    const id = modelId(ref), unknown = { id, window: LIMITS.window, known: false };
    if (id === null) return unknown;
    try {
      let custom = [];
      try { custom = await (typeof providers === 'function' ? providers() : (providers ?? providerStore()).list()); } catch {}
      const matches = custom.filter((p) => p.status !== 'error' && (ref.provider == null || p.id === ref.provider))
        .flatMap((p) => (p.models ?? []).filter((m) => m.id === ref.model));
      const declared = windowOf(matches);
      if (declared !== null) return { id, window: declared, known: true };
      const r = await load();
      const models = ref.provider == null ? (r?.getAllModels() ?? []).filter((m) => m.id === ref.model) : [r?.getModel(ref.provider, ref.model)].filter(Boolean);
      const window = windowOf(models);
      return window === null ? unknown : { id, window, known: true };
    } catch { return unknown; }
  } };
}

// What the human set for this computer: how the page looks and moves, and what the New run form starts with.
// Parsing only, with no storage and no DOM, so the forms and the page can both read it.
export const PREFS_KEY = 'scranton.prefs';
export const RUN_DEFAULTS_KEY = 'scranton.runDefaults';

export const DENSITIES = ['compact', 'comfortable', 'airy'];
export const MOTIONS = ['off', 'subtle', 'lively'];
export const PREF_DEFAULTS = Object.freeze({ density: 'comfortable', motion: 'lively', color: true });

function object(raw) {
  try {
    const v = JSON.parse(raw ?? '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Anything stored that is not one of the choices is the default.
export function parsePrefs(raw) {
  const v = object(raw);
  return {
    density: DENSITIES.includes(v.density) ? v.density : PREF_DEFAULTS.density,
    motion: MOTIONS.includes(v.motion) ? v.motion : PREF_DEFAULTS.motion,
    color: typeof v.color === 'boolean' ? v.color : PREF_DEFAULTS.color,
  };
}

// The page reads the choices from attributes of the root element; a default leaves none.
export function applyPrefs(root, prefs) {
  const set = (name, value, standard) => {
    if (value === standard) delete root.dataset[name];
    else root.dataset[name] = value;
  };
  set('density', prefs.density, PREF_DEFAULTS.density);
  set('motion', prefs.motion, PREF_DEFAULTS.motion);
  set('color', prefs.color ? 'on' : 'off', 'on');
}

// 1-32 milestones, as the run form accepts them; null: no number of that kind
export function parseParallel(text) {
  const s = String(text ?? '').trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 32 ? n : null;
}

// Only the fields the human set, so the rest stays what the project's configuration says. A trusted host as the
// default preselects the option; the acknowledgement is never stored.
export function parseRunDefaults(raw) {
  const v = object(raw);
  const out = {};
  const parallel = parseParallel(v.maxParallel);
  if (parallel !== null) out.maxParallel = parallel;
  if (v.sandbox === 'scranton' || v.sandbox === 'docker' || v.sandbox === 'host') out.sandbox = v.sandbox;
  return out;
}

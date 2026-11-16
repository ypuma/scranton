// The acknowledgement that agents (or checks) run on this computer without a sandbox is asked once per chat: a chat
// whose run started with it keeps it, on this computer, so its next requests do not ask again. A new chat asks.
// Only the fact is stored, per chat; unticking the box and starting a run in Docker never removes it, removing the
// chat's entry does (forgetTrust).
export const TRUST_KEY = 'scranton.trustedChats';
const MAX = 200;

// 'project/chat' for a chat of a project; 'single' for the one chat of a server without projects; null: no chat
export function trustKey(scope, { projects = true } = {}) {
  if (!projects) return 'single';
  const { project, chat } = scope ?? {};
  return typeof project === 'string' && project && typeof chat === 'string' && chat ? `${project}/${chat}` : null;
}

// The stored list, newest last; anything else is an empty list.
export function parseTrusted(raw) {
  try {
    const v = JSON.parse(raw ?? '');
    return Array.isArray(v) ? [...new Set(v.filter((k) => typeof k === 'string' && k && k.length <= 300))].slice(-MAX) : [];
  } catch {
    return [];
  }
}

export const isTrusted = (store, key) => Boolean(key) && parseTrusted(store.get(TRUST_KEY)).includes(key);

export function rememberTrust(store, key) {
  if (!key) return;
  const list = parseTrusted(store.get(TRUST_KEY)).filter((k) => k !== key);
  store.set(TRUST_KEY, JSON.stringify([...list, key].slice(-MAX)));
}

export function forgetTrust(store, key) {
  store.set(TRUST_KEY, JSON.stringify(parseTrusted(store.get(TRUST_KEY)).filter((k) => k !== key)));
}

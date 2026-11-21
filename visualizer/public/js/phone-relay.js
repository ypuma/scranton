// What Settings knows about the phone relay (docs/RELAY.md), without the DOM: the local hint for the dashboard on
// this computer and the proof that this browser is a phone paired through the relay.
export const RELAY_SESSION = '/_relay/session';
export const RELAY_LOGOUT = '/_relay/logout';
export const RELAY_HOST = 'https://YOUR-PRIVATE-HOST';

// The relay attaches to 127.0.0.1 only. Names that always resolve there work; another loopback address does not.
export function relayTarget(loc) {
  if (loc?.protocol !== 'http:') return null;
  const host = String(loc.hostname ?? '').toLowerCase();
  const port = loc.port || '80';
  if (!/^\d{1,5}$/.test(port)) return null;
  if (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost')) return { port, attached: true };
  if (host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return { port, attached: false };
  return null;
}

export function relayCommands(port) {
  const args = `relay --origin ${RELAY_HOST} --target-port ${port}`;
  return { checkout: `node bin/scranton.js ${args}`, windows: `.\\scranton-node.exe .\\app\\bin\\scranton.js ${args}` };
}

// The relay is only ever reached over HTTPS; a local or static page never asks for its session.
export const mayBeRelay = (loc) => loc?.protocol === 'https:';

// Paired only on a positive answer; anything else (no relay, 401, HTML, a network error) is no proof.
export async function relayPaired(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(RELAY_SESSION, {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    if (!res?.ok) return false;
    const doc = await res.json();
    return doc?.paired === true;
  } catch {
    return false;
  }
}

// The /live poll (.enma/live-activity-contract.md section 3): what the models of the run on screen are producing
// right now. Asked once a second, only while that run is live and the page is visible. A server without the route
// answers 404: the feature is then quietly off for that chat, and any other failure hides the tails until an
// answer comes again.
import { CLIENT_HEADERS } from './control.js';
import { parseLive } from './activity-model.js';

export const LIVE_POLL_MS = 1000;
export const LIVE_RETRY_MS = 5000;

// url(): where to ask, or null. wanted(): the run on screen is live. onChange(): what get() returns changed.
// get() -> { doc, at } (parseLive of the newest answer and when it came) or null.
export function createLivePoll({
  url, wanted, onChange = null, fetch: ask = (...a) => globalThis.fetch(...a), timers = globalThis, doc = globalThis.document, now = Date.now,
}) {
  let timer = 0;
  let inflight = false;
  let gen = 0;
  // the address that answered 404
  let off = null;
  let state = null;
  let shown = '';

  const due = () => {
    const at = url();
    return Boolean(at) && at !== off && wanted() && doc?.visibilityState !== 'hidden';
  };

  function set(next) {
    const key = next ? JSON.stringify(next.doc) : '';
    state = next;
    // an answer that says the same keeps the tails fresh without drawing anything again
    if (key === shown) return;
    shown = key;
    onChange?.();
  }

  async function poll() {
    const at = url();
    const mine = gen;
    let wait = LIVE_POLL_MS;
    inflight = true;
    try {
      const r = await ask(at, { cache: 'no-store', headers: CLIENT_HEADERS });
      if (mine !== gen) return;
      if (r.status === 404) off = at;
      const parsed = r.ok ? parseLive(await r.json().catch(() => null)) : null;
      if (mine !== gen) return;
      set(parsed ? { doc: parsed, at: now() } : null);
      if (!parsed) wait = LIVE_RETRY_MS;
    } catch {
      if (mine !== gen) return;
      set(null);
      wait = LIVE_RETRY_MS;
    } finally {
      if (mine === gen) {
        inflight = false;
        timer = timers.setTimeout(() => {
          timer = 0;
          sync();
        }, wait);
      }
    }
  }

  // Called whenever the page may have changed its mind: starts, keeps or stops the poll.
  function sync() {
    if (!due()) {
      timers.clearTimeout(timer);
      timer = 0;
      if (!inflight) set(null);
      return;
    }
    if (!timer && !inflight) poll();
  }

  doc?.addEventListener?.('visibilitychange', sync);

  return {
    sync,
    get: () => state,
    // the server of this chat has no /live route
    off: () => off !== null && off === url(),
    // another chat or run: nothing of the previous one is shown, and its 404 says nothing about this one
    reset() {
      gen += 1;
      timers.clearTimeout(timer);
      timer = 0;
      inflight = false;
      off = null;
      state = null;
      shown = '';
    },
  };
}

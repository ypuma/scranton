// Tool calls waiting for a human (approvals.js): one card per pending call, docked under the answer panel. The list
// is read about once a second while a run of the chat on screen is going; Approve and Deny post the verdict once per
// call. Every answer is checked against the chat it was asked for, so a late one paints nothing into another chat.
// Model text only ever becomes text nodes.
import { CLIENT_HEADERS, CONTROL_HEADERS } from './control.js';
import {
  APPROVALS_POLL_MS, APPROVALS_RETRY_MS, BADGE, parseApprovals, callView, whoText, secondsLeft, countdownText, askedText,
  buildVerdict, verdictText, verdictError,
} from './approvals.js';
import { isAccess, accessCard } from './access.js';

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function say(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// url(): the chat's approvals route, or null. wanted(): a run of the chat on screen is going and can be answered.
// getState(): the reducer state, for agent names. announce(text): the page's polite announcer.
export function createApprovals({
  url, wanted, getState = () => null, announce = () => {}, onChange = () => {},
  fetch: ask = (...a) => globalThis.fetch(...a), timers = globalThis, now = Date.now,
}) {
  const e = { box: $('approvals'), list: $('approvals-list') };
  let gen = 0;
  let timer = 0;
  let inflight = false;
  // the address that answered 404: a server without approvals
  let off = null;
  let items = [];
  // key -> the nodes of its card
  const cards = new Map();
  // key -> the verdict on its way, the verdict the server took, or why it did not
  const sending = new Map();
  const answered = new Map();
  const errors = new Map();
  const asked = new Set();

  const due = () => {
    const at = url();
    return Boolean(at) && at !== off && wanted();
  };

  async function get(at) {
    try {
      const r = await ask(at, { cache: 'no-store', headers: CLIENT_HEADERS });
      let data = null;
      try { data = await r.json(); } catch { /* empty or non-JSON body */ }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  async function post(at, body) {
    try {
      const r = await ask(at, { method: 'POST', cache: 'no-store', headers: CONTROL_HEADERS, body: JSON.stringify(body) });
      let data = null;
      try { data = await r.json(); } catch { /* empty or non-JSON body */ }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  function adopt(next) {
    const keys = new Set(next.map((a) => a.key));
    for (const m of [answered, errors]) for (const k of [...m.keys()]) if (!keys.has(k)) m.delete(k);
    const fresh = next.filter((a) => !asked.has(a.key));
    for (const a of fresh) asked.add(a.key);
    items = next;
    if (fresh.length) announce(fresh.map((a) => askedText(a, getState())).join(' '));
  }

  async function poll() {
    const at = url();
    const mine = gen;
    let wait = APPROVALS_POLL_MS;
    inflight = true;
    const r = await get(at);
    if (mine !== gen) return;
    inflight = false;
    if (r.status === 404) {
      off = at;
      items = [];
    } else {
      const list = r.ok ? parseApprovals(r.data) : null;
      // a failed reading keeps the cards: the calls are still waiting as far as anyone knows
      if (list) adopt(list);
      else wait = APPROVALS_RETRY_MS;
    }
    render();
    timer = timers.setTimeout(() => {
      timer = 0;
      sync();
    }, wait);
  }

  function sync() {
    if (!due()) {
      timers.clearTimeout(timer);
      timer = 0;
      if (items.length && !inflight) {
        items = [];
        render();
      }
      return;
    }
    if (!timer && !inflight) poll();
  }

  // read again now, e.g. after a verdict
  function refresh() {
    if (inflight || !due()) return;
    timers.clearTimeout(timer);
    timer = 0;
    poll();
  }

  // verdict: 'approve' | 'deny', or the grant of a request_access: 'read' | 'write'
  async function decide(key, verdict) {
    if (sending.has(key) || answered.has(key)) return;
    const a = items.find((x) => x.key === key);
    const at = url();
    if (!a || !at || secondsLeft(a, now()) === 0) return;
    const approved = verdict !== 'deny';
    const body = buildVerdict(a, approved, isAccess(a) ? verdict : null).body;
    const said = body.grant ?? approved;
    const mine = gen;
    sending.set(key, said);
    errors.delete(key);
    render();
    const r = await post(at, body);
    if (mine !== gen) return;
    sending.delete(key);
    if (r.ok) {
      answered.set(key, said);
      announce(verdictText(said));
    } else {
      errors.set(key, verdictError(r.status, r.data));
      announce(errors.get(key));
    }
    render();
    refresh();
  }

  function card() {
    const c = {
      li: el('li', 'approval-card'), badge: el('span', 'approval-badge', BADGE), who: el('span', 'approval-who'),
      left: el('span', 'hitl-meta approval-left'), title: el('p', 'approval-title'), label: el('span', 'field-label approval-label'),
      args: el('pre', 'approval-args mono'), asked: el('p', 'approval-asked'),
      reasonLabel: el('span', 'field-label approval-label', 'Reason'), reason: el('p', 'approval-reason'), warnings: el('ul', 'approval-warnings'),
      actions: el('div', 'hitl-actions'),
      approve: el('button', 'btn btn-primary', 'Approve'), read: el('button', 'btn', 'Allow read'), write: el('button', 'btn', 'Allow write'),
      deny: el('button', 'btn', 'Deny'), status: el('p', 'hitl-status approval-status'),
    };
    for (const v of ['approve', 'read', 'write', 'deny']) {
      c[v].type = 'button';
      c[v].dataset.verdict = v;
    }
    c.warnings.setAttribute('aria-label', 'Warnings');
    c.actions.setAttribute('role', 'group');
    c.actions.append(c.approve, c.read, c.write, c.deny);
    const head = el('div', 'hitl-head');
    head.append(c.badge, c.who, c.left);
    c.li.append(head, c.title, c.label, c.args, c.asked, c.reasonLabel, c.reason, c.warnings, c.actions, c.status);
    return c;
  }

  // what a request_access card adds: the reason, the warnings and the grants it offers; other cards hide them
  function fillAccess(c, a) {
    const x = isAccess(a) ? accessCard(a, getState()) : null;
    c.li.dataset.tool = x ? 'access' : '';
    c.li.dataset.protected = x?.protected ?? '';
    c.approve.hidden = Boolean(x);
    c.read.hidden = !x;
    c.write.hidden = !x?.grants.includes('write');
    // the grant asked for leads; reading only is always offered next to it
    c.read.className = x?.mode === 'read' ? 'btn btn-primary' : 'btn';
    c.write.className = x?.mode === 'write' ? 'btn btn-primary' : 'btn';
    for (const n of [c.reasonLabel, c.reason, c.warnings]) n.hidden = !x;
    c.asked.hidden = !x?.asked;
    if (!x) return;
    say(c.args, x.path);
    say(c.asked, x.asked ? `Asked for as ${x.asked}` : '');
    say(c.reason, x.reason);
    const key = x.warnings.join('\n');
    if (c.warnings.dataset.key !== key) {
      c.warnings.dataset.key = key;
      c.warnings.replaceChildren(...x.warnings.map((w) => el('li', 'approval-warn', w)));
    }
    c.warnings.hidden = !x.warnings.length;
  }

  function fill(c, a) {
    const v = callView(a);
    const t = now();
    c.li.dataset.key = a.key;
    say(c.who, whoText(a, getState()));
    say(c.left, countdownText(a, t));
    c.li.dataset.late = String(secondsLeft(a, t) === 0);
    say(c.title, v.title);
    say(c.label, v.label);
    say(c.args, v.text);
    fillAccess(c, a);
    c.actions.setAttribute('aria-label', `Your answer: ${v.title}`);
    const busy = sending.has(a.key);
    const done = answered.has(a.key);
    const late = secondsLeft(a, t) === 0;
    c.actions.hidden = done;
    for (const b of [c.approve, c.read, c.write, c.deny]) b.disabled = busy || late;
    const err = errors.get(a.key);
    const text = busy ? 'Sending your answer...' : done ? verdictText(answered.get(a.key)) : err ?? '';
    say(c.status, text);
    c.status.dataset.tone = busy ? 'busy' : err && !done ? 'error' : '';
  }

  function render() {
    const keys = new Set(items.map((a) => a.key));
    let lostFocus = false;
    for (const [k, c] of cards) {
      if (keys.has(k)) continue;
      lostFocus ||= c.li.contains(document.activeElement);
      c.li.remove();
      cards.delete(k);
    }
    items.forEach((a, i) => {
      if (!cards.has(a.key)) cards.set(a.key, card());
      const c = cards.get(a.key);
      fill(c, a);
      if (e.list.children?.[i] !== c.li) e.list.insertBefore(c.li, e.list.children?.[i] ?? null);
    });
    const shown = items.length > 0;
    const changed = e.box.hidden === shown;
    e.box.hidden = !shown;
    // the call answered went away: the next one waiting takes the focus, so a keyboard user is not left nowhere
    if (lostFocus && items.length) {
      const next = cards.get(items[0].key);
      [next?.approve, next?.read].find((b) => b && !b.hidden)?.focus();
    }
    if (changed) onChange();
  }

  e.list.addEventListener('click', (ev) => {
    const b = ev.target?.closest?.('button[data-verdict]');
    const key = b?.closest?.('.approval-card')?.dataset.key;
    if (!key || b.disabled) return;
    decide(key, b.dataset.verdict);
  });

  return {
    sync,
    refresh,
    // the calls on screen, for the page and its tests
    items: () => [...items],
    // another chat on screen: nothing of the previous one is kept, and an answer still on its way paints nothing
    reset() {
      gen += 1;
      timers.clearTimeout(timer);
      timer = 0;
      inflight = false;
      off = null;
      items = [];
      sending.clear();
      answered.clear();
      errors.clear();
      asked.clear();
      render();
    },
  };
}

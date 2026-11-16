// Messages panel: the transcript of chat_message / chat_delivery events and the human composer (POST /api/chat).
// The composer's rules and delivery states live in chat-steer.js, which the Chat view mounts as well.
import { CHAT_MAX, DELIVERY_LABEL, outboxStale } from './chat.js';
import { createSteering } from './chat-steer.js';
import { formatWhen, plural } from './format.js';
import { scopedUrl } from './scope.js';

const $ = (id) => document.getElementById(id);
const FOLLOW_SLACK_PX = 24;
// longer messages are clamped with a Show all toggle
const LONG = 320;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// onChange(): the panel rendered on its own account (a send, a queued message going stale), so whatever else
// shows the same messages can follow.
export function createChatPanel({ getState, getControl, refresh, url = (suffix) => scopedUrl(null, suffix), onChange = null }) {
  const e = {
    panel: $('chat-panel'), aside: $('chat-aside'), scroll: $('chat-scroll'), list: $('chat-list'), empty: $('chat-empty'),
    form: $('chat-form'), to: $('chat-to'), text: $('chat-text'), count: $('chat-count'), send: $('chat-send'),
    block: $('chat-block'), status: $('chat-status'), tabCount: $('tab-count-chat'),
  };
  const asideDefault = e.aside.textContent;
  const items = new Map();
  const expanded = new Set();
  let runId = null;
  // follow the newest message unless the reader scrolled back; kept while the tab is hidden and has no box
  let follow = true;
  let readTop = 0;
  const steer = createSteering({
    getState, getControl, refresh, url,
    onChange: () => {
      render();
      onChange?.();
    },
  });
  // the status line lives outside the tab panels; news that comes in on another tab shows there until it is seen
  const composer = steer.mount(e, { unseen: () => e.panel.hidden, onSent: () => toBottom() });

  // A hidden tab has no box: every measurement is 0, so it would always read as at the bottom.
  const laidOut = () => e.scroll.clientHeight > 0;

  function atBottom() {
    return e.scroll.scrollHeight - e.scroll.scrollTop - e.scroll.clientHeight <= FOLLOW_SLACK_PX;
  }

  function toBottom() {
    e.scroll.scrollTop = e.scroll.scrollHeight;
    follow = true;
  }

  e.scroll.addEventListener('scroll', () => {
    if (!laidOut()) return;
    follow = atBottom();
    readTop = e.scroll.scrollTop;
  });

  function entryKey(m, now) {
    return JSON.stringify([m.from, m.to, m.text, m.delivery, m.reason, m.local ?? false, outboxStale(m, now), expanded.has(m.id)]);
  }

  function fill(li, m, now) {
    li.dataset.delivery = m.delivery;
    li.dataset.human = String(m.from === 'human');
    li.toggleAttribute('data-expanded', expanded.has(m.id));
    const head = el('div', 'msg-head');
    const route = el('span', 'msg-route mono');
    route.append(el('b', '', m.from), ' -> ', el('b', '', m.to));
    route.title = `${m.from} -> ${m.to}`;
    const stale = outboxStale(m, now);
    const state = el('span', 'badge msg-state', stale ? 'queued · not picked up yet' : DELIVERY_LABEL[m.delivery] ?? m.delivery);
    if (m.delivery === 'rejected') state.dataset.tone = 'loud';
    else if (m.delivery === 'queued' || m.delivery === 'unknown') state.dataset.tone = 'quiet';
    state.title = m.local ? 'Accepted by the server; the orchestrator has not taken it up yet'
      : m.delivery === 'unknown' ? 'The acknowledgement timed out: it may or may not have arrived. It is not resent automatically.'
        : `Delivery: ${m.delivery}`;
    const time = el('span', 'msg-time mono', m.ts ? formatWhen(m.ts) : '--:--:--');
    time.title = m.ts ?? '';
    head.append(route);
    if (m.milestoneId) head.append(el('span', 'msg-ms mono', m.milestoneId));
    head.append(state, time);
    const body = el('p', 'msg-text', m.text);
    li.replaceChildren(head, body);
    if (m.truncated) li.append(el('p', 'msg-reason', `shortened to ${CHAT_MAX} characters for display`));
    if (m.text.length > LONG || m.text.split('\n').length > 4) {
      const more = el('button', 'msg-more', expanded.has(m.id) ? 'Show less' : 'Show all');
      more.type = 'button';
      more.dataset.toggle = m.id;
      more.setAttribute('aria-expanded', String(expanded.has(m.id)));
      li.append(more);
    }
    if (m.reason) li.append(el('p', 'msg-reason', m.delivery === 'rejected' ? `rejected: ${m.reason}` : m.reason));
  }

  function renderList(s, entries, now) {
    if ((s?.runId ?? null) !== runId) {
      runId = s?.runId ?? null;
      items.clear();
      expanded.clear();
      e.list.replaceChildren();
      follow = true;
    }
    // follow, not only the position: a box that just shrank (the composer grows on focus) is off the bottom
    const stick = follow || (laidOut() && atBottom());
    const ids = new Set(entries.map((m) => m.id));
    for (const [id, li] of items) {
      if (!ids.has(id)) {
        li.remove();
        items.delete(id);
      }
    }
    let added = false;
    for (const m of entries) {
      let li = items.get(m.id);
      const key = entryKey(m, now);
      if (!li) {
        li = el('li', 'msg');
        items.set(m.id, li);
        e.list.append(li);
        added = true;
      } else if (li.dataset.key === key) {
        continue;
      }
      li.dataset.key = key;
      fill(li, m, now);
    }
    e.empty.hidden = entries.length > 0;
    e.tabCount.textContent = String(entries.length);
    if (added && stick) toBottom();

    const queued = entries.filter((m) => m.delivery === 'queued').length;
    const rejected = entries.filter((m) => m.delivery === 'rejected').length;
    const unknown = entries.filter((m) => m.delivery === 'unknown').length;
    e.aside.textContent = entries.length
      ? [plural(entries.length, 'message'), queued && `${queued} queued`, rejected && `${rejected} rejected`, unknown && `${unknown} unknown`].filter(Boolean).join(' · ')
      : e.form.hidden ? steer.blocked() : asideDefault;
  }

  function render() {
    const now = Date.now();
    // the composers first: the list's aside says why nobody can be messaged
    const entries = steer.update(now);
    renderList(getState(), entries, now);
  }

  e.list.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-toggle]');
    if (!b) return;
    const id = b.dataset.toggle;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
    // opening a message near the end is reading it: the next one must not scroll it away
    if (laidOut()) follow = atBottom();
    e.list.querySelector(`button[data-toggle="${CSS.escape(id)}"]`)?.focus();
  });

  // Lane shortcut: preselect the instance and put the cursor in the message box.
  function compose(id) {
    render();
    if (!steer.recipients().some((r) => r.id === id)) {
      composer.status(`${id} cannot get messages right now`, 'error');
      return;
    }
    e.to.value = id;
    e.to.removeAttribute('aria-invalid');
    e.panel.scrollIntoView({ block: 'nearest' });
    e.text.focus();
  }

  // Another chat is on screen: its transcript must not carry over, nor anything a composer holds.
  function reset() {
    items.clear();
    expanded.clear();
    runId = null;
    follow = true;
    readTop = 0;
    e.list.replaceChildren();
    steer.reset();
    render();
  }

  // The Messages tab is on screen again: the news line has been seen, a follower gets the newest message
  // and a reader the place they left.
  function reveal() {
    e.status.dataset.unseen = 'false';
    if (!laidOut()) return;
    if (follow) toBottom();
    else e.scroll.scrollTop = readTop;
  }
  // shown again without a tab switch (the dashboard appears with the first run): the same.
  // Any other resize (composer focus, the window) keeps a follower on the newest message.
  let lastHeight = 0;
  if (globalThis.ResizeObserver) {
    new ResizeObserver(() => {
      const h = e.scroll.clientHeight;
      if (h > 0 && lastHeight === 0) reveal();
      else if (h > 0 && follow) toBottom();
      lastHeight = h;
    }).observe(e.scroll);
  }

  // steering: the session behind the composer, for another composer of the same page to mount
  return { render, compose, canMessage: steer.canMessage, reset, reveal, steering: steer };
}

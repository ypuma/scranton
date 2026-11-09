// Messages panel: the transcript of chat_message / chat_delivery events and the human composer (POST /api/chat).
// A sent message stays "queued" until the event stream says otherwise; nothing here marks it delivered.
import {
  CHAT_MAX, DELIVERY_LABEL, OUTBOX_STALE_MS, chatRecipients, buildChatRequest, transcript, pruneOutbox, outboxStale, deliveryNews,
  composerBlock,
} from './chat.js';
import { postJson } from './control-panel.js';
import { formatClock, plural } from './format.js';
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

export function createChatPanel({ getState, getControl, refresh, url = (suffix) => scopedUrl(null, suffix) }) {
  const e = {
    panel: $('chat-panel'), aside: $('chat-aside'), scroll: $('chat-scroll'), list: $('chat-list'), empty: $('chat-empty'),
    form: $('chat-form'), to: $('chat-to'), text: $('chat-text'), count: $('chat-count'), send: $('chat-send'),
    block: $('chat-block'), status: $('chat-status'), tabCount: $('tab-count-chat'),
  };
  const asideDefault = e.aside.textContent;
  const items = new Map();
  const expanded = new Set();
  const mine = new Set();
  let deliveries = new Map();
  let outbox = [];
  let runId = null;
  let sending = false;
  let recipients = [];
  let recipientsKey = '';
  let blocked = 'No run is in progress.';
  let staleTimer = 0;
  // follow the newest message unless the reader scrolled back; kept while the tab is hidden and has no box
  let follow = true;
  let readTop = 0;
  // bumped by reset(): an answer to a message sent from the previous chat is dropped
  let gen = 0;

  function status(text, tone = '') {
    if (e.status.textContent === text && e.status.dataset.tone === tone) return;
    e.status.textContent = text;
    e.status.dataset.tone = tone;
    // the line lives outside the tab panels; news that comes in on another tab shows there until it is seen
    e.status.dataset.unseen = String(Boolean(text) && e.panel.hidden);
  }

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
    const time = el('span', 'msg-time mono', m.ts ? formatClock(m.ts) : '--:--:--');
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

  function renderList(s, now) {
    if ((s?.runId ?? null) !== runId) {
      runId = s?.runId ?? null;
      items.clear();
      expanded.clear();
      e.list.replaceChildren();
      follow = true;
    }
    outbox = pruneOutbox(outbox, s);
    const entries = transcript(s, outbox);
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
      : e.form.hidden ? blocked : asideDefault;

    const next = new Map(entries.filter((m) => mine.has(m.id)).map((m) => [m.id, m.delivery]));
    const news = deliveryNews(deliveries, next, entries.filter((m) => mine.has(m.id)));
    deliveries = next;
    if (news) status(news, /rejected|unknown/.test(news) ? 'error' : '');

    clearTimeout(staleTimer);
    const waiting = outbox.filter((o) => !outboxStale({ ...o, local: true }, now));
    if (waiting.length) staleTimer = setTimeout(render, Math.max(50, Math.min(...waiting.map((o) => o.sentAt + OUTBOX_STALE_MS - now)) + 50));
  }

  function renderComposer(s) {
    const snap = getControl() ?? { control: null, mode: 'connecting', gates: { on: false, alive: false }, gone: false };
    const { control, mode, gates, gone } = snap;
    const enabled = Boolean(control?.enabled) && mode !== 'demo';
    const sameRun = Boolean(s?.runId) && control?.run?.runId === s.runId;
    recipients = enabled && gates.alive && sameRun ? chatRecipients(s, control) : [];
    blocked = composerBlock({ enabled: Boolean(control?.enabled), mode, alive: gates.alive, sameRun, recipients, gone });
    // read-only dashboards get the transcript only
    e.form.hidden = !enabled;
    if (!enabled) return;
    e.form.dataset.off = String(Boolean(blocked));
    e.block.textContent = blocked || 'Ctrl+Enter sends';
    const key = recipients.map((r) => `${r.id}:${r.status}`).join(',');
    if (key !== recipientsKey) {
      recipientsKey = key;
      const prev = e.to.value;
      e.to.replaceChildren(...(recipients.length
        ? recipients.map((r) => {
          const o = el('option', '', `${r.id} (${r.status})`);
          o.value = r.id;
          return o;
        })
        : [el('option', '', 'no running instance')]));
      if (recipients.some((r) => r.id === prev)) e.to.value = prev;
      else if (prev && recipients.length && document.activeElement === e.to) status(`${prev} is not running any more - pick another instance`, 'error');
    }
    e.to.disabled = !recipients.length || sending;
    e.send.disabled = Boolean(blocked) || sending;
    e.send.textContent = sending ? 'Sending...' : 'Send';
  }

  function render() {
    const s = getState();
    const now = Date.now();
    renderComposer(s);
    renderList(s, now);
  }

  function updateCount() {
    e.count.textContent = `${e.text.value.length} / ${CHAT_MAX}`;
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

  e.text.addEventListener('input', () => {
    e.text.removeAttribute('aria-invalid');
    updateCount();
  });
  e.to.addEventListener('change', () => e.to.removeAttribute('aria-invalid'));
  e.text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      e.form.requestSubmit();
    }
  });

  e.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (sending) return;
    const s = getState();
    const snap = getControl();
    const live = snap?.control?.run?.runId === s?.runId ? s.runId : null;
    const built = buildChatRequest({ to: e.to.value, text: e.text.value }, { runId: live, recipients });
    if (built.error) {
      status(built.error, 'error');
      const field = built.field === 'to' ? e.to : built.field === 'text' ? e.text : null;
      if (field) {
        field.setAttribute('aria-invalid', 'true');
        field.focus();
      }
      return;
    }
    const at = gen;
    sending = true;
    status(`Sending to ${built.body.to}...`, 'busy');
    render();
    const r = await postJson(url('chat'), built.body);
    if (at !== gen) return;
    sending = false;
    if (!r.ok) {
      status(r.error, 'error');
      if (r.status === 409) refresh?.();
      render();
      e.text.focus();
      return;
    }
    const id = typeof r.data?.id === 'string' && r.data.id ? r.data.id : null;
    const delivery = ['queued', 'delivered', 'rejected', 'unknown'].includes(r.data?.delivery) ? r.data.delivery : 'queued';
    if (id) {
      mine.add(id);
      deliveries.set(id, delivery);
      outbox.push({ id, runId: built.body.runId, from: 'human', to: built.body.to, text: built.body.text, truncated: false,
        milestoneId: null, delivery, reason: null, ts: new Date().toISOString(), sentAt: Date.now() });
    }
    e.text.value = '';
    updateCount();
    status(delivery === 'queued'
      ? `Queued for ${built.body.to}. It shows as delivered once the orchestrator hands it over.`
      : `Message to ${built.body.to} ${delivery}`, delivery === 'rejected' ? 'error' : '');
    render();
    toBottom();
    e.text.focus();
  });

  // Lane shortcut: preselect the instance and put the cursor in the message box.
  function compose(id) {
    render();
    if (!recipients.some((r) => r.id === id)) {
      status(`${id} cannot get messages right now`, 'error');
      return;
    }
    e.to.value = id;
    e.to.removeAttribute('aria-invalid');
    e.panel.scrollIntoView({ block: 'nearest' });
    e.text.focus();
  }

  function canMessage(id) {
    return !blocked && recipients.some((r) => r.id === id);
  }

  // Another chat is on screen: its draft, recipient and status line must not carry over (instance ids repeat).
  function reset() {
    gen += 1;
    clearTimeout(staleTimer);
    items.clear();
    expanded.clear();
    mine.clear();
    deliveries = new Map();
    outbox = [];
    runId = null;
    sending = false;
    recipients = [];
    recipientsKey = '';
    follow = true;
    readTop = 0;
    e.list.replaceChildren();
    e.to.replaceChildren();
    e.text.value = '';
    for (const f of [e.to, e.text]) f.removeAttribute('aria-invalid');
    status('');
    updateCount();
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

  updateCount();
  return { render, compose, canMessage, reset, reveal };
}

// Messaging a running agent instance (POST .../chat): who can get a message, the checks before one is sent, the
// outbox of what the server queued and the news about its delivery. One session per page; every composer (the
// Messages tab, the Chat view) is a mount of it, so the two cannot disagree about a rule or a delivery state.
// A sent message stays "queued" until the event stream says otherwise; nothing here marks it delivered.
import {
  CHAT_MAX, OUTBOX_STALE_MS, chatRecipients, buildChatRequest, transcript, pruneOutbox, outboxStale, deliveryNews, composerBlock,
} from './chat.js';
import { postJson } from './control-panel.js';
import { scopedUrl } from './scope.js';
import { shortcut } from './platform.js';
import { theName } from './state.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// onChange(): something a composer did changed what the page shows (a send, a queued message going stale).
export function createSteering({ getState, getControl, refresh, url = (suffix) => scopedUrl(null, suffix), onChange = () => {} }) {
  const mounts = [];
  const mine = new Set();
  let deliveries = new Map();
  let outbox = [];
  let sending = false;
  let recipients = [];
  let blocked = 'No run is in progress.';
  let enabled = false;
  let alive = false;
  let staleTimer = 0;
  // bumped by reset(): an answer to a message sent from the previous chat is dropped
  let gen = 0;
  // what an instance is called in a sentence: "the Developer (m1)", a custom agent by its name
  const called = (id) => theName(id, getState());

  // Called on every render: who can be messaged now, each composer, then the outbox and the delivery news.
  // -> the transcript of the run on screen (state.chat plus what the stream has not echoed yet)
  function update(now = Date.now()) {
    const s = getState();
    const snap = getControl() ?? { control: null, mode: 'connecting', gates: { on: false, alive: false }, gone: false };
    const { control, mode, gates, gone } = snap;
    enabled = Boolean(control?.enabled) && mode !== 'demo';
    alive = enabled && Boolean(gates.alive);
    const sameRun = Boolean(s?.runId) && control?.run?.runId === s.runId;
    recipients = enabled && gates.alive && sameRun ? chatRecipients(s, control) : [];
    blocked = composerBlock({ enabled: Boolean(control?.enabled), mode, alive: gates.alive, sameRun, recipients, gone });
    for (const m of mounts) m.render();

    outbox = pruneOutbox(outbox, s);
    const entries = transcript(s, outbox);
    const own = entries.filter((m) => mine.has(m.id));
    const next = new Map(own.map((m) => [m.id, m.delivery]));
    const news = deliveryNews(deliveries, next, own, called);
    deliveries = next;
    // news comes from the stream, so every composer says it: only the one on screen is seen and heard
    if (news) for (const m of mounts) m.status(news, /rejected|unknown/.test(news) ? 'error' : '');

    clearTimeout(staleTimer);
    const waiting = outbox.filter((o) => !outboxStale({ ...o, local: true }, now));
    if (waiting.length) staleTimer = setTimeout(onChange, Math.max(50, Math.min(...waiting.map((o) => o.sentAt + OUTBOX_STALE_MS - now)) + 50));
    return entries;
  }

  // One composer. e: { form, to, text, count, send, block, status }.
  // shown({ enabled, alive }): whether the form is on screen (default: wherever this page may send at all).
  // unseen(): the status line is out of sight right now. onSent(): the server took a message of this composer.
  function mount(e, { shown = (x) => x.enabled, unseen = () => false, onSent = () => {} } = {}) {
    let recipientsKey = '';

    function status(text, tone = '') {
      if (e.status.textContent === text && e.status.dataset.tone === tone) return;
      e.status.textContent = text;
      e.status.dataset.tone = tone;
      // news that comes in while the line is out of sight shows until it is seen
      e.status.dataset.unseen = String(Boolean(text) && unseen());
    }

    function render() {
      // read-only dashboards get the transcript only
      e.form.hidden = !shown({ enabled, alive });
      if (!enabled) return;
      e.form.dataset.off = String(Boolean(blocked));
      e.block.textContent = blocked || `${shortcut('Enter')} sends`;
      const key = recipients.map((r) => `${r.id}:${r.status}`).join(',');
      if (key !== recipientsKey) {
        recipientsKey = key;
        const prev = e.to.value;
        e.to.replaceChildren(...(recipients.length
          ? recipients.map((r) => {
            const o = el('option', '', `${r.name ?? r.id} (${r.status})`);
            o.value = r.id;
            return o;
          })
          : [el('option', '', 'no running instance')]));
        if (recipients.some((r) => r.id === prev)) e.to.value = prev;
        else if (prev && recipients.length && document.activeElement === e.to) status(`${called(prev)} is not running any more - pick another instance`, 'error');
      }
      e.to.disabled = !recipients.length || sending;
      e.send.disabled = Boolean(blocked) || sending;
      e.send.textContent = sending ? 'Sending...' : 'Send';
    }

    function updateCount() {
      e.count.textContent = `${e.text.value.length} / ${CHAT_MAX}`;
    }

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
      const built = buildChatRequest({ to: e.to.value, text: e.text.value }, { runId: live, recipients, name: called });
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
      status(`Sending to ${called(built.body.to)}...`, 'busy');
      onChange();
      const r = await postJson(url('chat'), built.body);
      if (at !== gen) return;
      sending = false;
      if (!r.ok) {
        status(r.error, 'error');
        if (r.status === 409) refresh?.();
        onChange();
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
        ? `Queued for ${called(built.body.to)}. It shows as delivered once the orchestrator hands it over.`
        : `Message to ${called(built.body.to)} ${delivery}`, delivery === 'rejected' ? 'error' : '');
      onChange();
      onSent();
      e.text.focus();
    });

    // another chat: its draft, recipient and status line must not carry over (instance ids repeat)
    function reset() {
      recipientsKey = '';
      e.to.replaceChildren();
      e.text.value = '';
      for (const f of [e.to, e.text]) f.removeAttribute('aria-invalid');
      status('');
      updateCount();
    }

    updateCount();
    const m = { render, status, reset };
    mounts.push(m);
    return m;
  }

  function reset() {
    gen += 1;
    clearTimeout(staleTimer);
    mine.clear();
    deliveries = new Map();
    outbox = [];
    sending = false;
    recipients = [];
    for (const m of mounts) m.reset();
  }

  return {
    mount, update, reset,
    blocked: () => blocked,
    recipients: () => recipients,
    canMessage: (id) => !blocked && recipients.some((r) => r.id === id),
    // what the stream has not echoed yet, for a transcript that shows it as queued
    pending: (now = Date.now()) => outbox.map((o) => ({ ...o, stale: outboxStale({ ...o, local: true }, now) })),
  };
}

// The end of the Chat transcript while a run is going: one entry per agent that is working now, like a message
// being written - who, what it is doing, and what its model is reasoning or writing at this moment. The entries
// are no part of the conversation (chat-entries.js): they go when the agent's turn is over and its message or
// tool line takes their place. Model text only ever becomes text nodes; the box is no live region.
import { STATUS_GLYPH } from './pipeline.js';

const $ = (id) => document.getElementById(id);
const FOLLOW_SLACK_PX = 24;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function say(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// The agents the transcript shows as working: every one that is busy, in the order of the run view.
export function workingAgents(view) {
  return view?.live ? view.agents.filter((a) => a.busy) : [];
}

// openThinking(): show the Thinking view (the whole stream of every agent).
export function createChatLive({ openThinking = null } = {}) {
  const e = { box: $('chat-live'), scroll: $('chat-view-scroll') };
  // agent id -> the nodes of its entry
  const items = new Map();

  function item() {
    const it = {
      el: el('article', 'chat-live-entry'), glyph: el('span', 'chat-live-glyph'), name: el('span', 'chat-who'), role: el('span', 'chat-role'),
      line: el('span', 'chat-live-line'), label: el('span', 'chat-live-label'), body: el('p', 'chat-live-body mono'), more: el('button', 'msg-more chat-live-more', 'Open in Thinking'),
    };
    it.glyph.setAttribute('aria-hidden', 'true');
    it.body.setAttribute('aria-live', 'off');
    it.more.type = 'button';
    it.more.hidden = !openThinking;
    const head = el('div', 'chat-head');
    head.append(it.glyph, it.name, it.role, it.line);
    it.el.append(head, it.label, it.body, it.more);
    return it;
  }

  function fill(it, a) {
    it.el.dataset.status = a.status;
    it.el.setAttribute('aria-label', `${a.name}, ${a.role}, working: ${a.line}`);
    say(it.glyph, STATUS_GLYPH[a.status] ?? '●');
    say(it.name, a.name);
    say(it.role, a.role);
    say(it.line, a.line);
    it.line.title = a.line;
    const t = a.text;
    it.label.hidden = it.body.hidden = !t;
    if (t) {
      say(it.label, t.label);
      it.el.dataset.kind = t.kind;
      say(it.body, `${t.cut ? '... ' : ''}${t.body}`);
      // the newest lines are the ones to read: the box shows its end
      it.body.scrollTop = it.body.scrollHeight;
    } else delete it.el.dataset.kind;
  }

  function render(view) {
    const agents = workingAgents(view);
    // read before anything grows: a reader at the end of the transcript stays there
    const stick = e.scroll.clientHeight > 0 && e.scroll.scrollHeight - e.scroll.scrollTop - e.scroll.clientHeight <= FOLLOW_SLACK_PX;
    for (const [id, it] of items) {
      if (agents.some((a) => a.id === id)) continue;
      it.el.remove();
      items.delete(id);
    }
    agents.forEach((a, i) => {
      if (!items.has(a.id)) items.set(a.id, item());
      const it = items.get(a.id);
      fill(it, a);
      if (e.box.children[i] !== it.el) e.box.insertBefore(it.el, e.box.children[i] ?? null);
    });
    e.box.hidden = agents.length === 0;
    if (stick) e.scroll.scrollTop = e.scroll.scrollHeight;
  }

  e.box.addEventListener('click', (ev) => {
    if (ev.target.closest?.('.chat-live-more')) openThinking?.();
  });

  return {
    render,
    reset() {
      items.clear();
      e.box.replaceChildren();
      e.box.hidden = true;
    },
  };
}

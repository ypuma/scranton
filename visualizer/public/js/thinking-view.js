// The Thinking view: every agent of the run on screen in a column of its own, side by side, each with what it
// reasoned, what it wrote and the tools it called, in the order they happened, and the block it is writing now
// at the end. It takes the place of the chat while it is open; the view bar opens and closes it. Columns and
// their blocks are kept and changed in place: the view is drawn about once a second while a run is going.
// Model text only ever becomes text nodes, and nothing here is a live region.
import { STATUS_GLYPH } from './pipeline.js';
import { formatWhen } from './format.js';

const $ = (id) => document.getElementById(id);
const FOLLOW_SLACK_PX = 24;
const LABEL = { reasoning: 'Reasoning', answer: 'Answer', tool: 'Tool' };
export const THINK_NOTES = {
  none: 'No run is on screen.',
  off: 'This run kept no thinking: it ran before thinking was saved, or with an engine that saves none.',
  liveOnly: 'Only the thought in progress is shown: this run saves no thinking.',
  empty: 'Nothing has been thought yet.',
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function say(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// "3 agents · 2 thinking now"
export function thinkingSummary(columns) {
  const live = columns.filter((c) => c.open || c.live).length;
  return [columns.length ? `${columns.length} agent${columns.length === 1 ? '' : 's'}` : '', live ? `${live} working now` : ''].filter(Boolean).join(' · ');
}

// What the line under the title says; '' when the columns speak for themselves.
export function thinkingNote({ runId, columns, off, live }) {
  if (!runId) return THINK_NOTES.none;
  const any = columns.some((c) => c.items.some((x) => x.kind !== 'tool') || c.open);
  if (off && live) return THINK_NOTES.liveOnly;
  if (off && !any) return THINK_NOTES.off;
  return any || columns.some((c) => c.items.length) ? '' : THINK_NOTES.empty;
}

// onToggle(open): the view was opened or closed, so what it shows may need to be fetched.
export function createThinkingView({ onToggle = null } = {}) {
  const e = {
    view: $('think-view'), title: $('think-title'), aside: $('think-aside'), note: $('think-note'), cols: $('think-cols'),
    button: $('bar-think'), close: $('think-close'), chat: $('bar-chat'), dash: $('bar-dash'),
  };
  let open = false;
  // column id -> { el, glyph, name, role, status, line, scroll, items: Map(item id -> node), open: node | null }
  const columns = new Map();

  function set(next, { focus = false } = {}) {
    if (open === next) return;
    open = next;
    e.view.hidden = !open;
    if (open) document.body.dataset.think = 'open';
    else delete document.body.dataset.think;
    e.button.setAttribute('aria-pressed', String(open));
    onToggle?.(open);
    if (focus) (open ? e.title : e.button).focus();
  }

  function column() {
    const c = {
      el: el('section', 'think-col'), glyph: el('span', 'act-glyph'), name: el('h3', 'think-name mono'), role: el('span', 'act-role'),
      status: el('span', 'act-status'), line: el('p', 'think-line'), scroll: el('div', 'think-scroll'), empty: el('p', 'placeholder', 'Nothing recorded for this agent.'),
      items: new Map(), open: null,
    };
    c.glyph.setAttribute('aria-hidden', 'true');
    c.scroll.tabIndex = 0;
    // it grows many times a second while its agent works: never read out as it changes
    c.scroll.setAttribute('aria-live', 'off');
    const head = el('header', 'think-head');
    const row = el('div', 'act-head');
    row.append(c.glyph, c.name, c.role, c.status);
    head.append(row, c.line);
    c.scroll.append(c.empty);
    c.el.append(head, c.scroll);
    return c;
  }

  function block(x) {
    const node = el(x.kind === 'tool' ? 'p' : 'article', 'think-item');
    node.dataset.kind = x.kind;
    if (x.kind === 'tool') {
      node.textContent = x.text;
      node.title = x.ts ? `${formatWhen(x.ts)} · ${x.text}` : x.text;
      return node;
    }
    const head = el('div', 'think-item-head');
    head.append(el('span', 'think-label', LABEL[x.kind]));
    if (x.ts) {
      const time = el('time', 'chat-time mono', formatWhen(x.ts));
      time.dateTime = x.ts;
      time.title = x.ts;
      head.append(time);
    }
    node.append(head, el('p', 'think-text', x.text));
    if (x.cut) node.append(el('p', 'chat-note', 'This block was shortened.'));
    return node;
  }

  function fill(c, col) {
    c.el.dataset.status = col.status;
    c.el.dataset.live = String(col.live);
    c.el.setAttribute('aria-label', `${col.name}${col.role ? `, ${col.role}` : ''}`);
    c.scroll.setAttribute('aria-label', `What ${col.name} thought and did, oldest first`);
    say(c.glyph, STATUS_GLYPH[col.status] ?? '○');
    say(c.name, col.name);
    say(c.role, col.role);
    say(c.status, col.status);
    say(c.line, col.line);
    c.line.title = col.line;
    const stick = c.scroll.clientHeight === 0 || c.scroll.scrollHeight - c.scroll.scrollTop - c.scroll.clientHeight <= FOLLOW_SLACK_PX;
    const ids = new Set(col.items.map((x) => x.id));
    for (const [id, node] of c.items) {
      if (ids.has(id)) continue;
      node.remove();
      c.items.delete(id);
    }
    const nodes = col.items.map((x) => {
      if (!c.items.has(x.id)) c.items.set(x.id, block(x));
      return c.items.get(x.id);
    });
    // the block that is being written: one node, its text replaced as it grows
    if (col.open) {
      if (!c.open) {
        c.open = el('article', 'think-item');
        c.open.dataset.open = 'true';
        c.openLabel = el('span', 'think-label');
        c.openText = el('p', 'think-text');
        const head = el('div', 'think-item-head');
        head.append(c.openLabel, el('span', 'think-now', 'now'));
        c.open.append(head, c.openText);
      }
      c.open.dataset.kind = col.open.kind;
      say(c.openLabel, col.open.label);
      say(c.openText, `${col.open.cut ? '... ' : ''}${col.open.body}`);
      nodes.push(c.open);
    } else if (c.open) {
      c.open.remove();
      c.open = null;
    }
    c.empty.hidden = nodes.length > 0;
    nodes.forEach((n, i) => {
      // the placeholder stays the first child; the blocks follow it in order
      if (c.scroll.children[i + 1] !== n) c.scroll.insertBefore(n, c.scroll.children[i + 1] ?? null);
    });
    if (stick) c.scroll.scrollTop = c.scroll.scrollHeight;
  }

  // cols: thoughtColumns(...). runId: the run on screen. off: the server keeps no thoughts for it. live: it is going.
  function render({ runId = null, columns: cols = [], off = false, live = false } = {}) {
    if (!open) return;
    say(e.aside, thinkingSummary(cols));
    const note = thinkingNote({ runId, columns: cols, off, live });
    e.note.hidden = !note;
    say(e.note, note);
    for (const [id, c] of columns) {
      if (cols.some((x) => x.id === id)) continue;
      c.el.remove();
      columns.delete(id);
    }
    cols.forEach((col, i) => {
      if (!columns.has(col.id)) columns.set(col.id, column());
      const c = columns.get(col.id);
      if (e.cols.children[i] !== c.el) e.cols.insertBefore(c.el, e.cols.children[i] ?? null);
      fill(c, col);
    });
    e.cols.hidden = cols.length === 0;
  }

  e.button.addEventListener('click', () => set(!open, { focus: true }));
  e.close.addEventListener('click', () => set(false, { focus: true }));
  // Chat and Dashboard are the other two views: picking one leaves this one
  for (const b of [e.chat, e.dash]) b.addEventListener('click', () => set(false));

  return {
    render,
    isOpen: () => open,
    open: () => set(true, { focus: true }),
    close: () => set(false),
    // another chat: nothing of the previous one stays in a column
    reset() {
      columns.clear();
      e.cols.replaceChildren();
    },
  };
}

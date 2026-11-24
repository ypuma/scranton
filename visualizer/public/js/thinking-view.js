// The Thinking view: every agent of the run on screen in a column of its own, side by side, each with what it
// reasoned, what it wrote and the tools it called, in the order they happened, and the block it is writing now
// at the end. It takes the place of the chat while it is open; the view bar opens and closes it. A strip under
// the title names the agents and brings a column into view, and one agent can have the whole width to be read.
// Long blocks fold, every block and every column can be copied. Columns and their blocks are kept and changed in
// place: the view is drawn about once a second while a run is going, and what the reader opened or scrolled to
// stays. Model text only ever becomes text nodes, and nothing here is a live region.
import { STATUS_GLYPH } from './pipeline.js';
import { formatWhen } from './format.js';
import { groupTools, entryText, columnText } from './thoughts.js';
import { copyButton } from './copy.js';
import { richText, jsonPayload, countLines, createFold, looksStructured } from './long-text.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const FOLLOW_SLACK_PX = 24;
const EDGE_SLACK_PX = 4;
const LABEL = { reasoning: 'Reasoning', answer: 'Answer' };
const ALONE_ICON = 'M9.5 3.5h3v3M12.5 3.5l-4 4M6.5 12.5h-3v-3M3.5 12.5l4-4';
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

function button(cls, text) {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

function icon(d) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  for (const [k, v] of [['d', d], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

function say(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function when(ts, cls) {
  const time = el('time', cls, formatWhen(ts));
  time.dateTime = ts;
  time.title = ts;
  return time;
}

// children of parent become exactly nodes, in order; a node already in place is not touched
function place(parent, nodes) {
  nodes.forEach((n, i) => {
    if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] ?? null);
  });
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
  // the agents of the run, one chip each, between the title and the columns
  const strip = el('div', 'think-strip');
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'Agents of this run');
  strip.hidden = true;
  e.view.insertBefore(strip, e.note);
  const everyone = button('think-chip think-chip-all', 'All agents');
  let open = false;
  // the agent that has the whole width; null: side by side. Kept until another chat is on screen.
  let alone = null;
  // what render() was last given, for a redraw the human asked for
  let last = {};
  // column id -> the nodes and the reading state of the column (column())
  const columns = new Map();
  // column id -> { el, glyph, name }
  const chips = new Map();

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

  // A column that is not on screen has no box: every measurement is 0, so it would always read as at the bottom.
  const laidOut = (c) => c.scroll.clientHeight > 0;
  const atBottom = (c) => c.scroll.scrollHeight - c.scroll.scrollTop - c.scroll.clientHeight <= FOLLOW_SLACK_PX;

  function showJump(c) {
    const hide = c.follow || !c.col?.live;
    // the button is about to go: the column it belongs to takes the focus, not the page
    if (hide && document.activeElement === c.jump) c.scroll.focus({ preventScroll: true });
    c.jump.hidden = hide;
  }

  function toBottom(c) {
    c.scroll.scrollTop = c.scroll.scrollHeight;
    c.follow = true;
    c.held = false;
    showJump(c);
  }

  // Which side of the strip of columns has more: the stylesheet fades that edge.
  function edges() {
    const room = e.cols.scrollWidth - e.cols.clientWidth;
    const start = e.cols.scrollLeft > EDGE_SLACK_PX;
    const end = room - e.cols.scrollLeft > EDGE_SLACK_PX;
    const more = start && end ? 'both' : start ? 'start' : end ? 'end' : 'none';
    if (e.cols.dataset.more !== more) e.cols.dataset.more = more;
  }

  function syncExpand(c) {
    const long = [...c.items].filter(([, b]) => b.fold.long());
    const all = long.length > 0 && long.every(([id]) => c.folds.get(id) ?? c.allOpen);
    c.expand.hidden = long.length === 0;
    say(c.expand, all ? 'Collapse all' : 'Expand all');
    c.expand.dataset.all = String(all);
  }

  // Folding is reading, not new output. Capture before layout/scroll anchoring moves the button below its body.
  function holdReading(c, anchor = null) {
    const top = c.scroll.scrollTop;
    const offset = laidOut(c) && anchor?.getBoundingClientRect
      ? anchor.getBoundingClientRect().top - c.scroll.getBoundingClientRect().top + top : top;
    c.follow = false;
    c.held = true;
    return () => {
      c.scroll.scrollTop = Math.min(top, Math.max(0, offset));
      c.readTop = c.scroll.scrollTop;
      showJump(c);
    };
  }

  // the human opened or closed one block
  function toggled(c, id, on) {
    c.folds.set(id, on);
    syncExpand(c);
    showJump(c);
  }

  function column(col) {
    const c = {
      id: col.id, el: el('section', 'think-col'), glyph: el('span', 'act-glyph'), name: el('h3', 'think-name'), role: el('span', 'act-role'),
      status: el('span', 'act-status'), line: el('p', 'think-line'), scroll: el('div', 'think-scroll'), empty: el('p', 'placeholder', 'Nothing recorded for this agent.'),
      expand: button('msg-more think-expand'), only: button('icon-btn think-only'), jump: button('jump', 'Jump to latest'),
      items: new Map(), open: null, col,
      // follow the newest block unless the reader scrolled back; kept while the column has no box
      follow: true, held: false, readTop: 0, seen: false,
      // the blocks the human opened or closed one by one, and how every other long block stands
      folds: new Map(), allOpen: false,
    };
    c.glyph.setAttribute('aria-hidden', 'true');
    c.scroll.tabIndex = 0;
    // it grows many times a second while its agent works: never read out as it changes
    c.scroll.setAttribute('aria-live', 'off');
    c.only.append(icon(ALONE_ICON));
    c.only.setAttribute('aria-label', `Show only ${col.name}`);
    c.jump.hidden = true;
    const head = el('header', 'think-head');
    const row = el('div', 'act-head');
    row.append(c.glyph, c.name, c.role, c.status);
    const tools = el('div', 'think-col-tools');
    tools.append(c.expand, copyButton({ text: () => columnText(c.col), what: `all of ${col.name}`, label: 'Copy all' }), c.only);
    const sub = el('div', 'think-sub');
    sub.append(c.line, tools);
    head.append(row, sub);
    c.scroll.append(c.empty);
    c.el.append(head, c.scroll, c.jump);

    c.scroll.addEventListener('scroll', () => {
      if (!laidOut(c)) return;
      c.follow = !c.held && atBottom(c);
      c.readTop = c.scroll.scrollTop;
      showJump(c);
    });
    // A real scroll gesture may resume following; layout-only scroll events after a fold may not.
    for (const type of ['wheel', 'touchmove', 'pointerdown']) c.scroll.addEventListener(type, () => { c.held = false; });
    c.scroll.addEventListener('keydown', (ev) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(ev.key)) c.held = false;
    });
    c.jump.addEventListener('click', () => toBottom(c));
    c.expand.addEventListener('click', () => {
      const restore = holdReading(c);
      c.allOpen = c.expand.dataset.all !== 'true';
      c.folds.clear();
      fill(c, c.col);
      restore();
    });
    c.only.addEventListener('click', () => {
      alone = alone === c.id ? null : c.id;
      render();
      c.only.focus();
    });
    return c;
  }

  function textBlock(c, x) {
    const node = el('article', 'think-item copy-host');
    node.dataset.kind = x.kind;
    const head = el('div', 'think-item-head');
    head.append(el('span', 'think-label', LABEL[x.kind]));
    if (x.ts) head.append(when(x.ts, 'chat-time mono'));
    head.append(copyButton({ text: x.text, what: LABEL[x.kind].toLowerCase() }));
    const body = el('div', 'think-body md');
    body.append(...richText(x.text));
    const fold = createFold(body, { onBeforeToggle: () => holdReading(c, node), onToggle: (on) => toggled(c, x.id, on) });
    fold.set({ lines: countLines(jsonPayload(x.text) ?? x.text) });
    node.append(head, body);
    if (x.cut) node.append(el('p', 'chat-note', 'This block was shortened.'));
    node.append(fold.more);
    return { el: node, fold };
  }

  // a run of tool calls: one list, a line per call
  function toolsBlock(c, x) {
    const b = { el: el('section', 'think-item copy-host'), list: el('ul', 'think-tools'), entry: x, key: '' };
    b.el.dataset.kind = 'tools';
    b.fold = createFold(b.list, { onBeforeToggle: () => holdReading(c, b.el), onToggle: (on) => toggled(c, x.id, on) });
    b.el.append(b.list, b.fold.more, copyButton({ text: () => entryText(b.entry), what: 'tool calls' }));
    return b;
  }

  function fillTools(b, x) {
    const key = x.calls.map((t) => t.id).join(' ');
    if (key === b.key) return;
    b.key = key;
    b.entry = x;
    b.el.setAttribute('aria-label', `${x.calls.length} tool call${x.calls.length === 1 ? '' : 's'}`);
    b.list.replaceChildren(...x.calls.map((t) => {
      const li = el('li', 'think-tool');
      li.append(t.ts ? when(t.ts, 'think-tool-time') : el('span', 'think-tool-time'), el('span', 'think-tool-text', t.text));
      return li;
    }));
    b.fold.set({ lines: x.calls.length });
  }

  // the block that is being written: one node, its text replaced as it grows
  function openBlock(c) {
    const node = el('article', 'think-item copy-host');
    node.dataset.open = 'true';
    c.openLabel = el('span', 'think-label');
    c.openText = el('p', 'think-text');
    const head = el('div', 'think-item-head');
    head.append(c.openLabel, el('span', 'think-now', 'now'), copyButton({ text: () => c.openText.textContent, what: 'the block being written' }));
    const body = el('div', 'think-body');
    body.append(c.openText);
    node.append(head, body);
    return node;
  }

  function fill(c, col) {
    c.col = col;
    c.el.dataset.status = col.status;
    c.el.dataset.live = String(col.live);
    c.el.setAttribute('aria-label', `${col.name}${col.role ? `, ${col.role}` : ''}`);
    c.scroll.setAttribute('aria-label', `What ${col.name} thought and did, oldest first`);
    say(c.glyph, STATUS_GLYPH[col.status] ?? '○');
    say(c.name, col.name);
    // what the agent does and the id of the instance are a hover away
    c.name.title = [col.name, col.about].filter(Boolean).join(': ');
    say(c.role, col.role);
    c.role.title = col.role;
    say(c.status, col.status);
    say(c.line, col.line);
    c.line.title = col.line;
    const entries = groupTools(col.items);
    const ids = new Set(entries.map((x) => x.id));
    for (const [id, b] of c.items) {
      if (ids.has(id)) continue;
      b.el.remove();
      c.items.delete(id);
      c.folds.delete(id);
    }
    const nodes = entries.map((x, i) => {
      if (!c.items.has(x.id)) c.items.set(x.id, x.kind === 'tools' ? toolsBlock(c, x) : textBlock(c, x));
      const b = c.items.get(x.id);
      if (x.kind === 'tools') fillTools(b, x);
      // the newest block of an agent at work may still grow and is the one being read: it is not folded
      const current = col.live && !col.open && i === entries.length - 1;
      b.fold.set({ open: c.folds.get(x.id) ?? c.allOpen, pinned: current });
      return b.el;
    });
    syncExpand(c);
    if (col.open) {
      if (!c.open) c.open = openBlock(c);
      const body = `${col.open.cut ? '... ' : ''}${col.open.body}`;
      c.open.dataset.kind = col.open.kind;
      // a plan or a result that arrives as JSON reads as code from its first line on
      c.open.dataset.payload = String(looksStructured(col.open.body));
      say(c.openLabel, col.open.label);
      say(c.openText, body);
      nodes.push(c.open);
    } else if (c.open) {
      c.open.remove();
      c.open = null;
    }
    c.empty.hidden = nodes.length > 0;
    // the placeholder stays the first child; the blocks follow it in order
    place(c.scroll, [c.empty, ...nodes]);
    // on screen again (the view was closed, or another agent had the width): a reader gets the place they left
    const shown = laidOut(c);
    if (shown && !c.seen && !c.follow) c.scroll.scrollTop = c.readTop;
    c.seen = shown;
    if (c.follow) toBottom(c);
    else showJump(c);
  }

  function chip(id) {
    const ch = { el: button('think-chip'), glyph: el('span', 'think-chip-glyph'), name: el('span', 'think-chip-name') };
    ch.glyph.setAttribute('aria-hidden', 'true');
    ch.el.append(ch.glyph, ch.name);
    ch.el.addEventListener('click', () => {
      // side by side the chip brings its column into view; while one agent has the width it is the one shown
      if (alone) {
        alone = id;
        render();
      } else columns.get(id)?.el.scrollIntoView({ inline: 'start', block: 'nearest' });
    });
    return ch;
  }

  function drawStrip(cols) {
    for (const [id, ch] of chips) {
      if (cols.some((c) => c.id === id)) continue;
      ch.el.remove();
      chips.delete(id);
    }
    const nodes = cols.map((col) => {
      if (!chips.has(col.id)) chips.set(col.id, chip(col.id));
      const ch = chips.get(col.id);
      ch.el.dataset.status = col.status;
      ch.el.dataset.live = String(col.live);
      say(ch.glyph, STATUS_GLYPH[col.status] ?? '○');
      // the chip says it short; its name and its tooltip say it in full
      say(ch.name, col.short ?? col.name);
      const about = [col.name, col.role, col.status].filter(Boolean).join(', ');
      ch.el.title = about;
      ch.el.setAttribute('aria-label', about);
      if (alone === col.id) ch.el.setAttribute('aria-current', 'true');
      else ch.el.removeAttribute('aria-current');
      return ch.el;
    });
    everyone.hidden = !alone;
    place(strip, [everyone, ...nodes]);
    strip.hidden = cols.length < 2;
  }

  // cols: thoughtColumns(...). runId: the run on screen. off: the server keeps no thoughts for it. live: it is going.
  function render(next = last) {
    last = next;
    if (!open) return;
    const { runId = null, columns: cols = [], off = false, live = false } = next;
    say(e.aside, thinkingSummary(cols));
    const note = thinkingNote({ runId, columns: cols, off, live });
    e.note.hidden = !note;
    say(e.note, note);
    if (alone && (cols.length < 2 || !cols.some((x) => x.id === alone))) alone = null;
    drawStrip(cols);
    for (const [id, c] of columns) {
      if (cols.some((x) => x.id === id)) continue;
      c.el.remove();
      columns.delete(id);
    }
    cols.forEach((col, i) => {
      if (!columns.has(col.id)) columns.set(col.id, column(col));
      const c = columns.get(col.id);
      if (e.cols.children[i] !== c.el) e.cols.insertBefore(c.el, e.cols.children[i] ?? null);
      c.el.hidden = Boolean(alone) && alone !== col.id;
      c.only.hidden = cols.length < 2;
      c.only.setAttribute('aria-pressed', String(alone === col.id));
      c.only.title = alone === col.id ? 'Show all agents side by side' : `Show only ${col.name}`;
      fill(c, col);
    });
    // one agent, alone by choice or because it is the only one, is a reading column in the middle
    e.cols.dataset.mode = alone || cols.length === 1 ? 'one' : 'all';
    e.cols.hidden = cols.length === 0;
    edges();
  }

  e.button.addEventListener('click', () => set(!open, { focus: true }));
  e.close.addEventListener('click', () => set(false, { focus: true }));
  // Chat and Dashboard are the other two views: picking one leaves this one
  for (const b of [e.chat, e.dash]) b.addEventListener('click', () => set(false));
  everyone.addEventListener('click', () => {
    const from = chips.get(alone)?.el;
    alone = null;
    render();
    // the button is gone with the mode it ended
    from?.focus();
  });
  e.cols.addEventListener('scroll', edges);
  if (globalThis.ResizeObserver) new ResizeObserver(edges).observe(e.cols);

  return {
    render,
    isOpen: () => open,
    open: () => set(true, { focus: true }),
    close: () => set(false),
    // another chat: nothing of the previous one stays in a column, and nobody has the width
    reset() {
      columns.clear();
      chips.clear();
      alone = null;
      last = {};
      e.cols.replaceChildren();
      strip.replaceChildren();
      strip.hidden = true;
    },
  };
}

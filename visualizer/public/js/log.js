// Event log grid: incremental one-line rows (click, Enter or Space to expand), filter buttons,
// auto-scroll that pauses while the user reads back. total: where the count of all events goes (the tab).
import { displayName } from './state.js';
import { formatClock } from './format.js';

const FOLLOW_SLACK_PX = 24;
const KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']);
// the column of the detail cell, where the stop starts
const DETAIL = 3;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createLog({ table, body, scroller, empty, jump, filters, total = null }) {
  let runId = null;
  let lastSeq = 0;
  let follow = true;
  let unseen = 0;
  let programmatic = false;
  // a key or a click put the reader on an older row: being at the bottom does not make them a follower then
  let held = false;
  // where the reader was, for when the log comes back from a hidden tab or a hidden dashboard
  let readTop = 0;

  // The table is a WAI-ARIA data grid with one tab stop (roving tabindex) on one cell; every cell carries the
  // row's aria-expanded, so the focused one announces it. current: the seq of the row the reader last focused,
  // null for the newest; col: the column of the stop. Both are numbers, so the stop survives re-renders and the trim.
  const rows = new WeakMap();
  let current = null;
  let col = DETAIL;
  let stop = null;
  // with no row to focus (a new run, or a filter that shows nothing) the grid itself keeps the focus in the log
  table.tabIndex = -1;

  const shown = (tr) => (table.dataset.filter ?? 'all') === 'all' || tr.dataset.cat === table.dataset.filter;
  const visibleRows = () => [...body.children].filter(shown);

  // a row the filter hides cannot take focus, so the stop moves to the next newer row, else to the newest
  function syncStop() {
    const list = visibleRows();
    const tr = (current === null ? null : list.find((r) => Number(r.dataset.seq) >= current)) ?? list.at(-1);
    const next = tr ? rows.get(tr).cells[col] : null;
    if (next === stop) return;
    if (stop) stop.tabIndex = -1;
    if (next) next.tabIndex = 0;
    stop = next;
  }

  function setFilter(name) {
    table.dataset.filter = name;
    for (const b of filters.querySelectorAll('button[data-filter]')) {
      b.setAttribute('aria-pressed', String(b.dataset.filter === name));
    }
    syncStop();
    toBottom();
  }
  filters.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-filter]');
    if (b) setFilter(b.dataset.filter);
  });

  // A hidden scroller (another tab, or the dashboard before its first run) has no box: every measurement
  // is 0, so it would always read as at the bottom.
  const laidOut = () => scroller.clientHeight > 0;

  function atBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_SLACK_PX;
  }

  function toBottom() {
    programmatic = true;
    scroller.scrollTop = scroller.scrollHeight;
    follow = true;
    held = false;
    unseen = 0;
    jump.hidden = true;
    requestAnimationFrame(() => { programmatic = false; });
  }

  scroller.addEventListener('scroll', () => {
    if (programmatic || !laidOut()) return;
    follow = atBottom();
    held = false;
    readTop = scroller.scrollTop;
    if (follow) {
      unseen = 0;
      jump.hidden = true;
    }
  });
  jump.addEventListener('click', toBottom);

  // opened, the detail cell shows the text in full and below it what the narrow columns clip
  function toggle(tr) {
    const r = rows.get(tr);
    const open = !tr.hasAttribute('data-expanded');
    tr.toggleAttribute('data-expanded', open);
    for (const td of r.cells) td.setAttribute('aria-expanded', String(open));
    r.more?.remove();
    r.more = null;
    if (!open) return;
    r.more = el('div', 't-more');
    for (const [label, value] of [['Time', r.entry.ts ?? '-'], ['Source', r.source], ['Type', r.entry.type]]) {
      const part = el('span', 't-fact');
      part.append(el('span', 'meta-label', `${label} `), el('span', '', value));
      r.more.append(part);
    }
    r.cell.append(r.more);
  }

  // The row the reader acts on decides tail-follow, not a scroll event: an older row in view does not scroll,
  // and the event of one that does can land while a render's toBottom still holds programmatic.
  function readAt(tr) {
    if (tr === visibleRows().at(-1)) return toBottom();
    follow = false;
    held = true;
    if (laidOut()) readTop = scroller.scrollTop;
  }

  // focus moves without the browser's own jump
  function moveTo(tr, c) {
    current = Number(tr.dataset.seq);
    col = c;
    syncStop();
    stop.focus({ preventScroll: true });
    programmatic = true;
    tr.scrollIntoView({ block: 'nearest' });
    requestAnimationFrame(() => { programmatic = false; });
    readAt(tr);
  }

  body.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    // selecting text inside a row must not collapse it
    if (!tr || !rows.has(tr) || String(getSelection()).length) return;
    toggle(tr);
    readAt(tr);
    const { cells } = rows.get(tr);
    const td = ev.target.closest('td');
    (cells.includes(td) ? td : cells[col]).focus({ preventScroll: true });
  });

  // the APG data-grid keys, and only with no modifier but Ctrl on Home and End: the rest stays the browser's
  body.addEventListener('keydown', (ev) => {
    const tr = ev.target.closest('tr');
    const cells = rows.get(tr)?.cells ?? [];
    const c = cells.indexOf(ev.target);
    if (c < 0 || !KEYS.has(ev.key) || ev.shiftKey || ev.altKey || ev.metaKey) return;
    if (ev.ctrlKey && ev.key !== 'Home' && ev.key !== 'End') return;
    ev.preventDefault();
    if (ev.key === 'Enter' || ev.key === ' ') {
      toggle(tr);
      readAt(tr);
      return;
    }
    const list = visibleRows();
    const i = list.indexOf(tr);
    const [r, to] = ev.ctrlKey
      ? [ev.key === 'Home' ? 0 : list.length - 1, c]
      : { ArrowUp: [i - 1, c], ArrowDown: [i + 1, c], ArrowLeft: [i, c - 1], ArrowRight: [i, c + 1], Home: [i, 0], End: [i, cells.length - 1] }[ev.key];
    if (list[r] && cells[to]) moveTo(list[r], to);
  });

  body.addEventListener('focusin', (ev) => {
    const tr = ev.target.closest('tr');
    if (!rows.has(tr)) return;
    current = Number(tr.dataset.seq);
    const c = rows.get(tr).cells.indexOf(ev.target);
    if (c >= 0) col = c;
    syncStop();
  });
  // left on the newest row, the stop keeps going to the newest one as rows arrive
  body.addEventListener('focusout', (ev) => {
    if (!body.contains(ev.relatedTarget) && stop?.parentNode === visibleRows().at(-1)) current = null;
  });

  function row(entry) {
    const tr = el('tr');
    tr.dataset.cat = entry.category;
    tr.dataset.tone = entry.tone;
    tr.dataset.seq = String(entry.seq);
    const source = entry.source === 'orchestrator' ? 'run' : displayName(entry.source).toLowerCase();
    const type = el('td', 't-type');
    type.append(el('span', '', entry.type));
    const cell = el('td', 't-detail', entry.text);
    const cells = [el('td', 't-time', formatClock(entry.ts)), el('td', 't-source', source), type, cell];
    for (const td of cells) {
      td.tabIndex = -1;
      td.setAttribute('aria-expanded', 'false');
    }
    tr.append(...cells);
    rows.set(tr, { entry, source, cell, cells, more: null });
    return tr;
  }

  function updateCounts(s) {
    const counts = { all: 0, handoffs: 0, tools: 0, results: 0 };
    for (const e of s?.log ?? []) {
      counts.all += 1;
      if (e.category in counts) counts[e.category] += 1;
    }
    for (const c of filters.querySelectorAll('[data-count]')) c.textContent = String(counts[c.dataset.count] ?? 0);
    if (total) total.textContent = String(counts.all);
  }

  // Back on screen: rows that arrived while it had no box could not scroll it, so the follower goes to the
  // newest row and a reader gets the place they left, with the count of what came in meanwhile.
  function reveal() {
    if (!laidOut()) return;
    if (follow) toBottom();
    else if (scroller.scrollTop !== readTop) {
      programmatic = true;
      scroller.scrollTop = readTop;
      requestAnimationFrame(() => { programmatic = false; });
    }
  }
  // the first rows of a run land while the dashboard is still hidden, and the tab or the window can change
  // size at any time, so the scroller says itself when it has a box again
  let lastHeight = 0;
  if (globalThis.ResizeObserver) {
    new ResizeObserver(() => {
      const h = scroller.clientHeight;
      if (h > 0 && lastHeight === 0) reveal();
      else if (h > 0 && follow) toBottom();
      lastHeight = h;
    }).observe(scroller);
  }

  function render(s) {
    // a removed cell hands the focus to the page, so where it was is read before any row goes
    const focused = table.contains(document.activeElement);
    let changed = false;
    if ((s?.runId ?? null) !== runId) {
      runId = s?.runId ?? null;
      lastSeq = 0;
      body.replaceChildren();
      current = null;
      col = DETAIL;
      stop = null;
      follow = true;
      held = false;
      unseen = 0;
      jump.hidden = true;
      changed = true;
    }
    const fresh = (s?.log ?? []).filter((e) => e.seq > lastSeq);
    if (fresh.length) {
      changed = true;
      const wasFollowing = follow || (!held && laidOut() && atBottom());
      const frag = document.createDocumentFragment();
      const animate = fresh.length <= 3;
      for (const e of fresh) {
        const tr = row(e);
        if (animate) tr.classList.add('fresh');
        frag.append(tr);
      }
      body.append(frag);
      lastSeq = fresh.at(-1).seq;
      const max = s.log.length;
      while (body.children.length > max) body.firstElementChild.remove();
      if (wasFollowing) toBottom();
      else {
        unseen += fresh.length;
        jump.hidden = false;
        jump.textContent = `${unseen} new · Jump to latest`;
      }
    }
    if (changed) {
      syncStop();
      // the focused row went (trim, new run): the stop takes the focus, else the grid, never the page
      if (focused && !body.contains(document.activeElement)) (stop ?? table).focus({ preventScroll: true });
    }
    empty.hidden = body.children.length > 0;
    updateCounts(s);
  }

  return { render, reveal };
}

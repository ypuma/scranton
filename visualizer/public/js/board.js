// The board (.enma/live-activity-contract.md section 5): five columns, one card per milestone or pipeline step.
// It draws what activity-model.js derived; a card is built again only when what it says changed.
import { STATUS_GLYPH, GATE_GLYPH } from './pipeline.js';
import { BOARD_COLUMNS } from './activity-model.js';

// a gate on a card: its result in the glyphs the lanes use, or that it runs or has not run yet
export const GATE_MARK = { ...GATE_GLYPH, running: STATUS_GLYPH.thinking, pending: STATUS_GLYPH.idle };
const GATE_WORD = { passed: 'passed', failed: 'failed', blocked: 'blocked', error: 'error', running: 'running', pending: 'not run yet' };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// children of parent become exactly nodes, in order; a node already in place is not touched
function place(parent, nodes) {
  for (const n of [...parent.children]) if (!nodes.includes(n)) n.remove();
  nodes.forEach((n, i) => {
    if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] ?? null);
  });
}

// "cycle 3 · 2 failed" for a milestone, "attempt 2 · 1 failed" for a pipeline step; '' before the first one
export function attemptText(card, kind) {
  if (!card.attempt) return '';
  return [`${kind === 'step' ? 'attempt' : 'cycle'} ${card.attempt}`, card.failed ? `${card.failed} failed` : ''].filter(Boolean).join(' · ');
}

// root: the element the board fills. name: what its columns are labelled against (several boards may be on a page).
export function createBoard(root, { name = 'board' } = {}) {
  const notice = el('p', 'board-notice');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const note = el('p', 'board-note');
  const empty = el('p', 'placeholder board-empty');
  const cols = el('div', 'board-cols');
  const columns = BOARD_COLUMNS.map((c) => {
    const sec = el('section', 'board-col');
    sec.dataset.column = c.id;
    const title = el('h3', '', c.label);
    title.id = `${name}-col-${c.id}`;
    sec.setAttribute('aria-labelledby', title.id);
    const n = el('span', 'board-count mono');
    const head = el('header', 'board-col-head');
    head.append(title, n);
    const list = el('ol', 'board-cards');
    sec.append(head, list);
    cols.append(sec);
    return { id: c.id, sec, n, list };
  });
  root.append(notice, cols, note, empty);
  // card id -> { el, key }
  const cards = new Map();
  const open = new Set();
  let kind = '';

  function card(c, boardKind) {
    const li = el('li', 'card');
    li.dataset.card = c.id;
    li.dataset.loud = String(c.loud);
    const head = el('div', 'card-head');
    head.append(el('span', 'card-id mono', c.id), el('span', 'card-state', c.state));
    li.append(head, el('p', 'card-title', c.title));
    if (c.note) li.append(el('p', 'card-note', c.note));
    if (c.reason) {
      const p = el('p', 'card-reason');
      p.append(el('b', '', 'last failure '), c.reason);
      li.append(p);
    }
    if (c.agents.length) {
      const ul = el('ul', 'card-agents');
      ul.setAttribute('aria-label', 'Working on it');
      ul.append(...c.agents.map((a) => {
        const row = el('li');
        const glyph = el('span', 'card-glyph', STATUS_GLYPH[a.status] ?? '○');
        glyph.setAttribute('aria-hidden', 'true');
        const line = el('span', 'card-line', a.line);
        line.title = a.line;
        row.append(glyph, el('span', 'card-agent mono', a.id), line);
        return row;
      }));
      li.append(ul);
    }
    const attempt = attemptText(c, boardKind);
    if (attempt || c.gates.length) {
      const foot = el('div', 'card-foot');
      if (attempt) foot.append(el('span', 'card-attempt mono', attempt));
      if (c.gates.length) {
        const gates = el('span', 'card-gates');
        gates.append(...c.gates.map((g) => {
          const s = el('span', 'card-gate');
          s.dataset.result = g.result;
          const glyph = el('span', '', GATE_MARK[g.result] ?? '○');
          glyph.setAttribute('aria-hidden', 'true');
          s.append(glyph, ` ${g.name}`, el('span', 'sr-only', ` ${GATE_WORD[g.result] ?? g.result}`));
          s.title = `${g.name}: ${GATE_WORD[g.result] ?? g.result}`;
          return s;
        }));
        foot.append(gates);
      }
      li.append(foot);
    }
    if (c.criteria.length || c.description) {
      const d = el('details', 'card-more');
      d.open = open.has(c.id);
      d.addEventListener('toggle', () => (d.open ? open.add(c.id) : open.delete(c.id)));
      const n = c.criteria.length;
      d.append(el('summary', '', n ? `${n} ${boardKind === 'step' ? 'criteri' : 'acceptance criteri'}${n === 1 ? 'on' : 'a'}` : 'Description'));
      if (c.description) d.append(el('p', 'card-desc', c.description));
      if (n) {
        const ul = el('ul', 'card-criteria');
        ul.append(...c.criteria.map((x) => el('li', '', x)));
        d.append(ul);
      }
      li.append(d);
    }
    return li;
  }

  function render(b) {
    if (b.kind !== kind) {
      kind = b.kind;
      open.clear();
    }
    const said = b.notice?.text ?? '';
    if (notice.textContent !== said) notice.textContent = said;
    notice.hidden = !said;
    notice.dataset.loud = String(Boolean(b.notice?.loud));
    if (note.textContent !== b.note) note.textContent = b.note;
    note.hidden = !b.note;
    if (empty.textContent !== b.empty) empty.textContent = b.empty;
    empty.hidden = !b.empty;
    cols.hidden = Boolean(b.empty);
    const held = document.activeElement?.closest?.('.card')?.dataset.card ?? null;
    const seen = new Set();
    for (const col of columns) {
      const list = b.columns.find((c) => c.id === col.id)?.cards ?? [];
      const count = String(list.length);
      if (col.n.textContent !== count) col.n.textContent = count;
      col.sec.dataset.empty = String(!list.length);
      place(col.list, list.map((c) => {
        seen.add(c.id);
        const key = JSON.stringify(c);
        let item = cards.get(c.id);
        if (item?.key !== key) {
          item = { el: card(c, b.kind), key };
          cards.set(c.id, item);
        }
        return item.el;
      }));
    }
    for (const id of [...cards.keys()]) if (!seen.has(id)) cards.delete(id);
    // a card that was drawn again took its disclosure with it: the new one gets the focus back
    if (held && !root.contains(document.activeElement)) cards.get(held)?.el.querySelector('summary')?.focus();
  }

  return { render };
}

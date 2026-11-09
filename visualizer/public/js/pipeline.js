// Pipeline panel: Human -> Michael -> Dwight -> the run's gate stages, and the message animation for hive_write.
// A parallel stage is one column of stacked cards; roles the run does not use have no card. A custom gate gets its
// card from run_started.roles the first time a run uses it.
import { AGENT_IDS, isFailKeyword, displayName, roleTitle, humanNeeded, roleView, workflowOf, gateView, workflowText, stepNames } from './state.js';
import { formatTokens, formatCost, plural, stripBidi } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
// a column count from which the row needs more room than a single gate stage did
const WIDE_COLUMNS = 4;
// past five columns (custom gates each in a stage of their own) the row goes vertical earlier still
const MANY_COLUMNS = 6;
export const STATUS_GLYPH = {
  idle: '○', thinking: '◐', working: '●', waiting: '○', blocked: '■', error: '✕', done: '✓',
  starting: '◌', finished: '✓', failed: '✕', aborted: '✕', stopped: '–', cancelled: '–', interrupted: '✕',
};
export const GATE_GLYPH = { passed: '✓', failed: '✕', blocked: '■', error: '✕' };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// The pipeline's columns for a run: [['michael'], ['dwight'], ...its gate stages].
export function pipelineColumns(state) {
  return [['michael'], ['dwight'], ...workflowOf(state?.runId ? state : null).map((stage) => [...stage])];
}

// What a gate that has not run yet waits for: Dwight, or the stage before its own. Short enough for two lines
// of the narrowest card; the column it sits in already says which stage it is. names: stepNames of the run.
export function waitsFor(cols, id, names = null) {
  const i = cols.findIndex((ids) => ids.includes(id));
  if (i < 2) return null;
  return i === 2 ? 'Waits for Dwight' : `After ${workflowText([cols[i - 1]], names).toLowerCase()}`;
}

export function createPipeline(root) {
  const nodes = {};

  const human = el('div', 'node-human');
  human.dataset.node = 'human';
  const humanGlyph = el('span', 'glyph', '○');
  const humanNote = el('span', 'node-note', 'standby');
  human.append(humanGlyph, el('span', 'node-name', 'Human'), humanNote);
  nodes.human = human;

  const cards = {};
  function cardFor(id) {
    if (Object.hasOwn(cards, id)) return cards[id];
    const card = el('article', 'agent');
    card.dataset.node = id;
    card.setAttribute('aria-labelledby', `agent-${id}`);
    const name = el('h3', '', displayName(id));
    name.id = `agent-${id}`;
    const glyph = el('span', 'glyph');
    glyph.setAttribute('aria-hidden', 'true');
    const word = el('span', 'status-word');
    const status = el('span', 'status');
    status.append(glyph, word);
    const head = el('header', 'agent-head');
    head.append(name, status);
    const role = el('span', 'role', roleTitle(id));
    const activity = el('p', 'activity');
    const keyword = el('span', 'fact-keyword');
    const tool = el('span', 'fact-tool');
    const totals = el('span', 'agent-totals');
    const meta = el('summary', 'agent-meta mono');
    meta.append(keyword, tool, totals);
    const more = el('details', 'agent-more');
    more.append(meta);
    card.append(head, role, activity, more);
    nodes[id] = card;
    cards[id] = { card, name, glyph, word, activity, tool, keyword, totals, role, more };
    return cards[id];
  }
  for (const id of AGENT_IDS) cardFor(id);

  // 'exited' (set by the control panel): the run process died, nobody can answer its pause
  let humanWhere = 'terminal';
  let state = null;
  let layoutKey = '';
  let cols = [];
  let names = {};
  // column index of every node on screen, for the message paths
  let column = {};

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('flow');
  svg.setAttribute('aria-hidden', 'true');

  // Only rebuilt when the run's workflow changes, so cards keep their open disclosures and focus.
  function layout(s) {
    const next = pipelineColumns(s);
    names = stepNames(s);
    const key = JSON.stringify([next, names]);
    if (key === layoutKey) return;
    layoutKey = key;
    cols = next;
    column = { human: 0 };
    const parts = [human];
    cols.forEach((ids, i) => {
      for (const id of ids) column[id] = i + 1;
      parts.push(el('div', 'connector'));
      if (ids.length === 1) {
        parts.push(cardFor(ids[0]).card);
        return;
      }
      const stack = el('div', 'stage-column agent-stack');
      stack.setAttribute('role', 'group');
      stack.setAttribute('aria-label', `Stage ${i - 1}, in parallel: ${workflowText([ids], names)}`);
      stack.dataset.count = String(ids.length);
      for (const id of ids) {
        const slot = el('div', 'stack-slot');
        slot.append(cardFor(id).card);
        stack.append(slot);
      }
      parts.push(stack);
    });
    root.dataset.stacked = String(cols.some((ids) => ids.length > 1));
    root.dataset.wide = String(cols.length >= WIDE_COLUMNS);
    root.dataset.columns = String(cols.length);
    if (cols.length >= MANY_COLUMNS) root.dataset.many = 'true';
    else delete root.dataset.many;
    root.replaceChildren(...parts, svg);
  }

  layout(null);

  function render(s) {
    state = s;
    const hasRun = Boolean(s?.runId);
    layout(s);
    for (const id of Object.keys(column)) {
      if (id === 'human') continue;
      const a = hasRun ? roleView(s, id) : null;
      const c = cards[id];
      const status = hasRun ? (a?.status ?? 'idle') : 'idle';
      const name = displayName(id, s);
      if (c.name.textContent !== name) c.name.textContent = name;
      // the lane count is said again by the lanes list, so a crowded row drops it (styles.css)
      c.role.replaceChildren(roleTitle(id, s), ...(a?.lanes ? [el('span', 'role-lanes', ` · ${plural(a.lanes, 'lane')}`)] : []));
      c.card.dataset.status = status;
      c.card.dataset.active = String(status === 'working' || status === 'thinking');
      c.glyph.textContent = STATUS_GLYPH[status] ?? '○';
      c.word.textContent = status;
      // a settled gate says the result of the lane the card speaks for, once; a busy or failing card says what it does
      const gate = hasRun && !['thinking', 'working', 'starting', 'error', 'blocked'].includes(status) ? gateView(s, id, a.focus) : null;
      const fresh = status === 'idle' && !a?.lanes && !a?.totals.runs;
      let activity = hasRun ? (a?.tool ? `${a.activity} · ${a.tool.tool} ${a.tool.detail}` : a?.activity) : 'Idle';
      if (fresh) activity = waitsFor(cols, id, names) ?? activity;
      // the status word already says it ("Idle", "dwight-m1: Idle")
      if (activity?.replace(/^[a-z]+(-[\w-]+)?: /, '').toLowerCase() === status) activity = '';
      if (gate) {
        c.card.dataset.gate = gate.result;
        const where = [gate.milestoneId, gate.cycle && `cycle ${gate.cycle}`].filter(Boolean).join(' · ');
        c.activity.replaceChildren(el('span', 'verdict', `${GATE_GLYPH[gate.result] ?? ''} ${gate.label}`), ...(where ? [' ', el('span', 'gate-where mono', where)] : []));
        c.activity.title = [gate.label, gate.keyword, where].filter(Boolean).join(' · ');
      } else {
        delete c.card.dataset.gate;
        c.activity.textContent = activity || '';
        c.activity.title = activity || '';
      }
      c.activity.hidden = !gate && !activity;
      // the meta line: what is known and nothing else; empty parts drop out with their separator.
      // It is the summary of a disclosure: opened (click, Enter, Space) it shows every part in full, labelled.
      // The keyword leads so a clipped line never hides it; a gate result already names it.
      c.keyword.replaceChildren();
      if (hasRun && a?.lastKeyword && !gate) {
        const k = el('span', isFailKeyword(s, id, a.lastKeyword) || a.lastExitCode ? 'keyword-bad' : '', a.lastKeyword);
        c.keyword.append(el('span', 'meta-label', 'Keyword '), k);
      }
      c.tool.replaceChildren();
      if (hasRun && a?.lastTool) {
        c.tool.append(el('span', 'meta-label', 'Last tool '), el('span', 'tool-name', a.lastTool.tool), ` ${a.lastTool.detail}`);
      }
      const t = hasRun ? a?.totals : null;
      // nothing to tell before the first run
      c.more.hidden = !t?.runs;
      c.totals.replaceChildren(el('span', 'meta-label', 'Totals '), t
        ? `${plural(t.runs, 'run')} · ${formatTokens(t.input + t.output)} tok · ${formatCost(t.cost)}`
        : `0 runs · 0 tok · ${formatCost(0)}`);
    }
    renderHuman(s);
  }

  function renderHuman(s) {
    const orphaned = humanNeeded(s) && humanWhere === 'exited';
    const needed = humanNeeded(s) && !orphaned;
    human.dataset.state = needed ? 'needed' : 'standby';
    humanGlyph.textContent = needed ? '■' : orphaned ? STATUS_GLYPH.error : '○';
    humanNote.textContent = needed ? 'input needed' : orphaned ? 'process exited' : 'standby';
  }

  function setHumanWhere(next) {
    if (next === humanWhere) return;
    humanWhere = next;
    renderHuman(state);
  }

  // Geometry in the pipeline's own coordinate space.
  function anchor(id) {
    const r = nodes[id].getBoundingClientRect();
    const base = root.getBoundingClientRect();
    return { l: r.left - base.left, r: r.right - base.left, t: r.top - base.top, b: r.bottom - base.top,
      cx: r.left - base.left + r.width / 2, cy: r.top - base.top + r.height / 2 };
  }

  // a message that skips a column arcs over every card, stacked ones included
  function topOfRow() {
    return Math.min(...Object.keys(column).map((id) => anchor(id).t));
  }

  function pathBetween(from, to) {
    const a = anchor(from);
    const b = anchor(to);
    const adjacent = Math.abs(column[from] - column[to]) === 1;
    const horizontal = Math.abs(a.cy - b.cy) < Math.min(a.b - a.t, b.b - b.t) / 2;
    // side by side but not level: a card of a parallel stage and its neighbour column
    const beside = column[from] !== column[to] && (a.r <= b.l + 1 || b.r <= a.l + 1);
    if (beside && !horizontal) {
      const forward = b.cx > a.cx;
      const x1 = forward ? a.r : a.l;
      const x2 = forward ? b.l : b.r;
      if (adjacent) {
        const mx = (x1 + x2) / 2;
        const lift = forward ? 0 : 10;
        return `M ${x1} ${a.cy + lift} C ${mx} ${a.cy + lift}, ${mx} ${b.cy + lift}, ${x2} ${b.cy + lift}`;
      }
      const y = topOfRow() + 1;
      return `M ${a.cx} ${a.t} C ${a.cx} ${y - 18}, ${b.cx} ${y - 18}, ${b.cx} ${b.t}`;
    }
    if (horizontal) {
      const forward = b.cx > a.cx;
      const x1 = forward ? a.r : a.l;
      const x2 = forward ? b.l : b.r;
      if (adjacent) {
        // returning messages ride just below the centre line so both directions read apart
        const y = a.cy + (forward ? 0 : 10);
        return `M ${x1} ${y} L ${x2} ${y}`;
      }
      const y = topOfRow() + 1;
      const sx = a.cx;
      const ex = b.cx;
      return `M ${sx} ${a.t} C ${sx} ${y - 18}, ${ex} ${y - 18}, ${ex} ${b.t}`;
    }
    const down = b.cy > a.cy;
    return `M ${a.cx + 10} ${down ? a.b : a.t} L ${b.cx + 10} ${down ? b.t : b.b}`;
  }

  function flash(id) {
    const n = nodes[id];
    if (!n) return;
    n.classList.remove('received');
    void n.offsetWidth;
    n.classList.add('received');
    n.addEventListener('animationend', () => n.classList.remove('received'), { once: true });
  }

  function animateMessage(from, to, kind) {
    if (!(from in column) || !(to in column) || from === to) return;
    if (reducedMotion() || document.hidden) {
      flash(to);
      return;
    }
    const box = root.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathBetween(from, to));
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '3.5');
    const label = document.createElementNS(SVG_NS, 'g');
    label.classList.add('flow-label');
    const text = document.createElementNS(SVG_NS, 'text');
    text.textContent = stripBidi(kind ?? 'message').replace('_', ' ');
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('rx', '3');
    label.append(rect, text);
    svg.append(path, dot, label);
    const tw = text.getComputedTextLength();
    rect.setAttribute('width', String(tw + 10));
    rect.setAttribute('height', '15');
    rect.setAttribute('x', String(-tw / 2 - 5));
    rect.setAttribute('y', '-22');
    text.setAttribute('x', String(-tw / 2));
    text.setAttribute('y', '-11');

    const len = path.getTotalLength();
    const dur = Math.min(1300, 650 + len * 0.9);
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
      const p = path.getPointAtLength(len * e);
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
      label.setAttribute('transform', `translate(${p.x} ${p.y})`);
      const fade = k > 0.85 ? (1 - k) / 0.15 : Math.min(1, k / 0.1);
      path.style.opacity = String(0.9 * fade);
      label.style.opacity = String(fade);
      if (k < 1) requestAnimationFrame(step);
      else {
        path.remove();
        dot.remove();
        label.remove();
        flash(to);
      }
    };
    requestAnimationFrame(step);
  }

  function clear() {
    svg.replaceChildren();
  }

  return { render, animateMessage, clear, setHumanWhere };
}

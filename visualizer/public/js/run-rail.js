// The run rail of the Chat view: beside the transcript it says what every agent is doing now, what the run costs
// and how the board stands. A window too narrow for it gets a toggle in the chat header, which opens the same
// content as a drawer, and one live line above the composer. Nodes are kept and changed in place: the rail is
// drawn about once a second while a run is going.
import { store } from './control-panel.js';
import { RAIL_KEY, RAIL_WIDE, railMode, parseRailChoice, liveLine, boardSummary, agentsSummary } from './activity-model.js';
import { STATUS_GLYPH } from './pipeline.js';
import { createLiveBlock } from './agent-live.js';
import { createUsage, usageFigures } from './usage-chart.js';

// agents listed before "Show all"; the ones that are active are always among them
export const RAIL_AGENTS_SHOWN = 6;
const LIVE_OFF = 'This server does not report live text. The lines above come from the event stream.';

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

function place(parent, nodes) {
  for (const n of [...parent.children]) if (!nodes.includes(n)) n.remove();
  nodes.forEach((n, i) => {
    if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] ?? null);
  });
}

// The agents the rail lists: the active ones first, then the rest in reading order.
export function railAgents(agents, all = false) {
  const ordered = [...agents.filter((a) => a.live), ...agents.filter((a) => !a.live)];
  const n = Math.max(RAIL_AGENTS_SHOWN, agents.filter((a) => a.live).length);
  return { shown: all ? ordered : ordered.slice(0, n), hidden: all ? 0 : Math.max(0, ordered.length - n) };
}

// viewMode(): 'chat' | 'dashboard'. openBoard(): show the whole board. liveOff(): the chat's server has no /live.
// media: the query that says the window has room for the rail beside the transcript.
export function createRunRail({ viewMode, openBoard, liveOff = () => false, media = matchMedia(RAIL_WIDE) }) {
  const e = {
    rail: $('run-rail'), body: $('rail-body'), close: $('rail-close'), status: $('rail-status'),
    toggle: $('rail-toggle'), toggleFig: $('rail-toggle-fig'), line: $('run-live-line'), lineText: $('run-live-text'),
    dialog: $('rail-dialog'), dialogBody: $('rail-dialog-body'), dialogClose: $('rail-dialog-close'),
    agents: $('rail-agents'), agentsTitle: $('rail-agents-title'), agentsAside: $('rail-agents-aside'), agentsEmpty: $('rail-agents-empty'), agentsMore: $('rail-agents-more'),
    liveNote: $('rail-live-note'), usage: $('rail-usage'), usageMore: $('rail-usage-more'),
    outcome: $('rail-outcome'), oResult: $('rail-outcome-result'), oUnit: $('rail-outcome-unit'), oDone: $('rail-outcome-done'), oDoneFig: $('rail-outcome-done-fig'),
    oDuration: $('rail-outcome-duration'), oDurationFig: $('rail-outcome-duration-fig'), oCost: $('rail-outcome-cost'),
    board: $('rail-board'), boardSummary: $('rail-board-summary'), boardNotice: $('rail-board-notice'),
  };
  const usage = createUsage({ height: 132, id: 'rail-usage' });
  e.usage.append(usage.el);
  // the choice lasts across chats and reloads, like the view switch
  let collapsed = parseRailChoice(store.get(RAIL_KEY));
  let overlay = false;
  let all = false;
  // the diagram of a run that is over is opened by the human: { run, open }; a run that is going always shows it
  let chart = { run: null, open: false };
  let view = null;
  // agent id -> the nodes of its entry
  const items = new Map();
  const open = new Set();

  const mode = () => railMode({ view: viewMode(), run: Boolean(view?.runId), wide: media.matches, collapsed, overlay });

  function item() {
    const li = el('li', 'act');
    const it = {
      el: li, glyph: el('span', 'act-glyph'), name: el('span', 'act-name mono'), role: el('span', 'act-role'), status: el('span', 'act-status'),
      line: el('p', 'act-line'), block: createLiveBlock(open),
    };
    it.glyph.setAttribute('aria-hidden', 'true');
    const head = el('div', 'act-head');
    head.append(it.glyph, it.name, it.role, it.status);
    li.append(head, it.line, it.block.el);
    return it;
  }

  function fill(it, a) {
    it.el.dataset.status = a.status;
    it.el.dataset.live = String(a.live);
    if (a.gate) it.el.dataset.gate = a.gate;
    else delete it.el.dataset.gate;
    say(it.glyph, STATUS_GLYPH[a.status] ?? (a.status === 'rejected' ? STATUS_GLYPH.cancelled : '○'));
    say(it.name, a.name);
    say(it.role, a.role);
    say(it.status, a.status);
    say(it.line, a.line);
    it.line.title = a.line;
    it.block.update(a);
  }

  function drawAgents() {
    const { shown, hidden } = railAgents(view.agents, all);
    for (const id of [...items.keys()]) if (!view.agents.some((a) => a.id === id)) items.delete(id);
    place(e.agents, shown.map((a) => {
      if (!items.has(a.id)) items.set(a.id, item());
      const it = items.get(a.id);
      fill(it, a);
      return it.el;
    }));
    // "now" is only true while the run is going
    say(e.agentsTitle, view.live ? 'Agents now' : 'Agents');
    say(e.agentsAside, agentsSummary(view.agents));
    e.agentsEmpty.hidden = view.agents.length > 0;
    e.agentsMore.hidden = !hidden && !(all && view.agents.length > RAIL_AGENTS_SHOWN);
    say(e.agentsMore, all ? 'Show fewer' : `Show all ${view.agents.length} agents`);
    e.agentsMore.setAttribute('aria-expanded', String(all));
    const off = view.live && liveOff();
    e.liveNote.hidden = !off;
    say(e.liveNote, off ? LIVE_OFF : '');
  }

  // A run that is over: how it ended comes first, and its diagram is folded away until it is asked for.
  function drawOutcome() {
    const o = view.outcome;
    e.outcome.hidden = !o;
    if (o) {
      say(e.oResult, o.label);
      e.oResult.dataset.tone = o.tone;
      say(e.oUnit, o.unit);
      say(e.oDone, o.done);
      e.oDoneFig.hidden = !o.done;
      say(e.oDuration, o.duration);
      e.oDurationFig.hidden = !o.duration;
      say(e.oCost, usageFigures(view.usage).cost);
    }
    if (chart.run !== view.runId) chart = { run: view.runId, open: false };
    const open = view.live || chart.open;
    e.usage.dataset.chart = open ? 'open' : 'closed';
    e.usageMore.hidden = view.live;
    say(e.usageMore, open ? 'Hide chart' : 'Show chart');
    e.usageMore.setAttribute('aria-expanded', String(open));
  }

  // Where the rail is, and what follows from it for the toggle, the drawer and the page.
  function sync() {
    if (overlay && (media.matches || viewMode() !== 'chat' || !view?.runId)) e.dialog.close();
    const m = mode();
    document.body.dataset.rail = m;
    e.rail.hidden = m !== 'open';
    e.toggle.hidden = m === 'none';
    e.toggle.setAttribute('aria-expanded', String(m === 'open' || m === 'overlay'));
    e.toggle.setAttribute('aria-controls', media.matches ? 'run-rail' : 'rail-dialog');
    if (media.matches) e.toggle.removeAttribute('aria-haspopup');
    else e.toggle.setAttribute('aria-haspopup', 'dialog');
    return m;
  }

  function render(next = view) {
    view = next;
    if (!view) return;
    const m = sync();
    // the cost stays on screen while the rail is not: the toggle carries it
    say(e.toggleFig, view.runId ? usageFigures(view.usage).cost : '');
    const line = liveLine(view, m);
    e.line.hidden = !line;
    say(e.lineText, line);
    // out of sight: nothing to draw, the next render that shows it does
    if (m !== 'open' && m !== 'overlay') return;
    say(e.status, [view.live ? 'live' : 'ended', agentsSummary(view.agents)].filter(Boolean).join(' · '));
    drawOutcome();
    drawAgents();
    usage.render(view.usage, { live: view.live });
    say(e.boardSummary, boardSummary(view.board));
    const notice = view.board.notice?.text ?? '';
    e.boardNotice.hidden = !notice;
    say(e.boardNotice, notice);
    e.boardNotice.dataset.loud = String(Boolean(view.board.notice?.loud));
  }

  function setOpen(next, { focus = null } = {}) {
    if (media.matches) {
      collapsed = !next;
      store.set(RAIL_KEY, collapsed ? 'closed' : 'open');
      render();
      focus?.focus();
      return;
    }
    if (!next) {
      e.dialog.close();
      return;
    }
    if (overlay) return;
    overlay = true;
    // the drawer shows the rail's own content, not a copy of it
    e.dialogBody.append(e.body);
    e.dialog.showModal();
    render();
    e.dialogClose.focus();
  }

  e.dialog.addEventListener('close', () => {
    if (!overlay) return;
    overlay = false;
    e.rail.append(e.body);
    render();
    (e.line.hidden ? e.toggle : e.line).focus();
  });
  e.dialogClose.addEventListener('click', () => e.dialog.close());
  e.toggle.addEventListener('click', () => setOpen(!(mode() === 'open' || mode() === 'overlay'), { focus: e.toggle }));
  e.close.addEventListener('click', () => setOpen(false, { focus: e.toggle }));
  e.line.addEventListener('click', () => setOpen(true, { focus: e.toggle }));
  e.agentsMore.addEventListener('click', () => {
    all = !all;
    render();
  });
  e.usageMore.addEventListener('click', () => {
    chart = { run: view?.runId ?? null, open: !chart.open };
    render();
  });
  e.board.addEventListener('click', () => openBoard?.());
  media.addEventListener?.('change', () => render());

  return {
    render,
    mode,
    // another chat: nobody of the previous one is listed, and nothing of it is open
    reset() {
      items.clear();
      open.clear();
      all = false;
      view = null;
      e.agents.replaceChildren();
      if (overlay) e.dialog.close();
      sync();
      e.line.hidden = true;
    },
  };
}

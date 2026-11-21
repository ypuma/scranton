// "Undo these changes" in the outcome of a finished Team run (undo.js): the chat's restore points are read on scope
// change, when a run of the chat finished and after every undo; the undo itself goes through the shared confirm
// dialog, and its result stays under the outcome, said once to screen readers. Every answer is checked against the
// chat it was asked for. Server text is only set as textContent.
import { request } from './context-panel.js';
import { findChat, chatEngine, ALIVE_STATUSES } from './scope.js';
import {
  undoUrl, parseRestorePoints, parseUndo, buildUndo, undoState, undoneText, leftText, partialText, unrestorableText, undoQuestion, forceQuestion, undoResult,
  stuckText, blockedText, changedOf, stuckOf, blockedOf, conflictText, changesNote, undoError, unsupported, undoWarnings, UNDO_LABEL, CONTINUE_LABEL, FORCE_LABEL,
  ACTIVE_TEXT, RECOVERY_TEXT, OLDER_TEXT, UNREADABLE_POINT, UNDOING_TEXT, UNKNOWN_TEXT, UNDO_TIMEOUT_MS,
} from './undo.js';

const $ = (id) => document.getElementById(id);
const MOVED = 'Another chat is on screen now. Nothing was sent.';
const UNREADABLE = 'The undo was sent, but its answer could not be read. Check the folder to see which files changed.';
// the states in which the last undo's result is shown; force only where the point can still be undone
const KEEPS = new Set(['offer', 'partial', 'undone']);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// one item per file: its path, then the server's reason
function fill(list, files) {
  list.hidden = !files.length;
  const key = JSON.stringify(files);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(...files.map((c) => {
    const li = el('li');
    const path = el('span', 'mono', c.path);
    path.title = c.path;
    li.append(path, ' ', el('span', 'hint', c.reason));
    return li;
  }));
}

function fillLines(list, lines) {
  list.hidden = !lines.length;
  const key = JSON.stringify(lines);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(...lines.map((t) => el('li', '', t)));
}

// getProjects(): the sidebar's projects document. confirm: the shared confirm dialog (control-panel.js). active():
// what the control document says holds the chat: 'recovery', any other truthy value for a run that is going, or
// nothing. announce(text): the page's polite announcer. onChange(): draw again. onUndone(): the folder changed, so
// what shows its files reads again.
export function createUndo({ getProjects = () => null, confirm, active = () => false, announce = () => {}, onChange = () => {}, onUndone = () => {} }) {
  const e = {
    box: $('rail-undo'), done: $('rail-undo-done'), run: $('rail-undo-run'), result: $('rail-undo-result'),
    conflicts: $('rail-undo-conflicts'), stuckText: $('rail-undo-stuck-text'), stuck: $('rail-undo-stuck'), warnings: $('rail-undo-warnings'),
    blockedText: $('rail-undo-blocked-text'), blocked: $('rail-undo-blocked'), force: $('rail-undo-force'),
  };
  e.force.textContent = FORCE_LABEL;
  let scope = null;
  let gen = 0;
  // the chat's restore points as last read, newest first, and how many readings there were
  let points = [];
  let listed = 0;
  let reading = null;
  // the last undo of this chat: { runId, force, text, conflicts, warnings, list }. list: the reading it is shown
  // against, null until the one after its answer; any later reading drops it.
  let result = null;
  // the POST in flight, { runId, promise }: a second OK while it goes waits for the same answer
  let sending = null;
  // what the outcome on screen asked for last: { runId, over, folder }
  let shown = null;
  // the chat as the sidebar last reported it: { alive, runs }
  let last = null;

  const team = () => chatEngine(getProjects(), scope) === 'team';
  const chatAlive = () => ALIVE_STATUSES.has(findChat(getProjects(), scope)?.status);
  const holder = () => active() || (chatAlive() ? 'run' : null);
  const pointOf = (runId) => (runId ? points.find((p) => p.runId === runId) ?? null : null);

  // a pipeline chat has no restore points; a server without the route has none either
  function load() {
    const url = scope && team() ? undoUrl(scope.project, scope.chat, 'restore-points') : null;
    if (!url) return Promise.resolve();
    reading?.abort();
    const ctl = new AbortController();
    reading = ctl;
    const at = gen;
    return request(url, { signal: ctl.signal }).then((r) => {
      if (at !== gen || reading !== ctl) return;
      reading = null;
      if (r.ok) {
        const doc = parseRestorePoints(r.data);
        if (doc.valid) adopt(doc.points);
      } else if (unsupported(r.status)) adopt([]);
      // another failure keeps what was read before
      onChange();
    });
  }

  function adopt(next) {
    points = next;
    listed += 1;
    if (result?.list === null) result.list = listed;
  }

  // runId and force are fixed when the human asks: the confirm dialog may sit between
  function send(runId, force) {
    if (sending) return sending.promise;
    const url = scope ? undoUrl(scope.project, scope.chat, 'undo') : null;
    const built = buildUndo(runId, force);
    if (!url || built.error) return { error: built.error ?? MOVED };
    const why = holder();
    if (why) return { error: why === 'recovery' ? RECOVERY_TEXT : ACTIVE_TEXT };
    if (result?.unknown && result.runId === runId && result.list === listed) return { error: UNKNOWN_TEXT };
    const mine = post(url, built.body, runId, force);
    sending = { runId, promise: mine };
    announce(UNDOING_TEXT);
    draw();
    return mine;
  }

  async function post(url, body, runId, force) {
    const at = gen;
    const ctl = new AbortController();
    let timer;
    const late = new Promise((r) => {
      timer = setTimeout(() => {
        ctl.abort();
        r(null);
      }, UNDO_TIMEOUT_MS);
    });
    const r = await Promise.race([request(url, { body, signal: ctl.signal }), late]);
    clearTimeout(timer);
    if (at !== gen) return {};
    sending = null;
    if (!r) {
      // the server may have undone any part of it: nothing is offered for this run until the points are read again
      result = { runId, force, text: UNKNOWN_TEXT, conflicts: [], warnings: [], list: listed, unknown: true };
      announce(UNKNOWN_TEXT);
      draw();
      return { error: UNKNOWN_TEXT };
    }
    if (!r.ok) {
      // the point is gone, or a run started: what is offered is read again
      load();
      draw();
      return { error: undoError(r.status, r.data) };
    }
    const u = parseUndo(r.data, runId);
    result = u.valid
      ? { runId, force, text: undoResult(u), conflicts: u.conflicts, warnings: undoWarnings(r.data), list: null }
      : { runId, force, text: UNREADABLE, conflicts: [], warnings: [], list: null };
    const said = (list) => (list.length ? ` ${list.map(conflictText).join('; ')}.` : '');
    const stuck = stuckText(result.conflicts);
    const blocked = blockedText(result.conflicts);
    announce(result.text + said(changedOf(result.conflicts)) + (stuck ? ` ${stuck}${said(stuckOf(result.conflicts))}` : '')
      + (blocked ? ` ${blocked}${said(blockedOf(result.conflicts))}` : '') + result.warnings.map((w) => ` ${w}`).join(''));
    draw();
    onUndone();
    const mine = result;
    await load();
    if (at !== gen) return {};
    // the reading failed: the points as they were read before
    if (mine.list === null) mine.list = listed;
    draw();
    return { focus: e.force.hidden ? e.result : e.force };
  }

  function ask(force) {
    const runId = shown?.runId;
    if (!runId || sending || !confirm) return;
    const pinned = { at: gen };
    const q = force ? forceQuestion(changedOf(view().mine.conflicts), shown.folder) : undoQuestion(shown.folder, pointOf(runId));
    confirm({
      ...q,
      scoped: pinned,
      action: () => (pinned.at !== gen ? { error: MOVED } : still(runId, force) ? send(runId, force) : {}),
    });
  }

  // the points may have been read again, or another run picked, while the dialog was open
  function still(runId, force) {
    const { s, state, mine } = view();
    return s?.runId === runId && (state === 'offer' || state === 'partial') && (!force || changedOf(mine?.conflicts ?? []).length > 0);
  }

  e.run.addEventListener('click', () => ask(false));
  e.force.addEventListener('click', () => {
    if (view().force) ask(true);
  });

  // What the run on screen shows. mine: the last undo's result, for this run and the points read after it, in a
  // state that keeps it; force: overwriting is offered from it.
  function view() {
    const s = shown;
    const run = s && { runId: s.runId, over: s.over, team: team() && Boolean(s.folder) };
    const state = undoState(run, points);
    const fresh = result && s && result.runId === s.runId && run.team && (result.list === null || result.list === listed);
    const mine = fresh && KEEPS.has(state) ? result : null;
    const force = Boolean(mine) && state !== 'undone' && changedOf(mine.conflicts).length > 0 && !mine.force && !holder();
    return { s, state, mine, force };
  }

  function draw() {
    const { s, state, mine, force } = view();
    const busy = Boolean(holder());
    const point = s ? pointOf(s.runId) : null;
    const going = Boolean(s) && sending?.runId === s.runId;
    // the result says it once; the state of the point is for a run undone before
    const said = mine || going ? ''
      : state === 'undone' ? undoneText(point.undoneAt) + leftText(point)
        : state === 'unrestorable' ? unrestorableText(point)
        : state === 'partial' ? partialText(point)
          : state === 'older' ? OLDER_TEXT
            : state === 'unreadable' ? UNREADABLE_POINT : '';
    e.done.hidden = !said;
    if (e.done.textContent !== said) e.done.textContent = said;
    // a result with blocked files keeps the way to retry them: undoing again is all they need
    const offer = (!mine || blockedOf(mine.conflicts).length > 0) && !busy && (state === 'offer' || state === 'partial');
    e.run.hidden = !offer;
    e.run.disabled = Boolean(sending);
    const label = state === 'partial' ? CONTINUE_LABEL : UNDO_LABEL;
    if (e.run.textContent !== label) e.run.textContent = label;
    const text = going ? UNDOING_TEXT : mine?.text ?? '';
    e.result.hidden = !text;
    if (e.result.textContent !== text) e.result.textContent = text;
    const list = going ? [] : mine?.conflicts ?? [];
    fill(e.conflicts, changedOf(list));
    const stuck = stuckText(list);
    e.stuckText.hidden = !stuck;
    if (e.stuckText.textContent !== stuck) e.stuckText.textContent = stuck;
    fill(e.stuck, stuckOf(list));
    const blocked = blockedText(list);
    e.blockedText.hidden = !blocked;
    if (e.blockedText.textContent !== blocked) e.blockedText.textContent = blocked;
    fill(e.blocked, blockedOf(list));
    fillLines(e.warnings, going ? [] : mine?.warnings ?? []);
    // overwriting is its own decision, only for files force can put back, and never while a run is going
    e.force.hidden = !force;
    e.force.disabled = Boolean(sending);
    e.box.hidden = !said && !offer && !text;
  }

  // The outcome on screen: runId, over (the run finished and is not live), folder (where its files are; null for a
  // run whose changes are kept elsewhere).
  function render(next) {
    shown = next?.runId ? { runId: next.runId, over: Boolean(next.over), folder: next.folder || null } : null;
    // another run on screen: the result was about the one before; an unknown one stays until the points are read again
    if (result && result.runId !== shown?.runId && !result.unknown) result = null;
    draw();
  }

  // Another chat on screen (or none): nothing of the old one is kept.
  function setScope(next) {
    gen += 1;
    reading?.abort();
    reading = null;
    scope = next?.project && next?.chat ? { project: next.project, chat: next.chat } : null;
    points = [];
    result = null;
    sending = null;
    shown = null;
    const c = findChat(getProjects(), scope);
    last = c ? { alive: ALIVE_STATUSES.has(c.status), runs: c.runs } : null;
    draw();
    return load();
  }

  // The sidebar's document changed: a run of this chat that finished has a restore point now.
  function projects(doc) {
    if (!scope) return;
    const c = findChat(doc, scope);
    const now = c ? { alive: ALIVE_STATUSES.has(c.status), runs: c.runs } : null;
    const before = last;
    last = now;
    if (before && now && !now.alive && (before.alive || before.runs !== now.runs)) load();
    else draw();
  }

  // point(runId): its restore point as last read, for the outcome's files line. note(runId): what the Changes panel
  // says above the diff of a run that was undone.
  return {
    render, setScope, projects, refresh: load,
    point: (runId) => (scope && team() ? pointOf(runId) : null),
    note: (runId) => (scope && team() ? changesNote(pointOf(runId)) : ''),
    points: () => [...points],
  };
}

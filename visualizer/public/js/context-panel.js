// The Context surface of a chat (.enma/context-contract.md section 10, .enma/context-budget-contract.md section 11):
// one line in the follow-up composer that says what the next turn would receive, and a drawer with the chat
// document, its budget in tokens, the developer brief, Start fresh / Restore earlier turns and the project's budget,
// sharing switch and notes. It reads on scope change, when a run of the chat
// finished, after each change and when the drawer opens; it never polls. Every answer is checked against the chat
// it was asked for, so a reply that lands after the page moved on is dropped. Server text is only set as textContent.
import { CLIENT_HEADERS, CONTROL_HEADERS } from './control.js';
import { formatWhen } from './format.js';
import { findChat, findProject, sameScope, ALIVE_STATUSES } from './scope.js';
import {
  ENGINE_LABEL, UNREADABLE, DEFAULTS, BUDGET_MODES, METER_CELLS, contextUrl, chatContextUrl, parseProjectContext, parseChatContext, contextLine,
  summaryRows, usageText, meterFill, windowNote, cappedText, developerText, modelText, ruleText, flagsText, resetText, resetQuestion,
  sectionNote, budgetState, previewText, switchMode, rangeText, buildBudget, buildBudgetReset, atDefault, buildCrossChat, buildNotes,
  notesCount, unsupported, contextError, tokenText,
} from './context.js';

const $ = (id) => document.getElementById(id);
const BUSY_TEXT = { reset: 'Starting fresh...', restore: 'Restoring earlier turns...', settings: 'Saving...', notes: 'Saving notes...', budget: 'Saving budget...' };
const DONE_TEXT = {
  reset: 'Started fresh. The next turn gets none of the earlier turns of this chat.',
  restore: 'Earlier turns restored. The next turn gets them again.',
  notes: 'Notes saved. New turns of every chat in this project get them.',
  budget: 'Budget saved. The next turn of every chat in this project uses it.',
  budgetReset: 'Budget reset to the default.',
};
// the changes that answer with the project document; budget posts to the settings route
const PROJECT_KINDS = new Set(['settings', 'notes', 'budget']);
const NOT_LOADED = 'Context: not loaded';
const LINE_TITLE = 'What the next turn of this chat receives as context';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// GET without a body, POST as JSON with the control headers. -> { ok, status, data }; status 0 = no answer
export async function request(url, { body, signal } = {}) {
  try {
    const r = await fetch(url, body === undefined
      ? { cache: 'no-store', headers: CLIENT_HEADERS, signal }
      : { method: 'POST', cache: 'no-store', headers: CONTROL_HEADERS, body: JSON.stringify(body), signal });
    let data = null;
    try { data = await r.json(); } catch { /* empty or non-JSON body */ }
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// getProjects(): the sidebar's projects document (mode, names, chat status). confirm: the shared confirm dialog,
// used before unsaved notes or an unsaved budget are dropped. plannerModel(): the planner pick the Pipeline form
// will send ({ provider, model } or null), the recipient of a Pipeline chat's pack.
export function createContextPanel({ getProjects = () => null, confirm = null, plannerModel = () => null } = {}) {
  const e = {
    line: $('context-line'), lineText: $('context-line-text'),
    dialog: $('context-dialog'), chat: $('context-chat'), body: $('context-body'), error: $('context-error'),
    retryRow: $('context-retry-row'), retry: $('context-retry'), empty: $('context-empty'), content: $('context-content'),
    engine: $('context-engine'), truncated: $('context-truncated'), degraded: $('context-degraded'), resetAt: $('context-reset-at'),
    usage: $('context-usage'), meter: $('context-meter'), windowNote: $('context-window-note'), capped: $('context-capped'),
    figures: $('context-figures'), flags: $('context-flags'), sections: $('context-sections'), sectionsEmpty: $('context-sections-empty'),
    budget: $('context-budget'), budgetMode: $('context-budget-mode'), budgetValue: $('context-budget-value'), budgetRange: $('context-budget-range'),
    budgetOnlyRow: $('context-budget-only-row'), budgetOnly: $('context-budget-only'), budgetOnlyLabel: $('context-budget-only-label'),
    budgetPreview: $('context-budget-preview'), budgetError: $('context-budget-error'), budgetStatus: $('context-budget-status'),
    budgetReset: $('context-budget-reset'), budgetSave: $('context-budget-save'),
    devSection: $('context-developer-section'), devUsage: $('context-developer-usage'), dev: $('context-developer'), devEmpty: $('context-developer-empty'),
    historyNote: $('context-history-note'), reset: $('context-reset'), restore: $('context-restore'), actionStatus: $('context-action-status'),
    confirmBox: $('context-reset-confirm'), question: $('context-reset-question'), resetCancel: $('context-reset-cancel'), resetOk: $('context-reset-ok'),
    form: $('context-project'), projectName: $('context-project-name'), projectError: $('context-project-error'),
    crossRow: $('context-cross-row'), cross: $('context-cross'), crossHint: $('context-cross-hint'), crossStatus: $('context-cross-status'),
    notes: $('context-notes'), count: $('context-notes-count'), notesError: $('context-notes-error'), notesStatus: $('context-notes-status'),
    undo: $('context-notes-undo'), save: $('context-notes-save'), foot: $('context-foot'),
  };
  // { project, chat } on screen; null without a chat
  let scope = null;
  // bumped on every scope change: an answer for an older scope is dropped
  let gen = 0;
  // the parsed chat and project documents of the scope
  let doc = null;
  let pdoc = null;
  // null = not known yet, false = this server has no context routes (single hive, older server)
  let available = null;
  let chatError = '';
  let projectError = '';
  let loading = false;
  let readChat = null;
  // the planner pick the last chat read was asked for, as JSON
  let readPick = 'null';
  let readProject = null;
  let sending = null;
  // the change on its way: 'reset' | 'restore' | 'settings' | 'notes' | 'budget'
  let busy = null;
  let confirming = false;
  // the saved notes the editor started from; null while there is none
  let notesSnap = null;
  // the budget control as it was last filled from the documents; null while it was not
  let budgetSnap = null;
  let opener = null;
  // the chat as the sidebar last reported it: { alive, runs }
  let last = null;

  const registry = () => getProjects()?.mode === 'registry';
  const dirty = () => notesSnap !== null && e.notes.value !== notesSnap;
  const budgetForm = () => JSON.stringify([e.budgetMode.value, e.budgetValue.value, e.budgetOnly.checked]);
  const budgetDirty = () => budgetSnap !== null && budgetForm() !== budgetSnap;
  // only a Pipeline chat sends the pick: a Team chat's recipients are the Agents defaults
  const pick = () => (findChat(getProjects(), scope)?.engine === 'pipeline' ? plannerModel() : null);

  function setText(node, text, tone) {
    if (node.textContent !== text) node.textContent = text;
    if (tone !== undefined && node.dataset.tone !== tone) node.dataset.tone = tone;
  }

  // role=alert: a rewrite of the same text is announced again on every render
  function showError(node, text) {
    setText(node, text);
    node.hidden = !text;
  }

  // rebuilt only when what it shows changed, so a reread leaves focus and scroll alone
  function fill(node, key, build) {
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.replaceChildren(...build());
  }

  // ------------------------------------------------------------ server
  function loadChat() {
    const asked = pick();
    const url = scope && registry() ? chatContextUrl(scope.project, scope.chat, '', asked) : null;
    if (!url) return Promise.resolve();
    readPick = JSON.stringify(asked);
    readChat?.abort();
    const ctl = new AbortController();
    readChat = ctl;
    const at = gen;
    loading = true;
    render();
    return request(url, { signal: ctl.signal }).then((r) => {
      if (at !== gen || readChat !== ctl) return;
      readChat = null;
      loading = false;
      if (r.ok) {
        const d = parseChatContext(r.data);
        available = true;
        if (d.valid) doc = d;
        chatError = d.valid ? '' : UNREADABLE;
        if (d.valid) syncBudget();
      } else if (unsupported(r.status)) {
        available = false;
        doc = null;
        chatError = '';
      } else {
        // a failed read keeps what was shown and says so in the line
        if (available === null) available = true;
        chatError = contextError(r.status, r.data);
      }
      render();
    });
  }

  function loadProject() {
    // a change on its way answers with the project document; a read started meanwhile could land later and be older
    const url = scope && registry() && e.dialog.open && !PROJECT_KINDS.has(busy) ? contextUrl(scope.project) : null;
    if (!url) return Promise.resolve();
    readProject?.abort();
    const ctl = new AbortController();
    readProject = ctl;
    const at = gen;
    return request(url, { signal: ctl.signal }).then((r) => {
      if (at !== gen || readProject !== ctl) return;
      readProject = null;
      const p = r.ok ? parseProjectContext(r.data) : null;
      if (p?.valid) {
        pdoc = p;
        projectError = '';
        syncNotes();
        syncBudget();
      } else {
        projectError = r.ok ? UNREADABLE : contextError(r.status, r.data);
      }
      render();
    });
  }

  function refresh() {
    return Promise.all([loadChat(), loadProject()]);
  }

  // done: what the status line says once it worked, when the kind's own text does not fit. -> {} | { error } | { stale: true }
  async function act(kind, body = {}, done = '') {
    if (!scope || busy) return { stale: true };
    const project = PROJECT_KINDS.has(kind);
    const url = project ? contextUrl(scope.project, kind === 'budget' ? 'settings' : kind) : chatContextUrl(scope.project, scope.chat, kind);
    if (!url) return { stale: true };
    const at = gen;
    busy = kind;
    // a read still on its way would land on top of this answer; a failed change reads again what it cancelled
    const dropped = Boolean(readChat);
    readChat?.abort();
    readChat = null;
    loading = false;
    if (project) {
      readProject?.abort();
      readProject = null;
    }
    const where = kind === 'settings' ? e.crossStatus : kind === 'notes' ? e.notesStatus : kind === 'budget' ? e.budgetStatus : e.actionStatus;
    for (const node of [e.crossStatus, e.notesStatus, e.budgetStatus, e.actionStatus]) setText(node, '', '');
    showError(e.notesError, '');
    showError(e.budgetError, '');
    setText(where, BUSY_TEXT[kind], 'busy');
    render();
    const ctl = new AbortController();
    sending = ctl;
    const r = await request(url, { body, signal: ctl.signal });
    if (at !== gen) return { stale: true };
    sending = null;
    busy = null;
    setText(where, '', '');
    if (!r.ok) {
      const error = contextError(r.status, r.data);
      if (kind === 'notes') showError(e.notesError, error);
      else setText(where, error, 'error');
      // the drawer was closed and opened again meanwhile, and its read waited for this answer
      if (project && !pdoc) loadProject();
      if (dropped) loadChat();
      render();
      return { error };
    }
    let ok = true;
    if (project) {
      const p = parseProjectContext(r.data);
      ok = p.valid;
      if (p.valid) {
        pdoc = p;
        syncNotes({ force: kind === 'notes' });
        syncBudget({ force: kind === 'budget' });
        setText(where, done || (kind === 'settings' ? crossText(p.settings.crossChat) : DONE_TEXT[kind]));
      } else {
        setText(where, UNREADABLE, 'error');
        loadProject();
      }
      // the next turn's pack follows the project's settings and notes
      loadChat();
    } else {
      const d = parseChatContext(r.data);
      ok = d.valid;
      if (d.valid) {
        doc = d;
        available = true;
        chatError = '';
        setText(where, DONE_TEXT[kind]);
        // the answer has no planner pick, so a Pipeline chat reads its document again with it
        if (pick()) loadChat();
      } else {
        setText(where, UNREADABLE, 'error');
        loadChat();
      }
    }
    render();
    return ok ? {} : { error: UNREADABLE };
  }

  const crossHint = (on) => `${on
    ? 'On: the next turn of every chat here also gets a short digest of the other chats of this project.'
    : 'Off: no chat of this project receives or provides the other chats part.'} Projects never share anything with each other.`;
  const crossText = (on) => (on
    ? 'Sharing is on. The chats of this project see a short digest of each other\'s turns.'
    : 'Sharing is off. No chat of this project receives or provides the other chats part.');

  // ------------------------------------------------------------ notes
  function syncNotes({ force = false } = {}) {
    if (!pdoc || (!force && dirty())) return;
    e.notes.value = pdoc.notes.text;
    notesSnap = e.notes.value;
    e.notes.removeAttribute('aria-invalid');
    // a failed save that landed after the drawer closed is still shown when it opens again
    if (force) showError(e.notesError, '');
  }

  e.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy || !pdoc || !dirty()) return;
    const built = buildNotes(e.notes.value);
    if (built.error) {
      showError(e.notesError, built.error);
      e.notes.setAttribute('aria-invalid', 'true');
      e.notes.focus();
      return;
    }
    const r = await act('notes', built.body);
    if (r.error && e.dialog.open) e.notes.focus();
  });
  e.notes.addEventListener('input', () => {
    e.notes.removeAttribute('aria-invalid');
    showError(e.notesError, '');
    setText(e.notesStatus, '', '');
    render();
  });
  e.undo.addEventListener('click', () => {
    syncNotes({ force: true });
    render();
    e.notes.focus();
  });

  // ------------------------------------------------------------ budget
  // The control follows the documents until the human changes it; an override of this recipient wins over the
  // project rule, as on the server.
  function syncBudget({ force = false } = {}) {
    if (!doc || (!force && budgetDirty())) return;
    const s = budgetState(doc, pdoc);
    e.budgetMode.value = s.mode;
    e.budgetValue.value = s.value;
    e.budgetOnly.checked = s.only;
    budgetSnap = budgetForm();
    e.budgetValue.removeAttribute('aria-invalid');
  }

  function budgetIdle() {
    showError(e.budgetError, '');
    setText(e.budgetStatus, '', '');
    e.budgetValue.removeAttribute('aria-invalid');
  }

  e.budget.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy || !pdoc || !doc) return;
    const built = buildBudget({ mode: e.budgetMode.value, value: e.budgetValue.value, only: e.budgetOnly.checked }, budgetState(doc, pdoc), pdoc);
    if (built.error) {
      showError(e.budgetError, built.error);
      const field = built.field === 'value' ? e.budgetValue : built.field === 'only' ? e.budgetOnly : e.budgetMode;
      if (field === e.budgetValue) field.setAttribute('aria-invalid', 'true');
      field.focus();
      return;
    }
    const r = await act('budget', built.body);
    if (r.error && e.dialog.open) e.budgetValue.focus();
  });
  e.budgetReset.addEventListener('click', async () => {
    if (busy || !pdoc || !doc) return;
    const r = await act('budget', buildBudgetReset(budgetState(doc, pdoc)).body, DONE_TEXT.budgetReset);
    if (!r.stale && e.dialog.open) (e.budgetReset.disabled ? e.budgetValue : e.budgetReset).focus();
  });
  // another mode keeps the budget it stands for
  e.budgetMode.addEventListener('change', () => {
    if (BUDGET_MODES.includes(e.budgetMode.value) && doc) e.budgetValue.value = switchMode(e.budgetMode.value, e.budgetValue.value, doc.model.window, pdoc?.defaults);
    budgetIdle();
    render();
  });
  for (const node of [e.budgetValue, e.budgetOnly]) {
    node.addEventListener(node === e.budgetOnly ? 'change' : 'input', () => {
      budgetIdle();
      render();
    });
  }

  // ------------------------------------------------------------ sharing
  e.cross.addEventListener('change', async () => {
    if (busy || !pdoc) {
      render();
      return;
    }
    const r = await act('settings', buildCrossChat(e.cross.checked).body);
    // a refused change shows the saved state again
    if (r.error) render();
  });

  // ------------------------------------------------------------ start fresh / restore
  function askReset(on) {
    confirming = on;
    render();
    (on ? e.resetCancel : e.reset).focus();
  }
  e.reset.addEventListener('click', () => {
    if (busy || !doc) return;
    askReset(!confirming);
  });
  e.resetCancel.addEventListener('click', () => askReset(false));
  e.resetOk.addEventListener('click', async () => {
    if (busy || !confirming) return;
    const r = await act('reset');
    if (r.stale) return;
    confirming = false;
    render();
    if (e.dialog.open) e.reset.focus();
  });
  e.restore.addEventListener('click', async () => {
    if (busy || !doc?.reset) return;
    const r = await act('restore');
    // the button goes once the marker is gone
    if (!r.stale && e.dialog.open) (e.restore.hidden ? e.reset : e.restore).focus();
  });
  e.retry.addEventListener('click', () => {
    chatError = '';
    projectError = '';
    refresh();
  });

  // ------------------------------------------------------------ rendering
  function renderLine() {
    const show = Boolean(scope) && registry() && available === true && Boolean(doc || chatError);
    e.line.hidden = !show;
    if (!show) return;
    const stale = Boolean(doc && chatError);
    setText(e.lineText, doc ? contextLine(doc, stale) : NOT_LOADED);
    e.line.dataset.tone = doc && !stale ? '' : 'error';
    const title = stale ? `The last read failed, this is the context read before: ${chatError}` : LINE_TITLE;
    if (e.line.title !== title) e.line.title = title;
  }

  function render() {
    renderLine();
    if (!e.dialog.open) return;
    const navDoc = getProjects();
    setText(e.chat, findChat(navDoc, scope)?.title ?? '');
    const d = doc;
    const emptyText = !scope ? 'No chat is selected.' : available === false ? 'This server does not offer context for chats.' : !d && !chatError ? 'Loading context...' : '';
    setText(e.empty, emptyText);
    e.empty.hidden = !emptyText;
    showError(e.error, available === false ? '' : chatError);
    e.retryRow.hidden = !(chatError || projectError) || loading || Boolean(busy);
    e.content.hidden = !d;
    e.body.setAttribute('aria-busy', String(Boolean(busy) || (loading && !d)));
    setText(e.foot, dirty() ? 'Unsaved notes' : budgetDirty() ? 'Unsaved budget' : '');
    if (!d) return;

    setText(e.engine, ENGINE_LABEL[d.engine]);
    e.truncated.hidden = !d.truncated;
    e.degraded.hidden = !d.degraded;
    setText(e.resetAt, d.reset ? `Fresh start ${formatWhen(d.reset.at)}` : '');
    renderUsage(d);
    fill(e.figures, JSON.stringify(summaryRows(d)), () => summaryRows(d).flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
    const flags = flagsText(d);
    // shortening to fit is routine; only a part that could not be read is loud
    setText(e.flags, flags, d.degraded ? '' : 'quiet');
    e.flags.hidden = !flags;

    setText(e.sectionsEmpty, d.sections.length ? '' : 'Nothing yet. The next turn starts with its request alone.');
    e.sectionsEmpty.hidden = d.sections.length > 0;
    blocks(e.sections, d.sections);
    e.devSection.hidden = !d.developer;
    setText(e.devUsage, d.developer ? developerText(d.developer) : '');
    const dev = d.developer?.text ? [{ id: 'developer', title: 'Developer brief', tokens: d.developer.tokens, text: d.developer.text, exact: true }] : [];
    e.devEmpty.hidden = !d.developer || dev.length > 0;
    blocks(e.dev, dev);

    setText(e.historyNote, resetText(d, (t) => formatWhen(t)));
    e.reset.disabled = Boolean(busy);
    e.reset.setAttribute('aria-expanded', String(confirming));
    e.restore.hidden = !d.reset;
    e.restore.disabled = Boolean(busy);
    e.confirmBox.hidden = !confirming;
    setText(e.question, resetQuestion(d));
    e.resetOk.disabled = Boolean(busy);
    e.resetCancel.disabled = Boolean(busy);

    setText(e.projectName, findProject(navDoc, scope?.project)?.name ?? '');
    showError(e.projectError, projectError);
    const shared = (pdoc ?? d).settings.crossChat;
    if (busy !== 'settings') e.cross.checked = shared;
    // the line under the box says what the box says now
    setText(e.crossHint, crossHint(e.cross.checked));
    e.cross.disabled = Boolean(busy) || !pdoc;
    e.crossRow.dataset.disabled = String(e.cross.disabled);
    e.notes.disabled = !pdoc || busy === 'notes';
    setText(e.count, notesCount(e.notes.value));
    e.save.disabled = Boolean(busy) || !pdoc || !dirty();
    e.undo.hidden = !dirty();
    renderBudget(d);
  }

  // the summary line, the meter of used against budget, and what limited the budget
  function renderUsage(d) {
    const text = usageText(d);
    setText(e.usage, text);
    const { used, tokens: budget } = d.budget;
    e.meter.hidden = !budget;
    const k = meterFill(used, budget);
    fill(e.meter, String(k), () => Array.from({ length: METER_CELLS }, (_, i) => {
      const cell = el('i');
      cell.dataset.fill = i < k ? 'full' : '';
      return cell;
    }));
    e.meter.setAttribute('aria-valuemax', String(budget));
    e.meter.setAttribute('aria-valuenow', String(Math.min(used, budget)));
    e.meter.setAttribute('aria-valuetext', text);
    const win = windowNote(d.model);
    setText(e.windowNote, win);
    e.windowNote.hidden = !win;
    const capped = cappedText(d);
    setText(e.capped, capped);
    e.capped.hidden = !capped;
  }

  function renderBudget(d) {
    const s = budgetState(d, pdoc);
    const defaults = pdoc?.defaults ?? DEFAULTS;
    const mode = BUDGET_MODES.includes(e.budgetMode.value) ? e.budgetMode.value : s.mode;
    const [lo, hi] = defaults[mode];
    e.budgetValue.setAttribute('min', String(lo));
    e.budgetValue.setAttribute('max', String(hi));
    setText(e.budgetRange, rangeText(mode, defaults));
    // Automatic has no id an override could be stored under
    e.budgetOnlyRow.hidden = !s.id;
    setText(e.budgetOnlyLabel, s.id ? `Only for ${modelText(s.id)}` : '');
    const v = Number(e.budgetValue.value);
    setText(e.budgetPreview, Number.isInteger(v) && v >= lo && v <= hi ? previewText({ mode, value: v }, d, defaults) : '');
    const off = Boolean(busy) || !pdoc;
    for (const x of [e.budgetMode, e.budgetValue, e.budgetOnly]) x.disabled = off;
    e.budgetSave.disabled = off || !budgetDirty();
    e.budgetReset.disabled = off || atDefault(s, pdoc);
    const title = s.override ? `Remove the override for ${modelText(s.id)}; the project rule applies again` : `Back to the default: ${ruleText(defaults.budget)}`;
    if (e.budgetReset.title !== title) e.budgetReset.title = title;
  }

  // one collapsible block per section; the ones the human opened stay open across a reread
  function blocks(node, list) {
    const opened = new Set([...node.childNodes].filter((x) => x.open).map((x) => x.dataset.section));
    fill(node, JSON.stringify(list), () => list.map((s) => {
      const det = el('details', 'context-block');
      det.dataset.section = s.id;
      det.open = opened.has(s.id);
      const sum = el('summary');
      const kind = el('span', 'badge', s.exact ? 'Exact' : 'Summary');
      kind.dataset.tone = s.exact ? 'on' : 'quiet';
      sum.append(el('span', 'context-block-title', s.title), kind, el('span', 'hint context-block-size', tokenText(s.tokens)));
      const pre = el('pre', 'context-text', s.text);
      // a scroller has to be reachable from the keyboard
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', s.title);
      det.append(sum, el('p', 'hint context-block-note', sectionNote(s)), pre);
      return det;
    }));
  }

  // ------------------------------------------------------------ drawer
  function open() {
    if (!scope || !registry() || available === false) return false;
    if (!e.dialog.open) {
      opener = document.activeElement;
      e.dialog.showModal();
    }
    confirming = false;
    e.dialog.querySelector('[data-close]')?.focus();
    render();
    refresh();
    return true;
  }

  const usable = (t) => t && t !== document.body && t.isConnected && !t.closest?.('[hidden]') && !t.disabled;

  function finish() {
    e.dialog.close();
    return usable(opener) ? opener : null;
  }

  const unsaved = () => dirty() || budgetDirty();

  function requestClose() {
    if (!unsaved() || !confirm) return finish();
    const both = dirty() && budgetDirty();
    confirm({
      title: both ? 'Discard unsaved changes?' : dirty() ? 'Discard notes changes?' : 'Discard budget changes?',
      detail: both ? 'The project notes and the context budget you changed are not saved.' : dirty() ? 'The project notes you changed are not saved.' : 'The context budget you changed is not saved.',
      ok: 'Discard',
      action: () => ({ focus: finish() }),
    });
    return null;
  }

  e.line.addEventListener('click', open);
  for (const b of e.dialog.querySelectorAll('[data-close]')) b.addEventListener('click', requestClose);
  e.dialog.addEventListener('click', (ev) => {
    if (ev.target === e.dialog) requestClose();
  });
  // Escape first leaves the inline confirmation, then the drawer
  e.dialog.addEventListener('cancel', (ev) => {
    if (confirming) {
      ev.preventDefault();
      askReset(false);
      return;
    }
    if (!unsaved() || !confirm) return;
    ev.preventDefault();
    requestClose();
  });
  e.dialog.addEventListener('close', () => {
    readProject?.abort();
    readProject = null;
    pdoc = null;
    projectError = '';
    notesSnap = null;
    e.notes.value = '';
    // the control is filled from the documents again when the drawer opens
    budgetSnap = null;
    confirming = false;
    for (const node of [e.crossStatus, e.notesStatus, e.budgetStatus, e.actionStatus]) setText(node, '', '');
    showError(e.notesError, '');
    showError(e.budgetError, '');
    setText(e.foot, '');
    const target = opener;
    opener = null;
    if (usable(target)) target.focus();
  });

  // Another chat on screen (or none): everything of the old one is dropped and the new one read.
  function setScope(next) {
    const s = next?.project && next?.chat ? { project: next.project, chat: next.chat } : null;
    if (sameScope(s, scope) && Boolean(s) === Boolean(scope) && gen > 0) return;
    gen += 1;
    for (const c of [readChat, readProject, sending]) c?.abort();
    readChat = readProject = sending = null;
    scope = s;
    doc = null;
    pdoc = null;
    available = null;
    chatError = '';
    projectError = '';
    loading = false;
    busy = null;
    confirming = false;
    budgetSnap = null;
    const c = findChat(getProjects(), scope);
    last = c ? { alive: ALIVE_STATUSES.has(c.status), runs: c.runs } : null;
    if (e.dialog.open) e.dialog.close();
    render();
    loadChat();
  }

  // The sidebar's document changed: a run of this chat that finished (or a turn added meanwhile) changes the pack.
  function projects(navDoc) {
    if (!scope) return;
    const c = findChat(navDoc, scope);
    const now = c ? { alive: ALIVE_STATUSES.has(c.status), runs: c.runs } : null;
    const before = last;
    last = now;
    if (available !== false && before && now && !now.alive && (before.alive || before.runs !== now.runs)) loadChat();
    else render();
  }

  // The Pipeline form's planner pick changed: a Pipeline chat's recipient is that pick, so its document is read
  // again. A Team chat's pick is always null, so it never is.
  function plannerChanged() {
    if (scope && available !== false && JSON.stringify(pick()) !== readPick) loadChat();
  }

  return {
    setScope, projects, refresh, open, render, plannerChanged,
    doc: () => doc,
    shown: () => !e.line.hidden,
  };
}

// Run control (docs/CONTROL.md): New run drawer, Stop run, the human-answer panel, the exit output
// of a run process that died, and notifications. Invisible unless GET /api/control says enabled.
import {
  CLIENT_HEADERS, CONTROL_HEADERS, DECISION_LABEL, CONFIRM_DECISIONS, REQUEST_MAX, FEEDBACK_MAX,
  parseControl, buildRunRequest, buildHitlRequest, responseError, answeredInState, sentOutcome, hitlPhase,
  hitlAnnouncement, hitlTitle, openPending, exitToShow, exitSettleLeft, exitKey, runInterrupted, notificationFor, documentTitle, humanWhere,
  errorField, modelErrorRoles, controlGates, clip, executionDefaults, permissionsDefault, exitHint, runModeOf,
  WORKFLOW_KEY, WORKFLOW_DEFAULT, WORKFLOW_ERROR, parseStoredWorkflow, workflowGates, buildWorkflow, configuredChoice, workflowNote,
  gateCatalog, roleIds, customNames, stagesOf, canReleaseOrphan, releaseOffered, recoveryText, recoveryTimes, startBlock,
} from './control.js';
import { trustKey, isTrusted, rememberTrust } from './trust.js';
import { formatClock, stripBidi } from './format.js';
import { workflowText } from './state.js';
import { RUN_DEFAULTS_KEY, parseRunDefaults } from './prefs.js';
import { scopedUrl, runStartError, buildFollowUp } from './scope.js';

const POLL_ALIVE_MS = 1000;
const POLL_IDLE_MS = 5000;
const NOTIFY_KEY = 'scranton.notify';
const DISMISS_KEY = 'scranton.exitDismissed';
const REFRESH_ON = new Set(['run_started', 'run_finished', 'hitl_request', 'hitl_response']);
const MOVED = 'Another chat is on screen now. Nothing was sent.';
const SANDBOX_TEXT = { scranton: 'Scranton sandbox', docker: 'Docker sandbox', host: 'no sandbox' };
// what the closed Options fold says about a permission mode other than Ask
const PERMISSIONS_TEXT = { auto: 'auto-approves access', bypass: 'bypasses permissions' };

const $ = (id) => document.getElementById(id);

export const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* storage blocked: the setting lasts for this page only */ }
  },
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function postJson(url, body = {}) {
  return sendJson('POST', url, body);
}

// Every control mutation is JSON with the client header (the server answers 415 without the content type).
export async function sendJson(method, url, body = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: CONTROL_HEADERS, body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, error: 'The server did not answer. Is it still running?' };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  return res.ok ? { ok: true, status: res.status, data } : { ok: false, status: res.status, data, error: responseError(res.status, data) };
}

// url(suffix): where the chat on screen answers ('control', 'runs', 'hitl', 'stop'); null = no chat selected.
// workspace(): the project's folder when runs go to a project, which then fixes the workspace field.
// limits(): { running, maxConcurrentRuns } for the 429 text. onNewRun(): true when it handled New run itself.
// replaying(): an archived run is on screen, so New run waits until the live run is back.
// pipelineForm: the drawer's Pipeline part (pipeline-form.js); a target with startPipeline offers it.
// chatKey(): the chat on screen as trust.js names it; the no-sandbox acknowledgement is kept per chat.
export function createControlPanel({
  dashboard, pipeline, lanes, models, getState, onRender,
  url = (suffix) => scopedUrl(null, suffix), workspace = () => null, limits = () => null, onNewRun = () => false,
  replaying = () => false, pipelineForm = null, chatKey = () => null,
}) {
  const e = {
    actions: $('run-actions'), newRun: $('new-run'), stop: $('stop-run'), bell: $('notify-toggle'),
    hitl: $('hitl'), hitlTitle: $('hitl-title'), hitlMeta: $('hitl-meta'), hitlReason: $('hitl-reason'),
    hitlActions: $('hitl-actions'), hitlForm: $('hitl-feedback'), hitlText: $('hitl-text'), hitlCount: $('hitl-count'),
    hitlCancel: $('hitl-cancel'), hitlSend: $('hitl-send'), hitlStatus: $('hitl-status'),
    exit: $('exit-panel'), exitTitle: $('exit-title'), exitAside: $('exit-aside'), exitTail: $('exit-tail'), exitDismiss: $('exit-dismiss'),
    emptyCli: $('empty-cli'), emptyControl: $('empty-control'), emptyTitle: $('empty-control-title'), emptyDetail: $('empty-control-detail'),
    runDialog: $('run-dialog'), runForm: $('run-form'), runSubmit: $('run-submit'), runBusy: $('run-busy'), runError: $('run-error'),
    advanced: $('run-advanced'), options: $('run-options'), optionsSummary: $('run-options-summary'), trustKept: $('f-trust-kept'), fRequest: $('f-request'), fRequestOpt: $('f-request-opt'), fRequestCount: $('f-request-count'),
    fWorkspace: $('f-workspace'), fCycles: $('f-cycles'), fStalled: $('f-stalled'), fBudget: $('f-budget'), fNoPlan: $('f-noplan'), fDemo: $('f-demo'),
    fScenario: $('f-scenario'), fDelay: $('f-delay'), demoFields: $('demo-fields'), fDemoRow: $('f-demo-row'), demoNone: $('f-demo-none'),
    exec: $('exec-fields'), fParallel: $('f-parallel'), fScranton: $('f-sandbox-scranton'), fDocker: $('f-sandbox-docker'), fHost: $('f-sandbox-host'),
    trustRow: $('f-trust-row'), fTrusted: $('f-trusted'), dockerFields: $('docker-fields'), fImage: $('f-image'), fNetwork: $('f-network'),
    fApproveShell: $('f-approve-shell'), fApproveFiles: $('f-approve-files'), fApproveTimeout: $('f-approve-timeout'), approveWait: $('f-approve-wait'),
    fPermAsk: $('f-permissions-ask'), fPermAuto: $('f-permissions-auto'), fPermBypass: $('f-permissions-bypass'),
    execNote: $('exec-note'), exitHint: $('exit-hint'), configError: $('config-error'),
    fModelMichael: $('f-model-michael'), fModelDwight: $('f-model-dwight'), fModelOscar: $('f-model-oscar'), fModelHank: $('f-model-hank'),
    fModelAngela: $('f-model-angela'),
    workflow: $('workflow-fields'), gateList: $('f-gate-list'), gatesSummary: $('f-gates-summary'), gatesConfig: $('f-gates-config'),
    recovery: $('recovery'), recoveryTitle: $('recovery-title'), recoveryMeta: $('recovery-meta'), recoveryDetail: $('recovery-detail'),
    recoveryStop: $('recovery-stop'), recoveryCheck: $('recovery-check'), recoveryStatus: $('recovery-status'),
    recoveryRelease: $('recovery-release'), recoveryError: $('recovery-error'), recoveryTimes: $('recovery-times'), releaseNote: $('release-note'),
    runTitle: $('run-dialog-title'), fWorkspaceHint: $('f-workspace-hint'),
    confirm: $('confirm-dialog'), cTitle: $('confirm-title'), cDetail: $('confirm-detail'), cError: $('confirm-error'),
    cOk: $('confirm-ok'), cCancel: $('confirm-cancel'), announcer: $('control-announcer'),
  };
  const execNoteDefault = [...e.execNote.childNodes].map((n) => n.cloneNode(true));
  const emptyDetailDefault = [...e.emptyDetail.childNodes].map((n) => n.cloneNode(true));
  const workspaceHintDefault = e.fWorkspaceHint.textContent;
  const tauriNotify = () => globalThis.__TAURI__?.notification ?? null;
  const canBell = !tauriNotify() && typeof Notification === 'function';

  let control = parseControl(null);
  let mode = 'connecting';
  let fetched = false;
  let pollTimer = 0;
  let inflight = null;
  let again = false;
  let sent = null;
  let sending = false;
  let submitting = false;
  let stopping = false;
  let releasing = false;
  // what the last release could not check; shown until the next run or chat switch
  let releaseNote = '';
  let workspaceTouched = false;
  let parallelTouched = false;
  // the human picked a sandbox; the configured default no longer moves the radio buttons
  let sandboxTouched = false;
  let permissionsTouched = false;
  let recoveryKey = '';
  // the orphan and its owner status: a heartbeat moving on is not news worth announcing
  let recoveryNews = '';
  let scenariosKey = '';
  let hitlKey = '';
  let phase = 'none';
  // where focus went when the answer panel hid; a follow-up request may take it back
  let parked = null;
  let shownExit = null;
  let settleTimer = 0;
  let dismissed = store.get(DISMISS_KEY);
  let confirmAction = null;
  let confirmFocus = null;
  // the chat a confirm dialog asks about; a switch closes it
  let confirmPin = null;
  // the chat the New run drawer was opened for (null: it starts somewhere fixed, see runTarget)
  let runPin = null;
  const notified = new Set();
  // bumped on every scope change: an answer that left for another chat is dropped
  let gen = 0;
  // viewing an archived run: nothing on screen can be answered or stopped
  let readOnly = false;
  // the New run drawer starts somewhere else than the chat on screen (+ New chat): { title, start(body) }
  let runTarget = null;
  let onStarted = null;
  // the target is the chat on screen (a pipeline chat's own drawer), not a chat made for the run
  let targetHere = false;
  // the chat on screen was started on the trusted host before: its acknowledgement is given
  let keptTrust = false;
  // the chat the acknowledgement box was last filled for: a tick given to one chat is not carried to another
  let trustFor = null;

  const gates = () => controlGates({ control, mode, submitting, sending, stopping, releasing });

  // The gate choice lasts across runs and reloads, like the model choice. Without one the drawer follows the
  // server's configured workflow (adoptWorkflow), else WORKFLOW_DEFAULT. configGates: the exact gates of a
  // configured workflow the stage numbers cannot say ([['hank', 'oscar']]), null once the human picks.
  let configGates = null;
  // what the rows were last set from: nothing configured until a server says otherwise
  let adoptedKey = 'null';
  // one row per gate of the catalog (gateCatalog): { li, box, stage, name, title }
  const gateRows = new Map();
  let rowsKey = '';
  const gateOrder = () => gateCatalog(control).map((g) => g.id);
  const firstGate = () => gateRows.values().next().value?.box ?? null;
  // the stored choice, with the ids the server does not list (any more) dropped
  const storedChoice = () => parseStoredWorkflow(store.get(WORKFLOW_KEY), gateOrder());
  // a stored choice from before the stage editor is shown as the stages it meant; it is stored in the new form only
  // once the human picks
  const showWorkflow = (choice) => {
    // the numbers as the stages they make, 1 to n without gaps
    const stages = choice.gates ? choice.stages : stagesOf(workflowGates(choice, gateOrder()));
    for (const [id, row] of gateRows) {
      row.box.checked = Object.hasOwn(stages, id);
      if (row.box.checked) row.stage.value = String(stages[id]);
    }
    configGates = choice.gates ?? null;
  };
  // { stages } with an entry for every gate that is on, its stage as typed
  const workflowChoice = () => ({
    stages: Object.fromEntries([...gateRows].filter(([, row]) => row.box.checked).map(([id, row]) => [id, row.stage.value])),
    ...(configGates ? { gates: configGates } : {}),
  });

  // The rows follow the server's catalog; a row that stays keeps what the human set in it.
  function syncGateRows() {
    const list = gateCatalog(control);
    const key = JSON.stringify(list);
    if (key === rowsKey) return false;
    rowsKey = key;
    const ids = list.map((g) => g.id);
    for (const id of [...gateRows.keys()]) if (!ids.includes(id)) gateRows.delete(id);
    const last = Math.max(1, ...[...gateRows.values()].map((r) => Number(r.stage.value) || 1));
    for (const g of list) {
      // an off built-in waits at its default stage, a new custom gate at the last one
      const row = gateRows.get(g.id) ?? gateRow(g.id, Object.hasOwn(WORKFLOW_DEFAULT.stages, g.id) ? WORKFLOW_DEFAULT.stages[g.id] : last);
      row.name.textContent = g.name;
      row.title.textContent = g.title || 'custom gate';
      row.stage.setAttribute('aria-label', `Stage of ${g.name}, 1 to ${list.length}`);
      gateRows.set(g.id, row);
    }
    e.gateList.replaceChildren(...list.map((g) => gateRows.get(g.id).li));
    return true;
  }

  // stage: where the gate goes when it is turned on (a new custom gate joins the last stage)
  function gateRow(id, stage) {
    const li = el('li', 'gate-row');
    li.dataset.gate = id;
    const check = el('label', 'check');
    const box = el('input');
    box.type = 'checkbox';
    box.id = `f-gate-${id}`;
    const name = el('span');
    const title = el('span', 'hint');
    const text = el('span');
    text.append(name, ' ', title);
    check.append(box, text);
    const at = el('label', 'gate-stage');
    const input = el('input', 'mono gate-stage-input');
    input.type = 'text';
    input.id = `f-stage-${id}`;
    input.inputMode = 'numeric';
    input.maxLength = 2;
    input.autocomplete = 'off';
    input.value = String(stage);
    at.append(el('span', 'hint', 'Stage'), input);
    li.append(check, at);
    const row = { li, box, stage: input, name, title };
    box.addEventListener('change', () => pickWorkflow());
    input.addEventListener('input', () => pickWorkflow());
    return row;
  }

  // the rows say the human's choice now, not the configured gates
  function pickWorkflow() {
    configGates = null;
    const choice = workflowChoice();
    // a choice without any gate, or with a stage out of range, is not kept: the next drawer would open on an error
    const built = buildWorkflow(choice, gateOrder(), customNames(control));
    if (!built.error) store.set(WORKFLOW_KEY, JSON.stringify({ stages: stagesOf(built.gates) }));
    syncWorkflow();
  }

  // After every poll: new rows for new gates, and the choice applied again when the catalog or the configuration
  // changed. A stored choice wins; it names the human's last usable pick, so re-applying it loses nothing kept.
  function adoptWorkflow() {
    const changed = syncGateRows();
    const stored = storedChoice();
    const configured = stored ? null : configuredChoice(control.workflow, gateOrder());
    const key = JSON.stringify(stored ? 'stored' : configured);
    if (key === adoptedKey && !changed) return;
    adoptedKey = key;
    showWorkflow(stored ?? configured ?? WORKFLOW_DEFAULT);
    syncWorkflow();
  }
  syncGateRows();
  showWorkflow(storedChoice() ?? WORKFLOW_DEFAULT);
  adoptedKey = JSON.stringify(storedChoice() ? 'stored' : null);
  const say = (text) => { e.announcer.textContent = text; };

  // A request for the chat on screen, fixed before anything is awaited: once another chat is on screen it is stale
  // and must not be sent, because url() would already point at the other chat.
  function pin(suffix) {
    const at = gen;
    return { url: url(suffix), stale: () => at !== gen };
  }

  // ------------------------------------------------------------ polling
  function schedule(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, ms);
  }

  function refresh() {
    const where = url('control');
    if (mode === 'demo' || !where) return Promise.resolve();
    // a poll already on the way may have left before the event that asked for this one
    if (inflight) {
      again = true;
      return inflight;
    }
    clearTimeout(pollTimer);
    const mine = gen;
    inflight = fetch(where, { cache: 'no-store', headers: CLIENT_HEADERS })
      .then((r) => (r.ok ? r.json().catch(() => null) : null), () => undefined)
      .then((doc) => {
        if (mine !== gen) return undefined;
        inflight = null;
        fetched = true;
        // undefined = network error: keep what we know and try again
        if (doc !== undefined) {
          control = parseControl(doc);
          adoptWorkflow();
        }
        if (!control.run) stopping = false;
        if (e.runDialog.open) models?.sync({ configured: control.models });
        render();
        if (again) {
          again = false;
          return refresh();
        }
        if (control.enabled) schedule(control.run ? POLL_ALIVE_MS : POLL_IDLE_MS);
      });
    return inflight;
  }

  function setMode(next) {
    const prev = mode;
    mode = next;
    if (next === 'demo') {
      clearTimeout(pollTimer);
      render();
      return;
    }
    // a (re)connected stream may be a restarted server with or without --control
    if ((next === 'live' && prev !== 'live') || (next === 'connecting' && !fetched)) refresh();
  }

  // Another chat is on screen: forget everything about the previous one. Nothing on the server is stopped.
  function reset() {
    gen += 1;
    clearTimeout(pollTimer);
    clearTimeout(settleTimer);
    inflight = null;
    again = false;
    control = parseControl(null);
    fetched = false;
    sent = null;
    sending = false;
    stopping = false;
    releasing = false;
    releaseNote = '';
    recoveryKey = '';
    recoveryNews = '';
    hitlKey = '';
    phase = 'none';
    shownExit = null;
    readOnly = false;
    // a question about the previous chat, or a drawer for it, has nothing left to act on
    if (e.confirm.open && confirmPin) e.confirm.close();
    if (e.runDialog.open && runPin) e.runDialog.close();
    render();
    if (mode !== 'demo') refresh();
  }

  function setReadOnly(next) {
    if (readOnly === next) return;
    readOnly = next;
    render();
  }

  // ------------------------------------------------------------ rendering
  function render() {
    const s = getState();
    const g = gates();
    const enabled = g.on;
    const live = enabled && !readOnly;
    e.actions.hidden = !enabled;
    renderEmpty(enabled, s);
    renderButtons();
    renderHitl(live, s);
    renderExit(live, s);
    renderRecovery(readOnly ? { ...g, recovery: false } : g);
    const gone = live && runInterrupted(control, s);
    const where = humanWhere({ enabled, alive: g.alive, gone });
    dashboard.setHumanWhere(where);
    pipeline?.setHumanWhere(where);
    lanes?.setRunMode(runModeOf(control, s));
    const title = documentTitle({ enabled: live, pending: Boolean(openPending(control, s)), live: mode === 'live', hitl: Boolean(s?.hitl), gone });
    if (document.title !== title) document.title = title;
    onRender?.();
  }

  // The chat still has an owner this server did not start (or lost on a restart): no new run until it is resolved.
  // What it offers follows the owner status: stop a live run, release a gone one, both when nobody can tell,
  // and only a stop when an old server reports no owner.
  function renderRecovery(g) {
    if (g.alive || g.recovery) releaseNote = '';
    e.releaseNote.textContent = releaseNote;
    e.releaseNote.hidden = !releaseNote || readOnly;
    if (!g.recovery) {
      if (!e.recovery.hidden && e.recovery.contains(document.activeElement)) fallbackFocus().focus();
      e.recovery.hidden = true;
      recoveryKey = '';
      recoveryNews = '';
      return;
    }
    const o = control.orphan ?? {};
    const text = recoveryText(o);
    e.recovery.hidden = false;
    e.recoveryStop.hidden = !o.runId || o.owner === 'gone';
    e.recoveryStop.disabled = !g.canStopOrphan;
    e.recoveryStop.textContent = stopping ? 'Stop requested...' : 'Request stop';
    e.recoveryRelease.hidden = !releaseOffered(o);
    e.recoveryRelease.disabled = !canReleaseOrphan(g, control, releasing);
    e.recoveryRelease.textContent = releasing ? 'Releasing...' : 'Release chat';
    const times = recoveryTimes(o);
    const key = JSON.stringify([o.runId, o.owner, o.recoveryError, times]);
    if (key === recoveryKey) return;
    recoveryKey = key;
    e.recoveryTitle.textContent = text.title;
    e.recoveryMeta.textContent = times.meta;
    e.recoveryMeta.title = times.meta;
    e.recoveryDetail.textContent = text.detail;
    e.recoveryError.textContent = o.recoveryError ?? '';
    e.recoveryError.hidden = !o.recoveryError;
    e.recoveryTimes.textContent = times.times;
    e.recoveryTimes.hidden = !times.times;
    const news = JSON.stringify([o.runId, o.startedAt, o.owner, o.recoveryError]);
    if (news === recoveryNews) return;
    recoveryNews = news;
    say(`${text.title}${o.runId ? `: run ${o.runId}` : ''}. New runs are disabled.`);
  }

  function renderEmpty(enabled, s) {
    e.emptyCli.hidden = enabled;
    e.emptyControl.hidden = !enabled;
    // 'chat': the follow-up composer above says the same, so the page shows only one of them
    e.emptyControl.dataset.kind = enabled && !control.run && !gates().recovery && workspace() ? 'chat' : '';
    if (!enabled) return;
    if (control.run && !s?.runId) {
      e.emptyTitle.textContent = 'Starting the run';
      e.emptyDetail.textContent = `process ${control.run.pid ?? '?'} is up, waiting for its first event`;
    } else if (gates().recovery) {
      e.emptyTitle.textContent = 'Recovery required';
      e.emptyDetail.textContent = 'an earlier run still holds this chat; see the panel above';
    } else if (workspace()) {
      e.emptyTitle.textContent = 'No run in this chat yet';
      e.emptyDetail.textContent = 'describe the goal above and start the first run';
    } else {
      e.emptyTitle.textContent = 'No run yet';
      e.emptyDetail.replaceChildren(...emptyDetailDefault.map((n) => n.cloneNode(true)));
    }
  }

  function renderButtons() {
    const g = gates();
    const alive = g.alive;
    const replay = replaying();
    e.newRun.setAttribute('aria-disabled', String(alive || g.recovery || replay));
    e.newRun.title = replay ? 'Showing an earlier run (read only) - go back to live to start a run'
      : alive ? `A run is in progress in this chat${workspace() ? '. For another run at the same time, start a new chat with + in the sidebar' : ''}`
        : g.recovery ? 'Recovery required - an earlier run still holds this chat' : 'Start a run';
    if (!alive && document.activeElement === e.stop) e.newRun.focus();
    e.stop.hidden = !alive || readOnly;
    e.stop.setAttribute('aria-disabled', String(stopping));
    e.stop.textContent = stopping ? 'Stopping...' : 'Stop run';
    e.stop.title = stopping ? 'Stop requested - waiting for the run to exit' : 'Stop the run (finishes it as aborted)';
    // a Start that cannot be pressed says why, beside it
    const why = startBlock({ control, mode, target: Boolean(runTarget), replaying: replay, submitting });
    e.runBusy.hidden = !why;
    e.runBusy.textContent = why || 'A run is in progress';
    e.runSubmit.disabled = runTarget ? !g.on || submitting : !g.canStart || replay;
    e.runSubmit.textContent = submitting ? 'Starting...' : 'Start run';
    renderBell();
  }

  function renderBell() {
    e.bell.hidden = !canBell;
    if (!canBell) return;
    const denied = Notification.permission === 'denied';
    const pressed = !denied && Notification.permission === 'granted' && store.get(NOTIFY_KEY) === 'on';
    e.bell.setAttribute('aria-pressed', String(pressed));
    e.bell.setAttribute('aria-disabled', String(denied));
    e.bell.title = denied ? 'Notifications are blocked for this page in the browser settings'
      : pressed ? 'Notifications on - click to turn them off' : 'Notify me when a human is needed or a run finishes';
  }

  function fallbackFocus() {
    if (!e.recovery.hidden) return e.recoveryCheck;
    return e.stop.hidden ? e.newRun : e.stop;
  }

  // unchanged text is not rewritten, so the live region does not repeat itself every poll
  function hitlStatus(text, tone = '') {
    if (e.hitlStatus.textContent === text && e.hitlStatus.dataset.tone === tone) return;
    e.hitlStatus.textContent = text;
    e.hitlStatus.dataset.tone = tone;
  }

  function renderHitl(enabled, s) {
    const pending = enabled ? openPending(control, s) : null;
    const decision = sent?.decision ?? '';
    const outcome = sentOutcome({ sent, pending, answered: answeredInState(s, sent), alive: Boolean(control.run) });
    if (outcome) sent = null;
    const next = enabled ? hitlPhase({ pending, sent }) : 'none';
    const prev = phase;
    phase = next;
    const key = next === 'answer' ? `${pending.runId}:${pending.requestSeq}` : '';
    const news = hitlAnnouncement({ prev, next, fresh: key !== hitlKey, pending, outcome, decision, result: s?.result ?? null });
    if (news) say(news.text);

    if (next === 'none') {
      if (!e.hitl.hidden && e.hitl.contains(document.activeElement)) park(fallbackFocus());
      e.hitl.hidden = true;
      hitlKey = '';
      return;
    }
    e.hitl.hidden = false;

    if (next === 'answer') {
      // the cause arrives on the event stream, the question on the poll: either may come first
      const title = hitlTitle(pending, s);
      if (e.hitlTitle.textContent !== title) e.hitlTitle.textContent = title;
      if (key !== hitlKey) {
        hitlKey = key;
        e.hitlMeta.textContent = pending.milestoneId ? `milestone ${pending.milestoneId}` : 'run';
        e.hitlMeta.title = e.hitlMeta.textContent;
        e.hitlReason.textContent = pending.reason || 'The orchestrator is waiting for a decision.';
        e.hitlActions.replaceChildren(...pending.options.map((d) => {
          const b = el('button', d === 'feedback' ? 'btn btn-primary' : 'btn', DECISION_LABEL[d] ?? d);
          b.type = 'button';
          b.dataset.decision = d;
          if (d === 'feedback') b.setAttribute('aria-expanded', 'false');
          return b;
        }));
        e.hitlForm.hidden = true;
        hitlStatus('');
        const active = document.activeElement;
        // never pull focus away from something the human is using elsewhere
        if (news?.focus && (!active || active === document.body || e.hitl.contains(active) || active === parked)) e.hitlTitle.focus();
      }
      e.hitlActions.hidden = false;
      for (const b of e.hitlActions.querySelectorAll('button')) b.disabled = sending;
      e.hitlSend.disabled = sending;
      return;
    }

    e.hitlActions.hidden = true;
    e.hitlForm.hidden = true;
    const label = DECISION_LABEL[sent.decision] ?? sent.decision;
    if (next === 'sent') {
      hitlStatus(`Answer sent (${label}) - waiting for the orchestrator`, 'busy');
    } else if (prev !== 'stale') {
      hitlStatus(`No reply ${Math.round((Date.now() - sent.at) / 1000)} s after sending (${label}). The orchestrator may have rejected it - see the event log.`, 'error');
      const again = el('button', 'btn btn-small', 'Answer again');
      again.type = 'button';
      again.addEventListener('click', () => {
        sent = null;
        hitlKey = '';
        render();
        e.hitlActions.querySelector('button')?.focus();
      });
      e.hitlStatus.append(' ', again);
    }
  }

  function park(target) {
    target.focus();
    parked = target;
    target.addEventListener('blur', () => { if (parked === target) parked = null; }, { once: true });
  }

  function renderExit(enabled, s) {
    const le = enabled ? exitToShow(control, s, dismissed) : null;
    const left = enabled && !control.run && control.lastExit ? exitSettleLeft(control.lastExit) : 0;
    clearTimeout(settleTimer);
    if (left > 0) settleTimer = setTimeout(render, left + 50);
    if (!le && !e.exit.hidden && e.exit.contains(document.activeElement)) fallbackFocus().focus();
    e.exit.hidden = !le;
    if (!le || exitKey(le) === shownExit) return;
    shownExit = exitKey(le);
    e.exitTitle.textContent = `Run process exited with code ${le.exitCode}`;
    e.exitAside.textContent = [le.mode, formatClock(le.finishedAt), le.request && clip(le.request, 90)].filter(Boolean).join(' · ');
    e.exitAside.title = le.request;
    const hint = exitHint(le);
    e.exitHint.textContent = hint;
    e.exitHint.hidden = !hint;
    e.exitTail.textContent = le.outputTail;
    e.exitTail.scrollTop = e.exitTail.scrollHeight;
  }

  // ------------------------------------------------------------ confirm dialog
  // scoped: the action is about the chat on screen (pin() it), so a chat switch closes the dialog
  function confirm({ title, detail, ok, action, scoped = null }) {
    confirmPin = scoped;
    e.cTitle.textContent = title;
    e.cDetail.textContent = detail;
    e.cOk.textContent = ok;
    e.cOk.disabled = false;
    e.cError.hidden = true;
    confirmAction = action;
    confirmFocus = null;
    e.confirm.showModal();
    e.cCancel.focus();
  }

  e.cCancel.addEventListener('click', () => e.confirm.close());
  e.cOk.addEventListener('click', async () => {
    const action = confirmAction;
    if (!action) return;
    e.cOk.disabled = true;
    const r = (await action()) ?? {};
    e.cOk.disabled = false;
    // the dialog closed (or asks something else) meanwhile
    if (confirmAction !== action) return;
    if (r.error) {
      e.cError.textContent = r.error;
      e.cError.hidden = false;
      return;
    }
    confirmFocus = r.focus ?? null;
    e.confirm.close();
  });
  e.confirm.addEventListener('close', () => {
    confirmAction = null;
    confirmPin = null;
    // the browser returns focus to the opener, which may be hidden by now
    const target = confirmFocus;
    confirmFocus = null;
    if (target && !target.hidden) target.focus();
    else if (document.activeElement === document.body) fallbackFocus().focus();
  });

  // ------------------------------------------------------------ human answer
  // to: pin('hitl') and pending: the request it answers, both taken when the human chose (a confirm may sit between)
  async function sendDecision(decision, feedback, to = pin('hitl'), pending = control.pendingHuman) {
    if (to.stale()) return { error: MOVED };
    const built = buildHitlRequest({ decision, feedback }, pending);
    if (built.error) return built;
    sending = true;
    hitlStatus('Sending the answer...', 'busy');
    render();
    const r = await postJson(to.url, built.body);
    // reset() already forgot this chat's busy flags
    if (to.stale()) return {};
    sending = false;
    if (!r.ok) {
      hitlStatus(r.error, 'error');
      render();
      if (r.status === 409) refresh();
      return { error: r.error };
    }
    sent = { runId: pending.runId, requestSeq: pending.requestSeq, decision, at: Date.now() };
    e.hitlText.value = '';
    updateCount(e.hitlText, e.hitlCount, FEEDBACK_MAX);
    render();
    refresh();
    return { focus: e.hitlStatus };
  }

  e.hitlActions.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-decision]');
    if (!b || !gates().canAnswer) return;
    const d = b.dataset.decision;
    const ms = control.pendingHuman?.milestoneId;
    if (d === 'feedback') {
      const open = e.hitlForm.hidden;
      e.hitlForm.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
      if (open) {
        if (e.hitlStatus.dataset.tone === 'error') hitlStatus('');
        e.hitlText.focus();
      }
      return;
    }
    if (CONFIRM_DECISIONS.has(d)) {
      const to = pin('hitl');
      const pending = control.pendingHuman;
      confirm(d === 'skip'
        ? { title: `Skip milestone${ms ? ` ${ms}` : ''}?`, detail: 'It is marked as skipped and the run moves on to the next milestone. The work so far stays in the workspace.', ok: 'Skip milestone', scoped: to, action: () => sendDecision('skip', undefined, to, pending) }
        : { title: 'Abort the run?', detail: 'The current milestone and the run finish as aborted. Nothing else is planned or tested.', ok: 'Abort run', scoped: to, action: () => sendDecision('abort', undefined, to, pending) });
      return;
    }
    sendDecision(d).then((r) => {
      if (r.focus) r.focus.focus();
    });
  });

  function closeFeedback() {
    e.hitlForm.hidden = true;
    const b = e.hitlActions.querySelector('[data-decision="feedback"]');
    b?.setAttribute('aria-expanded', 'false');
    b?.focus();
  }

  e.hitlCancel.addEventListener('click', closeFeedback);
  e.hitlText.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeFeedback();
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      e.hitlForm.requestSubmit();
    }
  });
  e.hitlText.addEventListener('input', () => {
    e.hitlText.removeAttribute('aria-invalid');
    updateCount(e.hitlText, e.hitlCount, FEEDBACK_MAX);
  });
  e.hitlForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!gates().canAnswer) return;
    const r = await sendDecision('feedback', e.hitlText.value);
    if (r.focus) {
      r.focus.focus();
    } else if (r.error) {
      hitlStatus(r.error, 'error');
      if (r.field === 'feedback') {
        e.hitlText.setAttribute('aria-invalid', 'true');
        e.hitlText.focus();
      }
    }
  });

  // ------------------------------------------------------------ stop
  e.stop.addEventListener('click', () => {
    if (!gates().canStop) return;
    const to = pin('stop');
    confirm({
      title: 'Stop the run?',
      detail: 'The orchestrator ends the active agent and finishes the run as aborted. Nothing is undone: what already reached the project folder stays there. If the process has not exited 15 s later, the server kills it.',
      ok: 'Stop run',
      scoped: to,
      action: async () => {
        if (to.stale()) return { error: MOVED };
        const r = await postJson(to.url);
        if (to.stale()) return {};
        if (!r.ok) {
          refresh();
          return { error: r.error };
        }
        stopping = true;
        say('Stop requested');
        render();
        refresh();
        return { focus: e.stop };
      },
    });
  });

  // ------------------------------------------------------------ recovery
  e.recoveryCheck.addEventListener('click', async () => {
    const at = pin('control');
    e.recoveryStatus.textContent = 'Checking...';
    await refresh();
    if (at.stale()) return;
    e.recoveryStatus.textContent = gates().recovery ? 'Still held by the other run.' : 'The chat is free again.';
  });
  e.recoveryStop.addEventListener('click', () => {
    if (!gates().canStopOrphan) return;
    const id = control.orphan?.runId;
    const to = pin('stop');
    confirm({
      title: `Request a stop of run ${id}?`,
      detail: recoveryText(control.orphan).stopConfirm,
      ok: 'Request stop',
      scoped: to,
      action: async () => {
        if (to.stale()) return { error: MOVED };
        const r = await postJson(to.url);
        if (to.stale()) return {};
        if (!r.ok) {
          refresh();
          return { error: r.error };
        }
        stopping = true;
        e.recoveryStatus.textContent = 'Stop requested - waiting for the run to end and free the chat.';
        render();
        refresh();
        return { focus: e.recoveryCheck };
      },
    });
  });
  e.recoveryRelease.addEventListener('click', () => {
    if (readOnly || !canReleaseOrphan(gates(), control, releasing)) return;
    // the run asked about, not whatever owns the chat once the human confirms
    const id = control.orphan.runId;
    const to = pin('release');
    confirm({
      title: 'Release this chat?',
      detail: recoveryText(control.orphan).releaseConfirm,
      ok: 'Release chat',
      scoped: to,
      action: async () => {
        if (to.stale()) return { error: MOVED };
        releasing = true;
        render();
        const r = await postJson(to.url, { runId: id });
        // reset() already forgot this chat's busy flag
        if (to.stale()) return {};
        releasing = false;
        if (!r.ok) {
          render();
          refresh();
          return { error: r.error };
        }
        const warnings = (Array.isArray(r.data?.warnings) ? r.data.warnings : []).filter((w) => typeof w === 'string' && w.trim());
        e.recoveryStatus.textContent = '';
        await refresh();
        if (to.stale()) return {};
        releaseNote = warnings.length ? `Chat released. ${warnings.map((w) => clip(stripBidi(w), 300)).join(' ')}` : '';
        render();
        say(releaseNote || 'Chat released');
        return { focus: gates().recovery ? e.recoveryCheck : e.newRun };
      },
    });
  });

  // ------------------------------------------------------------ new run
  function updateCount(field, counter, max) {
    counter.textContent = `${field.value.length} / ${max}`;
  }

  function syncDemo() {
    const demo = e.fDemo.checked;
    e.fScenario.disabled = !demo;
    e.fDelay.disabled = !demo;
    e.demoFields.dataset.disabled = String(!demo);
    e.fRequestOpt.hidden = !demo;
    e.exec.dataset.demo = String(demo);
    if (demo) {
      e.execNote.textContent = 'A demo runs a scripted model on this computer. It is simulated: no model, no approvals, and no sandbox boundary is created or claimed.';
    } else {
      e.execNote.replaceChildren(...execNoteDefault.map((n) => n.cloneNode(true)));
    }
    syncSandbox();
  }

  const sandboxPick = () => (e.fHost.checked ? 'host' : e.fDocker.checked ? 'docker' : 'scranton');
  const permissionsPick = () => (e.fPermBypass.checked ? 'bypass' : e.fPermAuto.checked ? 'auto' : 'ask');

  function syncSandbox() {
    const demo = e.fDemo.checked;
    const host = e.fHost.checked;
    for (const r of [e.fScranton, e.fDocker, e.fHost]) r.disabled = demo;
    e.trustRow.hidden = demo || !host;
    if (!host) e.fTrusted.checked = false;
    e.trustKept.hidden = !(keptTrust && host);
    e.fImage.disabled = demo || !e.fDocker.checked;
    e.dockerFields.dataset.disabled = String(e.fImage.disabled);
    // the trusted host has no boundary that could hold the network back
    e.fNetwork.disabled = demo || host;
    for (const r of [e.fPermAsk, e.fPermAuto, e.fPermBypass]) r.disabled = demo;
    e.fApproveShell.disabled = demo;
    e.fApproveFiles.disabled = demo;
    e.fApproveTimeout.disabled = demo || !(e.fApproveShell.checked || e.fApproveFiles.checked);
    e.approveWait.dataset.disabled = String(e.fApproveTimeout.disabled);
    syncWorkflow();
  }

  function syncWorkflow() {
    const demo = e.fDemo.checked;
    const names = customNames(control);
    const built = buildWorkflow(workflowChoice(), gateOrder(), names);
    const stages = built.gates ?? [];
    for (const row of gateRows.values()) {
      row.box.disabled = demo;
      // an off gate has no stage to set
      row.stage.disabled = demo || !row.box.checked;
    }
    e.workflow.dataset.demo = String(demo);
    const bad = !demo && built.error;
    e.gatesSummary.dataset.tone = bad ? 'error' : '';
    e.gatesSummary.textContent = demo ? 'A demo runs its scripted agents; no gate choice is sent.'
      : bad ? built.error : `${workflowText(stages, names)}, after each developer turn`;
    const note = demo || bad ? '' : workflowNote(control.workflow, stages, names);
    e.gatesConfig.textContent = note;
    e.gatesConfig.hidden = !note;
    if (built.field !== 'workflow') firstGate()?.removeAttribute('aria-invalid');
    for (const [id, row] of gateRows) if (built.field !== `stage.${id}`) row.stage.removeAttribute('aria-invalid');
    models?.sync({ demo, sandbox: sandboxPick(), noPlan: e.fNoPlan.checked, configured: control.models, gates: stages, agents: control.agents, names });
    syncOptions(demo ? null : bad ? 'Checks: the workflow needs a fix' : `Checks: ${stages.map((stage) => workflowText([stage], names)).join(', then ')}`);
  }

  // What the closed Options fold holds, in words a first run can read: the checks, the sandbox, what is asked first,
  // how many milestones at once.
  let gatesLine = '';
  function syncOptions(gatesText = gatesLine) {
    gatesLine = gatesText;
    const n = Number(e.fParallel.value.trim() || e.fParallel.placeholder);
    const ask = [e.fApproveShell.checked && 'commands', e.fApproveFiles.checked && 'file changes'].filter(Boolean).join(' and ');
    e.optionsSummary.textContent = gatesText === null ? `Demo with scripted agents${e.fScenario.value ? `: ${e.fScenario.value}` : ''}` : [
      gatesText, SANDBOX_TEXT[sandboxPick()], !e.fHost.checked && e.fNetwork.checked && 'no network', PERMISSIONS_TEXT[permissionsPick()], ask && `asks before ${ask}`,
      n > 1 ? `up to ${n} milestones at once` : 'one milestone at a time', e.fNoPlan.checked && 'no planning',
    ].filter(Boolean).join(' \u00b7 ');
  }

  // key: the chat whose kept acknowledgement counts (null: a chat made for this run has none yet)
  function fillExecution(key = null) {
    // what the human set in Settings for this computer wins over the project's configuration
    const d = { ...executionDefaults(control), ...parseRunDefaults(store.get(RUN_DEFAULTS_KEY)) };
    if (!parallelTouched || !e.fParallel.value.trim()) {
      e.fParallel.value = String(d.maxParallel);
      parallelTouched = false;
    }
    e.fParallel.placeholder = String(d.maxParallel);
    if (!sandboxTouched) {
      e.fHost.checked = d.sandbox === 'host';
      e.fDocker.checked = d.sandbox === 'docker';
      e.fScranton.checked = !e.fHost.checked && !e.fDocker.checked;
      // the acknowledgement belongs to a host the human sees; it is never given here
      if (!e.fHost.checked) e.fTrusted.checked = false;
    }
    if (!permissionsTouched) {
      const p = permissionsDefault(control);
      e.fPermAuto.checked = p === 'auto';
      e.fPermBypass.checked = p === 'bypass';
      e.fPermAsk.checked = p === 'ask';
    }
    // asked once per chat: a chat that already ran on the trusted host does not ask again
    keptTrust = isTrusted(store, key);
    if (key !== trustFor) e.fTrusted.checked = false;
    trustFor = key;
    if (keptTrust && e.fHost.checked) e.fTrusted.checked = true;
    e.trustKept.hidden = !(keptTrust && e.fHost.checked);
    e.fImage.placeholder = d.image;
    if (!e.fNetwork.dataset.touched) e.fNetwork.checked = d.network === 'none';
    e.configError.textContent = control.configurationError
      ? `The server could not load its configuration: ${clip(control.configurationError, 300)}. Fix scranton.config.json in the workspace first; a run there fails until then.`
      : '';
    e.configError.hidden = !control.configurationError;
  }

  function fillScenarios() {
    // the aggregated GET /api/control (no team chat on screen) lists no scenarios: no demo is offered then
    const none = !control.scenarios.length;
    e.fDemoRow.hidden = none;
    e.demoFields.hidden = none;
    e.demoNone.hidden = !none;
    if (none) e.fDemo.checked = false;
    const key = control.scenarios.join(',');
    if (key === scenariosKey) return;
    scenariosKey = key;
    const prev = e.fScenario.value;
    e.fScenario.replaceChildren(...control.scenarios.map((s) => el('option', '', s)));
    const pick = [prev, 'flaky', control.scenarios[0]].find((s) => control.scenarios.includes(s));
    if (pick) e.fScenario.value = pick;
  }

  function clearRunError() {
    e.runError.hidden = true;
    for (const f of e.runForm.querySelectorAll('[aria-invalid]')) f.removeAttribute('aria-invalid');
  }

  const FIELD = {
    request: 'fRequest', workspace: 'fWorkspace', maxCycles: 'fCycles', maxStalledCycles: 'fStalled', milestoneTokenBudget: 'fBudget',
    scenario: 'fScenario', delayMs: 'fDelay',
    maxParallel: 'fParallel', sandbox: 'fScranton', trustedHost: 'fTrusted', sandboxImage: 'fImage', sandboxNetwork: 'fNetwork',
    approvals: 'fApproveShell', approvalTimeout: 'fApproveTimeout', permissions: 'fPermAsk',
    models: 'fModelMichael', 'models.michael': 'fModelMichael', 'models.dwight': 'fModelDwight', 'models.oscar': 'fModelOscar',
    'models.hank': 'fModelHank', 'models.angela': 'fModelAngela',
  };
  // the inputs made for the catalog: a gate row, its stage, a custom gate's model select
  function fieldInput(f) {
    if (FIELD[f]) return e[FIELD[f]];
    if (f === 'workflow') return firstGate();
    if (f?.startsWith('stage.')) return gateRows.get(f.slice(6))?.stage ?? null;
    if (f?.startsWith('models.')) return models?.field?.(f.slice(7)) ?? null;
    return null;
  }

  // fields: every input the message is about (several model selects); the first gets the focus
  function runError(message, field, fields = []) {
    e.runError.textContent = message;
    e.runError.hidden = false;
    for (const f of fields) fieldInput(f)?.setAttribute('aria-invalid', 'true');
    const input = fieldInput(field);
    if (!input) return;
    input.setAttribute('aria-invalid', 'true');
    // everything but the request lives in the Options fold or is answered there: a missing acknowledgement opens
    // it too, so the sandboxes its message offers are on screen
    if (input !== e.fRequest) e.options.open = true;
    if (e.advanced.contains(input)) e.advanced.open = true;
    if (!input.disabled) return input.focus();
    // a disabled input cannot take focus: the message is read instead
    e.runError.setAttribute('tabindex', '-1');
    e.runError.focus();
  }

  // opts: { title, request, onStarted, target: { title, workspace, project, start(body) -> postJson result,
  //         startPipeline(body), cancel() }, engine: 'pipeline' for a pipeline chat (the target then has only
  //         startPipeline), task: the pipeline task to start from, problem: { error, field, fields } to show on
  //         the inputs it is about }
  function openRun(opts = {}) {
    runTarget = opts.target ?? null;
    targetHere = Boolean(runTarget) && opts.engine === 'pipeline';
    onStarted = opts.onStarted ?? null;
    if (!runTarget && (gates().alive || gates().recovery || replaying())) return;
    runPin = runTarget ? null : pin('runs');
    // no chat on screen to start the run in: the page starts one for it, a drawer without a route never opens
    if (runPin && !runPin.url) {
      runPin = null;
      if (!onNewRun()) say('Open a chat or start a new one first: a run belongs to a chat.');
      return;
    }
    e.runTitle.textContent = runTarget?.title ?? 'New run';
    const fixed = runTarget ? runTarget.workspace : workspace();
    e.fWorkspace.readOnly = Boolean(fixed);
    e.fWorkspaceHint.textContent = fixed ? 'The project folder. Every chat of a project works here.' : workspaceHintDefault;
    if (fixed) {
      e.fWorkspace.value = fixed;
    } else if (!workspaceTouched || !e.fWorkspace.value.trim()) {
      e.fWorkspace.value = control.workspace;
      workspaceTouched = false;
    }
    if (typeof opts.request === 'string' && opts.request.trim()) {
      e.fRequest.value = opts.request;
      updateCount(e.fRequest, e.fRequestCount, REQUEST_MAX);
    }
    fillExecution(runTarget ? null : chatKey());
    fillScenarios();
    syncDemo();
    clearRunError();
    e.options.open = false;
    renderButtons();
    models?.open();
    pipelineForm?.open({
      choice: Boolean(runTarget?.startPipeline), fixed: opts.engine === 'pipeline', project: runTarget?.project ?? null, task: opts.task ?? '',
      trusted: targetHere && isTrusted(store, chatKey()),
    });
    e.runDialog.showModal();
    if (pipelineForm?.active()) pipelineForm.focus();
    else e.fRequest.focus();
    if (!opts.problem) return;
    if (!pipelineForm?.active()) runError(opts.problem.error, opts.problem.field, opts.problem.fields);
    else if (!pipelineForm.markInvalid(opts.problem.field, opts.problem.error)) runError(opts.problem.error);
  }

  e.newRun.addEventListener('click', () => {
    if (onNewRun()) return;
    // a button that does nothing says why, for those who never see its tooltip
    if (e.newRun.getAttribute('aria-disabled') === 'true') return say(e.newRun.title);
    openRun();
  });
  for (const b of e.runForm.querySelectorAll('[data-close]')) b.addEventListener('click', () => e.runDialog.close());
  e.runDialog.addEventListener('close', () => {
    // a chat created for a run that never started is not left behind; the target decides, also mid-submit
    runTarget?.cancel?.();
    runTarget = null;
    runPin = null;
    onStarted = null;
    renderButtons();
  });
  // a click on the backdrop lands on the dialog element itself
  e.runDialog.addEventListener('click', (ev) => {
    if (ev.target === e.runDialog) e.runDialog.close();
  });
  e.fRequest.addEventListener('input', () => updateCount(e.fRequest, e.fRequestCount, REQUEST_MAX));
  e.fWorkspace.addEventListener('input', () => { workspaceTouched = true; });
  e.fParallel.addEventListener('input', () => {
    parallelTouched = true;
    syncOptions();
  });
  e.fScenario.addEventListener('change', () => syncOptions());
  e.fNetwork.addEventListener('change', () => {
    e.fNetwork.dataset.touched = '1';
    syncOptions();
  });
  for (const box of [e.fApproveShell, e.fApproveFiles]) box.addEventListener('change', syncSandbox);
  for (const r of [e.fPermAsk, e.fPermAuto, e.fPermBypass]) {
    r.addEventListener('change', () => {
      permissionsTouched = true;
      syncOptions();
    });
  }
  e.fDemo.addEventListener('change', syncDemo);
  e.fNoPlan.addEventListener('change', syncSandbox);
  for (const r of [e.fScranton, e.fDocker]) {
    r.addEventListener('change', () => {
      sandboxTouched = true;
      syncSandbox();
    });
  }
  e.fHost.addEventListener('change', () => {
    sandboxTouched = true;
    syncSandbox();
    if (e.fHost.checked && keptTrust) e.fTrusted.checked = true;
    else if (e.fHost.checked) e.fTrusted.focus();
  });
  e.runForm.addEventListener('input', (ev) => ev.target.removeAttribute?.('aria-invalid'));
  e.fRequest.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      e.runForm.requestSubmit();
    }
  });

  // The execution choices as the drawer holds them; a follow-up starts with the same ones.
  function executionForm() {
    return {
      maxCycles: e.fCycles.value, maxStalledCycles: e.fStalled.value, milestoneTokenBudget: e.fBudget.value,
      noPlan: e.fNoPlan.checked, maxParallel: e.fParallel.value,
      sandbox: sandboxPick(), trustedHost: e.fTrusted.checked,
      sandboxImage: e.fImage.value, sandboxNetwork: e.fNetwork.checked ? 'none' : 'allow', workflow: workflowChoice(),
      approveShell: e.fApproveShell.checked, approveFiles: e.fApproveFiles.checked, approvalTimeout: e.fApproveTimeout.value,
      permissions: permissionsPick(),
    };
  }

  const startError = (r) => (r.status === 429 || r.status === 409 ? runStartError(r.status, r.data, limits()) : r.error);
  const errorFields = (message) => modelErrorRoles(message, roleIds(control)).map((role) => `models.${role}`);

  e.runForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (pipelineForm?.active()) return submitPipeline();
    const target = runTarget;
    const to = runPin;
    const here = target ? null : chatKey();
    if (target ? !gates().on || submitting : !gates().canStart || replaying() || !to?.url) return;
    if (to?.stale()) return runError(MOVED);
    clearRunError();
    // the gates decide which roles need a model, so they are checked first
    const workflow = e.fDemo.checked ? { gates: undefined } : buildWorkflow(workflowChoice(), gateOrder(), customNames(control));
    if (workflow.error) return runError(workflow.error, workflow.field);
    const picked = models?.selection({
      demo: e.fDemo.checked, noPlan: e.fNoPlan.checked, configured: control.models, gates: workflow.gates,
      names: customNames(control),
    }) ?? { models: {} };
    if (picked.error) return runError(picked.error, picked.field, picked.fields);
    const built = buildRunRequest({
      ...executionForm(),
      request: e.fRequest.value, workspace: e.fWorkspace.readOnly ? '' : e.fWorkspace.value,
      demo: e.fDemo.checked, scenario: e.fScenario.value, delayMs: e.fDelay.value, models: picked.models,
    }, control);
    if (built.error) return runError(built.error, built.field);
    submitting = true;
    renderButtons();
    const r = target ? await target.start(built.body) : await postJson(to.url, built.body);
    submitting = false;
    // the chat the run started in keeps the acknowledgement (r.chat: the chat that was made for it)
    if (r.ok && built.body.trustedHost === true) rememberTrust(store, r.chat ? trustKey(r.chat) : here);
    // the drawer was closed meanwhile (a chat switch closes it too): whatever happened belongs to that chat
    if (!e.runDialog.open || (to && to.stale())) {
      renderButtons();
      if (r.ok) say(`Run started, process ${r.data?.pid ?? '?'}`);
      return;
    }
    if (!r.ok) {
      renderButtons();
      runError(startError(r), r.status === 400 ? errorField(r.error, roleIds(control)) : null, r.status === 400 ? errorFields(r.error) : []);
      if (r.status === 409 && !target) refresh();
      return;
    }
    e.fRequest.value = '';
    updateCount(e.fRequest, e.fRequestCount, REQUEST_MAX);
    runTarget = null;
    const started = onStarted;
    e.runDialog.close();
    started?.();
    say(`Run started, process ${r.data?.pid ?? '?'}`);
    await refresh();
    fallbackFocus().focus();
  });

  // Pipeline runs always go to a target: a new chat made for it, or the pipeline chat on screen.
  async function submitPipeline() {
    const target = runTarget;
    const here = targetHere ? chatKey() : null;
    if (!target?.startPipeline || !gates().on || submitting) return;
    clearRunError();
    const built = pipelineForm.build();
    if (built.error) {
      if (!pipelineForm.markInvalid(built.field, built.error)) runError(built.error);
      return;
    }
    submitting = true;
    renderButtons();
    const r = await target.startPipeline(built.body);
    submitting = false;
    if (r.ok && built.body?.sandbox?.trustHost === true) rememberTrust(store, r.chat ? trustKey(r.chat) : here);
    if (!e.runDialog.open) {
      renderButtons();
      if (r.ok) say('Pipeline run started');
      return;
    }
    if (!r.ok) {
      renderButtons();
      // a 400 about one setup or check row is shown at that row, a 409 about the sandbox in the sandbox section
      const shown = (r.status === 400 && pipelineForm.markInvalid(pipelineForm.errorField(r.error), r.error, { fromServer: true })) || pipelineForm.sandboxRefused?.(r);
      if (!shown) runError(startError(r));
      return;
    }
    pipelineForm.started();
    runTarget = null;
    const started = onStarted;
    e.runDialog.close();
    started?.(r);
    say('Pipeline run started');
    if (document.activeElement === document.body || !document.activeElement) fallbackFocus().focus();
  }

  // The Chat composer of a pipeline chat: the next run with the Pipeline form's choices as a freshly opened form
  // has them (the detected checks, the stored models, the sandbox the probe allows), never a demo.
  // target: { project, startPipeline(body) }.
  // -> { ok, status, data } | { error, field: 'request' } | { error, field, options } (the fix is in the drawer)
  async function startPipelineFollowUp(task, target) {
    if (!pipelineForm || !target?.startPipeline || !gates().on || submitting) return { error: 'A run cannot be started here right now.' };
    const to = pin('control');
    const here = chatKey();
    await pipelineForm.open({ fixed: true, project: target.project ?? null, trusted: isTrusted(store, here) });
    if (to.stale()) return { error: MOVED };
    const built = pipelineForm.build({ task, demo: false });
    if (built.error) return built.field === 'task' ? { error: built.error, field: 'request' } : { error: built.error, field: built.field ?? null, options: true };
    submitting = true;
    renderButtons();
    const r = await target.startPipeline(built.body);
    submitting = false;
    renderButtons();
    if (r.ok && built.body?.sandbox?.trustHost === true) rememberTrust(store, here);
    if (!r.ok) {
      const field = r.status === 400 ? pipelineForm.errorField(r.error) : null;
      if (field === 'task') return { error: startError(r), field: 'request' };
      // what the form can fix: a field the server named, or a sandbox it refused
      return { error: startError(r), field, options: Boolean(field) || (r.status === 409 && /\bimage\b|docker/i.test(r.error ?? '')) };
    }
    say('Pipeline run started');
    return r;
  }

  // The follow-up composer: a new run in the chat on screen with the drawer's execution and model choices.
  // -> { ok } | { error, field } | { error, field, fields, options } (the fix is in the drawer: openRun({ problem }))
  async function startFollowUp(goal) {
    const g = gates();
    if (!g.canStart) return { error: g.alive ? 'A run is already in progress in this chat.' : 'A run cannot be started here right now.' };
    const to = pin('runs');
    if (!to.url) return { error: 'A run cannot be started here right now.' };
    const here = chatKey();
    fillExecution(here);
    await models?.open();
    if (to.stale()) return { error: MOVED };
    const execution = executionForm();
    const workflow = buildWorkflow(execution.workflow, gateOrder(), customNames(control));
    if (workflow.error) return { error: workflow.error, field: workflow.field, fields: [], options: true };
    // a follow-up runs in the chat on screen, the workspace defaults.models describe
    const picked = models?.selection({
      demo: false, noPlan: execution.noPlan, configured: control.models, gates: workflow.gates,
      names: customNames(control),
    }) ?? { models: {} };
    const built = picked.error ? picked : buildFollowUp({ goal, models: picked.models, execution }, control);
    if (built.error) {
      if (built.field === 'request') return built;
      return { error: built.error, field: built.field ?? null, fields: built.fields ?? [], options: true };
    }
    submitting = true;
    renderButtons();
    const r = await postJson(to.url, built.body);
    submitting = false;
    renderButtons();
    if (r.ok && built.body.trustedHost === true) rememberTrust(store, here);
    if (to.stale()) return r.ok ? { ok: true } : { error: startError(r) };
    if (!r.ok) {
      if (r.status === 409) refresh();
      const field = r.status === 400 ? errorField(r.error, roleIds(control)) : null;
      if (field && field !== 'request') return { error: startError(r), field, fields: errorFields(r.error), options: true };
      return { error: startError(r), field: field === 'request' ? 'request' : null };
    }
    say(`Follow-up started, process ${r.data?.pid ?? '?'}`);
    await refresh();
    return { ok: true };
  }

  // ------------------------------------------------------------ exit panel
  e.exitDismiss.addEventListener('click', () => {
    dismissed = shownExit;
    store.set(DISMISS_KEY, dismissed ?? '');
    render();
  });

  // ------------------------------------------------------------ notifications
  async function notify({ title, body, tag }) {
    try {
      const t = tauriNotify();
      if (t) {
        let granted = await t.isPermissionGranted();
        if (!granted) granted = (await t.requestPermission()) === 'granted';
        if (granted) t.sendNotification({ title, body });
        return;
      }
      if (canBell && Notification.permission === 'granted' && store.get(NOTIFY_KEY) === 'on') new Notification(title, { body, tag });
    } catch {
      // notifications are best effort
    }
  }

  e.bell.addEventListener('click', async () => {
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'granted' && store.get(NOTIFY_KEY) === 'on') {
      store.set(NOTIFY_KEY, 'off');
    } else {
      const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      store.set(NOTIFY_KEY, p === 'granted' ? 'on' : 'off');
    }
    renderBell();
    say(e.bell.getAttribute('aria-pressed') === 'true' ? 'Notifications on' : 'Notifications off');
  });

  // Called for every event the reducer applied.
  function onEvent(event, { instant }) {
    if (!fetched || mode === 'demo') return;
    if (REFRESH_ON.has(event.type) && control.enabled) refresh();
    if (!gates().on) return;
    const n = notificationFor(event, { live: mode === 'live', instant });
    if (n && !notified.has(n.tag)) {
      notified.add(n.tag);
      notify(n);
    }
  }

  // gone: the run on screen lost its process without a run_finished (see runInterrupted)
  function snapshot() {
    const g = gates();
    return { control, mode, gates: g, gone: g.on && runInterrupted(control, getState()) };
  }

  return { render, setMode, onEvent, refresh, snapshot, confirm, reset, setReadOnly, openRun, startFollowUp, startPipelineFollowUp };
}

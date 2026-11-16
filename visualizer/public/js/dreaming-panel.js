// The Dreams drawer of a project (.enma/dreaming-contract.md), opened from the project's actions in the sidebar.
// It shows GET /api/projects/:id/dreaming and posts preview, sweep, settings and rollback, and for model reflection
// propose, proposal/apply, proposal/reject and cancel. Opening it never changes the chat on screen. Every reply is
// checked against the project it was asked for: a reply that arrives after the drawer closed or moved to another
// project is dropped, so it can never fill in someone else's data. Model text is only ever set as textContent.
import { CLIENT_HEADERS } from './control.js';
import { postJson } from './control-panel.js';
import { getJson, fillModelSelect } from './accounts-panel.js';
import { parseModels, modelGroups, parseModelKey } from './accounts.js';
import { formatWhen } from './format.js';
import {
  BUSY_POLL_MS, REFLECT_POLL_MS, PHASE_LABEL, PHASE_NOTE, SIGNALS, COUNT_LABEL, ENGINE_LABEL, SINGLE_NOTE, DEMO_NOTE, OP_LABEL, NOTE_LABEL, EVIDENCE_LABEL,
  dreamingUrl, parseDreaming, score, shortHash, isIncumbent, isRecommended, cohortLabel, countsText, stateBadge, stateText, scheduleText, intervalText,
  replaySummary, recommendationText, buildSettings, rollbackConfirm, dreamingError,
  modelRef, refKey, refText, modelAvailable, reflectBadge, reflectNote, usageText, proposeBlock, disclosure, proposeConfirm, applyConfirm, rejectConfirm,
  ATTEMPTED_NOTE,
} from './dreaming.js';

const $ = (id) => document.getElementById(id);
const UNREADABLE = 'The server sent a Dreams answer this page cannot read.';
const BUSY_TEXT = {
  preview: 'Computing a preview...', sweep: 'Sweeping...', settings: 'Saving settings...', rollback: 'Rolling back...',
  propose: 'Starting generation...', apply: 'Applying the proposal...', reject: 'Rejecting the proposal...', cancel: 'Cancelling...',
};
const NOTHING_TO_ROLL_BACK = 'Nothing to roll back: no sweep, settings change or applied proposal was saved since the last rollback.';
const ROLLBACK_TITLE = 'Restore the state before the last saved sweep, settings change or applied proposal, accepted notes included';
const REFLECT_KINDS = ['propose', 'apply', 'reject', 'cancel'];
const KIND_PATH = { apply: 'proposal/apply', reject: 'proposal/reject' };
// what waits while a reflection job runs; Preview reads only and Cancel is the way out
const WAITS_FOR_JOB = ['sweep', 'settings', 'rollback', 'propose', 'apply', 'reject'];
const SAVE_WAIT = 'Saving waits until the project is idle and no proposal is being generated.';
const INCOMPLETE = 'This proposal could not be shown in full here (too long or in a form this page does not know), so it cannot be applied from this drawer. Reject it, or review it with scranton dreaming status --json.';
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// -> { ok, status, data }; status 0 = no answer
async function getDoc(url, signal) {
  try {
    const r = await fetch(url, { cache: 'no-store', headers: CLIENT_HEADERS, signal });
    let data = null;
    try { data = await r.json(); } catch { /* empty or non-JSON body */ }
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// confirm: the shared confirm dialog ({ title, detail, ok, action } -> action() { error } | { focus })
// getProjects(): the sidebar's projects document, for the project's name and the server's mode
export function createDreamingPanel({ confirm, getProjects = () => null, announce = () => {} }) {
  const e = {
    dialog: $('dreams-dialog'), project: $('dreams-project'), error: $('dreams-error'), retryRow: $('dreams-retry-row'), retry: $('dreams-retry'),
    status: $('dreams-status'), empty: $('dreams-empty'), content: $('dreams-content'), body: $('dreams-body'),
    state: $('dreams-state'), last: $('dreams-last'), stateNote: $('dreams-state-note'), counts: $('dreams-counts'), schedule: $('dreams-schedule'),
    previewBox: $('dreams-preview'), previewExit: $('dreams-preview-exit'),
    runPreview: $('dreams-run-preview'), sweep: $('dreams-sweep'), rollback: $('dreams-rollback'), actionStatus: $('dreams-action-status'),
    form: $('dreams-settings'), enabled: $('dreams-enabled'), interval: $('dreams-interval'), intervalHint: $('dreams-interval-hint'),
    apply: $('dreams-apply'), sError: $('dreams-settings-error'), sStatus: $('dreams-settings-status'), sReset: $('dreams-settings-reset'),
    sSave: $('dreams-settings-save'),
    reflect: $('dreams-reflect'), disclosure: $('dreams-disclosure'), rState: $('dreams-reflect-state'), rWhen: $('dreams-reflect-when'),
    rNote: $('dreams-reflect-note'), rUsage: $('dreams-reflect-usage'), rError: $('dreams-reflect-error'), propose: $('dreams-propose'),
    cancel: $('dreams-cancel'), rStatus: $('dreams-reflect-status'), proposeHint: $('dreams-propose-hint'), proposal: $('dreams-proposal'),
    pSummary: $('dreams-proposal-summary'), pMeta: $('dreams-proposal-meta'), pNote: $('dreams-proposal-note'), ops: $('dreams-ops'),
    reject: $('dreams-reject'), applyProposal: $('dreams-apply-proposal'), notes: $('dreams-notes'), notesEmpty: $('dreams-notes-empty'),
    rLimits: $('dreams-reflect-limits'), rSettings: $('dreams-reflect-settings'), model: $('dreams-model'), modelHint: $('dreams-model-hint'),
    auto: $('dreams-reflect-auto'), tokens: $('dreams-tokens'), timeout: $('dreams-timeout'),
    phases: $('dreams-phases'), memory: $('dreams-memory'), memoryEmpty: $('dreams-memory-empty'),
    candidates: $('dreams-candidates'), candidatesEmpty: $('dreams-candidates-empty'),
    replaySummary: $('dreams-replay-summary'), objective: $('dreams-objective'), evalsWrap: $('dreams-evals-wrap'), evals: $('dreams-evals'),
    recs: $('dreams-recs'), replayLimits: $('dreams-replay-limits'), diary: $('dreams-diary'), diaryEmpty: $('dreams-diary-empty'),
    limits: $('dreams-limits'), foot: $('dreams-foot'),
  };
  // { id, name } of the project the drawer is about, null while closed
  let project = null;
  // the unsupported note (single-project server, demo) instead of any request
  let note = '';
  // the saved status, and a preview shown in its place until the human goes back or saves something
  let saved = null;
  let preview = null;
  let loading = false;
  let loadError = '';
  // the last refused preview, sweep or rollback; it stays until the next action, a reread does not clear it
  let actError = '';
  // the project left the list while the drawer was open
  let gone = false;
  // the mutation on its way: 'preview' | 'sweep' | 'settings' | 'rollback'
  let busy = null;
  // bumped when the drawer closes or moves to another project: a reply for an older one is dropped
  let gen = 0;
  let abort = null;
  let pollTimer = 0;
  let opener = null;
  let settingsSnap = '';
  // GET /api/models: undefined while it loads, null when there is none (control API off, no answer)
  let catalog;

  const shown = () => preview ?? saved;
  const readForm = () => ({
    enabled: e.enabled.checked, applyPolicy: e.apply.checked, interval: e.interval.value.trim(),
    reflectionEnabled: e.auto.checked, model: e.model.value, tokens: e.tokens.value.trim(), timeout: e.timeout.value.trim(),
  });
  // no snapshot yet: the form still shows nothing of this project, so nothing typed can be lost
  const dirty = () => Boolean(saved) && settingsSnap !== '' && JSON.stringify(readForm()) !== settingsSnap;
  const generating = () => saved?.reflection?.state === 'running';
  // busy for a reason other than our project's reflection job, which the server also reports as busy. Only Preview
  // reads through a job; if a chat runs as well the server refuses it with 409.
  const serverBusy = () => saved?.state === 'busy' && !generating();
  const pending = () => saved?.reflection?.proposal ?? null;
  const locked = () => Boolean(busy) || gone || !saved;
  const choice = () => parseModelKey(e.model.value);

  function setText(node, text, tone) {
    if (node.textContent !== text) node.textContent = text;
    if (tone !== undefined && node.dataset.tone !== tone) node.dataset.tone = tone;
  }

  function showError(node, text) {
    node.textContent = text;
    node.hidden = !text;
  }

  // rebuilt only when what it shows changed, so a poll leaves focus and scroll alone
  function fill(node, key, build) {
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.replaceChildren(...build());
  }

  // ------------------------------------------------------------ server
  function stopPoll() {
    clearTimeout(pollTimer);
    pollTimer = 0;
  }

  // a reflection job is followed until it ends, a project the server reports busy until it is idle again
  function schedulePoll() {
    stopPoll();
    if (!e.dialog.open || !project || note || gone || busy) return;
    const wait = generating() ? REFLECT_POLL_MS : serverBusy() ? BUSY_POLL_MS : 0;
    if (wait) pollTimer = setTimeout(() => load(), wait);
  }

  // the model list, for the reflection model select; a reply after the drawer moved on is dropped
  function loadModels() {
    const at = gen;
    catalog = undefined;
    return getJson('/api/models').then((doc) => {
      if (at !== gen || !e.dialog.open) return;
      catalog = doc ? parseModels(doc) : null;
      fillModels(e.model.value);
      render();
    });
  }

  // value: a select value; a saved model the list does not have is still offered, so the form keeps it
  function fillModels(value) {
    const groups = modelGroups(catalog ?? null);
    fillModelSelect(e.model, groups, 'No model chosen');
    const ref = parseModelKey(value);
    if (ref && !groups.some((g) => g.options.some((o) => o.value === value))) {
      const opt = el('option', '', `${refText(ref)} (${catalog === undefined ? 'loading the model list' : 'not in the model list'})`);
      opt.value = value;
      e.model.append(opt);
    }
    e.model.value = ref ? value : '';
  }

  function load() {
    if (!project || note || gone) return Promise.resolve();
    abort?.abort();
    const ctl = new AbortController();
    abort = ctl;
    const at = gen;
    const id = project.id;
    loading = true;
    render();
    return getDoc(dreamingUrl(id), ctl.signal).then((r) => {
      if (at !== gen || abort !== ctl) return;
      abort = null;
      loading = false;
      if (!r.ok) {
        loadError = dreamingError(r.status, r.data, 'The server did not answer. Is it still running?');
      } else {
        const d = parseDreaming(r.data, id);
        if (d) {
          const was = saved?.reflection?.state;
          saved = d;
          loadError = '';
          syncSettings();
          if (was === 'running' && d.reflection && d.reflection.state !== 'running') setText(e.status, endedText(d.reflection));
        } else {
          loadError = UNREADABLE;
        }
      }
      render();
      schedulePoll();
    });
  }

  // -> {} | { error }; kind is one of the POST suffixes
  async function act(kind, body = {}) {
    if (!project || locked()) return {};
    // the server refuses these while the project is busy (409); only Cancel may stop a job then
    if (kind !== 'cancel' && serverBusy()) return {};
    if (WAITS_FOR_JOB.includes(kind) && generating()) return {};
    const at = gen;
    const id = project.id;
    const reflect = REFLECT_KINDS.includes(kind);
    busy = kind;
    // a status read still on its way would land on top of this answer
    abort?.abort();
    abort = null;
    loading = false;
    stopPoll();
    actError = '';
    showError(e.sError, '');
    showError(e.rError, '');
    setText(e.status, '');
    setText(kind === 'settings' ? e.sStatus : reflect ? e.rStatus : e.actionStatus, BUSY_TEXT[kind], 'busy');
    render();
    const before = saved;
    const res = await postJson(dreamingUrl(id, KIND_PATH[kind] ?? kind), body);
    if (at !== gen) return {};
    busy = null;
    for (const n of [e.sStatus, e.actionStatus, e.rStatus]) setText(n, '', '');
    if (!res.ok) {
      const error = dreamingError(res.status, res.data);
      if (kind === 'settings') showError(e.sError, error);
      else if (reflect) showError(e.rError, error);
      else actError = error;
      render();
      // a refused request may mean the state moved on (a sweep or a job started elsewhere): read it again
      if (res.status === 409) load();
      return { error };
    }
    const d = parseDreaming(res.data, id);
    if (!d) {
      // 202 for propose need not carry the status: the job shows in the next read
      if (kind === 'propose') {
        setText(e.status, doneText(kind, null, body));
        load();
        e.status.focus();
        return {};
      }
      if (reflect) showError(e.rError, UNREADABLE);
      else actError = UNREADABLE;
      render();
      load();
      return { error: UNREADABLE };
    }
    if (kind === 'preview') {
      preview = { ...d, preview: true };
    } else if (reflect) {
      // reflection leaves a preview on screen and unsaved settings alone
      saved = { ...d, preview: false };
      syncSettings();
    } else {
      saved = { ...d, preview: false };
      preview = null;
      syncSettings({ force: true });
    }
    setText(e.status, doneText(kind, d, body, before));
    render();
    schedulePoll();
    e.status.focus();
    return {};
  }

  function doneText(kind, d, body, before) {
    if (kind === 'preview') return `Preview ready: ${d.counts.promoted} would be promoted from ${plural(d.counts.episodes, 'recorded chain', 'recorded chains')}. Nothing was saved.`;
    if (kind === 'sweep') return sweepText(d, before);
    if (kind === 'rollback') return 'Rolled back to the state before the last saved change.';
    if (kind === 'propose') {
      const r = d?.reflection;
      if (r && r.state !== 'running') return endedText(r);
      return `Generating a proposal with ${refText(body)}. Cancel stops it; nothing is saved until you apply a proposal.`;
    }
    if (kind === 'apply') return 'Proposal applied. The accepted notes below are what new runs get as advisory history.';
    if (kind === 'reject') return 'Proposal rejected. No note changed.';
    if (kind === 'cancel') return d.reflection?.state === 'running' ? 'Cancel requested. The job ends shortly; nothing is saved.' : 'Generation cancelled. Nothing was saved.';
    const auto = d.reflectionSupported ? ` Automatic proposals are ${d.reflectionEnabled ? 'on' : 'off'}.` : '';
    return `Settings saved. Automatic sweeps are ${d.enabled ? 'on' : 'off'}; applying retry recommendations is ${d.applyPolicy ? 'on' : 'off'}.${auto} A run already going keeps its limits.`;
  }

  // The sweep reply carries no saved flag: with no recorded chain and no earlier sweep the server saves nothing and
  // reports no sweep time, and a sweep that found the same chains saves without a diary entry or a new rollback point.
  function sweepText(d, before) {
    if (!d.lastSweepAt) return 'Nothing to sweep: there is no recorded chain yet, so nothing was saved.';
    const what = `${d.counts.promoted} promoted from ${plural(d.counts.episodes, 'recorded chain', 'recorded chains')}`;
    const logged = d.diary.at(-1)?.id && d.diary.at(-1).id !== before?.diary.at(-1)?.id;
    return logged ? `Sweep saved: ${what}.` : `Sweep saved: ${what}. No recorded chain changed since the last sweep, so it made no new rollback point.`;
  }

  // a job this drawer followed has ended
  function endedText(r) {
    if (r.state === 'ready' && r.proposal) {
      const k = r.proposal.operations.length;
      return k ? `Proposal ready: ${plural(k, 'change', 'changes')} to review. Nothing is applied until you apply it.` : 'Proposal ready: the model proposed no changes.';
    }
    if (r.state === 'failed') return 'Generation failed. Nothing was saved.';
    if (r.state === 'cancelled') return 'Generation cancelled. Nothing was saved.';
    return 'Generation ended without a proposal.';
  }

  // ------------------------------------------------------------ settings form
  function syncSettings({ force = false } = {}) {
    if (!saved || (!force && dirty())) return;
    e.enabled.checked = saved.enabled;
    e.apply.checked = saved.applyPolicy;
    e.interval.value = String(saved.intervalMinutes);
    e.auto.checked = saved.reflectionEnabled;
    e.tokens.value = String(saved.reflectionMaxOutputTokens);
    e.timeout.value = String(saved.reflectionTimeoutSeconds);
    fillModels(refKey(modelRef(saved.reflectionModel)));
    for (const n of [e.interval, e.tokens, e.timeout, e.model]) n.removeAttribute('aria-invalid');
    showError(e.sError, '');
    settingsSnap = JSON.stringify(readForm());
  }

  e.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (locked() || !dirty() || serverBusy() || generating()) return;
    const built = buildSettings(readForm(), saved, catalog ?? null);
    if (built.error) {
      showError(e.sError, built.error);
      const field = e[built.field] ?? e.interval;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      return;
    }
    const r = await act('settings', built.body);
    if (r.error && e.dialog.open) e.sSave.focus();
  });
  const changed = (ev) => {
    if ([e.interval, e.tokens, e.timeout, e.model].includes(ev.target)) ev.target.removeAttribute('aria-invalid');
    showError(e.sError, '');
    render();
  };
  e.form.addEventListener('input', changed);
  e.form.addEventListener('change', changed);
  e.sReset.addEventListener('click', () => {
    syncSettings({ force: true });
    render();
    e.enabled.focus();
  });

  // ------------------------------------------------------------ actions
  e.runPreview.addEventListener('click', () => act('preview'));
  e.sweep.addEventListener('click', () => act('sweep'));
  e.previewExit.addEventListener('click', () => {
    preview = null;
    setText(e.status, 'Showing the saved state.');
    render();
    e.runPreview.focus();
  });
  e.rollback.addEventListener('click', () => {
    if (locked() || serverBusy() || generating()) return;
    if (!saved.canRollback) return setText(e.actionStatus, NOTHING_TO_ROLL_BACK, 'error');
    const at = gen;
    confirm({
      ...rollbackConfirm(project.name),
      action: async () => {
        if (at !== gen) return {};
        const r = await act('rollback');
        if (r.error) return { error: r.error };
        return { focus: e.dialog.open ? e.status : null };
      },
    });
  });
  // ------------------------------------------------------------ model reflection
  // The model is always named in the request: the one chosen in Settings, never a server default.
  e.propose.addEventListener('click', () => {
    const c = choice();
    if (locked() || proposeBlock(saved, { catalog, choice: c })) return;
    const at = gen;
    confirm({
      ...proposeConfirm(project.name, c, { tokens: saved.reflectionMaxOutputTokens, timeout: saved.reflectionTimeoutSeconds }),
      action: async () => {
        if (at !== gen) return {};
        // a poll may have found a job or a proposal while the dialog was open
        const block = proposeBlock(saved, { catalog, choice: c });
        if (block) return { error: block };
        const r = await act('propose', { provider: c.provider, model: c.model });
        if (r.error) return { error: r.error };
        return { focus: e.dialog.open ? e.status : null };
      },
    });
  });
  e.cancel.addEventListener('click', () => {
    if (busy || gone || !generating()) return;
    act('cancel');
  });
  // Apply and Reject name the proposal shown; a different one arriving meanwhile is refused here and by the server
  function decide(kind, ask) {
    const p = pending();
    if (!p || locked() || serverBusy() || generating()) return;
    if (kind === 'apply' && (!p.complete || !p.operations.length)) return;
    const at = gen;
    confirm({
      ...ask(project.name, p.operations.length),
      action: async () => {
        if (at !== gen) return {};
        if (pending()?.id !== p.id) return { error: 'The proposal changed meanwhile. Review it again before deciding.' };
        const r = await act(kind, { proposalId: p.id });
        if (r.error) return { error: r.error };
        return { focus: e.dialog.open ? e.status : null };
      },
    });
  }
  e.applyProposal.addEventListener('click', () => decide('apply', applyConfirm));
  e.reject.addEventListener('click', () => decide('reject', rejectConfirm));

  e.retry.addEventListener('click', () => {
    loadError = '';
    actError = '';
    load();
  });

  // ------------------------------------------------------------ rendering
  function render() {
    if (!e.dialog.open) return;
    setText(e.project, project ? project.name : '');
    const d = shown();
    const emptyText = note || (gone ? '' : !saved && loading ? 'Loading dreams...' : '');
    setText(e.empty, emptyText);
    e.empty.hidden = !emptyText;
    if (!note) showError(e.error, gone ? 'This project is no longer in the project list. Nothing more can be done here.' : loadError || actError);
    e.retryRow.hidden = Boolean(note) || gone || !loadError || loading;
    e.content.hidden = !d || Boolean(note);
    e.body.setAttribute('aria-busy', String(Boolean(busy) || (loading && !saved)));
    setText(e.foot, dirty() ? 'Unsaved settings' : preview ? 'Preview shown, not saved' : generating() ? 'Generating a proposal' : pending() ? 'Proposal waiting for review' : '');
    if (!d || note) return;

    setText(e.state, ...stateBadge(d, { preview: Boolean(preview), sweeping: busy === 'sweep' }));
    setText(e.last, d.lastSweepAt ? `Last saved sweep ${formatWhen(d.lastSweepAt)}` : 'No sweep saved yet');
    const stateNote = stateText(saved ?? d);
    setText(e.stateNote, stateNote);
    e.stateNote.hidden = !stateNote;
    setText(e.counts, countsText(d.counts));
    setText(e.schedule, saved ? scheduleText(saved, (t) => formatWhen(t)) : '');
    e.previewBox.hidden = !preview;

    const wait = locked() || serverBusy();
    e.runPreview.disabled = wait;
    e.sweep.disabled = wait || generating();
    e.rollback.disabled = wait || generating();
    const noRollback = !saved?.canRollback;
    e.rollback.setAttribute('aria-disabled', String(noRollback));
    e.rollback.title = noRollback ? NOTHING_TO_ROLL_BACK : ROLLBACK_TITLE;

    for (const input of [e.enabled, e.interval, e.apply, e.model, e.auto, e.tokens, e.timeout]) input.disabled = locked();
    const typed = Number(e.interval.value.trim());
    setText(e.intervalHint, Number.isInteger(typed) && typed > 0 ? `About ${intervalText(typed)} between automatic sweeps. The default is 360.` : 'The default is 360 minutes.');
    const saveWait = serverBusy() || generating();
    e.sSave.disabled = locked() || !dirty() || saveWait;
    e.sReset.hidden = !dirty();
    if (!busy) setText(e.sStatus, dirty() && saveWait && !gone ? SAVE_WAIT : '', '');

    renderReflection();
    renderPhases(d);
    renderMemory(d);
    renderCandidates(d);
    renderReplay(d);
    renderDiary(d);
    fill(e.limits, JSON.stringify(d.limitations), () => (d.limitations.length ? d.limitations : ['None reported.']).map((t) => el('li', '', t)));
  }

  // always the saved status: a preview is about local consolidation only
  function renderReflection() {
    const s = saved;
    const r = s?.reflection;
    e.reflect.hidden = !r;
    e.rSettings.hidden = !r;
    if (!r) return;
    setText(e.disclosure, disclosure({ tokens: s.reflectionMaxOutputTokens, timeout: s.reflectionTimeoutSeconds }));
    setText(e.rState, ...reflectBadge(r));
    setText(e.rWhen, r.state === 'running' ? (r.startedAt ? `Started ${formatWhen(r.startedAt)}` : 'Started') : r.finishedAt ? `Ended ${formatWhen(r.finishedAt)}` : '');
    const rNote = reflectNote(r);
    setText(e.rNote, rNote);
    e.rNote.hidden = !rNote;
    const usage = r.usage ?? r.proposal?.usage ?? null;
    const showUsage = r.state !== 'idle' || Boolean(usage);
    setText(e.rUsage, showUsage ? usageText(usage) : '');
    e.rUsage.hidden = !showUsage;

    const c = choice();
    const block = proposeBlock(s, { catalog, choice: c, generating: busy === 'propose' });
    e.propose.disabled = locked() || Boolean(block);
    const tried = r.finishedAt ? ` ${ATTEMPTED_NOTE}` : '';
    setText(e.proposeHint, block || `Uses ${refText(c)}, chosen under Settings. You confirm before anything is sent.${tried}`);
    e.cancel.hidden = !generating();
    e.cancel.disabled = Boolean(busy) || gone;
    setText(e.modelHint, modelHint(c));

    renderProposal(r.proposal);
    renderNotes(r.memory);
    fill(e.rLimits, JSON.stringify(r.limitations), () => r.limitations.map((t) => el('li', '', t)));
    e.rLimits.hidden = !r.limitations.length;
  }

  function modelHint(c) {
    if (catalog === undefined) return 'Loading the model list...';
    if (!catalog) return 'The model list is not available here (it needs the control API), so no model can be chosen.';
    if (!catalog.providers.some((p) => p.signedIn && p.models.length)) return 'No provider is signed in. Sign in or add a key under Accounts first.';
    if (c && !modelAvailable(catalog, c)) return 'The chosen model is not signed in or not offered any more.';
    return 'Used by Generate proposal and by automatic proposals. There is no default model.';
  }

  function renderProposal(p) {
    e.proposal.hidden = !p;
    if (!p) {
      fill(e.ops, '', () => []);
      return;
    }
    const k = p.operations.length;
    setText(e.pSummary, p.summary || 'The model gave no summary.');
    setText(e.pMeta, [p.model && `Model ${p.model}`, p.createdAt && `created ${formatWhen(p.createdAt)}`, plural(k, 'change', 'changes')].filter(Boolean).join(' · '));
    const pNote = !p.complete ? INCOMPLETE : !k ? 'The model proposed no changes. Reject the proposal to clear it; nothing is applied.'
      : 'A quote shows where a change came from, not that it is right. Check every change before you apply the proposal.';
    setText(e.pNote, pNote);
    e.pNote.hidden = false;
    const wait = locked() || serverBusy() || generating();
    e.applyProposal.disabled = wait || !p.complete || !k;
    e.reject.disabled = wait;
    fill(e.ops, JSON.stringify(p), () => p.operations.map(renderOp));
  }

  function sideBox(side) {
    const box = el('div', 'dreams-side');
    box.dataset.side = side;
    return box;
  }

  function noteParts(n) {
    const out = [];
    const head = [n.type && NOTE_LABEL[n.type], n.title].filter(Boolean).join(': ');
    if (head) out.push(el('strong', '', head));
    if (n.text) out.push(el('p', '', n.text));
    return out;
  }

  function renderOp(op) {
    const li = el('li', 'dreams-op');
    li.dataset.action = op.action;
    const head = el('div', 'dreams-op-head');
    const badge = el('span', 'badge', OP_LABEL[op.action]);
    badge.dataset.tone = op.action === 'remove' ? 'loud' : 'on';
    head.append(badge);
    const type = op.after?.type || op.type || op.before[0]?.type || '';
    if (type) head.append(el('span', 'badge mono', NOTE_LABEL[type]));
    head.append(el('span', 'dreams-text', op.after?.title || op.title || op.before.map((b) => b.title).filter(Boolean).join(' + ') || 'Untitled note'));

    const diff = el('div', 'dreams-diff');
    const before = sideBox('before');
    before.append(el('span', 'dreams-label', op.before.length > 1 ? `Before (${op.before.length} notes merged)` : 'Before'));
    if (op.before.length) for (const b of op.before) before.append(...noteParts(b));
    else before.append(el('p', 'hint', 'No note yet.'));
    const after = sideBox('after');
    after.append(el('span', 'dreams-label', 'After'));
    if (op.after) after.append(...noteParts(op.after));
    else after.append(el('p', 'hint', 'Removed. No note takes its place.'));
    diff.append(before, after);

    li.append(head, diff, el('p', 'dreams-why', op.reason ? `Model's reason: ${op.reason}` : 'The model gave no reason.'));
    if (op.evidence.length) li.append(quoteList(op.evidence));
    else li.append(el('p', 'hint', op.action === 'remove' ? 'No quote. Removing a generated note needs none.' : 'No quote reported.'));
    return li;
  }

  function quoteList(evidence) {
    const ul = el('ul', 'dreams-quotes');
    ul.setAttribute('aria-label', 'Quoted evidence');
    ul.append(...evidence.map((q) => {
      const li = el('li');
      li.dataset.role = q.role;
      const meta = [q.path && `${q.path} · ${shortHash(q.sha256)}`, q.at && formatWhen(q.at)].filter(Boolean).join(' · ');
      li.append(el('span', 'badge', EVIDENCE_LABEL[q.role]), el('blockquote', 'dreams-quote', q.quote));
      if (meta) {
        const m = el('span', 'mono dreams-quote-meta', meta);
        if (q.sha256) m.title = `${q.path}\nsha256 ${q.sha256}`;
        li.append(m);
      }
      return li;
    }));
    return ul;
  }

  function renderNotes(list) {
    setText(e.notesEmpty, list.length ? '' : 'No accepted notes yet. A note appears here only after you apply a proposal.');
    e.notesEmpty.hidden = list.length > 0;
    fill(e.notes, JSON.stringify(list), () => list.map((m) => {
      const li = el('li', 'account dreams-item');
      const head = el('div', 'account-head');
      if (m.type) head.append(el('span', 'badge mono', NOTE_LABEL[m.type]));
      head.append(el('span', 'dreams-text', m.title || 'Untitled note'));
      li.append(head);
      if (m.text) li.append(el('p', 'dreams-why', m.text));
      const meta = [m.createdAt && `Proposed ${formatWhen(m.createdAt)}`, m.evidence.length && plural(m.evidence.length, 'quote', 'quotes')].filter(Boolean).join(' · ');
      if (meta) li.append(el('p', 'account-detail', meta));
      if (m.evidence.length) {
        const more = el('details', 'dreams-more');
        more.append(el('summary', '', 'Where it came from'), quoteList(m.evidence));
        li.append(more);
      }
      if (m.sources.length) li.append(sourceList(m.sources));
      return li;
    }));
  }

  function renderPhases(d) {
    fill(e.phases, JSON.stringify(d.phases), () => d.phases.map((p) => {
      const li = el('li', 'dreams-phase');
      li.dataset.phase = p.name;
      const head = el('div', 'dreams-phase-head');
      head.append(el('span', 'dreams-phase-name', PHASE_LABEL[p.name]), el('span', 'mono dreams-phase-count', String(p.count)));
      li.append(head, el('span', 'dreams-phase-status', p.known ? p.status || 'no status' : 'not reported'), el('span', 'hint', PHASE_NOTE[p.name]));
      return li;
    }));
  }

  function sourceList(sources) {
    const ul = el('ul', 'dreams-sources');
    ul.setAttribute('aria-label', 'Sources');
    ul.append(...sources.map((s) => {
      const li = el('li', 'mono', `${s.path} · ${shortHash(s.sha256)}`);
      li.title = s.sha256 ? `${s.path}\nsha256 ${s.sha256}` : s.path;
      return li;
    }));
    if (!sources.length) ul.append(el('li', 'hint', 'No source reported'));
    return ul;
  }

  function renderMemory(d) {
    const what = preview ? 'This preview would promote nothing.' : d.lastSweepAt ? 'Nothing passed every gate yet, so no memory was promoted.' : 'No memory yet. A sweep promotes recurring verified outcomes.';
    setText(e.memoryEmpty, d.memory.length ? '' : what);
    e.memoryEmpty.hidden = d.memory.length > 0;
    fill(e.memory, JSON.stringify(d.memory), () => d.memory.map((m) => {
      const li = el('li', 'account dreams-item');
      const head = el('div', 'account-head');
      head.append(el('span', 'dreams-text', m.text), el('span', 'badge mono', `score ${score(m.score)}`));
      const meta = el('p', 'account-detail', m.promotedAt ? `Promoted ${formatWhen(m.promotedAt)} · ${m.sources.length} ${m.sources.length === 1 ? 'source' : 'sources'}` : `${m.sources.length} ${m.sources.length === 1 ? 'source' : 'sources'}`);
      li.append(head, meta, sourceList(m.sources));
      return li;
    }));
  }

  function renderCandidates(d) {
    setText(e.candidatesEmpty, d.candidates.length ? '' : 'No candidates. They come from outcomes that recur across recorded runs.');
    e.candidatesEmpty.hidden = d.candidates.length > 0;
    fill(e.candidates, JSON.stringify(d.candidates), () => d.candidates.map((c) => {
      const li = el('li', 'account dreams-item');
      li.dataset.eligible = String(c.eligible);
      const head = el('div', 'account-head');
      const gate = el('span', 'badge', c.eligible ? 'Passes gates' : 'Held back');
      gate.dataset.tone = c.eligible ? 'on' : 'quiet';
      head.append(el('span', 'dreams-text', c.text), gate, el('span', 'badge mono', `score ${score(c.score)}`));
      const signals = el('dl', 'dreams-signals');
      signals.setAttribute('aria-label', 'Score breakdown');
      for (const [key, label, weight] of SIGNALS) {
        if (!(key in c.signals)) continue;
        signals.append(el('dt', '', label), el('dd', 'mono', `${c.signals[key].toFixed(2)} × ${weight.toFixed(2)}`));
      }
      for (const [key, value] of Object.entries(c.signals)) {
        if (SIGNALS.some(([k]) => k === key)) continue;
        signals.append(el('dt', '', COUNT_LABEL[key] ?? key), el('dd', 'mono', Number.isInteger(value) ? String(value) : value.toFixed(2)));
      }
      li.append(head, signals);
      if (c.reasons.length) {
        const why = el('ul', 'dreams-reasons');
        why.setAttribute('aria-label', 'Why it is held back');
        why.append(...c.reasons.map((r) => el('li', '', r)));
        li.append(why);
      }
      const more = el('details', 'dreams-more');
      more.append(el('summary', '', `${c.sources.length} ${c.sources.length === 1 ? 'source' : 'sources'}`), sourceList(c.sources));
      li.append(more);
      return li;
    }));
  }

  function renderReplay(d) {
    const r = d.replay;
    setText(e.replaySummary, replaySummary(r));
    setText(e.objective, r.objective ? `Objective: ${r.objective}. Ties keep the configured limit.` : '');
    e.objective.hidden = !r.objective;
    e.evalsWrap.hidden = !r.evaluations.length;
    fill(e.evals, JSON.stringify(r.evaluations), () => r.evaluations.map((v) => {
      const tr = el('tr');
      const incumbent = isIncumbent(v, r.recommendations);
      const recommended = isRecommended(v, r.recommendations);
      tr.dataset.incumbent = String(incumbent);
      tr.dataset.recommended = String(recommended);
      const cap = el('td', 'mono', String(v.cap));
      if (incumbent) cap.append(el('span', 'badge', 'configured'));
      if (recommended) {
        const b = el('span', 'badge', 'recommended');
        b.dataset.tone = 'loud';
        cap.append(b);
      }
      const result = el('td', 'dreams-result', v.eligible ? 'Eligible' : v.reasons.join('; ') || 'Not eligible');
      const cohort = el('td', 'mono', cohortLabel(v.cohort).replace('cohort ', ''));
      cohort.title = v.cohort ? `Evaluator recipe sha256 ${v.cohort}` : 'The server reported no cohort for this comparison';
      tr.dataset.cohort = v.cohort;
      tr.append(el('td', '', ENGINE_LABEL[v.engine]), cohort, cap, el('td', 'mono', score(v.score)), el('td', 'mono', score(v.quality)),
        el('td', 'mono', String(v.attempts)), el('td', 'mono', String(v.rounds)), result);
      return tr;
    }));
    const recs = r.recommendations.map((x) => {
      const li = el('li', 'dreams-rec', recommendationText(x, (saved ?? d).applyPolicy));
      li.title = x.cohort ? `Evaluator recipe sha256 ${x.cohort}` : '';
      if (x.rationale) li.append(el('span', 'hint', x.rationale));
      return li;
    });
    if (!recs.length && r.evaluations.length) recs.push(el('li', 'hint', 'No recommendation: no lower limit scored strictly better on the same recorded attempts without losing quality, so the configured limit stays.'));
    fill(e.recs, JSON.stringify([r.recommendations, r.evaluations.length, (saved ?? d).applyPolicy]), () => recs);
    e.recs.hidden = !recs.length;
    fill(e.replayLimits, JSON.stringify(r.limitations), () => r.limitations.map((t) => el('li', '', t)));
    e.replayLimits.hidden = !r.limitations.length;
  }

  function renderDiary(d) {
    setText(e.diaryEmpty, d.diary.length ? '' : 'No diary entries yet.');
    e.diaryEmpty.hidden = d.diary.length > 0;
    // newest first
    fill(e.diary, JSON.stringify(d.diary), () => [...d.diary].reverse().map((x) => {
      const li = el('li', 'dreams-entry');
      li.append(el('span', 'mono hint', x.at ? formatWhen(x.at) : '--:--:--'), el('span', '', x.text), el('span', 'hint', `${x.promoted} promoted`));
      return li;
    }));
  }

  // ------------------------------------------------------------ drawer
  function reset() {
    gen += 1;
    abort?.abort();
    abort = null;
    stopPoll();
    saved = null;
    preview = null;
    loading = false;
    loadError = '';
    actError = '';
    gone = false;
    busy = null;
    note = '';
    settingsSnap = '';
    catalog = undefined;
    showError(e.error, '');
    showError(e.sError, '');
    showError(e.rError, '');
    for (const n of [e.status, e.actionStatus, e.sStatus, e.rStatus]) setText(n, '', '');
    e.reflect.hidden = true;
    e.rSettings.hidden = true;
    e.proposal.hidden = true;
    for (const n of [e.phases, e.memory, e.candidates, e.evals, e.recs, e.replayLimits, e.diary, e.limits, e.ops, e.notes, e.rLimits]) {
      n.replaceChildren();
      delete n.dataset.key;
    }
  }

  // projectId: a project of the sidebar's document. -> true when the drawer opened.
  function open(projectId) {
    const doc = getProjects();
    const p = doc?.projects.find((x) => x.id === projectId) ?? null;
    if (!e.dialog.open) opener = document.activeElement;
    reset();
    project = p ? { id: p.id, name: p.name } : null;
    if (!doc) note = DEMO_NOTE;
    else if (doc.mode !== 'registry') note = SINGLE_NOTE;
    else if (!p || !dreamingUrl(p.id)) note = 'That project is not in the project list any more.';
    if (!e.dialog.open) e.dialog.showModal();
    const close = e.dialog.querySelector('[data-close]');
    close?.focus();
    render();
    if (note) return true;
    loadModels();
    load().then(() => {
      // the first action once there is something to act on, unless the human already moved on
      if (e.dialog.open && saved && (!close || document.activeElement === close) && !e.runPreview.disabled) e.runPreview.focus();
    });
    return true;
  }

  // The sidebar's document changed: a project removed meanwhile stops the drawer, a rename shows.
  function projects(doc) {
    if (!e.dialog.open || !project || note) return;
    const p = doc?.projects.find((x) => x.id === project.id);
    if (p && doc.mode === 'registry') {
      project.name = p.name;
      render();
      return;
    }
    if (gone) return;
    gen += 1;
    abort?.abort();
    abort = null;
    stopPoll();
    busy = null;
    gone = true;
    announce(`Project ${project.name} was removed`);
    render();
  }

  function finish() {
    e.dialog.close();
    const usable = (t) => t && t !== document.body && t.isConnected && !t.closest?.('[hidden]') && !t.disabled;
    return usable(opener) ? opener : null;
  }

  function requestClose() {
    if (!dirty()) return finish();
    confirm({
      title: 'Discard settings changes?',
      detail: 'The Dreams settings you changed are not saved.',
      ok: 'Discard',
      action: () => ({ focus: finish() }),
    });
    return null;
  }

  for (const b of e.dialog.querySelectorAll('[data-close]')) b.addEventListener('click', requestClose);
  e.dialog.addEventListener('click', (ev) => {
    if (ev.target === e.dialog) requestClose();
  });
  e.dialog.addEventListener('cancel', (ev) => {
    if (!dirty()) return;
    ev.preventDefault();
    requestClose();
  });
  e.dialog.addEventListener('close', () => {
    reset();
    project = null;
    setText(e.foot, '');
    const target = opener;
    opener = null;
    if (target?.isConnected && !target.closest?.('[hidden]') && !target.disabled) target.focus();
  });

  return {
    open, projects, render,
    project: () => project?.id ?? null,
    showing: () => (preview ? 'preview' : saved ? 'saved' : null),
  };
}

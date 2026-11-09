// The chat header: project and chat title, the run picker (the live run or a read-only replay of an earlier one)
// and the Follow up composer that starts the next run of the thread.
import { CLIENT_HEADERS, REQUEST_MAX } from './control.js';
import {
  findProject, findChat, parseRuns, runChoices, runEventsUrl, replayRun, replayError, composerGate, CHAT_STATUS,
} from './scope.js';

const $ = (id) => document.getElementById(id);
const RUNS_ON = new Set(['run_started', 'run_finished']);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function getDoc(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', headers: CLIENT_HEADERS });
    return { status: r.status, doc: r.ok ? await r.json().catch(() => null) : null };
  } catch {
    return { status: 0, doc: null };
  }
}

// scope: the scope object of main.js. nav: the sidebar. control: the control panel.
// onReplay({ runId, state, run } | null): show an archived run, or the live one again.
export function createThread({ scope, nav, control, onReplay }) {
  const e = {
    root: $('thread'), project: $('thread-project'), title: $('thread-title'), state: $('thread-state'), rename: $('thread-rename'),
    runs: $('thread-runs'), picker: $('run-picker'), status: $('thread-status'),
    empty: $('thread-empty'), emptyTitle: $('thread-empty-title'), emptyDetail: $('thread-empty-detail'), emptyAction: $('thread-empty-action'),
    banner: $('replay-banner'), bannerDetail: $('replay-detail'), back: $('replay-back'),
    form: $('followup'), label: $('followup-label'), text: $('followup-text'), send: $('followup-send'), options: $('followup-options'),
    hint: $('followup-hint'), count: $('followup-count'), fStatus: $('followup-status'), fix: $('followup-fix'),
  };
  let active = false;
  let runs = [];
  let runsKey = '';
  let runsGen = -1;
  let replay = null;
  let loading = null;
  let submitting = false;
  let emptyAction = null;
  // what the drawer has to fix before a follow-up can start: { error, field, fields }
  let problem = null;

  function say(box, text, tone = '') {
    if (box.textContent === text && box.dataset.tone === tone) return;
    box.textContent = text;
    box.dataset.tone = tone;
  }

  function loadRuns() {
    const url = scope.get()?.chat ? scope.url('runs') : null;
    // a pipeline chat lists its runs in the pipeline view
    if (!active || !url || findChat(nav.doc(), scope.get())?.engine === 'pipeline') return Promise.resolve();
    const mine = scope.gen();
    return getDoc(url).then(({ status, doc }) => {
      if (mine !== scope.gen()) return;
      const parsed = parseRuns(doc);
      runsGen = mine;
      if (parsed) runs = parsed;
      else if (status !== 0) say(e.status, `The run history could not be loaded (HTTP ${status}).`, 'error');
      render();
    });
  }

  function fillPicker() {
    const choices = runChoices(runs);
    const key = JSON.stringify(choices);
    if (key !== runsKey) {
      runsKey = key;
      e.picker.replaceChildren(...choices.map((c) => {
        const o = el('option', '', c.text);
        o.value = c.value;
        o.title = c.title;
        return o;
      }));
    }
    // one choice is no choice: the picker appears once the chat has an earlier run to replay
    e.runs.dataset.choices = String(choices.length);
    e.picker.value = replay?.runId ?? loading ?? 'live';
    e.picker.disabled = Boolean(loading) || choices.length < 2;
    e.picker.title = choices.length < 2 ? 'This chat has no earlier runs yet' : 'Show the live run or replay an earlier one';
  }

  function renderEmpty(doc, s) {
    const p = findProject(doc, s?.project);
    if (!doc?.projects.length) {
      e.emptyTitle.textContent = 'No project yet.';
      e.emptyDetail.textContent = doc?.mode === 'single' ? '' : 'Create one for a folder on this computer; every project keeps its own chats.';
      e.emptyAction.textContent = '+ New project';
      e.emptyAction.hidden = doc?.mode === 'single';
      emptyAction = () => nav.newProject();
    } else {
      e.emptyTitle.textContent = `No chat in ${p?.name ?? 'this project'} yet.`;
      e.emptyDetail.textContent = 'Start one with a goal for the agents.';
      e.emptyAction.textContent = '+ New chat';
      e.emptyAction.hidden = doc.mode === 'single' || !p;
      emptyAction = () => p && nav.newChat(p.id);
    }
  }

  function render() {
    const doc = nav.doc();
    const s = scope.get();
    e.root.hidden = !active;
    if (!active) return;
    const chat = findChat(doc, s);
    const project = findProject(doc, s?.project);
    document.body.dataset.scope = chat ? 'chat' : 'none';
    e.empty.hidden = Boolean(chat);
    e.project.textContent = project?.name ?? '';
    e.project.title = project?.workspace ?? '';
    if (!chat) {
      renderEmpty(doc, s);
      e.title.textContent = '';
      for (const x of [e.title, e.state, e.rename, e.runs, e.banner, e.form]) x.hidden = true;
      e.root.querySelector('.thread-sep').hidden = !project;
      return;
    }
    // a pipeline chat has its own run selector and starts runs from the drawer, not from the composer
    const pipelineChat = chat.engine === 'pipeline';
    for (const x of [e.title, e.state]) x.hidden = false;
    e.runs.hidden = pipelineChat;
    // a single-mode server refuses renames (409 single_mode)
    e.rename.hidden = doc.mode === 'single';
    e.root.querySelector('.thread-sep').hidden = false;
    e.title.textContent = chat.title;
    e.title.title = chat.title;
    const view = CHAT_STATUS[chat.status] ?? CHAT_STATUS.idle;
    e.state.textContent = `${view.glyph} ${view.label}`;
    if (chat.status === 'needs_human' || chat.status === 'failed') e.state.dataset.tone = 'loud';
    else delete e.state.dataset.tone;
    if (runsGen !== scope.gen()) runs = [];
    fillPicker();

    e.banner.hidden = !replay;
    if (replay) {
      const n = runs.findIndex((r) => r.runId === replay.runId) + 1;
      e.bannerDetail.textContent = [n ? `run ${n}` : '', replay.runId, replay.run?.goal ? `"${replay.run.goal}"` : ''].filter(Boolean).join(' · ');
      e.bannerDetail.title = replay.run?.goal ?? replay.runId;
    }

    const snap = control.snapshot();
    const gate = composerGate({
      scoped: true, enabled: Boolean(snap?.control?.enabled), mode: snap?.mode, replaying: Boolean(replay),
      chatStatus: chat.status, alive: Boolean(snap?.gates?.alive), recovery: Boolean(snap?.gates?.recovery),
      runs: Math.max(chat.runs, runs.length), submitting,
    });
    e.form.hidden = gate.hidden || pipelineChat;
    e.form.dataset.off = String(gate.disabled && !submitting);
    e.label.textContent = gate.label;
    e.text.disabled = gate.disabled && !submitting;
    e.text.placeholder = gate.label === 'Follow up' ? 'What should the agents do next in this chat?' : 'What should the agents build?';
    e.send.disabled = gate.disabled;
    e.options.disabled = gate.disabled;
    e.send.textContent = submitting ? 'Starting...' : gate.label;
    e.fix.hidden = !problem || (gate.disabled && !submitting);
    e.hint.textContent = gate.reason || 'Earlier runs of this chat are given to Michael as context. Ctrl+Enter starts.';
  }

  // ------------------------------------------------------------ replay
  async function show(runId) {
    if (runId === 'live') return back();
    const url = runEventsUrl(scope.get(), runId);
    if (!url) return;
    const mine = scope.gen();
    loading = runId;
    say(e.status, 'Loading the earlier run...', 'busy');
    render();
    const { status, doc } = await getDoc(url);
    if (mine !== scope.gen() || loading !== runId) return;
    loading = null;
    const r = doc ? replayRun(doc, runId) : null;
    if (!r) {
      say(e.status, doc ? 'The server sent no events for this run.' : replayError(status), 'error');
      render();
      return;
    }
    replay = { runId, state: r.state, run: runs.find((x) => x.runId === runId) ?? null };
    say(e.status, '');
    onReplay(replay);
    render();
    e.back.focus();
  }

  function back() {
    loading = null;
    if (!replay) {
      render();
      return;
    }
    replay = null;
    say(e.status, '');
    onReplay(null);
    render();
    e.picker.focus();
  }

  e.picker.addEventListener('change', () => show(e.picker.value));
  e.back.addEventListener('click', back);
  e.rename.addEventListener('click', () => {
    const s = scope.get();
    if (s?.chat && !e.rename.hidden) nav.rename('chat', s);
  });
  e.emptyAction.addEventListener('click', () => emptyAction?.());

  // ------------------------------------------------------------ follow up
  function setProblem(next) {
    problem = next;
    e.fix.hidden = !problem;
  }

  function updateCount() {
    e.count.textContent = `${e.text.value.length} / ${REQUEST_MAX}`;
  }

  e.text.addEventListener('input', () => {
    e.text.removeAttribute('aria-invalid');
    updateCount();
  });
  e.text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      e.form.requestSubmit();
    }
  });
  const started = () => {
    setProblem(null);
    e.text.value = '';
    updateCount();
    say(e.fStatus, 'Run started. Its events appear below; the composer opens again once it has finished.');
    loadRuns();
    nav.refresh();
  };
  e.options.addEventListener('click', () => control.openRun({ request: e.text.value, onStarted: started }));
  e.fix.addEventListener('click', () => control.openRun({ request: e.text.value, onStarted: started, problem }));
  e.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submitting || e.send.disabled) return;
    const goal = e.text.value.trim();
    if (!goal) {
      say(e.fStatus, 'Describe what the agents should do next.', 'error');
      e.text.setAttribute('aria-invalid', 'true');
      e.text.focus();
      return;
    }
    const mine = scope.gen();
    submitting = true;
    setProblem(null);
    say(e.fStatus, 'Starting the run...', 'busy');
    render();
    const r = await control.startFollowUp(goal);
    submitting = false;
    if (mine !== scope.gen()) return;
    if (r.ok) started();
    else if (r.options) {
      say(e.fStatus, r.error, 'error');
      setProblem({ error: r.error, field: r.field, fields: r.fields });
    } else {
      say(e.fStatus, r.error, 'error');
      if (r.field === 'request') e.text.setAttribute('aria-invalid', 'true');
      e.text.focus();
    }
    render();
    if (r.options && !e.fix.hidden) e.fix.focus();
  });

  return {
    // projects mode: the header is shown
    activate() {
      active = true;
      render();
    },
    // another chat: forget the runs and any replay
    setScope() {
      replay = null;
      loading = null;
      runs = [];
      submitting = false;
      setProblem(null);
      say(e.status, '');
      say(e.fStatus, '');
      e.text.value = '';
      updateCount();
      render();
      loadRuns();
    },
    onEvent(event) {
      if (RUNS_ON.has(event.type)) loadRuns();
    },
    render,
    replaying: () => Boolean(replay),
  };
}

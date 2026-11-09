import { createState, reduce, roleOf, interruptedView } from './state.js';
import { startFeed } from './feed.js';
import { createDashboard } from './dashboard.js';
import { createPipeline } from './pipeline.js';
import { createLog } from './log.js';
import { createControlPanel } from './control-panel.js';
import { createLanes } from './lanes.js';
import { createChatPanel } from './chat-panel.js';
import { createAccountsPanel, createModelPicker } from './accounts-panel.js';
import { createAgentsPanel } from './agents-panel.js';
import { CLIENT_HEADERS } from './control.js';
import { createScope, parseHash, hashFor, pickScope, scopeGone, findProject, chatEngine } from './scope.js';
import { createPipelineForm } from './pipeline-form.js';
import { createPipelineView } from './pipeline-view.js';
import { createNav } from './nav.js';
import { createThread } from './thread.js';
import { createTabs } from './tabs.js';

const params = new URLSearchParams(location.search);
const mode = params.has('demo') ? 'demo' : params.has('live') ? 'live' : 'auto';
const speed = Number(params.get('speed')) || 1;
const seek = Math.max(0, Number.parseInt(params.get('seek') ?? '0', 10) || 0);
const REFRESH_NAV_ON = new Set(['run_started', 'run_finished', 'hitl_request', 'hitl_response']);

const $ = (id) => document.getElementById(id);
const dashboard = createDashboard();
const pipeline = createPipeline($('pipeline'));
const log = createLog({
  table: $('log'), body: $('log-body'), scroller: $('log-scroll'), empty: $('log-empty'), jump: $('log-jump'), filters: $('log-filters'),
  total: $('tab-count-events'),
});

// null until /api/projects answered: a server without projects keeps the unscoped routes of a single hive
const scope = createScope(null);
let projectsMode = false;
let live = createState();
// an archived run on screen instead of the live one: { runId, state, run }
let replay = null;
const current = () => replay?.state ?? live;
let frame = 0;
let control = null;
let accounts = null;
let agents = null;
let feed = null;
let nav = null;
let thread = null;
let bound = false;
// the engine of the chat on screen: 'team' (the event stream and the dashboard) or 'pipeline' (the pipeline view)
let engine = 'team';

// Chat routes of the chat on screen. Without a chat (no project yet, or a project without chats) only the
// control document is read, for the Accounts and New run buttons; nothing else has anywhere to go. A pipeline
// chat has none of the team routes either: its runs go through the pipeline view.
function urlFor(suffix) {
  if (!projectsMode || (scope.get()?.chat && engine !== 'pipeline')) return scope.url(suffix);
  return suffix === 'control' ? '/api/control' : null;
}
const readOnlyView = () => Boolean(replay) || (projectsMode && (!scope.get()?.chat || engine === 'pipeline'));
const models = createModelPicker({ openAccounts: (opts) => accounts?.open(opts), canOpenAccounts: () => Boolean(accounts?.available()) });
const chat = createChatPanel({
  getState: current,
  // a replay reads like a recording: the transcript only, nobody to message
  getControl: () => {
    const snap = control?.snapshot() ?? null;
    return snap && readOnlyView() ? { ...snap, mode: 'demo' } : snap;
  },
  refresh: () => control?.refresh(),
  url: urlFor,
});
const activity = createTabs($('activity-tabs'), {
  onSelect: (name) => (name === 'events' ? log.reveal() : name === 'chat' ? chat.reveal() : null),
});
// a lane's Message button opens the Messages tab with the composer
const lanes = createLanes({
  block: $('lanes-block'), list: $('lanes'), exec: $('lanes-exec'),
  onMessage: (id) => {
    activity.select('chat');
    chat.compose(id);
  },
});
lanes.setMessageable((id) => chat.canMessage(id));
// What the header, cards and lanes show: the reducer state, or the interrupted view of it once the run's
// process is gone without a run_finished. The event log always shows the events as they are.
function view() {
  if (replay) return replay.state;
  const snap = control?.snapshot();
  return snap?.gone ? interruptedView(live, { at: snap.control.lastExit?.finishedAt, exitCode: snap.control.lastExit?.exitCode }) : live;
}

const pipelineView = createPipelineView({
  confirm: (opts) => control.confirm(opts),
  openRun: (target, onStarted) => control.openRun({ engine: 'pipeline', target, onStarted }),
  onChange: () => nav?.refresh(),
});

control = createControlPanel({
  dashboard, pipeline, lanes, models, getState: current, pipelineForm: createPipelineForm(),
  url: urlFor,
  workspace: () => (projectsMode ? findProject(nav?.doc(), scope.get()?.project)?.workspace || null : null),
  limits: () => nav?.doc() ?? null,
  replaying: () => Boolean(replay),
  // without a chat on screen, New run starts a chat (or asks for a project first)
  onNewRun: () => {
    if (projectsMode && scope.get()?.chat && engine === 'pipeline') {
      pipelineView.newRun();
      return true;
    }
    if (!projectsMode || scope.get()?.chat) return false;
    const p = scope.get()?.project;
    if (p) nav.newChat(p);
    else nav.newProject();
    return true;
  },
  // the control poll changes whether the run is gone and who can be messaged, so the views follow it
  onRender: () => {
    const v = view();
    dashboard.render(v);
    pipeline.render(v);
    lanes.render(v);
    chat.render();
    accounts?.render();
    agents?.render();
    thread?.render();
  },
});
accounts = createAccountsPanel({ getControl: () => control.snapshot(), confirm: control.confirm, onChange: (list) => models.setAccounts(list) });
// a created, changed or deleted agent changes the gates and agent defaults the New run drawer offers
agents = createAgentsPanel({ getControl: () => control.snapshot(), confirm: control.confirm, onChange: () => control.refresh() });

function render() {
  frame = 0;
  log.render(current());
  control.render();
}

// Bursts (a reconnect replays the whole file) are coalesced into one render per frame.
function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function onEvent(event, { instant }) {
  const prev = live;
  live = reduce(live, event);
  if (live === prev) return;
  if (!replay) {
    if (live.runId !== prev.runId) pipeline.clear();
    // instance mailboxes animate between their role cards
    if (event.type === 'hive_write' && !instant) pipeline.animateMessage(roleOf(event.from, live), roleOf(event.to, live), event.kind);
    if (event.type === 'chat_message' && !instant) pipeline.animateMessage(roleOf(event.from, live), roleOf(event.to, live), 'message');
  }
  control.onEvent(event, { instant });
  if (projectsMode && REFRESH_NAV_ON.has(event.type)) nav.refresh();
  thread?.onEvent(event);
  schedule();
}

const onMode = (m, info) => {
  dashboard.setMode(m, info);
  control.setMode(m);
};

// Shows another chat: the old stream is closed and every client-side trace of it dropped. Runs keep going.
function bind(next) {
  if (!scope.set(next) && bound) return;
  bound = true;
  feed?.stop();
  feed = null;
  live = createState();
  replay = null;
  // before the control panel reads its url again
  applyEngine();
  pipeline.clear();
  control.reset();
  control.setReadOnly(readOnlyView());
  chat.reset();
  thread.setScope();
  nav.render();
  attach();
  schedule();
}

// -> true when the chat on screen turned out to have another engine than the one shown
function applyEngine() {
  const next = projectsMode ? chatEngine(nav.doc(), scope.get()) : 'team';
  const changed = next !== engine;
  engine = next;
  document.body.dataset.engine = next;
  return changed;
}

// A team chat follows its event stream; a pipeline chat has no stream, its view polls the pipeline routes.
function attach() {
  feed?.stop();
  feed = null;
  if (engine === 'pipeline') {
    pipelineView.show(scope.get(), findProject(nav.doc(), scope.get()?.project)?.workspace ?? '');
    return;
  }
  pipelineView.hide();
  const url = urlFor('events');
  if (url) feed = startFeed({ mode: 'live', url, headers: CLIENT_HEADERS, onEvent, onMode });
}

// The hash names the chat; a missing or unknown one falls back to the most recent chat.
function follow({ replace = false } = {}) {
  const doc = nav.doc();
  const wanted = parseHash(location.hash);
  const next = pickScope(doc, wanted);
  const hash = hashFor(next);
  if (hash && location.hash !== hash) history.replaceState(null, '', hash);
  else if (!hash && replace && location.hash) history.replaceState(null, '', location.pathname + location.search);
  bind(next);
}

function navigate(next) {
  const hash = hashFor(next);
  if (hash && location.hash !== hash) history.pushState(null, '', hash);
  follow();
}

function onReplay(next) {
  replay = next;
  pipeline.clear();
  control.setReadOnly(readOnlyView());
  render();
}

nav = createNav({
  getScope: () => scope.get(),
  navigate,
  openRun: (opts) => control.openRun(opts),
  // a chat removed elsewhere (or the one on screen) moves the page to another one
  onProjects: (doc) => {
    if (projectsMode && scopeGone(doc, scope.get())) follow({ replace: true });
    else if (projectsMode && bound && applyEngine()) {
      live = createState();
      control.reset();
      control.setReadOnly(readOnlyView());
      chat.reset();
      attach();
      schedule();
    }
  },
  announce: (text) => { $('control-announcer').textContent = text; },
});
thread = createThread({ scope, nav, control, onReplay });

render();
setInterval(() => dashboard.tick(), 1000);

if (mode === 'demo') {
  feed = startFeed({ mode, speed, seek, onEvent, onMode });
} else {
  nav.start().then((doc) => {
    if (!doc) {
      // an older server, or plain `scranton visualize`: one hive at /events, demo fallback as before
      feed = startFeed({ mode, speed, seek, onEvent, onMode });
      return;
    }
    projectsMode = true;
    thread.activate();
    onMode('connecting');
    follow({ replace: true });
    addEventListener('hashchange', () => follow());
    addEventListener('popstate', () => follow());
  });
}

// handy for poking at it from the console
globalThis.scranton = { get state() { return current(); }, get scope() { return scope.get(); }, get replay() { return replay; } };

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
import { createDreamingPanel } from './dreaming-panel.js';
import { createContextPanel } from './context-panel.js';
import { CLIENT_HEADERS } from './control.js';
import { createScope, parseHash, hashFor, pickScope, scopeGone, findProject, chatEngine } from './scope.js';
import { createPipelineForm } from './pipeline-form.js';
import { trustKey } from './trust.js';
import { createPipelineView } from './pipeline-view.js';
import { createNav } from './nav.js';
import { createThread } from './thread.js';
import { createTabs } from './tabs.js';
import { createWindowControls } from './window-controls.js';
import { createViewMode, createDock } from './view-mode.js';
import { createChatView } from './chat-view.js';
import { teamChatAdapter, CHAT_EVENT_TYPES } from './chat-adapter-team.js';
import { pipelineChatAdapter } from './chat-adapter-pipeline.js';
import { teamRunView, pipelineRunView, boardSummary, liveTails } from './activity-model.js';
import { createBoard } from './board.js';
import { createFolds } from './folds.js';
import { createSidePanel } from './side-panel.js';
import { renderPlan, renderPlanBrief } from './plan-render.js';
import { createViewBar } from './viewbar.js';
import { createSettings } from './settings-panel.js';
import { createUsage } from './usage-chart.js';
import { createRunRail } from './run-rail.js';
import { createLivePoll } from './live-poll.js';
import { createThoughtLog, thoughtColumns } from './thoughts.js';
import { createThinkingView } from './thinking-view.js';
import { createChatLive } from './chat-live.js';

const params = new URLSearchParams(location.search);
const mode = params.has('demo') ? 'demo' : params.has('live') ? 'live' : 'auto';
const speed = Number(params.get('speed')) || 1;
const seek = Math.max(0, Number.parseInt(params.get('seek') ?? '0', 10) || 0);
const REFRESH_NAV_ON = new Set(['run_started', 'run_finished', 'hitl_request', 'hitl_response']);
// the Chat view's events of the run on screen; a longer run keeps its request and its newest events
const CHAT_EVENTS_MAX = 5000;

const $ = (id) => document.getElementById(id);
// first: the desktop window has no other way to be moved or closed, whatever fails further down
createWindowControls();
// a pipeline chat has a run once its run list has one; the team's reducer state knows nothing of it
const dashboard = createDashboard({ hasRun: () => (engine === 'pipeline' ? Boolean(pipelineView.chat().list?.runs.length) : null) });
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
// what the Chat view is drawn from: the live run's events the adapter reads, and whether the newest of them
// was history (a chat that was just opened replays its run) or happened now
let liveEvents = [];
let catchingUp = true;
let entries = [];
let entriesKey = '';
// the same for a pipeline chat: what its view last loaded was the run as the page found it
let pipelineHistory = true;
// how the event stream stands (feed.js); only a live one has a run whose models can be listened to
let feedMode = 'connecting';

function forgetLive() {
  live = createState();
  liveEvents = [];
  catchingUp = true;
}

// Chat routes of the chat on screen. Without a chat (no project yet, or a project without chats) only the
// control document is read, for the Accounts and New run buttons; nothing else has anywhere to go. A pipeline
// chat has none of the team routes either: its runs go through the pipeline view.
function urlFor(suffix) {
  if (!projectsMode || (scope.get()?.chat && engine !== 'pipeline')) return scope.url(suffix);
  return suffix === 'control' ? '/api/control' : null;
}
const readOnlyView = () => Boolean(replay) || (projectsMode && (!scope.get()?.chat || engine === 'pipeline'));
const models = createModelPicker({
  openAccounts: (opts) => accounts?.open(opts), canOpenAccounts: () => Boolean(accounts?.available()),
  openAgents: () => agents?.open(), canOpenAgents: () => Boolean(agents?.available()),
});
const chat = createChatPanel({
  getState: current,
  // a replay reads like a recording: the transcript only, nobody to message
  getControl: () => {
    const snap = control?.snapshot() ?? null;
    return snap && readOnlyView() ? { ...snap, mode: 'demo' } : snap;
  },
  refresh: () => control?.refresh(),
  url: urlFor,
  onChange: () => chatView.render(),
});
// Chat | Dashboard (Details in a pipeline chat): the conversation is always the live chat, so an earlier run on
// screen gives way to it
const viewMode = createViewMode({
  onChange: (next) => {
    if (next === 'chat') {
      thread?.live();
      if (engine === 'pipeline') pipelineView.live();
    }
    control?.render();
  },
});

// The conversation of the chat on screen: its earlier runs, the live run and what was sent but not echoed yet.
// A pipeline chat's comes from what its view polls.
function chatEntries() {
  if (engine === 'pipeline') {
    const c = pipelineView.chat();
    const key = `pipeline|${c.version}`;
    if (key !== entriesKey) {
      entriesKey = key;
      entries = pipelineChatAdapter(c);
    }
    return entries;
  }
  const outbox = chat.steering.pending();
  const key = [live.runId, live.lastSeq, liveEvents.length, thread?.version() ?? 0, outbox.map((o) => `${o.id}:${o.delivery}:${o.stale}`).join(',')].join('|');
  if (key !== entriesKey) {
    entriesKey = key;
    entries = teamChatAdapter({ events: [...(thread?.details() ?? []), ...liveEvents], state: live, runs: thread?.runs() ?? [], outbox });
  }
  return entries;
}
const chatView = createChatView({
  // the message names the milestones; the Plan panel is where the plan is read
  plan: { brief: true, render: (items) => renderPlanBrief(items), open: () => side.set('plan', { focus: true }) },
  getEntries: chatEntries,
  currentRunId: () => (engine === 'pipeline' ? pipelineView.chat().current : live.runId),
  loadRun: (runId) => (engine === 'pipeline' ? pipelineView.loadRun(runId) : thread.loadRun(runId)),
  announce: (text, kind) => {
    // a page that can answer the question says so itself when its answer panel opens
    if (kind === 'question' && engine !== 'pipeline' && control.snapshot().gates.on && !readOnlyView()) return;
    $('control-announcer').textContent = text;
  },
  // a pipeline gate is decided in Details, where the plan, the diff and the evidence are; a team question in the
  // answer panel docked under the transcript
  ask: () => (engine !== 'pipeline' ? null : {
    label: 'Review and decide',
    open() {
      viewMode.set('dashboard', { remember: false });
      pipelineView.review();
    },
  }),
});
// the composer that messages a running agent: the Messages composer's session, mounted a second time
chat.steering.mount({
  form: $('chat-view-form'), to: $('chat-view-to'), text: $('chat-view-input'), count: $('chat-view-count'),
  send: $('chat-view-send'), block: $('chat-view-block'), status: $('chat-view-status'),
}, {
  shown: ({ enabled, alive }) => enabled && alive && viewMode.get() === 'chat',
  onSent: () => chatView.toBottom(),
});
const dock = createDock([
  { form: $('followup'), field: $('followup-text') },
  { form: $('chat-view-form'), field: $('chat-view-input') },
], $('chat-view-scroll'));
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

// Live activity (.enma/live-activity-contract.md): what the agents do now, the board and the usage, as one run view
// that the rail of the Chat view and the panels of the Dashboard and of Details all draw.
const livePoll = createLivePoll({
  url: () => urlFor('live'),
  wanted: () => engine === 'team' && !replay && feedMode === 'live' && ['planning', 'running', 'paused'].includes(live.status) && !control?.snapshot().gone,
  onChange: () => schedule(),
});
function runView() {
  if (engine === 'pipeline') return pipelineRunView(pipelineView.activity());
  return teamRunView({ state: view(), live: replay ? null : livePoll.get(), runs: thread?.runs() ?? [] });
}
// What the agents reasoned and wrote, saved with the run: asked for while the Thinking view is open.
const thoughtLog = createThoughtLog({
  url: (runId) => (engine === 'team' && runId ? urlFor(`runs/${encodeURIComponent(runId)}/thoughts`) : null),
  onChange: () => schedule(),
});
const thinking = createThinkingView({ onToggle: () => renderActivity() });
const chatLive = createChatLive({ openThinking: () => thinking.open() });
function renderThinking(rv) {
  chatLive.render(rv);
  thoughtLog.want(engine === 'team' ? rv.runId : null, { live: rv.live, open: thinking.isOpen() });
  if (!thinking.isOpen()) return;
  const log = thoughtLog.get();
  // a pipeline run saves no thinking: its columns show the thought in progress the run view already carries
  const saved = engine === 'team' && !log.off;
  const tools = engine === 'team' ? [...(thread?.details() ?? []), ...liveEvents].filter((e) => e.type === 'agent_tool' && e.runId === rv.runId) : [];
  const columns = thoughtColumns({
    agents: rv.agents, thoughts: log.runId === rv.runId ? log.thoughts : [], tools, saved,
    tails: engine === 'team' && !replay ? liveTails(livePoll.get(), rv.runId) : null,
  });
  // without /live tails of its own, a pipeline agent's open block is the text of its run view entry
  if (engine !== 'team') for (const c of columns) c.open = rv.agents.find((a) => a.id === c.id)?.text ?? null;
  thinking.render({ runId: rv.runId, columns, off: !saved, live: rv.live });
}
createFolds($('dash'));
createSettings();
createViewBar();
const side = createSidePanel({ onChange: () => renderActivity() });
const boards = {
  dash: createBoard($('board'), { name: 'board' }),
  details: createBoard($('pv-board'), { name: 'pv-board' }),
  dialog: createBoard($('board-dialog-body'), { name: 'board-dialog' }),
};
const usages = { dash: createUsage({ table: true, height: 180, id: 'dash-usage' }), details: createUsage({ table: true, height: 180, id: 'pv-usage' }) };
$('usage-panel').append(usages.dash.el);
$('pv-usage').append(usages.details.el);
const boardDialog = $('board-dialog');
$('board-dialog-close').addEventListener('click', () => boardDialog.close());
const rail = createRunRail({
  viewMode: () => viewMode.get(),
  liveOff: () => livePoll.off(),
  openBoard: () => {
    if (boardDialog.open) return;
    renderActivity();
    boardDialog.showModal();
    $('board-dialog-close').focus();
  },
});

// Everything that reads the run view, after the state or a poll changed.
function renderActivity(v = view()) {
  const rv = runView();
  const summary = rv.board.total ? boardSummary(rv.board) : '';
  if (engine === 'pipeline') {
    $('pv-live').hidden = !rv.runId;
    boards.details.render(rv.board);
    $('pv-board-aside').textContent = summary;
    usages.details.render(rv.usage, { live: rv.live });
  } else {
    lanes.render(v, rv);
    boards.dash.render(rv.board);
    $('board-aside').textContent = summary;
    usages.dash.render(rv.usage, { live: rv.live });
  }
  boards.dialog.render(rv.board);
  $('board-dialog-aside').textContent = summary;
  rail.render(rv);
  renderThinking(rv);
  side.render(rv, engine === 'pipeline' ? pipelineView.changes() : teamChanges(rv, summary));
  livePoll.sync();
}

// The line diff of a team run, for the Changes side panel: what the run integrated so far, read from its private
// repository. Asked for while the panel is open, and again when the board moved (a milestone was integrated).
// A run that kept no diff (404: it ran without worktrees) leaves the panel its list of files.
let teamDiff = null;
function teamChanges(rv, progress) {
  if (side.get() !== 'changes' || !rv.runId) return teamDiff?.runId === rv.runId ? teamDiff : null;
  const url = urlFor(`runs/${encodeURIComponent(rv.runId)}/diff`);
  if (!url) return null;
  const key = JSON.stringify([url, progress, rv.live]);
  if (teamDiff?.key === key) return teamDiff;
  const mine = { key, runId: rv.runId, loading: true, content: teamDiff?.runId === rv.runId ? teamDiff.content : '', truncated: false, error: '' };
  teamDiff = mine;
  fetch(url, { headers: CLIENT_HEADERS, cache: 'no-store' })
    .then(async (res) => (res.ok ? res.json() : res.status === 404 ? null : Promise.reject(new Error(`HTTP ${res.status}`))))
    // known: the run has a diff to read, even when it is empty
    .then((doc) => Object.assign(mine, { loading: false, known: typeof doc?.content === 'string', content: typeof doc?.content === 'string' ? doc.content : '', truncated: doc?.truncated === true }),
      (err) => Object.assign(mine, { loading: false, error: `It could not be loaded (${err.message}).` }))
    .then(() => { if (teamDiff === mine) renderActivity(); });
  return mine;
}

const pipelineView = createPipelineView({
  confirm: (opts) => control.confirm(opts),
  openRun: (target, onStarted, { task, problem } = {}) => control.openRun({ engine: 'pipeline', target, onStarted, task, problem }),
  onChange: () => nav?.refresh(),
  // the one poller of a pipeline chat feeds the Chat view too
  onUpdate: ({ history }) => {
    pipelineHistory = history;
    schedule();
  },
});

control = createControlPanel({
  dashboard, pipeline, lanes, models, getState: current, pipelineForm: createPipelineForm(),
  url: urlFor,
  chatKey: () => trustKey(scope.get(), { projects: projectsMode }),
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
    const settle = dock.hold();
    dashboard.render(v);
    pipeline.render(v);
    renderActivity(v);
    chat.render();
    accounts?.render();
    agents?.render();
    thread?.render();
    chatView.render({ quiet: engine === 'pipeline' ? pipelineHistory : catchingUp });
    settle();
  },
});
accounts = createAccountsPanel({ getControl: () => control.snapshot(), confirm: control.confirm, onChange: (list) => models.setAccounts(list) });
// a created, changed or deleted agent changes the gates and agent defaults the New run drawer offers
agents = createAgentsPanel({ getControl: () => control.snapshot(), confirm: control.confirm, onChange: () => control.refresh() });
// a project's Dreams: opened from the sidebar, never moves the page to another chat
const dreams = createDreamingPanel({
  confirm: control.confirm,
  getProjects: () => nav?.doc() ?? null,
  announce: (text) => { $('control-announcer').textContent = text; },
});
// what the next turn of the chat on screen receives: the line in the follow-up composer and its drawer
const context = createContextPanel({ getProjects: () => nav?.doc() ?? null, confirm: control.confirm });

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
  if (live.runId !== prev.runId) liveEvents = [];
  if (CHAT_EVENT_TYPES.has(event.type)) {
    liveEvents.push(event);
    if (liveEvents.length > CHAT_EVENTS_MAX) liveEvents.splice(1, liveEvents.length - CHAT_EVENTS_MAX);
  }
  catchingUp = Boolean(instant);
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
  feedMode = m;
  dashboard.setMode(m, info);
  control.setMode(m);
};

// Shows another chat: the old stream is closed and every client-side trace of it dropped. Runs keep going.
function bind(next) {
  if (!scope.set(next) && bound) return;
  bound = true;
  feed?.stop();
  feed = null;
  forgetLive();
  replay = null;
  // before the control panel reads its url again
  applyEngine();
  pipeline.clear();
  control.reset();
  control.setReadOnly(readOnlyView());
  chat.reset();
  chatView.reset();
  livePoll.reset();
  rail.reset();
  chatLive.reset();
  thinking.reset();
  thread.setScope();
  context.setScope(scope.get());
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
  // the second view of a pipeline chat is its pipeline view
  viewMode.name(next === 'pipeline' ? 'Details' : 'Dashboard');
  pipelineHistory = true;
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
    dreams.projects(doc);
    // a run of the chat on screen that finished shows here first, for either engine
    context.projects(doc);
    if (projectsMode && scopeGone(doc, scope.get())) follow({ replace: true });
    else if (projectsMode && bound && applyEngine()) {
      forgetLive();
      control.reset();
      control.setReadOnly(readOnlyView());
      chat.reset();
      chatView.reset();
      livePoll.reset();
      rail.reset();
      attach();
      schedule();
    }
  },
  announce: (text) => { $('control-announcer').textContent = text; },
  openDreams: (projectId) => dreams.open(projectId),
});
thread = createThread({
  scope, nav, control, onReplay,
  view: () => viewMode.get(),
  hasRun: () => Boolean(current().runId),
  onRuns: schedule,
  keepEvent: (event) => CHAT_EVENT_TYPES.has(event.type),
  pipeline: {
    gate() {
      const c = pipelineView.chat();
      return { loaded: c.loaded, active: c.active, runs: c.list?.runs.length ?? 0 };
    },
    note: () => pipelineView.chat().note,
    async start(task) {
      const next = pipelineView.nextRun();
      if (!next) return { error: 'A run of this chat is still going. Follow up once it has finished.' };
      const r = await control.startPipelineFollowUp(task, next.target);
      if (r.ok) next.started(r);
      return r;
    },
    options: (opts) => pipelineView.newRun(opts),
  },
});

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

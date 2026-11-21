// Pure logic of projects and chat threads (.enma/multiproject-contract.md): the hash route, the scoped URLs every
// chat-specific request goes to, the GET /api/projects and GET .../runs documents, what the sidebar shows,
// replay of an archived run, when the follow-up composer may start a run, and the request bodies. No DOM.
import { stripBidi } from './format.js';
import { reduceAll } from './state.js';
import { buildRunRequest, isAbsolutePath, responseError, clip } from './control.js';

// The contract's project id; chat ids are left a little looser, but never contain "/" or start with a dot.
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.#:-]{0,199}$/;
export const NAME_MAX = 80;
export const TITLE_MAX = 120;
// The server's default title of a chat: its first goal, cut to this length.
export const AUTO_TITLE_MAX = 60;
export const PROJECTS_POLL_MS = 3000;
export const CHAT_STATUSES = ['idle', 'running', 'needs_human', 'done', 'failed', 'stopped'];
export const CHAT_STATUS = {
  idle: { glyph: '○', label: 'idle' },
  running: { glyph: '●', label: 'running' },
  needs_human: { glyph: '■', label: 'needs you' },
  done: { glyph: '✓', label: 'done' },
  failed: { glyph: '✕', label: 'failed' },
  stopped: { glyph: '–', label: 'stopped' },
};
// A chat in one of these has a live run: it cannot be removed and takes no follow-up.
export const ALIVE_STATUSES = new Set(['running', 'needs_human']);

// The unscoped routes of a server without /api/projects (and of the single hive it serves).
const LEGACY = {
  events: '/events', state: '/api/state', runs: '/api/runs', chat: '/api/chat', hitl: '/api/hitl', stop: '/api/runs/stop',
  release: '/api/runs/release', control: '/api/control', live: '/api/live',
};

const str = (v) => (typeof v === 'string' ? stripBidi(v) : '');
const raw = (v) => (typeof v === 'string' ? v : '');
const enc = encodeURIComponent;

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

// '#/p/<project>/c/<chat>' or '#/p/<project>' -> { project, chat } (chat null), anything else -> null
export function parseHash(hash) {
  const m = /^#?\/p\/([^/?#]+)(?:\/c\/([^/?#]+))?\/?$/.exec(typeof hash === 'string' ? hash : '');
  if (!m) return null;
  const project = decode(m[1]);
  const chat = m[2] === undefined ? null : decode(m[2]);
  if (!project || !PROJECT_ID_RE.test(project)) return null;
  if (m[2] !== undefined && (chat === null || !CHAT_ID_RE.test(chat))) return null;
  return { project, chat };
}

export function hashFor(scope) {
  if (!scope?.project) return '';
  return scope.chat ? `#/p/${enc(scope.project)}/c/${enc(scope.chat)}` : `#/p/${enc(scope.project)}`;
}

export function sameScope(a, b) {
  return (a?.project ?? null) === (b?.project ?? null) && (a?.chat ?? null) === (b?.chat ?? null);
}

// Where a chat-specific request goes. scope null = a server without projects: the unscoped routes of today.
// A project without a chat has no chat routes at all -> null.
export function scopedUrl(scope, suffix) {
  if (!scope) return LEGACY[suffix] ?? null;
  if (!scope.project || !scope.chat) return null;
  return `/api/projects/${enc(scope.project)}/chats/${enc(scope.chat)}/${suffix}`;
}

export function runEventsUrl(scope, runId) {
  const base = scope ? scopedUrl(scope, 'runs') : null;
  return base && RUN_ID_RE.test(runId ?? '') ? `${base}/${enc(runId)}/events` : null;
}

// The current { project, chat }. Every change bumps gen, so an answer to a request made for an earlier
// scope can tell it is stale.
export function createScope(initial = null) {
  let current = initial;
  let gen = 0;
  return {
    get: () => current,
    gen: () => gen,
    url: (suffix) => scopedUrl(current, suffix),
    // false when nothing changed
    set(next) {
      if (sameScope(current, next) && Boolean(current) === Boolean(next)) return false;
      current = next ? { project: next.project, chat: next.chat ?? null } : null;
      gen += 1;
      return true;
    },
  };
}

// ------------------------------------------------------------ GET /api/projects

function count(v) {
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

function parseChat(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !CHAT_ID_RE.test(c.id)) return null;
  return {
    id: c.id,
    title: str(c.title).trim() || 'Untitled chat',
    status: CHAT_STATUSES.includes(c.status) ? c.status : 'idle',
    updatedAt: str(c.updatedAt) || null,
    runs: count(c.runs),
    // absent = the pi team; the server already maps a pipeline chat's status (pipeline-contract section 9)
    ...(c.engine === 'pipeline' ? { engine: 'pipeline' } : {}),
  };
}

export const chatEngine = (doc, scope) => (findChat(doc, scope)?.engine === 'pipeline' ? 'pipeline' : 'team');

// -> { mode, maxConcurrentRuns, running, projects } or null when the answer is not a projects document
export function parseProjects(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.projects)) return null;
  const mode = doc.mode === 'single' ? 'single' : doc.mode === 'registry' ? 'registry' : null;
  if (!mode) return null;
  const seen = new Set();
  const projects = [];
  for (const p of doc.projects) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !PROJECT_ID_RE.test(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    const ids = new Set();
    const chats = (Array.isArray(p.chats) ? p.chats : []).map(parseChat).filter((c) => c && !ids.has(c.id) && ids.add(c.id));
    projects.push({ id: p.id, name: str(p.name).trim() || p.id, workspace: str(p.workspace), chats });
  }
  return {
    mode,
    maxConcurrentRuns: Number.isInteger(doc.maxConcurrentRuns) && doc.maxConcurrentRuns > 0 ? doc.maxConcurrentRuns : null,
    running: count(doc.running),
    projects,
    // where a project without a folder of its own is created; a server from before it sends none
    projectsRoot: typeof doc.projectsRoot === 'string' && doc.projectsRoot.length <= 1024 && isAbsolutePath(str(doc.projectsRoot)) ? str(doc.projectsRoot) : null,
  };
}

export function findProject(doc, id) {
  return doc?.projects.find((p) => p.id === id) ?? null;
}

export function findChat(doc, scope) {
  return findProject(doc, scope?.project)?.chats.find((c) => c.id === scope?.chat) ?? null;
}

const recency = (c) => Date.parse(c.updatedAt ?? '') || 0;

function latestChat(chats) {
  return chats.reduce((best, c) => (!best || recency(c) > recency(best) ? c : best), null);
}

// The scope to show for what the hash asks for: that chat when it exists, else the project's most recent chat,
// else the most recent chat anywhere. -> { project, chat } (chat null for a project without chats) or null
export function pickScope(doc, wanted = null) {
  if (!doc?.projects.length) return null;
  const project = findProject(doc, wanted?.project);
  if (project) {
    if (wanted.chat && project.chats.some((c) => c.id === wanted.chat)) return { project: project.id, chat: wanted.chat };
    const c = latestChat(project.chats);
    return { project: project.id, chat: c?.id ?? null };
  }
  let best = null;
  for (const p of doc.projects) {
    const c = latestChat(p.chats);
    if (c && (!best || recency(c) > recency(best.c))) best = { p, c };
  }
  return best ? { project: best.p.id, chat: best.c.id } : { project: doc.projects[0].id, chat: null };
}

// The list changed under the page: only a scope that points at something gone (or nothing while projects exist)
// moves the page. A project shown without a chat stays put when a chat appears in it, e.g. one being created.
export function scopeGone(doc, s) {
  if (!doc) return false;
  if (!s?.project) return doc.projects.length > 0;
  const project = findProject(doc, s.project);
  return !project || (Boolean(s.chat) && !project.chats.some((c) => c.id === s.chat));
}

// Why a chat or project cannot be removed now, or ''.
function removeBlock(single, alive) {
  if (single) return 'This server serves a single project.';
  return alive ? 'Stop the run first.' : '';
}

// What the sidebar shows. collapsed = Set of project ids the human folded.
export function sidebarModel(doc, current = null, { collapsed = new Set() } = {}) {
  if (!doc) return null;
  const single = doc.mode === 'single';
  let attention = 0;
  const projects = doc.projects.map((p) => {
    let waiting = 0;
    let running = 0;
    const chats = p.chats.map((c) => {
      const here = current?.project === p.id && current?.chat === c.id;
      const alive = ALIVE_STATUSES.has(c.status);
      // a chat on screen already shows its answer panel; the badge is for the ones in the background
      const needs = c.status === 'needs_human' && !here;
      if (needs) waiting += 1;
      if (alive) running += 1;
      return {
        ...c, ...CHAT_STATUS[c.status], current: here, attention: needs, alive,
        removeBlock: removeBlock(single, alive),
      };
    });
    attention += waiting;
    return {
      id: p.id, name: p.name, workspace: p.workspace, chats, waiting, running,
      current: current?.project === p.id,
      expanded: !collapsed.has(p.id),
      removeBlock: removeBlock(single, running > 0),
    };
  });
  return {
    mode: doc.mode, single, canCreate: !single, projects, attention,
    running: doc.running, maxConcurrentRuns: doc.maxConcurrentRuns,
  };
}

// The sidebar foot line: "2 running · up to 4 in parallel"
export function capacityText(doc) {
  if (!doc) return '';
  const parts = [`${doc.running} running`];
  if (doc.maxConcurrentRuns) parts.push(`up to ${doc.maxConcurrentRuns} in parallel`);
  return parts.join(' · ');
}

// ------------------------------------------------------------ runs of a chat

const RUN_STATUS_LABEL = { success: 'done', partial: 'partial', failed: 'failed', aborted: 'aborted', running: 'running' };
const REPLY_KINDS = ['answer', 'report', 'summary'];

// A run's return message as the run list carries it (bounded by the server); null for a run without one.
function parseReply(r) {
  if (!r || typeof r !== 'object' || typeof r.text !== 'string' || !REPLY_KINDS.includes(r.kind)) return null;
  return { kind: r.kind, text: str(r.text), ...(r.truncated === true ? { truncated: true } : {}) };
}

// What a run used, as the run list carries it (live-activity-contract section 2); null from a server before it.
function parseRunUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return { tokens: n(u.tokens), cost: n(u.cost) };
}

// GET .../runs -> [{ runId, goal, status, startedAt, endedAt, current, summary, reply, usage }] (oldest first) or null
export function parseRuns(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.runs)) return null;
  const seen = new Set();
  const runs = [];
  for (const r of doc.runs) {
    if (!r || typeof r !== 'object' || typeof r.runId !== 'string' || !RUN_ID_RE.test(r.runId) || seen.has(r.runId)) continue;
    seen.add(r.runId);
    runs.push({
      runId: r.runId, goal: str(r.goal), status: str(r.status) || null,
      startedAt: str(r.startedAt) || null, endedAt: str(r.endedAt) || null, current: r.current === true,
      summary: str(r.summary), reply: parseReply(r.reply), usage: parseRunUsage(r.usage),
    });
  }
  return runs;
}

function shortDate(ts) {
  const d = new Date(ts ?? '');
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The run picker: the live view first, then the earlier runs, newest first. value 'live' = follow the stream.
// -> [{ value, text, title }]
export function runChoices(runs) {
  const list = runs ?? [];
  const numbered = list.map((r, i) => ({ ...r, n: i + 1 }));
  const current = numbered.find((r) => r.current);
  const live = {
    value: 'live',
    text: current ? `Current · run ${current.n} · ${clip(current.goal, 42) || current.runId}` : 'Current run',
    title: current ? `${current.runId}${current.goal ? `\n${current.goal}` : ''}` : 'Follow the live event stream of this chat',
  };
  const past = numbered.filter((r) => !r.current).reverse().map((r) => ({
    value: r.runId,
    text: [`Run ${r.n}`, clip(r.goal, 42) || r.runId, RUN_STATUS_LABEL[r.status] ?? r.status, shortDate(r.startedAt)].filter(Boolean).join(' · '),
    title: `${r.runId}${r.goal ? `\n${r.goal}` : ''}`,
  }));
  return [live, ...past];
}

// GET .../runs/:runId/events -> { state, events } (the run replayed through the reducer) or null.
// Events of another run are dropped, so a replay never mixes two runs.
export function replayRun(doc, runId) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.events)) return null;
  const events = doc.events.filter((e) => e && typeof e === 'object' && e.runId === runId);
  return { state: reduceAll(events), events: events.length };
}

export function replayError(status) {
  if (status === 413) return 'The event log of this run is larger than 20 MiB, so it cannot be replayed here.';
  if (status === 404) return 'This run is not in the chat history any more.';
  if (status === 0) return 'The server did not answer. Is it still running?';
  return `The run could not be loaded (HTTP ${status}).`;
}

// Why the agent messages of an earlier run cannot be shown in the Chat view.
export function detailError(status) {
  if (status === 413) return 'The event log of this run is larger than 20 MiB, so its agent messages cannot be shown here.';
  if (status === 404) return 'This run is not in the chat history any more.';
  if (status === 0) return 'The server did not answer. Is it still running?';
  return `The agent messages of this run could not be loaded (HTTP ${status}).`;
}

// What the follow-up composer does. view 'chat': while a run is live the Chat view shows the composer that
// messages its agents in the same place, so this one steps aside. -> { hidden, disabled, reason, label }
export function composerGate({ scoped, enabled, mode, replaying, chatStatus = 'idle', alive = false, recovery = false, runs = 0, submitting = false, view = 'dashboard' }) {
  const label = runs > 0 ? 'Follow up' : 'Start run';
  if (!scoped || !enabled || mode === 'demo' || replaying) return { hidden: true, disabled: true, reason: '', label };
  if (alive || ALIVE_STATUSES.has(chatStatus)) {
    if (view === 'chat' && alive) return { hidden: true, disabled: true, reason: '', label };
    return { hidden: false, disabled: true, label,
      reason: view === 'chat' ? 'A run is in progress. Follow up once it has finished.'
        : 'A run is in progress. Message its agents under Messages; follow up once it has finished.' };
  }
  if (recovery) return { hidden: false, disabled: true, reason: 'Recovery required: another owner still holds this chat.', label };
  return { hidden: false, disabled: submitting, reason: '', label };
}

// ------------------------------------------------------------ request bodies

// form: { goal, models, execution: the run form's execution fields } -> { body } or { error, field }.
// A chat's workspace is its project's, so a follow-up never sends one.
export function buildFollowUp({ goal, models = {}, execution = {} } = {}, control) {
  return buildRunRequest({ ...execution, request: goal, workspace: '', demo: false, models }, control);
}

// POST /api/projects -> { body } or { error, field }
export function buildProject({ name, workspace, create } = {}) {
  const n = raw(name).trim();
  if (!n) return { error: 'Give the project a name.', field: 'name' };
  if (n.length > NAME_MAX) return { error: `The name has at most ${NAME_MAX} characters.`, field: 'name' };
  const body = { name: n };
  const ws = raw(workspace).trim();
  if (ws) {
    if (!isAbsolutePath(ws)) return { error: 'The folder must be an absolute path, for example C:\\Users\\you\\code\\app.', field: 'workspace' };
    body.workspace = ws;
    if (create === true) body.create = true;
  }
  return { body };
}

// POST /api/projects/rename { id, name } and POST .../chats/rename { id, title } -> { body } or { error }
export function buildRename(kind, { id, value } = {}) {
  const v = raw(value).trim();
  const what = kind === 'project' ? 'project' : 'chat';
  const max = kind === 'project' ? NAME_MAX : TITLE_MAX;
  if (!v) return { error: `Give the ${what} a ${kind === 'project' ? 'name' : 'title'}.` };
  if (v.length > max) return { error: `At most ${max} characters.` };
  return { body: kind === 'project' ? { id, name: v } : { id, title: v } };
}

// POST /api/projects/remove { id, deleteHistory? } and POST .../chats/remove { id }
export function buildRemove(kind, { id, deleteHistory = false } = {}) {
  return kind === 'project' && deleteHistory === true ? { body: { id, deleteHistory: true } } : { body: { id } };
}

// The title a new chat gets from the goal that starts it.
export function titleFromGoal(goal) {
  const t = raw(goal).replace(/\s+/g, ' ').trim();
  return t.length > AUTO_TITLE_MAX ? `${t.slice(0, AUTO_TITLE_MAX - 3).trimEnd()}...` : t;
}

const PROJECT_CODES = {
  single_mode: 'This server serves a single project. Start it with --data <dir> to manage projects.',
  running: 'A run is still in progress there. Stop it first.',
  chat_running: 'A run is still in progress there. Stop it first.',
};

// A server error that is a bare code ("too_many_runs") is not something to show as it is.
function serverText(data) {
  const msg = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : '';
  return /^[a-z_]+$/.test(msg) ? { code: msg, text: '' } : { code: typeof data?.code === 'string' ? data.code : '', text: msg };
}

// Error text for a failed project or chat POST.
export function projectError(status, data) {
  const { code, text } = serverText(data);
  if (PROJECT_CODES[code]) return PROJECT_CODES[code];
  if (status === 409) return text || 'Conflict: a run is in progress there, or the list changed. Try again.';
  return responseError(status, text ? { error: text } : null);
}

// Which field of the new-project form a server message is about.
export function projectErrorField(message) {
  const t = typeof message === 'string' ? message : '';
  if (/\b(workspace|folder|path|directory|drive|profile)\b/i.test(t)) return 'workspace';
  if (/\bname\b/i.test(t)) return 'name';
  return null;
}

// Error text for a run that did not start: 429 is the parallel limit, 409 a chat that already runs.
export function runStartError(status, data, limits = null) {
  const { code, text } = serverText(data);
  if (status === 429 || code === 'too_many_runs') {
    const n = limits?.maxConcurrentRuns ? ` (${limits.running} of ${limits.maxConcurrentRuns} running)` : '';
    return `Too many runs in parallel${n}. Wait until one finishes or stop one, then start this one again.`;
  }
  if (status === 409) return text || 'This chat already has a run in progress.';
  return responseError(status, text ? { error: text } : null);
}

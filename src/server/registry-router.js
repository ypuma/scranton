import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry, validateId, derivedChatTitle } from '../core/projects.js';
import { readThoughts } from '../core/live-activity.js';
import { acquireRunLease, readRunLease } from '../core/run-lease.js';
import { orphanSnapshot } from '../core/run-recovery.js';
import { listRuns } from '../core/thread.js';
import { listRestorePoints, undoRun } from '../core/restore-points.js';
import { readRunDiff } from '../core/worktree.js';
import { isLoopbackAddress } from '../core/network.js';
import { createControl, readBody, json } from './control.js';
import { createPipelineSupervisor } from '../core/pipeline-supervisor.js';
import { resolveReflectionModel } from '../core/dreaming-reflection-sources.js';
import { getAuthService } from '../core/auth.js';
import { loadConfig, PACKAGE_ROOT } from '../core/config.js';
import { createModelWindows } from '../core/model-windows.js';
import { createContext } from '../core/context/index.js';
import { UNKNOWN_RECIPIENT } from '../core/context/limits.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
function authorize(req) {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!isLoopbackAddress(req.socket.remoteAddress) || !(host === 'localhost' || isLoopbackAddress(host)) || req.headers['x-scranton-client'] !== '1') throw fail(403, 'Forbidden');
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${host.includes(':') ? `[${host}]` : host}:${req.socket.localPort}`) throw fail(403, 'Forbidden origin');
}
function currentId(hive) {
  try { return JSON.parse(fs.readFileSync(path.join(hive, 'state.json'), 'utf8')).runId; } catch { return null; }
}
function runsFor(hive) {
  const current = currentId(hive);
  return listRuns(hive).map((run) => ({ ...run, current: run.runId === current }));
}
function replay(hive, runId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) throw fail(400, 'Invalid run ID');
  const file = path.join(hive, 'runs', runId, 'events.jsonl');
  try {
    const dir = fs.realpathSync(path.join(hive, 'runs'));
    const real = fs.realpathSync(file);
    if (!dir.startsWith(fs.realpathSync(hive) + path.sep) || !real.startsWith(dir + path.sep)) throw fail(403, 'Forbidden archive path');
    if (fs.statSync(file).size > 20 * 1024 * 1024) throw fail(413, 'Archive exceeds 20 MiB');
    const text = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(text) > 20 * 1024 * 1024) throw fail(413, 'Archive exceeds 20 MiB');
    return text.split('\n').slice(0, -1).flatMap((line) => { try { const e = JSON.parse(line); return e && typeof e === 'object' ? [e] : []; } catch { return []; } });
  } catch (err) { if (err.code === 'ENOENT') throw fail(404, 'Run archive not found'); throw err; }
}

export function createRegistryRouter({ dataDir, hiveDir, control, maxConcurrentRuns, projectsRoot, legacyWorkspace, contextFactory, single, completeReflection = control?.completeReflection, modelWindows = control?.modelWindows ?? (dataDir ? createModelWindows() : undefined) }) {
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) throw fail(400, 'Invalid maxConcurrentRuns');
  const registry = dataDir ? createProjectRegistry({ dataDir, projectsRoot }) : null;
  if (legacyWorkspace) registry?.importLegacy(legacyWorkspace);
  registry?.listProjects();
  const chatContext = registry ? createContext({ dataDir, registry }) : null;
  const contexts = new Map();
  const completed = new Map(), dreams = new Map(), nextDream = new Map();
  function dreaming(projectId) {
    registry.getProject(projectId);
    if (!dreams.has(projectId)) dreams.set(projectId, registry.dreaming(projectId, { completeReflection, isBusy: () => closing || registry.listChats(projectId).some((c) => c.error || live(c)) }));
    return dreams.get(projectId);
  }
  let recent = null;
  let closing = false;
  const authController = registry ? createControl({ hive: dataDir, ...control, modelWindows, promptsDir: path.join(dataDir, 'prompts') }) : null;
  const allChats = () => registry.listProjects().flatMap((p) => registry.listChats(p.id));
  const pipeline = createPipelineSupervisor({ dataDir: dataDir ?? path.dirname(hiveDir), auth: control?.auth, context: chatContext, modelWindows,
    dreaming: registry ? (projectId) => dreaming(projectId) : undefined,
    checkCapacity() { if (running() >= maxConcurrentRuns) throw fail(429, 'too_many_runs'); },
    onStarting(chat, task) { const current = registry.getChat(chat.projectId, chat.id); registry.updateChat(chat.projectId, chat.id, current.title === 'New chat' ? { title: derivedChatTitle(task) } : {}); }
  });
  const live = (chat) => chat.engine === 'pipeline' ? pipeline.busy(chat) : Boolean(contexts.get(chat.hiveDir)?.controller?.snapshot().run || readRunLease(chat.hiveDir));
  const running = () => allChats().filter((c) => c.engine !== 'pipeline' && live(c)).length + pipeline.liveCount;
  const defaultProject = () => ({ id: 'default', name: 'Default', workspace: path.resolve(control?.workspace ?? 'workspace') });
  const defaultChat = () => ({ id: 'default', projectId: 'default', title: 'Default', hiveDir: path.resolve(hiveDir), updatedAt: null });
  function context(project, chat) {
    if (single) return single;
    let ctx = contexts.get(chat.hiveDir);
    if (!ctx) {
      ctx = contextFactory({ hive: chat.hiveDir, control: { ...control, modelWindows, promptsDir: path.join(dataDir, 'prompts'), workspace: project.workspace, closeAuth: false, prepareThread: true, fixedWorkspace: true,
        dreaming: () => dreaming(project.id),
        threadContext: ({ memory, recipients }) => chatContext.forTeam(project.id, chat.id, { memory, recipients }),
        onStarting(info) {
          const current = registry.getChat(project.id, chat.id);
          registry.updateChat(project.id, chat.id, current.title === 'New chat' ? { title: derivedChatTitle(info.request) } : {});
        },
        acquire(hive, info) {
          return registry.locked(() => {
            if (closing) throw fail(409, 'Server is closing');
            registry.getChat(project.id, chat.id);
            if (readRunLease(hive)) throw fail(409, readRunLease(hive)?.mode === 'undo' ? 'An undo is running in this chat; wait for it to finish or recover it before starting a run.' : 'Chat is running or requires recovery');
            if (running() >= maxConcurrentRuns) throw fail(429, 'too_many_runs');
            return acquireRunLease(hive, info);
          });
        }
      } });
      contexts.set(chat.hiveDir, ctx);
    }
    return ctx;
  }
  let lastRecoveryScan = -Infinity;
  function recoverGone() {
    if (single) { void single.controller?.recoverGone(); return; }
    if (Date.now() - lastRecoveryScan < 1000) return;
    lastRecoveryScan = Date.now();
    for (const chat of allChats()) {
      if (!chat.error && chat.engine !== 'pipeline' && readRunLease(chat.hiveDir)) void context(registry.getProject(chat.projectId), chat).controller?.recoverGone();
    }
  }
  void recoverGone();
  function snapshot(chat) {
    if (chat.engine === 'pipeline') return pipeline.snapshot(chat);
    const ctx = single ?? contexts.get(chat.hiveDir);
    if (ctx?.controller) return ctx.controller.snapshot();
    const lease = readRunLease(chat.hiveDir);
    return { v: 1, enabled: true, run: null, pendingHuman: null, lastExit: completed.get(chat.hiveDir) ?? null, recoveryRequired: Boolean(lease), orphan: lease ? orphanSnapshot(chat.hiveDir) : null };
  }
  function chatSummary(chat) {
    if (chat.engine === 'pipeline' && !chat.error) {
      const { runs } = pipeline.list(chat), last = runs.at(-1);
      const statuses = { running: 'running', awaiting_approval: 'needs_human', succeeded: 'done', failed: 'failed', suspended: 'stopped', rejected: 'stopped', cancelled: 'stopped' };
      return { id: chat.id, title: chat.title, engine: 'pipeline', status: pipeline.snapshot(chat).run ? 'running' : statuses[last?.status] ?? 'idle', updatedAt: last?.updatedAt ?? chat.updatedAt, runs: runs.length };
    }
    if (chat.error) return { id: chat.id, title: chat.title, status: 'error', error: chat.error, updatedAt: chat.updatedAt, runs: 0 };
    const s = snapshot(chat), runs = runsFor(chat.hiveDir), last = runs.at(-1);
    const statuses = { success: 'done', partial: 'done', finished: 'done', aborted: 'stopped', failed: 'failed' };
    // without a registry the one chat has no title of its own: it is called what it was first asked
    const title = !registry && runs[0]?.goal ? derivedChatTitle(String(runs[0].goal)) : chat.title;
    return { id: chat.id, title, status: s.pendingHuman ? 'needs_human' : s.run || s.recoveryRequired ? 'running' : statuses[last?.status] ?? 'idle', updatedAt: last?.endedAt ?? last?.startedAt ?? chat.updatedAt, runs: runs.length };
  }
  const reaper = registry ? setInterval(() => {
    for (const [hive, ctx] of contexts) {
      const s = ctx.controller.snapshot();
      if (!ctx.inFlight && !ctx.subscribers && !s.run && !s.recoveryRequired) {
        if (s.lastExit) completed.set(hive, s.lastExit);
        contexts.delete(hive);
        void ctx.close();
      }
    }
  }, 1000) : null;
  reaper?.unref();
  const dreamTimer = registry ? setInterval(() => {
    if (closing) return;
    let projects;
    try { projects = registry.listProjects(); } catch { return; }
    for (const project of projects) {
      try {
        const dream = dreaming(project.id), status = dream.status(), now = Date.now();
        if (!status.enabled) { nextDream.delete(project.id); continue; }
        const due = nextDream.get(project.id) ?? (status.lastSweepAt ? Date.parse(status.lastSweepAt) + status.intervalMinutes * 60000 : now);
        if (now < due || status.state === 'busy') continue;
        dream.sweep(); nextDream.set(project.id, now + status.intervalMinutes * 60000);
        if (status.reflectionEnabled && status.reflectionModel && !status.reflection?.proposal && status.reflection?.state !== 'running') {
          void resolveReflectionModel(control?.auth ?? getAuthService(), status.reflectionModel).then((model) => {
            if (!closing) return dream.propose({ model });
          }).catch(() => {});
        }
      } catch { nextDream.set(project.id, Date.now() + 60000); }
    }
  }, 60000) : null;
  dreamTimer?.unref();
  async function inspectContext(project, chat, req) {
    let activeRunId;
    try {
      activeRunId = chat.engine === 'pipeline' ? pipeline.list(chat).active
        : contexts.get(chat.hiveDir)?.controller?.snapshot().run?.runId ?? readRunLease(chat.hiveDir)?.runId;
    } catch {}
    let memory = chat.engine === 'pipeline' ? [] : '';
    try { const dream = dreaming(project.id); memory = chat.engine === 'pipeline' ? dream.structuredContext() : dream.context(); } catch {}
    let recipients;
    if (chat.engine === 'pipeline') {
      const query = new URL(req?.url ?? '/', 'http://localhost').searchParams;
      const provider = query.get('provider'), model = query.get('model');
      if (provider !== null || model !== null) {
        if ([provider, model].some((v) => typeof v !== 'string' || v.length < 1 || v.length > 256 || /[\s\x00-\x1f\x7f-\x9f]/.test(v)) || query.getAll('provider').length !== 1 || query.getAll('model').length !== 1) throw fail(400, 'Invalid context model');
        try { recipients = { planner: await modelWindows.resolve({ provider, model }) }; } catch {}
      }
    } else {
      recipients = { planner: UNKNOWN_RECIPIENT, developer: UNKNOWN_RECIPIENT };
      try {
        const config = loadConfig({ cwd: PACKAGE_ROOT, validateWorkflow: false, env: { ...process.env, SCRANTON_DATA: '', SCRANTON_SETTINGS_DIR: dataDir }, flags: { workspace: project.workspace, hive: chat.hiveDir, gates: control?.gates } });
        const [planner, developer] = await Promise.all(['michael', 'dwight'].map((id) => modelWindows.resolve(config.agents[id].modelSetting.value)));
        recipients = { planner, developer };
      } catch { /* Invalid configuration must not hide the context document. */ }
    }
    return chatContext.inspect(project.id, chat.id, { activeRunId, memory, recipients });
  }
  async function scoped(req, res, project, chat, suffix) {
    if (suffix === '/restore-points' || suffix === '/undo') {
      if (!registry) throw fail(404, 'Not found');
      if (suffix === '/restore-points' && req.method === 'GET') return json(res, 200, { points: chat.engine === 'pipeline' ? [] : listRestorePoints(chat.hiveDir).map(({ workspace, ...point }) => point) });
      if (suffix === '/undo' && req.method === 'POST') {
        const body = await readBody(req);
        if (Object.keys(body).some((key) => !['runId', 'force'].includes(key)) || body.runId !== undefined && (typeof body.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.runId)) || body.force !== undefined && typeof body.force !== 'boolean') throw fail(400, 'Expected only optional runId (restore point ID) and force (boolean)');
        if (snapshot(chat).run) throw fail(409, 'A run is active in this chat; stop it before undo.');
        const siblings = registry.listChats(project.id).filter((c) => c.id !== chat.id);
        if (siblings.some((c) => snapshot(c).run)) throw fail(409, 'A run is active in another chat of this project; stop or recover it before undo.');
        if (chat.engine === 'pipeline') throw fail(404, 'No restore point available');
        try { return json(res, 200, await undoRun({ hiveDir: chat.hiveDir, siblings: siblings.map((c) => c.hiveDir), ...body })); }
        catch (err) {
          if (err.message === 'No restore point available') throw fail(404, err.message);
          if (err.status === 409 && err.message.startsWith('Newer runs must be undone first:')) throw fail(409, err.message.replace('undo it with --force or leave both.', 'force its undo or leave both.'));
          throw err;
        }
      }
      throw fail(404, 'Not found');
    }
    if (suffix === '/context' || suffix.startsWith('/context/')) {
      if (!chatContext) throw fail(404, 'Not found');
      if (suffix === '/context' && req.method === 'GET') return json(res, 200, await inspectContext(project, chat, req));
      if (['/context/reset', '/context/restore'].includes(suffix) && req.method === 'POST') {
        const body = await readBody(req);
        if (Object.keys(body).length) throw fail(400, 'Expected an empty JSON object');
        chatContext[suffix.endsWith('/reset') ? 'reset' : 'restore'](project.id, chat.id);
        return json(res, 200, await inspectContext(project, chat));
      }
      throw fail(404, 'Not found');
    }
    if (suffix === '/pipeline' || suffix.startsWith('/pipeline/')) {
      if (chat.engine !== 'pipeline') throw fail(409, 'This chat does not use the pipeline engine');
      if (suffix === '/pipeline' && req.method === 'GET') return json(res, 200, pipeline.list(chat));
      if (suffix === '/pipeline/runs' && req.method === 'POST') return json(res, 202, await pipeline.start(project, chat, await readBody(req)));
      const run = /^\/pipeline\/runs\/([^/]+)(?:\/(decision|resume|cancel|artifacts\/[^/]+))?$/.exec(suffix);
      if (run) {
        if (!run[2] && req.method === 'GET') {
          const raw = new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0';
          if (!/^\d+$/.test(raw)) throw fail(400, 'Invalid event sequence');
          return json(res, 200, await pipeline.inspect(chat, run[1], Number(raw)));
        }
        if (run[2]?.startsWith('artifacts/') && req.method === 'GET') return json(res, 200, pipeline.artifact(chat, run[1], run[2].slice(10)));
        if (['decision', 'resume', 'cancel'].includes(run[2]) && req.method === 'POST') return json(res, 202, await pipeline.action(chat, run[1], run[2], await readBody(req)));
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (chat.engine === 'pipeline' && req.method === 'POST' && ['/runs', '/chat', '/hitl', '/stop', '/release', '/runs/stop', '/runs/release'].includes(suffix)) throw fail(409, 'This chat uses the pipeline engine');
    if (chat.engine === 'pipeline') return json(res, 404, { error: 'Not found' });
    if (suffix === '/runs' && req.method === 'GET') { json(res, 200, { runs: runsFor(chat.hiveDir) }); return; }
    const archive = /^\/runs\/([^/]+)\/events$/.exec(suffix);
    if (archive && req.method === 'GET') { json(res, 200, { events: replay(chat.hiveDir, archive[1]) }); return; }
    // what the run integrated into the workspace, read from its private repository; 404: it kept none
    const changes = /^\/runs\/([^/]+)\/diff$/.exec(suffix);
    if (changes && req.method === 'GET') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(changes[1])) throw fail(400, 'Invalid run ID');
      const diff = await readRunDiff({ hiveDir: chat.hiveDir, runId: changes[1] });
      if (!diff) throw fail(404, 'This run kept no diff');
      json(res, 200, { runId: changes[1], content: diff.content, truncated: diff.truncated }); return;
    }
    // what the run's models reasoned and wrote, block by block (thoughts.jsonl); 404: the run kept none
    const thoughts = /^\/runs\/([^/]+)\/thoughts$/.exec(suffix);
    if (thoughts && req.method === 'GET') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(thoughts[1])) throw fail(400, 'Invalid run ID');
      const raw = new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0';
      if (!/^\d{1,12}$/.test(raw)) throw fail(400, 'Invalid sequence');
      const doc = readThoughts(chat.hiveDir, thoughts[1], Number(raw));
      if (!doc) throw fail(404, 'This run kept no thoughts');
      json(res, 200, doc); return;
    }
    const ctx = context(project, chat);
    if (suffix === '/events' && req.method === 'GET') return ctx.handleEvents(req, res);
    if (suffix === '/live' && req.method === 'GET') return ctx.handleLive(req, res);
    if (suffix === '/state' && req.method === 'GET') return ctx.handleState(req, res);
    if (suffix === '/control' && req.method === 'GET') {
      const s = ctx.controller?.snapshot() ?? { v: 1, enabled: false };
      if (s.lastExit == null && completed.has(chat.hiveDir)) s.lastExit = completed.get(chat.hiveDir);
      return json(res, 200, s);
    }
    const mapped = { '/runs': '/api/runs', '/chat': '/api/chat', '/hitl': '/api/hitl', '/stop': '/api/runs/stop', '/runs/stop': '/api/runs/stop', '/release': '/api/runs/release', '/runs/release': '/api/runs/release' }[suffix];
    if (mapped && req.method === 'POST' && ctx.controller) {
      if (registry && suffix === '/runs') {
        registry.updateChat(project.id, chat.id, {});
        recent = { projectId: project.id, chatId: chat.id };
      }
      ctx.inFlight = (ctx.inFlight ?? 0) + 1;
      try { return await ctx.controller.handle(req, res, mapped); }
      finally { ctx.inFlight--; }
    }
    json(res, 404, { error: 'Not found' });
  }
  return {
    authController,
    recoverGone,
    async handle(req, res, pathname) {
      const scopedPath = /^\/api\/projects\/([^/]+)\/chats\/([^/]+)(\/.*)$/.exec(pathname);
      const chatRoute = /^\/api\/projects\/([^/]+)\/chats(?:\/(rename|remove))?$/.exec(pathname);
      const projectsRoute = ['/api/projects', '/api/projects/rename', '/api/projects/remove'].includes(pathname);
      const alias = registry && ['/events', '/api/live', '/api/state', '/api/runs', '/api/chat', '/api/hitl', '/api/stop', '/api/runs/stop', '/api/runs/release', '/api/control'].includes(pathname);
      const dreamPath = /^\/api\/projects\/([^/]+)\/dreaming(?:\/(preview|sweep|settings|rollback|proposal|propose|proposal\/apply|proposal\/reject|cancel))?$/.exec(pathname);
      const contextPath = /^\/api\/projects\/([^/]+)\/context(?:\/(.*))?$/.exec(pathname);
      const detectPath = /^\/api\/projects\/([^/]+)\/pipeline\/detect$/.exec(pathname);
      if (!scopedPath && !chatRoute && !projectsRoute && !alias && !['/api/runs', '/api/pipeline', '/api/pipeline/sandbox/build'].includes(pathname) && !detectPath && !dreamPath && !contextPath) return false;
      if (!registry && (contextPath || scopedPath?.[3] === '/context' || scopedPath?.[3].startsWith('/context/'))) throw fail(404, 'Not found');
      if (!registry && !scopedPath && !chatRoute && !projectsRoute && pathname === '/api/runs' && req.method !== 'GET') return false;
      authorize(req);
      if (!registry && pathname === '/api/runs' && req.method === 'GET') { json(res, 200, { runs: runsFor(defaultChat().hiveDir) }); return true; }
      if (closing) throw fail(409, 'Server is closing');
      recoverGone();
      if (contextPath) {
        const projectId = contextPath[1], action = contextPath[2];
        registry.getProject(projectId);
        if (action === undefined && req.method === 'GET') { json(res, 200, chatContext.status(projectId)); return true; }
        if (!['settings', 'notes'].includes(action) || req.method !== 'POST') throw fail(404, 'Not found');
        const body = await readBody(req);
        if (action === 'settings' && (!Object.keys(body).length || Object.keys(body).some((key) => !['crossChat', 'budget', 'models'].includes(key)))) throw fail(400, 'Expected a context settings patch');
        if (action === 'notes' && (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'text'))) throw fail(400, 'Expected only text');
        if (action === 'notes' && (typeof body.text !== 'string' || body.text.length > 16000)) throw fail(400, 'text must be a string of at most 16000 characters');
        json(res, 200, action === 'settings' ? chatContext.configure(projectId, body) : chatContext.setNotes(projectId, body.text)); return true;
      }
      if (dreamPath) {
        if (!registry) throw fail(409, 'single_mode');
        const dream = dreaming(dreamPath[1]), action = dreamPath[2];
        if ((!action || action === 'proposal') && req.method === 'GET') { const status = dream.status(); json(res, 200, action ? status.reflection : status); return true; }
        if (!action || req.method !== 'POST') throw fail(404, 'Not found');
        const body = await readBody(req);
        const allowed = action === 'settings' ? ['enabled', 'intervalMinutes', 'applyPolicy', 'reflectionEnabled', 'reflectionModel', 'reflectionMaxOutputTokens', 'reflectionTimeoutSeconds'] : action === 'propose' ? ['provider', 'model'] : ['proposal/apply', 'proposal/reject'].includes(action) ? ['proposalId'] : [];
        if (Object.keys(body).some((key) => !allowed.includes(key))) throw fail(400, 'Unexpected request field');
        if (['proposal/apply', 'proposal/reject'].includes(action) && (typeof body.proposalId !== 'string' || !body.proposalId || body.proposalId.length > 128)) throw fail(400, 'Proposal ID required');
        if (action === 'propose') {
          if (body.provider !== undefined && (typeof body.provider !== 'string' || typeof body.model !== 'string')) throw fail(400, 'Provider requires a model');
          const selected = body.provider === undefined ? body.model ?? dream.status().reflectionModel : `${body.provider}/${body.model}`;
          const model = await resolveReflectionModel(control?.auth ?? getAuthService(), selected);
          const job = dream.propose({ model });
          void job.catch(() => {});
          json(res, 202, dream.status()); return true;
        }
        const result = action === 'settings' ? dream.configure(body)
          : action === 'proposal/apply' ? dream.applyProposal(body.proposalId)
          : action === 'proposal/reject' ? dream.rejectProposal(body.proposalId)
          : action === 'cancel' ? dream.cancelReflection() : dream[action]();
        nextDream.delete(dreamPath[1]);
        json(res, 200, result); return true;
      }
      if (pathname === '/api/pipeline' && req.method === 'GET') { json(res, 200, await pipeline.capability()); return true; }
      if (pathname === '/api/pipeline/sandbox/build' && req.method === 'POST') { json(res, 202, await pipeline.buildSandbox(await readBody(req))); return true; }
      if (detectPath && req.method === 'POST') {
        if (!registry) throw fail(409, 'single_mode');
        json(res, 200, await pipeline.detect(registry.getProject(detectPath[1]), await readBody(req))); return true;
      }
      if (pathname === '/api/projects' && req.method === 'GET') {
        const projects = registry ? registry.listProjects() : [defaultProject()];
        json(res, 200, { mode: registry ? 'registry' : 'single', ...(registry ? { projectsRoot: registry.projectsRoot } : {}), maxConcurrentRuns, running: registry ? running() : Number(Boolean(single.controller?.snapshot().run)), projects: projects.map((p) => ({ ...p, chats: (registry ? registry.listChats(p.id) : [defaultChat()]).map(chatSummary) })) }); return true;
      }
      if (alias && pathname === '/api/control' && req.method === 'GET') {
        const chats = allChats(), snapshots = chats.map((c) => ({ projectId: c.projectId, chatId: c.id, ...snapshot(c) }));
        json(res, 200, { v: 1, enabled: true, scenarios: authController.snapshot().scenarios, defaults: authController.snapshot().defaults, running: running(), pendingHuman: snapshots.filter((s) => s.pendingHuman).length, chats: snapshots.filter((s) => s.run || s.pendingHuman || s.recoveryRequired) }); return true;
      }
      if (scopedPath || (alias && !projectsRoute)) {
        let p = scopedPath?.[1] ?? recent?.projectId;
        let c = scopedPath?.[2] ?? recent?.chatId;
        if (registry && !p) {
          const chat = allChats().filter((c) => !c.error).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
          p = chat?.projectId; c = chat?.id;
        }
        if (!p && registry) throw fail(404, 'No active chat');
        const project = registry ? registry.getProject(p) : defaultProject();
        const chat = registry ? registry.getChat(p, c) : defaultChat();
        if (!registry && (p !== 'default' || c !== 'default')) throw fail(404, 'Chat not found');
        const suffix = scopedPath?.[3] ?? (pathname === '/events' ? '/events' : pathname.slice(4));
        await scoped(req, res, project, chat, suffix); return true;
      }
      if (req.method !== 'POST') throw fail(404, 'Not found');
      const body = await readBody(req);
      if (!registry) throw fail(409, 'single_mode');
      if (projectsRoute) {
        const allowed = pathname === '/api/projects' ? ['name', 'workspace', 'create'] : pathname.endsWith('/rename') ? ['id', 'name'] : ['id', 'deleteHistory'];
        if (Object.keys(body).some((k) => !allowed.includes(k))) throw fail(400, 'Unexpected request field');
        if (pathname === '/api/projects') json(res, 201, { project: registry.addProject(body) });
        else if (pathname.endsWith('/rename')) json(res, 200, { project: registry.renameProject(body.id, body.name) });
        else {
          const chats = registry.listChats(body.id);
          if (chats.some((c) => c.error || live(c))) throw fail(409, 'Project has running chats or requires recovery');
          if (body.deleteHistory !== undefined && typeof body.deleteHistory !== 'boolean') throw fail(400, 'Invalid deleteHistory');
          await dreams.get(body.id)?.close(); dreams.delete(body.id); nextDream.delete(body.id);
          if (body.deleteHistory) for (const chat of chats) if (chat.engine === 'pipeline') pipeline.remove(chat);
          registry.removeProject(body.id, { deleteHistory: body.deleteHistory, isRunning: live });
          json(res, 200, { ok: true });
        }
        return true;
      }
      if (chatRoute) {
        const p = validateId(chatRoute[1]), action = chatRoute[2];
        const allowed = action === 'remove' ? ['id'] : action === 'rename' ? ['id', 'title'] : ['title', 'engine'];
        if (Object.keys(body).some((k) => !allowed.includes(k))) throw fail(400, 'Unexpected request field');
        if (!action) json(res, 201, { chat: registry.createChat(p, body) });
        else if (action === 'rename') json(res, 200, { chat: registry.updateChat(p, body.id, { title: body.title }) });
        else {
          const chat = registry.getChat(p, body.id);
          if (chat.engine === 'pipeline') pipeline.remove(chat);
          registry.removeChat(p, body.id, live); json(res, 200, { ok: true });
        }
        return true;
      }
      throw fail(404, 'Not found');
    },
    async close() {
      closing = true; clearInterval(reaper); clearInterval(dreamTimer);
      const errors = [];
      const drain = async (closers) => {
        const results = await Promise.allSettled(closers.map((close) => Promise.resolve().then(close)));
        errors.push(...results.filter((r) => r.status === 'rejected').map((r) => r.reason));
      };
      await drain([...dreams.values()].map((dream) => () => dream.close()));
      dreams.clear(); nextDream.clear();
      await drain([...contexts.values()].map((ctx) => () => ctx.close()));
      await drain([() => pipeline.close(), () => authController?.close()]);
      if (errors.length) throw new AggregateError(errors, 'Registry resource cleanup failed');
    }
  };
}

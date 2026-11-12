import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry, validateId, derivedChatTitle } from '../core/projects.js';
import { acquireRunLease, readRunLease } from '../core/run-lease.js';
import { orphanSnapshot } from '../core/run-recovery.js';
import { listRuns } from '../core/thread.js';
import { isLoopbackAddress } from '../core/network.js';
import { createControl, readBody, json } from './control.js';
import { createPipelineSupervisor } from '../core/pipeline-supervisor.js';

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

export function createRegistryRouter({ dataDir, hiveDir, control, maxConcurrentRuns, projectsRoot, legacyWorkspace, contextFactory, single }) {
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) throw fail(400, 'Invalid maxConcurrentRuns');
  const registry = dataDir ? createProjectRegistry({ dataDir, projectsRoot }) : null;
  if (legacyWorkspace) registry?.importLegacy(legacyWorkspace);
  registry?.listProjects();
  const contexts = new Map();
  const completed = new Map();
  let recent = null;
  let closing = false;
  const authController = registry ? createControl({ hive: dataDir, ...control, promptsDir: path.join(dataDir, 'prompts') }) : null;
  const allChats = () => registry.listProjects().flatMap((p) => registry.listChats(p.id));
  const pipeline = createPipelineSupervisor({ dataDir: dataDir ?? path.dirname(hiveDir), auth: control?.auth,
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
      ctx = contextFactory({ hive: chat.hiveDir, control: { ...control, promptsDir: path.join(dataDir, 'prompts'), workspace: project.workspace, closeAuth: false, prepareThread: true, fixedWorkspace: true,
        onStarting(info) {
          const current = registry.getChat(project.id, chat.id);
          registry.updateChat(project.id, chat.id, current.title === 'New chat' ? { title: derivedChatTitle(info.request) } : {});
        },
        acquire(hive, info) {
          return registry.locked(() => {
            if (closing) throw fail(409, 'Server is closing');
            registry.getChat(project.id, chat.id);
            if (readRunLease(hive)) throw fail(409, 'Chat is running or requires recovery');
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
    return { id: chat.id, title: chat.title, status: s.pendingHuman ? 'needs_human' : s.run || s.recoveryRequired ? 'running' : statuses[last?.status] ?? 'idle', updatedAt: last?.endedAt ?? last?.startedAt ?? chat.updatedAt, runs: runs.length };
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
  async function scoped(req, res, project, chat, suffix) {
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
      const detectPath = /^\/api\/projects\/([^/]+)\/pipeline\/detect$/.exec(pathname);
      if (!scopedPath && !chatRoute && !projectsRoute && !alias && !['/api/runs', '/api/pipeline', '/api/pipeline/sandbox/build'].includes(pathname) && !detectPath) return false;
      if (!registry && !scopedPath && !chatRoute && !projectsRoute && pathname === '/api/runs' && req.method !== 'GET') return false;
      authorize(req);
      if (!registry && pathname === '/api/runs' && req.method === 'GET') { json(res, 200, { runs: runsFor(defaultChat().hiveDir) }); return true; }
      if (closing) throw fail(409, 'Server is closing');
      recoverGone();
      if (pathname === '/api/pipeline' && req.method === 'GET') { json(res, 200, await pipeline.capability()); return true; }
      if (pathname === '/api/pipeline/sandbox/build' && req.method === 'POST') { json(res, 202, await pipeline.buildSandbox(await readBody(req))); return true; }
      if (detectPath && req.method === 'POST') {
        if (!registry) throw fail(409, 'single_mode');
        json(res, 200, await pipeline.detect(registry.getProject(detectPath[1]), await readBody(req))); return true;
      }
      if (pathname === '/api/projects' && req.method === 'GET') {
        const projects = registry ? registry.listProjects() : [defaultProject()];
        json(res, 200, { mode: registry ? 'registry' : 'single', maxConcurrentRuns, running: registry ? running() : Number(Boolean(single.controller?.snapshot().run)), projects: projects.map((p) => ({ ...p, chats: (registry ? registry.listChats(p.id) : [defaultChat()]).map(chatSummary) })) }); return true;
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
          if (body.deleteHistory) for (const chat of chats) if (chat.engine === 'pipeline') pipeline.remove(chat);
          registry.removeProject(body.id, { deleteHistory: body.deleteHistory, isRunning: live }); json(res, 200, { ok: true });
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
      closing = true; clearInterval(reaper);
      await Promise.all([...contexts.values()].map((ctx) => ctx.close()));
      await pipeline.close();
      await authController?.close();
    }
  };
}

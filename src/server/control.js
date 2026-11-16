import { saveAgent, deleteAgent, validateAgentId } from '../core/agents-config.js';
import { AGENT_IDS } from '../core/state.js';
import { normalizeWorkflow, activeRoles } from '../core/workflow.js';
import { agentCatalog, resolvePrompt } from '../core/prompts.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireRunLease, readRunLease, releaseRunLease, runOwnerStatus } from '../core/run-lease.js';
import { orphanSnapshot, recoverOrphan } from '../core/run-recovery.js';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { loadConfig, PACKAGE_ROOT, THINKING_LEVELS } from '../core/config.js';
import { killTree } from '../core/pi-command.js';
import { validDecision } from '../core/file-control.js';
import { withFsRetry, writeFileAtomicSync } from '../core/util.js';

import { listRuns, formatThreadContext } from '../core/thread.js';
import { getAuthService } from '../core/auth.js';
import { validateDockerModels } from '../core/sandbox.js';
import { isLoopbackAddress } from '../core/network.js';
import { dreamingCap, teamDreamingCohort, teamDreamingContext } from '../core/dreaming-sources.js';

const SCENARIOS = ['happy', 'flaky', 'breaker', 'blocked', 'changes_once', 'security_issues', 'question'];
// Error/blocked invocations can retry; only completed instances stop accepting queued chat.
const CHAT_RECIPIENT_STATES = new Set(['idle', 'thinking', 'working', 'waiting', 'blocked', 'error']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const error = (status, message) => Object.assign(new Error(message), { status });

export function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(value));
}

export async function readBody(req) {
  if (req.headers['x-scranton-client'] !== '1') throw error(403, 'Forbidden');
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) throw error(415, 'Expected application/json');
  if (Number(req.headers['content-length']) > 65536) throw error(413, 'Body too large');
  const text = await new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) { chunks.length = 0; reject(error(413, 'Body too large')); }
      else chunks.push(chunk);
    });
    req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.once('error', reject);
    req.once('aborted', () => reject(error(400, 'Request aborted')));
  });
  try {
    const value = JSON.parse(text);
    if (!object(value)) throw Error();
    return value;
  } catch { throw error(400, 'Expected a JSON object'); }
}

export function createControl({ hive, workspace, runner = spawn, auth = getAuthService(), closeAuth = true, acquire = acquireRunLease, prepareThread = false, fixedWorkspace = false, promptsDir, gates, recoveryDocker, onStarting = () => {}, dreaming }) {
  workspace = path.resolve(workspace ?? 'workspace');
  let active = null;
  let lastExit = null;
  let closing = false;
  let recoveryError = null;
  let dreamingWarning = null;
  let recovery = null;
  let recoveryToken = null;
  let attemptedToken = null;
  function recoverGone() {
    const lease = active ? null : readRunLease(hive);
    const identity = lease ? `${lease.runId}:${lease.token}` : null;
    if (identity !== recoveryToken) {
      recoveryToken = identity; recoveryError = null; attemptedToken = null;
    }
    if (!lease || runOwnerStatus(hive, lease) !== 'gone' || attemptedToken === lease.token) return recovery ?? Promise.resolve();
    attemptedToken = lease.token;
    return recovery ??= recoverOrphan(hive, lease.runId, "Interrupted: the run's process ended without finishing", recoveryDocker, { automatic: true })
      .then(() => { recoveryError = null; }, (err) => { if (err.status !== 409 && recoveryToken === identity) recoveryError = err.message; })
      .finally(() => { recovery = null; });
  }
  void recoverGone();
  const write = (file, value) => writeFileAtomicSync(path.join(hive, file), `${JSON.stringify({ v: 1, ...value, ts: new Date().toISOString() })}\n`);

  const configuration = (extra = {}) => {
    const config = loadConfig({ cwd: PACKAGE_ROOT, validateWorkflow: false, env: { ...process.env, SCRANTON_DATA: '', SCRANTON_SETTINGS_DIR: promptsDir ? path.dirname(promptsDir) : hive }, flags: { workspace, hive, gates, ...extra } });
    if (promptsDir) config.promptsDir = promptsDir;
    return config;
  };
  function snapshot() {
    let pendingHuman = null;
    if (active) {
      try {
        const lines = fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8').split('\n');
        for (const line of lines.slice(0, -1)) {
          let e;
          try { e = JSON.parse(line); } catch { continue; }
          if (!active.info.runId || e.runId !== active.info.runId) continue;
          if (e.type === 'hitl_request') pendingHuman = { runId: e.runId, requestSeq: e.seq, milestoneId: e.milestoneId, reason: e.reason, options: e.options };
          if (e.type === 'hitl_response' || e.type === 'run_finished') pendingHuman = null;
        }
      } catch { /* no current events yet */ }
    }
    let state = null;
    try { state = JSON.parse(fs.readFileSync(path.join(hive, 'state.json'), 'utf8')); } catch { /* not yet published */ }
    if (!active || state?.runId !== active.info.runId) state = null;
    const instances = state?.instances ?? {};
    let execution = null;
    let workflow = null;
    let models = Object.fromEntries(AGENT_IDS.map((id) => [id, null]));
    let configurationError = null, agents = [];
    try {
      const config = configuration();
      configurationError = config.workflowWarning;
      execution = { ...config.execution };
      if (execution.conversation !== true) delete execution.conversation;
      workflow = config.workflow;
      agents = config.roles.map(({ id, name, title, kind, builtin, passKeyword, failKeyword }) => ({ id, name, title, kind, builtin, gate: kind === 'gate', ...(passKeyword ? { passKeyword, failKeyword } : {}) }));
      models = Object.fromEntries(Object.entries(config.agents).map(([role, { provider, model }]) => [role, provider && model ? { provider, model } : null]));
    }
    catch (err) { configurationError = err.message; }
    void recoverGone();
    const orphan = active ? null : orphanSnapshot(hive, recoveryError);
    return { v: 1, enabled: true, dreamingWarning, workspace, scenarios: SCENARIOS, run: active?.info ?? null, lastExit, pendingHuman, defaults: { execution, workflow, models, agents, thinkingLevels: THINKING_LEVELS, configurationError }, instances, sessions: state?.sessions ?? {}, chatAck: state?.chatAck ?? null, recoveryRequired: Boolean(orphan), orphan };
  }

  function stop(delay = 15000) {
    if (!active) {
      const orphan = readRunLease(hive);
      if (!orphan?.runId) throw error(409, orphan ? 'Run ownership requires manual recovery' : 'No run is alive');
      write('control/stop.json', { runId: orphan.runId });
      return Promise.resolve();
    }
    const run = active;
    if (run.exited) return run.done;
    const send = () => {
      if (run.exited) return;
      if (run.info.runId) {
        try { write('control/stop.json', { runId: run.info.runId }); } catch (err) { run.tail = (run.tail + err.message).slice(-8192); }
      }
    };
    send();
    // The child may not have published run_started yet.
    run.stopPoll ??= setInterval(send, 250);
    const deadline = Date.now() + delay;
    if (!run.deadline || deadline < run.deadline) {
      clearTimeout(run.timer);
      run.deadline = deadline;
      run.timer = setTimeout(() => { killTree(run.child); }, delay);
    }
    return run.done;
  }

  async function start(body) {
    await recoverGone();
    if (active || closing || recovery) throw error(409, 'A run is already alive or the server is closing');
    const demo = body.demo;
    if (demo !== undefined && (!object(demo) || !SCENARIOS.includes(demo.scenario) ||
      (demo.delayMs !== undefined && (!Number.isInteger(demo.delayMs) || demo.delayMs < 0 || demo.delayMs > 5000)))) throw error(400, 'Invalid demo');
    if ((!demo || body.request !== undefined) && (typeof body.request !== 'string' || !body.request.trim() || body.request.length > 4000)) throw error(400, 'Invalid request');
    if (body.workspace !== undefined && (typeof body.workspace !== 'string' || !path.isAbsolute(body.workspace))) throw error(400, 'Workspace must be absolute');
    if (body.maxCycles !== undefined && (!Number.isInteger(body.maxCycles) || body.maxCycles < 1 || body.maxCycles > 10)) throw error(400, 'Invalid maxCycles');
    if (body.noPlan !== undefined && typeof body.noPlan !== 'boolean') throw error(400, 'Invalid noPlan');
    if (body.conversation !== undefined && typeof body.conversation !== 'boolean') throw error(400, 'Invalid conversation');
    const baseConfig = configuration();
    if (body.sandbox !== undefined && !['docker', 'host'].includes(body.sandbox)) throw error(400, 'Invalid sandbox');
    if (body.trustedHost !== undefined && typeof body.trustedHost !== 'boolean') throw error(400, 'Invalid trustedHost');
    if (body.sandbox === 'host' && body.trustedHost !== true) throw error(400, 'Host execution requires trustedHost:true');
    if (body.trustedHost === true && body.sandbox === 'docker') throw error(400, 'trustedHost conflicts with docker sandbox');
    const docker = !demo && !body.trustedHost && (body.sandbox ?? baseConfig.execution.sandbox.mode) === 'docker';
    const workflow = normalizeWorkflow(body.workflow === undefined ? baseConfig.workflow : body.workflow, baseConfig.roles.filter((r) => r.kind === 'gate').map((r) => r.id));
    const modelEnv = {};
    if (body.models !== undefined && (!object(body.models) || Object.keys(body.models).some((role) => !Object.hasOwn(baseConfig.agents, role)))) throw error(400, 'Invalid models');
    for (const choice of Object.values(body.models ?? {})) {
      if (!object(choice) || Object.keys(choice).some((key) => !['provider', 'model', 'thinking'].includes(key)) ||
          typeof choice.provider !== 'string' || typeof choice.model !== 'string' ||
          (choice.thinking !== undefined && !THINKING_LEVELS.includes(choice.thinking))) throw error(400, 'Invalid model selection');
    }
    // Docker always uses resolved agent defaults, never cached per-run selections.
    if (body.models !== undefined && !docker) {
      const catalog = await auth.listModels();
      for (const [role, choice] of Object.entries(body.models)) {
        if (!catalog.providers.some((p) => p.id === choice.provider && p.signedIn && p.models.some((m) => m.id === choice.model))) throw error(400, 'Invalid model selection');
        const prefix = `SCRANTON_${role.toUpperCase()}`;
        modelEnv[`${prefix}_PROVIDER`] = choice.provider;
        modelEnv[`${prefix}_MODEL`] = choice.model;
        if (choice.thinking !== undefined) modelEnv[`${prefix}_THINKING`] = choice.thinking;
      }
    }
    // Catalog lookup can yield; recheck before acquiring ownership or spawning.
    if (active || closing) throw error(409, 'A run is already alive or the server is closing');
    if (fixedWorkspace && body.workspace !== undefined && path.resolve(body.workspace) !== workspace) throw error(400, 'Workspace belongs to the project');
    const ws = body.workspace ?? workspace;
    fs.mkdirSync(ws, { recursive: true });
    const mode = demo ? 'demo' : 'run';
    const args = [path.join(PACKAGE_ROOT, 'bin', 'scranton.js'), mode];
    if (demo) args.push('--scenario', demo.scenario, '--delay', String(demo.delayMs ?? 600));
    else args.push('--', body.request);
    // parseArgs accepts options after positionals, but not after the -- terminator.
    const options = ['--gates', workflow.gates.map((stage) => stage.join('+')).join(','), '--single-hive', '--hive', hive, '--workspace', ws, '--on-breaker', 'hive'];
    if (body.maxCycles !== undefined) options.push('--max-cycles', String(body.maxCycles));
    if (body.noPlan) options.push('--no-plan');
    if (body.conversation !== undefined) options.push(body.conversation ? '--conversation' : '--no-conversation');
    if (body.maxParallel !== undefined) {
      if (!Number.isInteger(body.maxParallel) || body.maxParallel < 1 || body.maxParallel > 32) throw error(400, 'maxParallel must be an integer from 1 to 32');
      options.push('--parallel', String(body.maxParallel));
    }
    if (body.sandbox === 'host' || body.trustedHost === true) options.push('--trusted-host');
    else if (body.sandbox === 'docker') options.push('--sandbox', 'docker');
    if (body.sandboxImage !== undefined) {
      if (typeof body.sandboxImage !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(body.sandboxImage)) throw error(400, 'Invalid sandboxImage');
      options.push('--sandbox-image', body.sandboxImage);
    }
    if (body.sandboxNetwork !== undefined) {
      if (!['bridge', 'none'].includes(body.sandboxNetwork)) throw error(400, 'Invalid sandboxNetwork');
      options.push('--sandbox-network', body.sandboxNetwork);
    }
    if (!demo) {
      const launchConfig = loadConfig({ cwd: PACKAGE_ROOT, env: { ...process.env, ...modelEnv, SCRANTON_DATA: '', SCRANTON_SETTINGS_DIR: baseConfig.settingsDir }, flags: { workspace: ws, hive, gates: workflow.gates.map((s) => s.join('+')).join(','), ...(body.trustedHost || body.sandbox === 'host' ? { trustedHost: true } : body.sandbox ? { sandbox: body.sandbox } : {}) } });
      try { validateDockerModels(launchConfig, activeRoles(launchConfig, body.noPlan)); }
      catch (err) { throw error(400, err.message); }
    }
    let memory = '', effective = body.maxCycles ?? baseConfig.maxFailedCycles;
    dreamingWarning = null;
    if (!demo && dreaming) {
      const cohort = teamDreamingCohort({ ...baseConfig, workflow });
      try {
        const dream = dreaming();
        try { Promise.resolve(dream?.cancelReflection?.()).catch(() => {}); } catch {}
        const context = dream?.context() ?? '';
        const cap = dreamingCap(dream, 'team', effective, cohort);
        memory = context; effective = cap;
      } catch { dreamingWarning = 'Optional Dreaming unavailable; using configured retry ceiling without project memory'; }
      const index = options.indexOf('--max-cycles');
      if (index >= 0) options[index + 1] = String(effective);
      else if (effective !== baseConfig.maxFailedCycles) options.push('--max-cycles', String(effective));
    }
    args.splice(2, 0, ...options);
    const info = { mode, request: body.request ?? (demo?.scenario === 'question' ? 'How does the Team orchestrator handle a request?' : 'Build a tiny todo CLI'), workspace: ws, startedAt: new Date().toISOString(), runId: randomUUID(), exitCode: null };
    let lease;
    try { lease = acquire(hive, info); }
    catch (err) { if (err.code === 'EEXIST') throw error(409, 'Hive is owned by another run; stop it or recover ownership first'); throw err; }
    let child;
    try {
      try { Promise.resolve(dreaming?.()?.cancelReflection?.()).catch(() => {}); } catch {}
      onStarting(info);
      if (prepareThread) {
        const file = path.join(hive, 'control', 'thread-context.json');
        writeFileAtomicSync(file, JSON.stringify({ v: 1, text: teamDreamingContext(formatThreadContext(listRuns(hive), { maxChars: 8000 }), memory) }));
        args.splice(2, 0, '--thread-context', file);
      }
      child = runner(process.execPath, args, { cwd: PACKAGE_ROOT, env: { ...process.env, ...modelEnv, SCRANTON_PROMPTS_DIR: baseConfig.promptsDir, SCRANTON_SETTINGS_DIR: baseConfig.settingsDir, SCRANTON_DATA: '', SCRANTON_RUN_ID: info.runId, SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: lease.token }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    } catch (err) { releaseRunLease(hive, lease.token); throw err; }
    const run = { child, tail: '', info: { ...info, pid: child.pid } };
    active = run;
    let startupRefused = false;
    let workStarted = false;
    child.on('message', (message) => {
      if (message?.token !== lease.token) return;
      if (message.type === 'scranton-startup-refused') startupRefused = true;
      if (['scranton-startup-begun', 'scranton-guard-registered'].includes(message.type)) workStarted = true;
    });
    const heartbeat = () => { if (!child.stdin?.destroyed && child.stdin?.writable) child.stdin.write('heartbeat\n'); };
    child.stdin?.on('error', () => { /* guardian fails closed when heartbeats stop */ });
    run.heartbeat = setInterval(heartbeat, 1000);
    heartbeat();
    run.done = new Promise((resolve) => {
      let finished = false;
      const stopSending = () => {
        run.exited = true;
        clearTimeout(run.timer);
        clearInterval(run.stopPoll);
        clearInterval(run.heartbeat);
        const file = path.join(hive, 'control', 'stop.json');
        try {
          if (run.info.runId && JSON.parse(withFsRetry(() => fs.readFileSync(file, 'utf8'))).runId === run.info.runId) {
            withFsRetry(() => fs.rmSync(file, { force: true }));
          }
        } catch (err) {
          if (err.code !== 'ENOENT') run.tail = (run.tail + `Cannot clean stop request: ${err.message}`).slice(-8192);
        }
      };
      const finish = (code, closed = false) => {
        if (finished) return;
        finished = true;
        stopSending();
        if (closed && startupRefused && !workStarted) releaseRunLease(hive, lease.token);
        lastExit = { runId: run.info.runId, startedAt: run.info.startedAt, mode, request: run.info.request, exitCode: code ?? 1, finishedAt: new Date().toISOString(), outputTail: stripVTControlCharacters(run.tail).slice(-4096) };
        if (active === run) active = null;
        resolve();
      };
      child.stdout?.on('data', (d) => { run.tail = (run.tail + d).slice(-8192); });
      child.stderr?.on('data', (d) => { run.tail = (run.tail + d).slice(-8192); });
      child.once('error', (err) => {
        run.tail += err.message;
        if (!child.pid) { releaseRunLease(hive, lease.token); finish(null); }
      });
      child.once('exit', stopSending);
      child.once('close', (code) => finish(code, true));
    });
    return child.pid;
  }

  return {
    snapshot,
    recoverGone,
    async handle(req, res, pathname) {
      try {
        if (!isLoopbackAddress(req.socket.remoteAddress)) throw error(403, 'Forbidden peer');
        if (req.headers['x-scranton-client'] !== '1') throw error(403, 'Forbidden');
        const origin = req.headers.origin;
        const port = req.socket.localPort;
        const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
        if (origin !== undefined && origin !== `http://${host}:${port}`) throw error(403, 'Forbidden origin');
        if (req.method === 'GET' && pathname === '/api/auth') {
          const accounts = await auth.listAccounts();
          auth.checkRenewals?.(accounts);
          return json(res, 200, { accounts, login: auth.getLogin() });
        }
        if (req.method === 'GET' && pathname === '/api/models') return json(res, 200, await auth.listModels());
        if (req.method === 'GET' && pathname === '/api/auth/providers') return json(res, 200, await auth.listProviders());
        if (pathname === '/api/agents' && req.method === 'GET') return json(res, 200, agentCatalog(configuration()));
        if (pathname === '/api/agents' && req.method === 'POST') {
          const body = await readBody(req), config = configuration();
          saveAgent(config, body.id, body, { create: true });
          return json(res, 201, { ok: true, agent: agentCatalog(configuration()).roles.find((r) => r.id === body.id) });
        }
        const agentRoute = /^\/api\/agents\/([^/]+)$/.exec(pathname);
        if (agentRoute && ['PATCH', 'DELETE'].includes(req.method)) {
          const id = validateAgentId(agentRoute[1]), config = configuration();
          if (req.method === 'DELETE') {
            if (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) await readBody(req);
            let workflow;
            try { workflow = normalizeWorkflow(config.workflow, config.roles.filter((r) => r.kind === 'gate').map((r) => r.id)); }
            catch { /* Invalid workflows must not prevent settings recovery. */ }
            if (!AGENT_IDS.includes(id) && workflow?.gates.some((stage) => stage.includes(id))) throw error(409, `Configured workflow still names gate: ${id}`);
            deleteAgent(config, id);
          }
          else saveAgent(config, id, await readBody(req));
          return json(res, 200, { ok: true, ...(req.method === 'PATCH' ? { agent: agentCatalog(configuration()).roles.find((r) => r.id === id) } : {}) });
        }
        const promptRoute = /^\/api\/agents\/([^/]+)\/prompt$/.exec(pathname);
        if (promptRoute && ['PUT', 'DELETE'].includes(req.method)) {
          const id = promptRoute[1], config = configuration();
          validateAgentId(id);
          if (!Object.hasOwn(config.agents, id)) throw error(404, 'Unknown agent');
          if (!resolvePrompt(config, id).editable) throw error(409, 'Prompt is pinned by configuration');
          const file = path.join(config.promptsDir, `${id}.md`);
          if (req.method === 'DELETE') {
            if (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) await readBody(req);
            fs.rmSync(file, { force: true });
          }
          else {
            const body = await readBody(req);
            if (Object.keys(body).some((k) => k !== 'text') || typeof body.text !== 'string' || !body.text.trim()) throw error(400, 'Expected non-empty prompt text');
            if (Buffer.byteLength(body.text) > 32768) throw error(413, 'Prompt exceeds 32 KiB');
            writeFileAtomicSync(file, body.text.trim() + '\n');
          }
          return json(res, 200, { ok: true });
        }
        const body = await readBody(req);
        const fields = { '/api/auth/key': ['provider', 'key'], '/api/providers': ['id', 'label', 'baseUrl', 'api', 'models', 'key'], '/api/providers/discover': ['baseUrl', 'api', 'key'], '/api/providers/remove': ['id'] }[pathname];
        if (fields && Object.keys(body).some((k) => !fields.includes(k))) throw error(400, 'Unexpected request field');
        if (pathname === '/api/auth/key') { await auth.setApiKey(body.provider, body.key); return json(res, 202, { ok: true }); }
        if (pathname === '/api/providers/discover') return json(res, 200, await auth.discoverModels(body));
        if (pathname === '/api/providers') { await auth.addProvider(body); return json(res, 202, { ok: true }); }
        if (pathname === '/api/providers/remove') { await auth.removeProvider(body.id); return json(res, 202, { ok: true }); }
        if (pathname === '/api/auth/login') return json(res, 202, auth.startLogin(body.provider));
        if (pathname === '/api/auth/login/open') {
          if (Object.keys(body).some((key) => key !== 'id')) throw error(400, 'Only a login session ID is accepted');
          await auth.openLogin(body.id);
          return json(res, 202, { ok: true });
        }
        if (pathname === '/api/auth/login/input') { auth.input(body.id, body.value); return json(res, 202, { ok: true }); }
        if (pathname === '/api/auth/login/cancel') { await auth.cancel(body.id); return json(res, 202, { ok: true }); }
        if (pathname === '/api/auth/logout') { await auth.logout(body.provider); return json(res, 202, { ok: true }); }
        if (pathname === '/api/runs') return json(res, 202, { ok: true, pid: await start(body) });
        if (pathname === '/api/runs/stop') { stop(); return json(res, 202, { ok: true }); }
        if (pathname === '/api/runs/release') {
          if (recovery) throw error(409, 'Recovery is already in progress. Try again in a moment.');
          if (active || closing || !body.runId || Object.keys(body).some((key) => key !== 'runId')) throw error(409, 'No matching orphan exists');
          const lease = readRunLease(hive);
          recoveryToken = lease ? `${lease.runId}:${lease.token}` : null;
          try {
            const warnings = await recoverOrphan(hive, body.runId, 'Released by the user', recoveryDocker);
            recoveryError = null;
            return json(res, 200, { ok: true, warnings });
          } catch (err) { if (err.status !== 409) recoveryError = err.message; throw err; }
        }
        if (pathname === '/api/chat') {
          if (!active || active.exited || body.runId !== active.info.runId) throw error(409, 'Run is not active');
          if (typeof body.to !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(body.to)) throw error(400, 'Invalid recipient');
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw error(400, 'Chat text must contain 1 to 4000 characters');
          const instances = snapshot().instances;
          const instance = Object.hasOwn(instances, body.to) ? instances[body.to] : null;
          if (!instance || !CHAT_RECIPIENT_STATES.has(instance.status)) throw error(409, 'Recipient is unknown or terminal');
          const dir = path.join(hive, 'control', 'chat');
          fs.mkdirSync(dir, { recursive: true });
          if (fs.readdirSync(dir).length >= 1000) throw error(429, 'Chat queue is full');
          const id = randomUUID();
          write(`control/chat/${id}.json`, { id, runId: active.info.runId, from: 'human', to: body.to, text: body.text });
          return json(res, 202, { ok: true, id, delivery: 'queued' });
        }
        const pending = snapshot().pendingHuman;
        if (!pending) throw error(409, 'No human answer is pending');
        if (!validDecision(body, pending.options)) throw error(400, 'Invalid decision or feedback');
        write('human/response.json', { runId: pending.runId, requestSeq: pending.requestSeq, decision: body.decision, ...(body.feedback !== undefined ? { feedback: body.feedback } : {}) });
        json(res, 202, { ok: true });
      } catch (err) { json(res, err.status ?? 500, { error: err.status ? err.message : 'Control operation failed' }); }
    },
    async close() {
      closing = true;
      const stopping = active ? stop(5000) : Promise.resolve();
      await Promise.all([closeAuth ? auth.close() : undefined, stopping, recovery]);
    }
  };
}

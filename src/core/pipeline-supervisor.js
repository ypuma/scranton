import fs from 'node:fs';
import { dreamingCap, pipelineDreamingCohort } from './dreaming-sources.js';
import { buildPipelineHistory } from './pipeline-history.js';
import { pipelineUsage, pipelineSteps } from './pipeline-activity.js';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCredentials, PROVIDER_ENV_NAMES } from './credentials/index.js';
import { models as llmModels } from './llm/index.js';
import { createModelWindows } from './model-windows.js';
import { validateId } from './projects.js';
import { writeFileAtomicSync, withFsRetry } from './util.js';
import { killTree } from './process-tree.js';
import { PACKAGE_ROOT, loadAgentsMd } from './config.js';
import { probePipeline, resolvePipelineCommand, execPipeline, spawnPipeline, pipelineChildEnv, probePipelineSandbox, probePipelineNative, unavailablePipelineNative } from './pipeline-command.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const terminal = new Set(['succeeded', 'failed', 'rejected', 'cancelled']);
const roles = ['planner', 'implementer', 'reviewer'];
const artifactPaths = { plan: 'artifacts/plan.json', diff: 'delivery/candidate.diff', report: 'delivery/report.md', 'report-json': 'delivery/report.json' };
const runStatus = (v) => object(v) && v.schema === 1 && typeof v.run_id === 'string' && ['running', 'awaiting_approval', 'suspended', ...terminal].includes(v.status);
const modelValue = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/^[-@]|[\x00-\x20\x7f]/.test(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function pipelineFields(value, allowed) {
  if (!object(value) || Object.keys(value).some((k) => !allowed.includes(k))) throw fail(400, 'Unexpected request field');
}
export function tokenizePipelineCommand(text) {
  if (typeof text !== 'string' || text.length > 8192 || /[\0\r\n]/.test(text)) throw fail(400, 'Invalid command');
  const argv = []; let token = '', quote = '', begun = false;
  for (const char of text) {
    if (quote) { if (char === quote) quote = ''; else token += char; begun = true; }
    else if (char === '"' || char === "'") { quote = char; begun = true; }
    else if (/\s/.test(char)) { if (begun) { argv.push(token); token = ''; begun = false; } }
    else { token += char; begun = true; }
  }
  if (quote) throw fail(400, 'Unclosed command quote');
  if (begun) argv.push(token);
  if (!argv.length || !argv[0] || argv.length > 64) throw fail(400, 'Command needs 1 to 64 tokens');
  return argv;
}
export function formatPipelineCommand(argv) {
  return argv.map((arg) => arg === '' ? '""' : /[\s"']/.test(arg) ? '"' + arg.replaceAll('"', "\"'\"'\"") + '"' : arg).join(' ');
}
const readJson = (file) => JSON.parse(withFsRetry(() => fs.readFileSync(file, 'utf8')));
const writeJson = (file, value) => writeFileAtomicSync(file, JSON.stringify(value, null, 2) + '\n');
const optional = (file) => { try { return readJson(file); } catch (e) { if (e.code === 'ENOENT') return null; throw fail(409, 'Unreadable Pipeline metadata'); } };

export function createPipelineSupervisor({ dataDir, env = process.env, auth, checkCapacity = () => {}, onStarting = () => {}, dreaming, context, agentsMd, cwd = PACKAGE_ROOT, flags = {}, modelWindows = createModelWindows() } = {}) {
  const children = new Map(), starting = new Set(), diagnostics = new Map(), secrets = new Set(), normalizing = new Map();
  let closing = false, sandboxProbe = null, buildEntry = null, buildStarting = false;
  const sandboxFlights = new Map(), probeStop = new AbortController();
  let nativeProbe = null, nativeFlight = null;
  const build = { state: 'idle', startedAt: null, finishedAt: null, tail: '' };
  const workspaceRoot = path.resolve(env.SCRANTON_PIPELINE_WORKSPACE_ROOT || (process.platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Scranton', 'pipeline') : path.join(dataDir, 'pipeline-workspaces')));
  const scrub = (value) => {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const key of secrets) text = text.split(key).join('[REDACTED]');
    return typeof value === 'string' ? text : JSON.parse(text);
  };
  function root(chat) {
    const target = path.join(dataDir, 'projects', validateId(chat.projectId), 'chats', validateId(chat.id), 'pipeline');
    if (fs.existsSync(dataDir)) safe(dataDir, path.relative(dataDir, target), false);
    return target;
  }
  function safe(base, rel, exists = true) {
    const target = path.resolve(base, rel);
    const realBase = fs.realpathSync(base);
    let parent = target;
    while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
    const real = fs.realpathSync(parent);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) throw fail(403, 'Forbidden Pipeline path');
    if (exists && !fs.existsSync(target)) throw fail(404, 'Pipeline artifact not found');
    return target;
  }
  function dir(chat, id) {
    if (!/^[a-z0-9]{8,32}$/.test(id)) throw fail(400, 'Invalid Pipeline run ID');
    const base = root(chat);
    if (!fs.existsSync(base)) throw fail(404, 'Pipeline run not found');
    return safe(base, `runs/${id}`, false);
  }
  function statuses(chat) {
    const base = root(chat), runRoot = path.join(base, 'runs');
    const ids = new Set();
    if (fs.existsSync(runRoot)) { safe(base, 'runs'); for (const id of fs.readdirSync(runRoot)) if (/^[a-z0-9]{8,32}$/.test(id)) ids.add(id); }
    const requests = path.join(base, 'requests');
    if (fs.existsSync(requests)) { safe(base, 'requests'); for (const file of fs.readdirSync(requests)) if (/^[a-z0-9]{8,32}\.error\.json$/.test(file)) ids.add(file.split('.')[0]); }
    return [...ids].flatMap((id) => {
      const runDir = dir(chat, id), s = fs.existsSync(runDir) ? optional(safe(runDir, 'status.json', false)) : null;
      const error = optional(safe(base, `requests/${id}.error.json`, false));
      const meta = error && optional(safe(base, `requests/${id}.json.launch.json`, false));
      return s ? [{ ...s, run_id: id }] : error ? [{ run_id: id, status: 'failed', phase: 'done', task: meta?.task ?? '', created_at: meta?.createdAt ?? '', updated_at: meta?.createdAt ?? '' }] : [];
    }).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  function list(chat) {
    const values = statuses(chat);
    return { active: values.find((s) => !terminal.has(s.status))?.run_id ?? null, runs: values.map((s) => {
      const row = { runId: s.run_id, status: s.status, phase: s.phase, task: scrub(s.task), createdAt: s.created_at, updatedAt: s.updated_at, usage: s.usage ? { tokens: (s.usage.input_tokens ?? 0) + (s.usage.output_tokens ?? 0), cost: s.usage.estimated_cost ?? null, ...(typeof s.usage.estimated_cost === 'number' ? { estimated: true } : {}) } : null };
      if (s.reply) {
        const text = scrub(s.reply.text);
        row.reply = { kind: s.reply.kind, text: text.slice(0, 4000), truncated: s.reply.truncated === true || text.length > 4000, citations: scrub(s.reply.citations) };
      }
      return row;
    }) };
  }
  const busy = (chat) => starting.has(root(chat)) || [...children.values()].some((c) => c.chatKey === root(chat)) || Boolean(list(chat).active);
  function snapshot(chat) {
    const all = list(chat), last = all.runs.at(-1);
    return { run: [...children.values()].find((c) => c.chatKey === root(chat)) ? { runId: all.active } : null, pendingHuman: last?.status === 'awaiting_approval' ? { runId: last.runId } : null, last };
  }
  async function available() {
    const result = await probePipeline({ env });
    if (!result.available) throw fail(503, `Pipeline engine is not available: ${result.reason}`);
    return resolvePipelineCommand({ env });
  }
  let credentialService;
  const ownCredentials = () => credentialService ??= createCredentials({ env });
  const accountsService = () => auth ?? ownCredentials();
  async function modelCatalog() {
    const service = await accountsService(), accounts = await service.listAccounts();
    const custom = service.store?.read().providers ?? (accounts.some((a) => a.custom) ? (await ownCredentials()).store.read().providers : {});
    return accounts.map((a) => {
      const definition = custom[a.id];
      const baseUrl = definition?.api === 'openai-completions' ? definition.baseUrl : a.id === 'openai' ? 'https://api.openai.com/v1' : null;
      const models = definition?.models ?? llmModels.filter((m) => m.provider === a.id);
      const via = a.kind === 'api_key' && a.status === 'signed_in' && baseUrl ? 'direct' : 'bridge';
      const reason = a.status !== 'signed_in' ? 'Provider credentials are not available' : models.length ? null : 'No available Scranton models';
      return { provider: a.id, label: a.label ?? a.id, supported: !reason, reason, via, models: models.map((m) => ({ id: m.id, label: m.name ?? m.id })), baseUrl };
    });
  }
  const sandboxText = (text) => {
    for (const [name, value] of Object.entries(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^SCRANTON_PROVIDER_.*_KEY$/i.test(name) && value) text = text.split(value).join('[REDACTED]');
    return scrub(text).replace(/\bBearer\s+\S+|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]').replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  };
  const buildTail = () => Buffer.from(sandboxText(build.tail)).subarray(-8192).toString('utf8').replace(/^\uFFFD+/, '');
  async function sandboxStatus({ image, fresh = false } = {}) {
    if (!image && !fresh && sandboxProbe && Date.now() - sandboxProbe.at < 3000) return sandboxProbe.value;
    const key = image ?? '';
    if (sandboxFlights.has(key)) return !image && !fresh && sandboxProbe ? sandboxProbe.value : sandboxFlights.get(key);
    const pending = (async () => {
      let spec; try { spec = await available(); } catch { return { default_image: null, docker: { available: false, version: null, reason: 'Pipeline engine is not available' }, image: { name: image ?? null, present: false } }; }
      const result = await probePipelineSandbox(spec, { env, image, signal: probeStop.signal });
      result.docker.reason = result.docker.reason ? sandboxText(result.docker.reason) : result.docker.available ? null : 'Docker is not available';
      return result;
    })().then((value) => { if (!image) sandboxProbe = { at: Date.now(), value }; return value; }).finally(() => sandboxFlights.delete(key));
    sandboxFlights.set(key, pending);
    return !image && !fresh && sandboxProbe ? sandboxProbe.value : pending;
  }
  async function nativeStatus(spec, windowsMode) {
    const native = await probePipelineNative(spec, { env, windowsMode, signal: probeStop.signal });
    for (const p of [native, ...Object.values(native.modes)]) if (p.reason) p.reason = sandboxText(p.reason);
    return native;
  }
  function nativeCapability(spec) {
    if (nativeProbe && Date.now() - nativeProbe.at < 3000) return nativeProbe.value;
    return nativeFlight ??= nativeStatus(spec).then((value) => {
      nativeProbe = { at: Date.now(), value };
      return value;
    }).finally(() => { nativeFlight = null; });
  }
  async function capability() {
    const engine = await probePipeline({ env });
    // Docker may take up to 45 s. Refresh it without holding up the native response.
    if (engine.available && !closing) void sandboxStatus();
    const [native, catalog] = await Promise.all([
      engine.available ? nativeCapability(resolvePipelineCommand({ env })) : unavailablePipelineNative('Pipeline engine is not available'),
      modelCatalog(),
    ]);
    const sandbox = sandboxProbe?.value ?? {
      default_image: null,
      docker: { available: false, version: null, reason: engine.available ? 'Checking Docker availability' : 'Pipeline engine is not available', ...(engine.available ? { pending: true } : {}) },
      image: { name: null, present: false },
    };
    return { ...engine, sandbox: { native, dockerImage: sandbox.default_image, docker: sandbox.docker, image: sandbox.image, build: { ...build, tail: buildTail() } }, models: catalog.map(({ baseUrl, ...m }) => m) };
  }
  async function buildSandbox(body) {
    pipelineFields(body, []);
    if (closing) throw fail(409, 'Server is closing');
    if (buildStarting || buildEntry) throw fail(409, 'Pipeline sandbox build is already running');
    buildStarting = true;
    try {
      const spec = await available(), sandbox = await sandboxStatus({ fresh: true });
      if (!sandbox.docker.available) throw fail(503, `Docker is not available: ${sandbox.docker.reason}`);
      if (closing) throw fail(409, 'Server is closing');
      const child = spawnPipeline(spec, ['sandbox', 'build'], pipelineChildEnv(env));
      Object.assign(build, { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, tail: '' });
      const entry = { child, stdout: '' }; buildEntry = entry;
      child.stdin.on('error', () => {});
      const output = (d) => { build.tail = Buffer.from(build.tail + String(d)).subarray(-8192).toString('utf8'); };
      child.stderr.on('data', output);
      child.stdout.on('data', (d) => { entry.stdout = (entry.stdout + d).slice(-8192); output(d); });
      child.on('error', () => { build.tail = 'Pipeline sandbox build could not start'; });
      entry.done = new Promise((resolve) => child.on('close', (code) => {
        let value; try { value = JSON.parse(entry.stdout.trim()); } catch {}
        build.state = code === 0 && value?.built === true ? 'succeeded' : 'failed';
        build.finishedAt = new Date().toISOString(); build.tail = buildTail();
        buildEntry = null; sandboxProbe = null; resolve();
      }));
      return { ok: true };
    } finally { buildStarting = false; }
  }
  async function credentials(choices) {
    const catalog = await modelCatalog(), models = {}, extra = {};
    pipelineFields(choices, roles);
    for (const role of roles) {
      const choice = choices[role]; pipelineFields(choice, ['provider', 'model']);
      const p = catalog.find((p) => p.provider === choice.provider && p.supported);
      if (!modelValue(choice.provider) || !modelValue(choice.model)) throw fail(400, `models.${role}: Invalid provider or model`);
      if (!p || !p.models.some((m) => m.id === choice.model)) throw fail(400, 'Unsupported Pipeline model selection');
      if (p.via === 'bridge') {
        for (const name of PROVIDER_ENV_NAMES[choice.provider] ?? []) {
          if (env[name]) { extra[name] = env[name]; secrets.add(env[name]); }
        }
        models[role] = { provider: 'command', model: choice.model, command: [process.execPath, path.join(PACKAGE_ROOT, 'tools/pipeline-complete.js'), '--provider', choice.provider, '--model', choice.model], structured_output: 'json_text' };
        continue;
      }
      let credential;
      try {
        const service = auth?.resolveAuth ? auth : await ownCredentials();
        credential = { value: (await service.resolveAuth(choice.provider)).key };
        if (typeof credential.value !== 'string' || !credential.value) throw Error();
      }
      catch { throw fail(400, 'Pipeline API key is not available'); }
      secrets.add(credential.value);
      const name = `SCRANTON_PIPELINE_KEY_${role.toUpperCase()}`;
      extra[name] = credential.value;
      models[role] = { provider: 'openai_compatible', model: choice.model, base_url: p.baseUrl, api_key_env: name };
    }
    return { models, extra };
  }
  async function config(spec, body) {
    pipelineFields(body, ['task', 'demo', 'demoScenario', 'delivery', 'sandbox', 'checks', 'setup', 'models', 'approvals', 'review', 'replans', 'parallelSteps', 'grounding', 'guidance', 'conversation']);
    if (typeof body.task !== 'string' || !body.task.trim() || Buffer.byteLength(body.task) > 32768 || body.task.includes('\0')) throw fail(400, 'Task needs 1 to 32768 bytes');
    if (body.demo !== undefined && typeof body.demo !== 'boolean') throw fail(400, 'Invalid demo');
    if (body.delivery !== undefined && !['apply', 'patch'].includes(body.delivery)) throw fail(400, 'Invalid delivery');
    for (const [field, min, max] of [['replans', 0, 3], ['parallelSteps', 1, 4]]) if (body[field] !== undefined && (!Number.isInteger(body[field]) || body[field] < min || body[field] > max)) throw fail(400, `${field}: Expected integer from ${min} to ${max}`);
    if (body.demoScenario !== undefined && (body.demo !== true || !['basic', 'replan', 'parallel', 'evidence', 'answer'].includes(body.demoScenario))) throw fail(400, 'demoScenario: Expected basic, replan, parallel, evidence or answer with demo:true');
    if (body.grounding !== undefined && !['enforce', 'observe'].includes(body.grounding)) throw fail(400, 'grounding: Expected enforce or observe');
    if (body.demoScenario === 'evidence' && body.grounding === 'observe') throw fail(400, 'grounding: The evidence demo needs enforce');
    if (body.guidance !== undefined && typeof body.guidance !== 'boolean') throw fail(400, 'guidance: Expected boolean');
    if (body.conversation !== undefined && typeof body.conversation !== 'boolean') throw fail(400, 'conversation: Expected boolean');
    const settings = { agentsMd: agentsMd ?? loadAgentsMd({ cwd, env, flags }), ...(body.conversation === true ? { conversation: true } : {}), ...(body.grounding === undefined ? {} : { grounding: { mode: body.grounding } }), ...(body.guidance === undefined ? {} : { procedure: { enabled: body.guidance } }) };
    const sandbox = body.sandbox === undefined ? { mode: 'scranton' } : body.sandbox;
    pipelineFields(sandbox, ['mode', 'image', 'trustHost', 'windowsMode']);
    if (!['scranton', 'docker', 'host'].includes(sandbox.mode)) throw fail(400, 'Invalid sandbox mode');
    if (sandbox.trustHost !== undefined && (sandbox.mode !== 'host' || typeof sandbox.trustHost !== 'boolean')) throw fail(400, 'Invalid sandbox.trustHost (host only)');
    if (sandbox.image !== undefined && (sandbox.mode !== 'docker' || typeof sandbox.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(sandbox.image))) throw fail(400, 'Invalid sandbox image (docker only)');
    if (sandbox.windowsMode !== undefined && (sandbox.mode !== 'scranton' || !['low', 'strict'].includes(sandbox.windowsMode))) throw fail(400, 'Invalid sandbox.windowsMode (scranton only; expected low or strict)');
    const windowsMode = sandbox.windowsMode ?? 'low', trustHost = sandbox.trustHost === true;
    if (!body.demo && sandbox.mode === 'host' && !trustHost) throw fail(409, 'Host mode requires trustHost:true');
    function validateSetupNetwork(setup) {
      if (sandbox.mode !== 'scranton' || windowsMode !== 'strict' || !Array.isArray(setup)) return;
      const row = setup.findIndex((v) => v?.network === true);
      if (row >= 0) throw fail(400, `setup[${row}].network: Scranton sandbox strict mode does not allow network access`);
    }
    async function nativeMode({ demoDefault = false } = {}) {
      if (sandbox.mode !== 'scranton') return sandbox.mode;
      const { modes } = await nativeStatus(spec, windowsMode);
      if (modes[windowsMode].available) return 'scranton';
      if (demoDefault) return 'host';
      throw fail(409, `Scranton sandbox (${windowsMode}) is not available: ${modes[windowsMode].reason}`);
    }
    async function dockerImage() {
      if (sandbox.mode !== 'docker') return undefined;
      const probe = await sandboxStatus({ image: sandbox.image, fresh: true });
      if (!probe.docker.available) throw fail(409, `Docker daemon is not available: ${probe.docker.reason}`);
      const image = sandbox.image ?? probe.default_image;
      if (!probe.image.present) throw fail(409, `Docker image is missing: ${image}. Build the sandbox image first`);
      return image;
    }
    if (body.demo) {
      validateSetupNetwork(body.setup);
      const mode = await nativeMode({ demoDefault: body.sandbox === undefined });
      return { extra: {}, operator: null, settings, trustHost, demoScenario: body.demoScenario ?? 'basic', sandbox: mode, windowsMode: mode === 'scranton' ? windowsMode : undefined, image: await dockerImage() };
    }
    const commands = (values, setup) => {
      if (!Array.isArray(values) || values.length > (setup ? 4 : 12)) throw fail(400, `${setup ? 'setup' : 'checks'}: Expected an array of at most ${setup ? 4 : 12} commands`);
      const ids = new Set();
      return values.map((v, row) => {
        const field = `${setup ? 'setup' : 'checks'}[${row}]`;
        const bad = (name, message) => { throw fail(400, `${field}.${name}: ${message}`); };
        if (!object(v)) bad('id', 'Expected command object');
        const allowed = setup ? ['id', 'command', 'timeoutSec', 'network'] : ['id', 'kind', 'command', 'timeoutSec', 'required', 'scope'];
        for (const name of Object.keys(v)) if (!allowed.includes(name)) bad(name, 'Unexpected field');
        if (typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.id) || ids.has(v.id)) bad('id', 'Expected unique ID matching ^[A-Za-z0-9_-]{1,64}$');
        ids.add(v.id);
        if (v.timeoutSec !== undefined && (!Number.isInteger(v.timeoutSec) || v.timeoutSec < 1 || v.timeoutSec > 3600)) bad('timeoutSec', 'Expected integer from 1 to 3600');
        for (const name of setup ? ['network'] : ['required']) if (v[name] !== undefined && typeof v[name] !== 'boolean') bad(name, 'Expected boolean');
        if (!setup && !['syntax', 'lint', 'typecheck', 'test', 'security', 'other'].includes(v.kind)) bad('kind', 'Invalid check kind');
        if (!setup && v.scope !== undefined && !['step', 'final'].includes(v.scope)) bad('scope', 'Invalid check scope');
        let argv; try { argv = tokenizePipelineCommand(v.command); } catch (e) { bad('command', e.message); }
        return { id: v.id, argv, timeout_s: v.timeoutSec ?? 600, ...(setup ? { network: v.network ?? false } : { kind: v.kind, required: v.required ?? true, scope: v.scope ?? 'step' }) };
      });
    };
    const checks = commands(body.checks ?? [], false), setup = commands(body.setup ?? [], true);
    validateSetupNetwork(setup);
    if (body.approvals !== undefined) { pipelineFields(body.approvals, ['plan']); if (!['always', 'auto_low_risk'].includes(body.approvals.plan)) throw fail(400, 'Invalid approval policy'); }
    if (body.review !== undefined && typeof body.review !== 'boolean') throw fail(400, 'Invalid review');
    const { models, extra } = await credentials(body.models);
    await nativeMode();
    const image = await dockerImage();
    const operator = { schema: 1, ...settings, models, limits: { max_replans: body.replans ?? 1 }, execution: { max_parallel_steps: body.parallelSteps ?? 1 }, sandbox: { mode: sandbox.mode, ...(sandbox.mode === 'docker' ? { docker: { image } } : sandbox.mode === 'scranton' ? { windows_mode: windowsMode } : {}) }, checks, setup, ...(checks.length ? {} : { allow_no_checks: true }), approvals: body.approvals ?? { plan: 'always' }, review: { enabled: body.review ?? true } };
    if (scrub(JSON.stringify(operator)) !== JSON.stringify(operator)) throw fail(400, 'Configuration must not contain credentials');
    return { operator, extra, trustHost };
  }
  async function normalize(runDir) {
    if (children.has(runDir) || children.has(runDir + ':cancel')) return;
    const s = optional(safe(runDir, 'status.json', false));
    if (!s) return;
    const cancelErrorFile = safe(runDir, 'cancel.error.json', false);
    if (terminal.has(s.status)) { fs.rmSync(cancelErrorFile, { force: true }); return; }
    // An owner can publish a gate after its last cancel check; finish the durable request once it exits.
    const cancelling = fs.existsSync(safe(runDir, 'cancel.requested', false));
    if (!cancelling && s.status !== 'running') return;
    // Failed cancellation requires an explicit retry, including after a server restart.
    if (cancelling && fs.existsSync(cancelErrorFile)) return;
    if (!normalizing.has(runDir)) normalizing.set(runDir, (async () => {
      try {
        const spec = await available();
        const r = await execPipeline(spec, [cancelling ? 'cancel' : 'status', '--run-dir', runDir], { env });
        if (r.error || !runStatus(r.value)) throw fail(503, r.error ?? ([r.value?.failure?.code, r.value?.failure?.message].filter(Boolean).join(': ') || 'Could not inspect Pipeline owner'));
      } catch (e) {
        if (!cancelling) throw e;
        writeJson(cancelErrorFile, { message: `Cancellation could not complete: ${sandboxText(String(e.message)).slice(-8192)}. Resolve the engine error, then cancel again to retry.`, failedAt: new Date().toISOString() });
      }
    })().finally(() => normalizing.delete(runDir)));
    await normalizing.get(runDir);
  }
  function launch(spec, args, runDir, chat, extra, observedDir = runDir) {
    if (closing) throw fail(409, 'Server is closing');
    const errorFile = safe(root(chat), `requests/${path.basename(observedDir)}.error.json`, false);
    const before = fs.existsSync(observedDir) ? optional(safe(observedDir, 'status.json', false)) : null;
    const child = spawnPipeline(spec, [...args, '--parent-guard'], { ...pipelineChildEnv(env), ...extra });
    const entry = { child, chatKey: root(chat), tail: '', stdout: '' };
    children.set(runDir, entry);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => { entry.stdout = (entry.stdout + d).slice(-1024 * 1024); });
    child.stderr.on('data', (d) => { entry.tail = (entry.tail + scrub(String(d))).slice(-8192); });
    child.on('error', () => { entry.tail = 'Pipeline process could not start'; });
    entry.done = new Promise((resolve) => child.on('close', async (code) => {
      try {
        let value = null; try { value = JSON.parse(entry.stdout.trim()); } catch {}
        const after = fs.existsSync(observedDir) ? optional(safe(observedDir, 'status.json', false)) : null;
        if (runStatus(value) || after && JSON.stringify(after) !== JSON.stringify(before)) fs.rmSync(errorFile, { force: true });
        else writeJson(errorFile, scrub({ code, message: String(value?.failure?.message ?? entry.tail ?? '').trim().slice(-8192) || `Pipeline invocation exited ${code ?? 'without a code'}` }));
        children.delete(runDir); diagnostics.set(runDir, entry.tail);
        try { await normalize(observedDir); } catch { diagnostics.set(runDir, entry.tail + '\nCould not normalize Pipeline status'); }
      } catch { diagnostics.set(runDir, 'Could not record Pipeline invocation result'); }
      finally { children.delete(runDir); resolve(); }
    }));
    return entry;
  }
  async function start(project, chat, body) {
    const key = root(chat);
    try { Promise.resolve(dreaming?.(chat.projectId)?.cancelReflection?.()).catch(() => {}); } catch {}
    if (busy(chat)) throw fail(409, 'Chat has a non-terminal Pipeline run');
    starting.add(key);
    try {
      const spec = await available(), cfg = await config(spec, body);
      let projectMemory = [], dreamingWarning = null;
      if (!body.demo && dreaming && cfg.operator) {
        const ceiling = cfg.operator.limits.max_step_attempts ?? 3;
        const cohort = pipelineDreamingCohort(cfg.operator);
        try {
          const dream = dreaming(chat.projectId);
          const memory = dream?.structuredContext() ?? [];
          const cap = dreamingCap(dream, 'pipeline', ceiling, cohort);
          projectMemory = memory;
          if (cap < ceiling) cfg.operator.limits.max_step_attempts = cap;
        } catch { dreamingWarning = 'Optional Dreaming unavailable; using configured retry ceiling without project memory'; }
      }
      const planner = body.demo ? null : await modelWindows.resolve(body.models.planner);
      if (closing) throw fail(409, 'Server is closing');
      checkCapacity();
      const runId = randomBytes(6).toString('hex'), runRoot = path.join(key, 'runs'), runDir = path.join(runRoot, runId);
      fs.mkdirSync(key, { recursive: true }); safe(path.dirname(key), 'pipeline');
      safe(key, 'runs', false); fs.mkdirSync(runRoot, { recursive: true });
      const request = path.join(key, 'requests', `${runId}.json`);
      safe(key, 'requests', false);
      if (cfg.operator) writeJson(request, cfg.operator);
      writeJson(request + '.launch.json', { models: body.demo ? null : body.models, trustHost: cfg.trustHost, demo: Boolean(body.demo), workspaceRoot, task: body.task, createdAt: new Date().toISOString() });
      const args = [body.demo ? 'demo' : 'run', '--run-root', runRoot, '--run-id', runId, '--workspace-root', workspaceRoot, '--delivery', body.delivery ?? 'apply'];
      if (body.demo) { args.push('--scenario', cfg.demoScenario, '--sandbox', cfg.sandbox); if (cfg.image) args.push('--image', cfg.image); if (cfg.windowsMode) args.push('--windows-mode', cfg.windowsMode); if (cfg.settings.grounding) args.push('--grounding', cfg.settings.grounding.mode); if (cfg.settings.procedure) args.push('--guidance', String(cfg.settings.procedure.enabled)); if (cfg.settings.conversation) args.push('--conversation'); }
      if (!body.demo) { const taskFile = request + '.task.txt'; writeFileAtomicSync(taskFile, body.task); args.push('--source', project.workspace, '--task-file', taskFile, '--config', request); if (cfg.trustHost) args.push('--trust-host'); }
      if (!body.demo) {
        const history = context ? context.forPipeline(chat.projectId, chat.id, { redact: sandboxText, projectMemory, recipients: { planner } })
          : buildPipelineHistory({ dataDir, projectId: chat.projectId, chatId: chat.id, redact: sandboxText, projectMemory });
        if (history) {
          const historyFile = path.join(key, 'requests', `${runId}.history.json`);
          writeFileAtomicSync(historyFile, JSON.stringify(history));
          args.push('--history-file', historyFile);
        }
      }
      try { Promise.resolve(dreaming?.(chat.projectId)?.cancelReflection?.()).catch(() => {}); } catch {}
      onStarting(chat, body.task);
      launch(spec, args, runDir, chat, cfg.extra);
      return { ok: true, runId, ...(dreamingWarning ? { dreamingWarning } : {}) };
    } finally { starting.delete(key); }
  }
  async function inspect(chat, id, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw fail(400, 'Invalid event sequence');
    const runDir = dir(chat, id);
    const launchError = optional(safe(root(chat), `requests/${id}.error.json`, false));
    if (!fs.existsSync(runDir) && launchError) return scrub({ status: null, live: false, usage: null, stepsDone: [], stepsDoneExact: false, launchError, events: [], lastSeq: after, plan: null, review: null, stderrTail: '' });
    if (!fs.existsSync(runDir)) throw fail(404, 'Pipeline status not found');
    await normalize(runDir);
    const status = optional(safe(runDir, 'status.json', false));
    if (!status) throw fail(404, 'Pipeline status not found');
    const file = safe(runDir, 'events.jsonl', false), events = [], activity = [], calls = [];
    let skippedEvents = 0;
    if (fs.existsSync(file)) {
      // Stream from disk; only retain the requested page, not the whole journal.
      let pending = '', dropping = false;
      const maxLine = 1024 * 1024;
      for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
        let text = chunk;
        if (dropping) {
          const end = text.indexOf('\n');
          if (end < 0) continue;
          text = text.slice(end + 1); dropping = false;
        }
        pending += text;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (line.length > maxLine) { skippedEvents++; continue; }
          try {
            const e = JSON.parse(line);
            if (!object(e)) { skippedEvents++; continue; }
            if (Number.isSafeInteger(e.seq) && e.seq > after && events.length < 500) events.push(e);
            if (['procedure', 'llm_call', 'wave_merged', 'replanned', 'route'].includes(e.type)) activity.push(e);
            if (e.type === 'llm_call') calls.push({ ...e.data, ts: e.ts });
          } catch { skippedEvents++; }
        }
        if (pending.length > maxLine) { skippedEvents++; pending = ''; dropping = true; }
      }
    }
    const readObject = (rel) => { const f = safe(runDir, rel, false); if (!fs.existsSync(f)) return null; if (fs.statSync(f).size > 1024 * 1024) return null; return optional(f); };
    let ledger = [];
    const ledgerFile = safe(runDir, 'usage.jsonl', false);
    if (fs.existsSync(ledgerFile) && fs.statSync(ledgerFile).size <= 1024 * 1024) ledger = fs.readFileSync(ledgerFile, 'utf8').split('\n').flatMap(line => { try { const row = JSON.parse(line); return object(row) ? [row] : []; } catch { return []; } });
    const plan = readObject('artifacts/plan.json');
    const usage = pipelineUsage(status, calls, ledger);
    const steps = pipelineSteps(status, activity, plan, readObject('delivery/report.json'));
    let review = null;
    const artifacts = safe(runDir, 'artifacts', false);
    if (fs.existsSync(artifacts)) { const names = fs.readdirSync(artifacts).filter((n) => /^review-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])); if (names.length) review = readObject(`artifacts/${names.at(-1)}`); }
    return scrub({ status, usage, ...steps, cancelError: terminal.has(status.status) ? null : readObject('cancel.error.json'), launchError: optional(safe(root(chat), `requests/${id}.error.json`, false)), live: children.has(runDir), events, lastSeq: events.at(-1)?.seq ?? after, plan, review, stderrTail: [children.get(runDir)?.tail ?? diagnostics.get(runDir) ?? '', ...(skippedEvents ? [`Skipped ${skippedEvents} malformed or oversized Pipeline event lines`] : [])].filter(Boolean).join('\n') });
  }
  async function action(chat, id, action, body) {
    try { Promise.resolve(dreaming?.(chat.projectId)?.cancelReflection?.()).catch(() => {}); } catch {}
    pipelineFields(body, action === 'decision' ? ['gate', 'decision', 'digest', 'comment'] : []);
    const runDir = dir(chat, id); await normalize(runDir);
    let status = optional(safe(runDir, 'status.json'));
    if (action === 'decision') {
      if (!['plan', 'delivery'].includes(body.gate) || !['approve', 'reject'].includes(body.decision) || typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest) || body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 4000 || body.comment.includes('\0'))) throw fail(400, 'Invalid Pipeline decision');
      if (status.status !== 'awaiting_approval' || status.pending?.gate !== body.gate || status.pending?.digest !== body.digest) throw fail(409, 'Pipeline gate or digest is stale');
    } else if (action === 'resume' ? status.status !== 'suspended' : terminal.has(status.status)) throw fail(409, 'Pipeline run cannot perform this action');
    if (action !== 'cancel' && children.has(runDir)) throw fail(409, 'Pipeline process is active');
    const key = root(chat);
    if (starting.has(key)) throw fail(409, 'Pipeline operation is starting');
    starting.add(key);
    try {
      const spec = await available();
      const meta = optional(safe(root(chat), `requests/${id}.json.launch.json`));
      const extra = action === 'cancel' || !meta.models ? {} : (await credentials(meta.models)).extra;
      if (closing) throw fail(409, 'Server is closing');
      if (action !== 'cancel') checkCapacity();
      const current = children.get(runDir);
      if (action === 'cancel' && current) {
        // The owner's lock stays held: cancel is a separate short sentinel-writing invocation.
        const cancelKey = runDir + ':cancel';
        if (children.has(cancelKey)) throw fail(409, 'Cancellation is already in progress');
        launch(spec, ['cancel', '--run-dir', runDir], cancelKey, chat, {}, runDir);
      } else {
        const args = [action === 'cancel' ? 'cancel' : 'resume', '--run-dir', runDir];
        if (meta.trustHost && action !== 'cancel') args.push('--trust-host');
        if (action === 'decision') { for (const name of ['gate', 'decision', 'digest', 'comment']) if (body[name] !== undefined) args.push(`--${name}=${body[name]}`); }
        launch(spec, args, runDir, chat, extra);
      }
      return { ok: true };
    } finally { starting.delete(key); }
  }
  function artifact(chat, id, name) {
    if (!Object.hasOwn(artifactPaths, name)) throw fail(404, 'Unknown Pipeline artifact');
    const runDir = dir(chat, id);
    const rel = name === 'diff' ? optional(safe(runDir, 'status.json'))?.artifacts?.diff : artifactPaths[name];
    if (typeof rel !== 'string' || !rel) throw fail(404, 'Pipeline artifact not found');
    const file = safe(runDir, rel);
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(1024 * 1024); const count = fs.readSync(fd, buf, 0, buf.length, 0); return { name, content: scrub(buf.subarray(0, count).toString('utf8')), truncated: fs.fstatSync(fd).size > count }; }
    finally { fs.closeSync(fd); }
  }
  function remove(chat) {
    if (busy(chat)) throw fail(409, 'Chat has a non-terminal Pipeline run');
    for (const s of statuses(chat)) {
      const meta = optional(safe(root(chat), `requests/${s.run_id}.json.launch.json`, false));
      if (meta?.workspaceRoot && path.resolve(meta.workspaceRoot) === workspaceRoot) {
        if (fs.existsSync(workspaceRoot)) {
          const target = safe(workspaceRoot, s.run_id, false);
          const allocation = safe(workspaceRoot, `.scranton-sandbox-allocation-${s.run_id}.json`, false);
          withFsRetry(() => fs.rmSync(target, { recursive: true, force: true }));
          withFsRetry(() => fs.rmSync(allocation, { force: true }));
        }
      }
    }
    withFsRetry(() => fs.rmSync(root(chat), { recursive: true, force: true }));
  }
  return { capability, buildSandbox, list, busy, snapshot, start, inspect, action, artifact, remove, get liveCount() { return children.size; },
    async detect(project, body) { pipelineFields(body, []); const spec = await available(); const r = await execPipeline(spec, ['detect', '--source', project.workspace], { env }); if (r.code !== 0 || !r.value) throw fail(503, 'Pipeline detection failed'); return { git: r.value.git, languages: r.value.languages, ...Object.fromEntries(['checks', 'setup'].map((name) => [name, (r.value[name] ?? []).map(({ argv, ...v }) => ({ ...v, command: formatPipelineCommand(argv) }))])) }; },
    async close() {
      closing = true;
      probeStop.abort();
      await Promise.allSettled([...sandboxFlights.values(), nativeFlight]);
      if (credentialService) await (await credentialService).close();
      const buildClosing = buildEntry;
      if (buildClosing) await killTree(buildClosing.child);
      await buildClosing?.done;
      await Promise.all([...children.values()].map(async (entry) => {
        entry.child.stdin.end();
        const timer = setTimeout(() => { void killTree(entry.child); }, 5000);
        try { await entry.done; } finally { clearTimeout(timer); }
      }));
    }
  };
}

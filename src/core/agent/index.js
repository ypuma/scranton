import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createDurableRuntime } from '../durable/index.js';
import { createLLM } from '../llm/index.js';
import { createCredentials } from '../credentials/index.js';
import { createAgentScript } from './scripted.js';
import { agentHiveScopePrefix } from './identity.js';
export { agentHiveScopePrefix } from './identity.js';
import { selectModel } from './model.js';
import { errorText } from '../redact.js';
import { runAgentWorkflow, definitionsFor } from './workflow.js';

export { AUTOMATIC_MODELS, selectModel } from './model.js';
export { describeTool } from './workflow.js';
const registrations = new WeakMap(), owned = new Map(), invocations = new Map();
const AGENT_MESSAGE = 'Your Hive inbox message is attached. Do the work it describes and end your final message with exactly one status keyword on its own line, as your role instructions require.';
const directory = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = 'scranton.agent.v1';

export function agentWorkflowId({ projectId, chatId, hiveDir, hive, runId = 'single', instanceId = 'agent', invocationKey = 'default' } = {}) {
  const directory = hive?.dir ?? hiveDir;
  const prefix = projectId !== undefined && chatId !== undefined || !directory
    ? `scr:${[projectId ?? 'single', chatId ?? 'hive'].map(v => encodeURIComponent(String(v))).join('/')}/`
    : agentHiveScopePrefix(directory);
  return prefix + [runId, instanceId, invocationKey].map(v => encodeURIComponent(String(v))).join('/');
}
export async function agentAppVersion() {
  const pkg = JSON.parse(await fs.readFile(path.join(directory, '../../../package.json'), 'utf8'));
  const sources = await Promise.all((await fs.readdir(directory)).filter(n => n.endsWith('.js')).sort().map(n => fs.readFile(path.join(directory, n))));
  return `${pkg.version}-${createHash('sha256').update(Buffer.concat(sources)).digest('hex').slice(0, 16)}`;
}

export function registerAgentWorkflow(runtime, defaults = {}) {
  if (registrations.has(runtime)) return registrations.get(runtime);
  const bindings = new Map();
  let credentials;
  const getCredentials = () => defaults.credentials ? Promise.resolve(defaults.credentials) : credentials ??= createCredentials();
  const registration = { bindings, getCredentials, jobs: new Map(), close: async () => { if (credentials) await (await credentials).close(); } };
  runtime.registerWorkflow(WORKFLOW, async (wf, input) => {
    const binding = bindings.get(wf.workflowId) ?? {};
    const controller = binding.controller ?? new AbortController();
    const deps = { ...defaults, ...binding, controller };
    deps.errorEnv = deps.env ?? process.env;
    deps.env = Object.fromEntries(Object.entries(deps.env ?? process.env).filter(([name]) => !/SCRANTON_(?:RUN_LEASE|PARENT_GUARD)|API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|_KEY$|DATABASE_URL|^DBOS_/i.test(name)));
    deps.llm ??= createLLM({ resolveAuth: async provider => (deps.credentials ?? await getCredentials()).resolveAuth(provider, { signal: controller.signal }) });
    deps.chat = async message => {
      if (!deps.onMessage) return { ok: false, delivery: 'rejected', error: 'Agent chat is unavailable' };
      let timer;
      try {
        const ack = await Promise.race([
          Promise.resolve().then(() => deps.onMessage(message)),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); }),
        ]);
        if (typeof ack?.ok === 'boolean') return ack;
      } catch { /* An attempted send cannot safely be repeated. */ }
      finally { clearTimeout(timer); }
      return { ok: false, delivery: 'unknown', error: 'No valid chat acknowledgement; delivery unknown. Do not resend automatically.' };
    };
    const job = runAgentWorkflow(wf, input, deps);
    registration.jobs.set(wf.workflowId, job);
    try { return await job; } finally { registration.jobs.delete(wf.workflowId); }
  });
  registrations.set(runtime, registration);
  return registration;
}

async function defaultRuntime(options) {
  const hiveDir = path.resolve(options.hive?.dir ?? options.hiveDir ?? path.join(options.cwd, 'hive'));
  let pending = owned.get(hiveDir);
  if (!pending) {
    pending = (async () => {
      const runtime = await createDurableRuntime({ hiveDir, markerDir: path.join(hiveDir, 'agent-step-markers'), executorId: `run:${options.runId ?? 'single'}`, appVersion: await agentAppVersion() });
      return runtime;
    })();
    owned.set(hiveDir, pending);
    pending.catch(() => owned.delete(hiveDir));
  }
  return pending;
}

export function startAgent(options) {
  const counterKey = JSON.stringify([options.runId ?? 'single', options.instanceId ?? options.agentId ?? 'agent']);
  const invocation = (invocations.get(counterKey) ?? 0) + 1;
  if (options.invocationKey === undefined && !options.workflowId) invocations.set(counterKey, invocation);
  const workflowId = options.workflowId ?? agentWorkflowId({ ...options, hiveDir: options.hive?.dir ?? options.hiveDir ?? path.join(options.cwd, 'hive'), instanceId: options.instanceId ?? options.agentId ?? 'agent', invocationKey: options.invocationKey ?? `auto:${invocation}` });
  const digest = createHash('sha256').update(`scranton.agent.session:${workflowId}`).digest();
  digest[6] = (digest[6] & 15) | 128; digest[8] = (digest[8] & 63) | 128;
  const hex = digest.subarray(0, 16).toString('hex');
  const sessionId = options.sessionId ?? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const controller = new AbortController();
  const started = Date.now();
  let runtime, registration, timer, reason, settled = false;
  let spent = null;
  const ready = (async () => {
    const config = options.agentConfig ?? {};
    if (options.pi || options.extraArgs?.length || config.extraArgs?.length || options.extraEnv?.SCRANTON_PI_COMMAND || process.env.SCRANTON_PI_COMMAND) throw new Error('Pi settings and extraArgs are not supported by the Scranton agent');
    if (options.execution) throw new Error('Pi execution overrides are not supported; inject spawn for Scranton tools');
    if (options.sandbox && typeof options.sandbox.spawn !== 'function') throw new Error('sandbox must expose spawn');
    const spawn = options.spawn ?? options.sandbox?.spawn?.bind(options.sandbox);
    if (spawn !== undefined && typeof spawn !== 'function') throw new Error('spawn must be a function');
    runtime = options.runtime ?? await defaultRuntime(options);
    const fresh = !registrations.has(runtime);
    registration = registerAgentWorkflow(runtime, options.dependencies);
    const binding = { ...options, ...(spawn ? { spawn } : {}), controller, env: { ...process.env, ...options.extraEnv }, onAccountUsage: usage => { spent = usage; } };
    registration.bindings.set(workflowId, binding);
    // A recovered workflow must see its callbacks before launch schedules it.
    if (fresh) registration.launchPromise = Promise.resolve().then(() => runtime.launch());
    if (registration.launchPromise) await registration.launchPromise;
    const existing = runtime.retrieveWorkflow(workflowId);
    if (await existing.getStatus()) return existing;
    if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1)) throw new Error('maxTurns must be a positive integer');
    const approvals = options.approvals ?? config.approvals;
    if (approvals && (!Array.isArray(approvals.tools) || !approvals.tools.every(t => typeof t === 'string') || !Number.isFinite(approvals.timeoutSeconds) || approvals.timeoutSeconds <= 0)) throw new Error('Invalid tool approvals configuration');
    const agentId = options.agentId ?? config.id ?? 'dwight';
    const instruct = text => text.includes(AGENT_MESSAGE) ? text : `${AGENT_MESSAGE}\n\n${text}`;
    const message = instruct(options.message ?? (options.messages ? '' : await fs.readFile(options.hive.inboxPath(agentId), 'utf8')));
    const messages = options.messages ? structuredClone(options.messages) : [{ role: 'user', content: message }];
    const firstUser = messages.find(item => item.role === 'user');
    if (typeof firstUser?.content === 'string') firstUser.content = instruct(firstUser.content);
    else if (Array.isArray(firstUser?.content)) {
      if (!firstUser.content.some(block => block.type === 'text' && block.text.includes(AGENT_MESSAGE))) firstUser.content.unshift({ type: 'text', text: AGENT_MESSAGE });
    } else if (options.messages) messages.unshift({ role: 'user', content: AGENT_MESSAGE });
    const systemPrompt = options.systemPrompt ?? (options.systemPromptFile ? await fs.readFile(options.systemPromptFile, 'utf8') : '');
    const script = await createAgentScript(options.scripted, { ...options, systemPrompt, agentId, message, env: binding.env });
    if (script) { binding.llm = script.llm; binding.spawn ??= options.dependencies?.spawn ?? script.spawn; }
    const credentials = options.credentials ?? options.dependencies?.credentials ?? (options.model || options.llm || script || options.dependencies?.llm ? null : await registration.getCredentials());
    const model = options.model ?? script?.model ?? selectModel(config, credentials);
    const input = { cwd: path.resolve(options.cwd), agentId: options.agentId ?? config.id, sessionId,
      model, thinking: config.thinking ?? 'off', allow: config.tools ?? [], definitions: definitionsFor(config.tools ?? []),
      keywords: config.keywords, systemPrompt,
      messages, maxTurns: options.maxTurns ?? 100, timeoutMs: options.timeoutMs,
      approvals, compactTokenLimit: options.compactTokenLimit ?? process.env.SCRANTON_AUTO_COMPACT_TOKEN_LIMIT,
      retrySeconds: options.retrySeconds ?? 2 };
    return runtime.startWorkflow(WORKFLOW, { workflowId }, input);
  })();
  const cancel = async (why = 'user') => {
    if (settled) return;
    if (!reason) {
      try { options.onLive?.({ type: 'agent_settled', aborted: true }); } catch { /* Display failures cannot prevent cancellation. */ }
    }
    reason ??= why;
    controller.abort(new Error(why === 'timeout' ? 'Agent timed out' : 'Agent aborted'));
    try { await ready; await runtime.cancelWorkflow(workflowId); } catch { /* Initialization may already have failed. */ }
  };
  if (options.timeoutMs) timer = setTimeout(() => void cancel('timeout'), options.timeoutMs);
  const done = (async () => {
    try {
      const handle = await ready;
      if (reason) await runtime.cancelWorkflow(workflowId);
      const result = await handle.getResult();
      if (reason) throw new Error('Agent cancelled');
      return result.failure ? { ...result, failure: { ...result.failure, message: errorText(result.failure.message, { ...process.env, ...options.extraEnv }) } } : result;
    } catch (error) {
      await registration?.jobs.get(workflowId)?.catch(() => {});
      return { ok: false, text: '', keyword: null, usage: spent, exitCode: -1, durationMs: Date.now() - started,
        failure: { kind: reason === 'timeout' ? 'timeout' : reason === 'user' ? 'interrupted' : reason ? 'aborted' : 'agent', message: reason ? (reason === 'timeout' ? 'Agent timed out' : 'Agent aborted') : errorText(error.message, { ...process.env, ...options.extraEnv }) }, sessionId, cleanupComplete: true };
    } finally {
      clearTimeout(timer);
      if (registration) {
        await registration.jobs.get(workflowId)?.catch(() => {});
        registration.bindings.delete(workflowId);
      }
      settled = true;
    }
  })();
  return { sessionId, workflowId, done, abort: async () => { await cancel('abort'); return done; }, kill: async why => { await cancel(why); return done; },
    sendMessage: async text => {
      if (settled || reason || typeof text !== 'string' || !text.trim() || text.length > 16000) return { ok: false, delivery: 'rejected', error: 'Agent is finished or message is invalid' };
      try { await ready; await runtime.send(workflowId, { text }, 'steer', randomUUID()); return { ok: true, delivery: 'delivered' }; }
      catch { return { ok: false, delivery: 'unknown', error: 'Steer delivery unknown; do not resend automatically' }; }
    } };
}

export function approveToolCall(runtimeOrClient, workflowId, { step, callId }, approved, by) {
  if (typeof step !== 'string' || !/^tool:\d+:\d+$/.test(step) || typeof callId !== 'string' || !callId || typeof approved !== 'boolean' || typeof by !== 'string') throw new Error('Invalid tool approval');
  return runtimeOrClient.send(workflowId, { workflowId, step, callId, approved, by }, 'tool_approval', JSON.stringify([workflowId, step, callId]));
}

export async function readAgentHistory(runtimeOrClient, workflowId) {
  let messages = [];
  for await (const { value } of runtimeOrClient.readStream(workflowId, 'history')) {
    if (value.type === 'replace') messages = [...value.messages];
    else if (value.type === 'append') messages.push(value.message);
  }
  return messages;
}

export async function readAgentOutput(runtimeOrClient, workflowId) {
  const steps = new Map();
  for await (const { value } of runtimeOrClient.readStream(workflowId, 'output')) {
    if (value.type === 'attempt_start') steps.set(value.step, []);
    else if (value.v === 1) steps.get(value.step)?.push(value);
  }
  return [...steps.values()].flat();
}

export async function shutdownAgentRuntimes() {
  for (const pending of owned.values()) {
    const runtime = await pending;
    await runtime.shutdown();
    await registrations.get(runtime)?.close();
  }
  owned.clear();
}

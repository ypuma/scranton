import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_IDS } from './state.js';
import { normalizeWorkflow } from './workflow.js';
import { loadAgentsConfig, roleDefinitions } from './agents-config.js';
import { isFile } from './util.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MAX_FAILED_CYCLES = 3;
export const DEFAULT_TIMEOUT_MINUTES = 20;
export const CONFIG_FILE_NAME = 'scranton.config.json';
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_TOOLS = {
  michael: ['read', 'grep', 'find', 'ls'],
  dwight: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
  // Read-only by allowlist: no write/edit. bash can still modify files - see README "Security".
  oscar: ['read', 'grep', 'find', 'ls', 'bash'],
  hank: ['read', 'grep', 'find', 'ls', 'bash'],
  angela: ['read', 'grep', 'find', 'ls', 'bash']
};

export class ConfigError extends Error {
  name = 'ConfigError';
}

/** Load ./.env (existing environment variables win). Returns the path or null. */
export function loadDotEnv(cwd = process.cwd(), loader = process.loadEnvFile) {
  const file = path.join(cwd, '.env');
  if (!isFile(file)) return null;
  loader.call(process, file);
  return file;
}

/** Pi's bash tool needs Git Bash (or another bash.exe) on Windows. */
export function windowsBashAvailable(env = process.env) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')];
  if (roots.some((r) => r && isFile(path.join(r, 'Git', 'bin', 'bash.exe')))) return true;
  return String(env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .some((dir) => dir && isFile(path.join(dir, 'bash.exe')));
}

export function defaultTools(agent, { platform = process.platform, hasBash = windowsBashAvailable() } = {}) {
  const tools = [...DEFAULT_TOOLS[agent]];
  if (platform === 'win32' && !hasBash) return tools.map((t) => (t === 'bash' ? 'powershell' : t));
  return tools;
}

/** `SCRANTON_PI_COMMAND`: a JSON array, or a plain string split on whitespace. */
export function parseCommandSpec(value, name = 'SCRANTON_PI_COMMAND') {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`${name} is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((p) => typeof p !== 'string')) {
      throw new ConfigError(`${name} must be a non-empty JSON array of strings`);
    }
    return parsed;
  }
  return text.split(/\s+/);
}

function readFileConfig(cwd, configPath) {
  const explicit = configPath ? path.resolve(cwd, configPath) : null;
  const file = explicit ?? path.join(cwd, CONFIG_FILE_NAME);
  if (!isFile(file)) {
    if (explicit) throw new ConfigError(`config file not found: ${explicit}`);
    return { file: null, data: {} };
  }
  try {
    return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    throw new ConfigError(`cannot parse ${file}: ${err.message}`);
  }
}

const blank = (v) => v === undefined || v === null || v === '';
const pick = (...values) => values.find((v) => !blank(v));

function toPositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${label} must be a positive integer (got "${value}")`);
  return n;
}

function toPositiveNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${label} must be a positive number (got "${value}")`);
  return n;
}

function toList(value, label) {
  if (blank(value)) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((t) => t.trim()).filter(Boolean);
  throw new ConfigError(`${label} must be a string or an array`);
}

/**
 * Effective configuration. Precedence: flags > env > config file > defaults.
 * `fileConfig` replaces reading the file (tests); `platform`/`hasBash` make tool defaults testable.
 */
export function loadConfig({
  cwd = process.cwd(),
  env = process.env,
  flags = {},
  configPath,
  fileConfig,
  platform = process.platform,
  hasBash,
  validateWorkflow = true
} = {}) {
  const loaded = fileConfig ? { file: null, data: fileConfig } : readFileConfig(cwd, configPath ?? flags.config);
  const file = loaded.data;
  const fileBase = loaded.file ? path.dirname(loaded.file) : cwd;
  const warnings = [];

  const fromFile = (value) => (blank(value) ? undefined : path.resolve(fileBase, String(value)));
  const fromCwd = (value) => (blank(value) ? undefined : path.resolve(cwd, String(value)));
  const workspace = pick(fromCwd(flags.workspace), fromCwd(env.SCRANTON_WORKSPACE), fromFile(file.workspace), path.resolve(cwd, 'workspace'));
  const dataDir = flags.singleHive ? null : pick(fromCwd(flags.data), fromCwd(env.SCRANTON_DATA), fromFile(file.dataDir)) ?? null;
  const maxConcurrentRuns = toPositiveInt(pick(flags.maxRuns, env.SCRANTON_MAX_RUNS, file.maxConcurrentRuns, 4), 'maxConcurrentRuns');
  const hiveDir = pick(fromCwd(flags.hive), fromCwd(env.SCRANTON_HIVE), fromFile(file.hiveDir), path.resolve(cwd, 'hive'));

  const maxFailedCycles = toPositiveInt(
    pick(flags.maxCycles, env.SCRANTON_MAX_FAILED_CYCLES, file.maxFailedCycles, DEFAULT_MAX_FAILED_CYCLES),
    'maxFailedCycles'
  );
  const agentTimeoutMinutes = toPositiveNumber(
    pick(flags.timeoutMin, env.SCRANTON_AGENT_TIMEOUT_MIN, file.agentTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES),
    'agentTimeoutMinutes'
  );

  const onBreaker = pick(flags.onBreaker, env.SCRANTON_ON_BREAKER, file.onBreaker, 'ask');
  if (!['ask', 'abort', 'skip', 'hive'].includes(onBreaker)) throw new ConfigError('onBreaker must be ask, abort, skip or hive');

  const envCommand = parseCommandSpec(env.SCRANTON_PI_COMMAND);
  const fileCommand = Array.isArray(file.pi?.command) && file.pi.command.length ? file.pi.command.map(String) : null;
  const pi = {
    command: envCommand ?? fileCommand,
    commandSource: envCommand ? 'env' : fileCommand ? 'config' : null,
    extraArgs: toList(file.pi?.extraArgs, 'pi.extraArgs') ?? [],
    minimalContext: file.pi?.minimalContext !== false
  };

  if (file.execution?.maxReplans) warnings.push('execution.maxReplans is unsupported and ignored; the published DAG is immutable');
  const conversation = pick(flags.conversation, env.SCRANTON_CONVERSATION, file.execution?.conversation, false);
  const conversationFromEnv = blank(flags.conversation) && !blank(env.SCRANTON_CONVERSATION);
  if (conversationFromEnv ? !['1', '0'].includes(conversation) : typeof conversation !== 'boolean') throw new ConfigError('execution.conversation must be boolean (SCRANTON_CONVERSATION: 1 or 0)');
  const execution = {
    conversation: conversation === true || conversation === '1',
    maxParallel: toPositiveInt(pick(flags.parallel, env.SCRANTON_PARALLEL, file.execution?.maxParallel, 3), 'execution.maxParallel'),
    isolation: file.execution?.isolation ?? 'worktree',
    persistentSessions: file.execution?.persistentSessions !== false,
    maxReplans: 0,
    sandbox: {
      mode: flags.trustedHost ? 'host' : pick(flags.sandbox, file.execution?.sandbox?.mode, 'host'),
      image: pick(flags.sandboxImage, file.execution?.sandbox?.image, 'scranton-sandbox:1.5.0-r2'),
      network: pick(flags.sandboxNetwork, file.execution?.sandbox?.network, 'bridge')
    }
  };
  if (!['shared', 'worktree'].includes(execution.isolation)) throw new ConfigError('execution.isolation must be shared or worktree');
  if (execution.isolation === 'shared' && (execution.sandbox.mode !== 'host' || !flags.trustedHost && flags.sandbox !== 'host' && file.execution?.sandbox?.mode !== 'host')) throw new ConfigError('shared isolation requires explicit trusted-host execution; Docker requires worktree isolation');
  if (execution.maxParallel > 1 && execution.isolation !== 'worktree') throw new ConfigError('parallel execution requires worktree isolation');
  if (!['host', 'docker'].includes(execution.sandbox.mode)) throw new ConfigError('sandbox must be host or docker');
  if (!['none', 'bridge'].includes(execution.sandbox.network)) throw new ConfigError('sandbox network must be none or bridge');
  if (flags.sandbox === 'host' && !flags.trustedHost) throw new ConfigError('--sandbox host requires --trusted-host');
  pi.transport = file.pi?.transport ?? 'rpc';
  if (!['rpc', 'json'].includes(pi.transport)) throw new ConfigError('pi.transport must be rpc or json');
  if (execution.isolation === 'worktree' && pi.transport !== 'rpc') throw new ConfigError('worktree isolation requires RPC transport');

  const promptsDir = fromCwd(env.SCRANTON_PROMPTS_DIR) ?? path.join(dataDir ?? hiveDir, 'prompts');
  const settingsDir = fromCwd(env.SCRANTON_SETTINGS_DIR) ?? dataDir ?? hiveDir;
  const settings = loadAgentsConfig(settingsDir);
  const roles = roleDefinitions(settings);
  warnings.push(...settings.warnings);
  const configuredWorkflow = flags.gates !== undefined ? { gates: flags.gates.split(',').map((stage) => stage.split('+').map((id) => id.trim())) } : file.workflow;
  let workflow = configuredWorkflow, workflowWarning = null;
  try { workflow = normalizeWorkflow(configuredWorkflow, roles.filter((r) => r.kind === 'gate').map((r) => r.id)); }
  catch (err) {
    if (validateWorkflow) throw err;
    workflowWarning = err.message; warnings.push(workflowWarning);
  }
  const bash = hasBash ?? (platform === 'win32' ? windowsBashAvailable(env) : true);
  const agents = {};
  for (const role of roles) {
    const id = role.id, saved = settings.agents[id] ?? {};
    const f = file.agents?.[id] ?? {};
    const upper = id.toUpperCase();
    const customTools = role.builtin ? null : toList(f.tools, `agents.${id}.tools`) ?? role.tools;
    if (customTools && (!customTools.length || customTools.some((tool) => !['read', 'grep', 'find', 'ls', 'bash'].includes(tool)))) throw new ConfigError(`${id}: custom gates require read-only tools`);
    const agent = {
      skillSource: f.skill ? 'config' : 'builtin',
      skill: fromFile(f.skill) ?? path.join(PACKAGE_ROOT, 'agents', id, 'SKILL.md'),
      provider: pick(env[`SCRANTON_${upper}_PROVIDER`], f.provider, saved.model?.provider) ?? null,
      model: pick(env[`SCRANTON_${upper}_MODEL`], f.model, saved.model?.model) ?? null,
      thinking: pick(env[`SCRANTON_${upper}_THINKING`], f.thinking, saved.thinking) ?? null,
      tools: role.builtin ? toList(f.tools, `agents.${id}.tools`) ?? defaultTools(id, { platform, hasBash: bash }) : customTools.map((t) => platform === 'win32' && !bash && t === 'bash' ? 'powershell' : t),
      extraArgs: toList(f.extraArgs, `agents.${id}.extraArgs`) ?? []
    };
    if (role.kind === 'gate') validateGateTools({ ...agent, id }, pi);
    if (agent.thinking && !THINKING_LEVELS.includes(agent.thinking)) {
      throw new ConfigError(`${id} thinking level "${agent.thinking}" is not one of: ${THINKING_LEVELS.join(', ')}`);
    }
    if (agent.provider && !agent.model) {
      warnings.push(`${id}: provider "${agent.provider}" is set without a model - pi needs both, so the provider is ignored`);
      agent.provider = null;
    }
    const modelSource = !blank(env[`SCRANTON_${upper}_PROVIDER`]) || !blank(env[`SCRANTON_${upper}_MODEL`]) ? 'env' : !blank(f.provider) || !blank(f.model) ? 'config' : saved.model ? 'settings' : 'none';
    const thinkingSource = !blank(env[`SCRANTON_${upper}_THINKING`]) ? 'env' : !blank(f.thinking) ? 'config' : saved.thinking != null ? 'settings' : 'none';
    agent.modelSetting = { value: agent.model ? { provider: agent.provider, model: agent.model } : null, source: modelSource, pinned: ['env', 'config'].includes(modelSource) };
    agent.thinkingSetting = { value: agent.thinking, source: thinkingSource, pinned: ['env', 'config'].includes(thinkingSource) };
    agents[id] = agent;
  }

  return { configPath: loaded.file, cwd, workspace, hiveDir, dataDir, maxConcurrentRuns, maxFailedCycles, agentTimeoutMinutes, execution, workflow, promptsDir, settingsDir, roles, agentWarnings: [...settings.warnings, ...(workflowWarning ? [workflowWarning] : [])], workflowWarning, pi, agents, warnings, onBreaker };
}

// Audited against pi 1.5.0 cli/args.js. Unknown flags fail closed, including future resource loaders.
const GATE_VALUE_FLAGS = new Set(['--provider', '--model', '--api-key', '--system-prompt', '--append-system-prompt', '--name', '-n', '--session', '--session-id', '--fork', '--session-dir', '--models', '--thinking']);
const GATE_BOOLEAN_FLAGS = new Set(['--continue', '-c', '--resume', '-r', '--no-session', '--no-extensions', '-ne', '--no-mcp', '--no-skills', '-ns', '--no-prompt-templates', '-np', '--no-themes', '--no-context-files', '-nc', '--verbose', '--no-approve', '-na', '--offline']);
const GATE_TOOL_FLAGS = new Set(['--tools', '-t', '--exclude-tools', '-xt', '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--extension', '-e', '--skill', '--prompt-template', '--theme', '--']);

export function validateGateTools(agent, pi) {
  for (const [key, args] of [['pi.extraArgs', pi.extraArgs ?? []], [`agents.${agent.id ?? 'gate'}.extraArgs`, agent.extraArgs ?? []]]) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (GATE_TOOL_FLAGS.has(arg.split('=')[0])) throw new ConfigError(`${key}: tool-changing extraArgs are forbidden for gate roles: ${arg}`);
      if (GATE_BOOLEAN_FLAGS.has(arg)) continue;
      if (!GATE_VALUE_FLAGS.has(arg)) throw new ConfigError(`${key}: unsupported gate extraArgs flag: ${arg}`);
      // Do not let a value consume another option or cross into Scranton's managed argv.
      const value = args[++i];
      if (!value || value.startsWith('-') || value.startsWith('@')) throw new ConfigError(`${key}: gate extraArgs ${arg} requires a value that is not an option or file argument`);
    }
  }
  if (!agent.tools?.length || agent.tools.some((tool) => !['read', 'grep', 'find', 'ls', 'bash', 'powershell'].includes(tool))) throw new ConfigError(`agents.${agent.id ?? 'gate'}.tools: gates require read-only tools`);
}

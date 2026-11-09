import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { ConfigError, PACKAGE_ROOT, loadConfig, loadDotEnv } from './config.js';
import { runDoctor } from './doctor.js';
import { createTerminalLog, styler } from './log.js';
import { saveAgent } from './agents-config.js';
import { agentCatalog } from './prompts.js';
import { KEYWORDS } from './keywords.js';
import { Hive } from './hive.js';
import { Orchestrator } from './orchestrator.js';
import { PiNotFoundError, resolvePiCommand } from './pi-command.js';
import { startPi, writeSystemPrompt } from './pi-runner.js';
import { acquireRunLease, readRunLease, releaseRunLease, startRunHeartbeat, guardParent, registerParentStartup } from './run-lease.js';
import { randomUUID } from 'node:crypto';
import { AGENT_IDS } from './state.js';
import { isLoopbackAddress } from './network.js';
import { createAuthService } from './auth.js';
import { validateDockerModels } from './sandbox.js';
import { activeRoles } from './workflow.js';
import os from 'node:os';
import { createProjectRegistry, derivedChatTitle } from './projects.js';
import { listRuns, formatThreadContext } from './thread.js';
import { setTimeout as sleep } from 'node:timers/promises';

export const SCENARIOS = ['happy', 'flaky', 'breaker', 'blocked', 'changes_once', 'security_issues'];
const POLICIES = ['ask', 'abort', 'skip', 'hive'];
const SUCCESS_KEYWORDS = new Set(['PLAN_READY', 'TASK_COMPLETE', 'TEST_PASSED', 'REVIEW_APPROVED', 'SECURITY_PASSED']);

export const HELP = `Project Scranton - multi-agent harness around the pi coding agent

Usage:
  scranton run "<request>" [options]       Plan, build and test a request (Michael, Dwight, Angela)
  scranton agent <michael|dwight|oscar|hank|angela> "<task>" [--workspace DIR]
                                           Run one audited, isolated agent; private changes are not integrated
  scranton demo [--scenario S] [--delay MS] [options]
                                           Full run with the fake pi (S: happy|flaky|breaker|blocked, default flaky)
  scranton dashboard [--once] [--ascii]    Live terminal dashboard (second terminal)
  scranton visualize [--port N] [--host H] Web dashboard in the browser (default http://127.0.0.1:1725)
  scranton app-server [--port N]           Controlled server for desktop (default port 0)
  scranton login <claude|chatgpt>           Sign in with a subscription in your browser
  scranton login <provider> --api-key        Store an API key (hidden prompt or stdin, never argv)
  scranton login gemini                    Store a Gemini API key
  scranton provider add <id> --base-url URL --api API [--models a,b | --discover] [--label L]
  scranton provider remove <id>
  scranton logout <claude|chatgpt>          Remove one stored provider credential
  scranton accounts                        Show account status (no token refresh)
  scranton projects list|add <name> [--workspace PATH] [--create]|remove <id> [--delete-history]
  scranton chats <project>                 List threads in a project
  scranton agents                          List agents and effective settings
  scranton agent set-model <id> --provider P --model M [--thinking T]
  scranton agent remove-model <id>          Clear saved model and thinking
  scranton doctor                          Check Node, pi, credentials and folders
  scranton help

Options:
  --gates STAGES       Ordered gates, e.g. oscar+hank,angela
  --parallel N         Maximum concurrent milestone pipelines (default 3)
  --trusted-host       Explicitly run outside Docker (worktrees remain isolated)
  --sandbox MODE       docker (default); host requires --trusted-host
  --sandbox-image IMG  Docker image (default scranton-sandbox:1.5.0-r2)
  --sandbox-network N  none | bridge (default bridge)
  --workspace DIR      Where the agents work (default ./workspace; demo: ./demo-workspace)
  --hive DIR           Mailbox + event directory (default ./hive)
  --data DIR           Project registry directory (or SCRANTON_DATA)
  --project ID         run: registered project; --chat ID continues a thread
  --thread-context FILE Internal bounded earlier-thread context
  --config FILE        Config file (default ./scranton.config.json)
  --no-plan            run: skip Michael's planning, use one milestone for the whole request
  --max-cycles N       Failed test cycles before the circuit breaker trips (default 3)
  --on-breaker P       ask | abort | skip | hive: what to do when a human is needed (default ask;
                       without a terminal "ask" aborts)
  --control            visualize: enable run, answer and stop routes
  --timeout-min N      Per-agent timeout in minutes (default 20)

Exit codes: 0 success, 1 partial/failed/aborted, 2 usage error, 130 interrupted with Ctrl+C.
Environment and .env: see .env.example. Precedence: flags > env > scranton.config.json > defaults.
`;

const OPTIONS = {
  data: { type: 'string' },
  'single-hive': { type: 'boolean' },
  project: { type: 'string' },
  chat: { type: 'string' },
  create: { type: 'boolean' },
  'delete-history': { type: 'boolean' },
  'thread-context': { type: 'string' },
  'legacy-workspace': { type: 'string' },
  'api-key': { type: 'boolean' },
  'base-url': { type: 'string' },
  api: { type: 'string' },
  models: { type: 'string' },
  discover: { type: 'boolean' },
  label: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  thinking: { type: 'string' },
  gates: { type: 'string' },
  parallel: { type: 'string' },
  'trusted-host': { type: 'boolean' },
  sandbox: { type: 'string' },
  'sandbox-image': { type: 'string' },
  'sandbox-network': { type: 'string' },
  workspace: { type: 'string' },
  hive: { type: 'string' },
  config: { type: 'string' },
  'no-plan': { type: 'boolean' },
  'max-cycles': { type: 'string' },
  'on-breaker': { type: 'string' },
  'timeout-min': { type: 'string' },
  scenario: { type: 'string' },
  delay: { type: 'string' },
  once: { type: 'boolean' },
  ascii: { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  control: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
};

class UsageError extends Error {}

function toFlags(values) {
  return {
    gates: values.gates,
    data: values.data,
    singleHive: values['single-hive'],
    parallel: values.parallel,
    trustedHost: values['trusted-host'],
    sandbox: values.sandbox,
    sandboxImage: values['sandbox-image'],
    sandboxNetwork: values['sandbox-network'],
    workspace: values.workspace,
    hive: values.hive,
    config: values.config,
    maxCycles: values['max-cycles'],
    onBreaker: values['on-breaker'],
    timeoutMin: values['timeout-min']
  };
}

function policyOf(values, config) {
  const policy = values['on-breaker'] ?? config.onBreaker;
  if (!POLICIES.includes(policy)) throw new UsageError(`--on-breaker must be one of: ${POLICIES.join(', ')}`);
  return policy;
}

/** Runs the CLI and returns the exit code. */
export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env, cwd = process.cwd(), auth } = {}) {
  const startup = registerParentStartup({ env });
  let begun = false;
  const begin = async () => { begun = true; await startup.begin(); };
  const c = styler(stderr, env);
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const [command = 'help', ...rest] = positionals;
    if (command === 'help' || values.help) {
      stdout.write(HELP);
      return 0;
    }
    if (values['single-hive'] && (values.data || values.project || values.chat)) throw new UsageError('--single-hive conflicts with registry options');
    const registryRun = !values['single-hive'] && command === 'run' && Boolean(values.data || env.SCRANTON_DATA);
    if (command === 'run' && !registryRun && (values.project || values.chat)) {
      throw new UsageError('--project and --chat require --data or inherited SCRANTON_DATA');
    }
    if (command === 'run') {
      // Keep workspace dotenv values out of the inherited environment used by later runs.
      loadDotEnv(registryRun ? PACKAGE_ROOT : cwd, (file) => { env = { ...parseEnv(readFileSync(file, 'utf8')), ...env }; });
    } else loadDotEnv(cwd);
    if (['accounts', 'login', 'logout', 'provider'].includes(command)) {
      return await cmdAuth(command, rest, values, { stdout, stderr, stdin, auth: auth ?? createAuthService({ env }) });
    }
    const config = loadConfig({ validateWorkflow: !['doctor', 'agents', 'agent', 'visualize', 'app-server'].includes(command), cwd: registryRun ? PACKAGE_ROOT : cwd, env, flags: { ...toFlags(values), ...(registryRun ? { data: path.resolve(cwd, values.data || env.SCRANTON_DATA), config: undefined } : {}) } });
    if (command === 'run' && config.dataDir && !registryRun) throw new UsageError('Registry runs require --data or inherited SCRANTON_DATA; workspace configuration is not trusted');
    if (command === 'agents') {
      stdout.write('ID | Name | Title | Kind | Model | Model Source | Prompt Source\n');
      for (const r of agentCatalog(config).roles) stdout.write(`${r.id} | ${r.name} | ${r.title} | ${r.kind} | ${r.model.value ? r.model.value.provider + '/' + r.model.value.model : 'pi default'} | ${r.model.source} | ${r.prompt.source}\n`);
      return 0;
    }
    if (command === 'agent' && ['set-model', 'remove-model'].includes(rest[0])) {
      if (rest.length !== 2) throw new UsageError('agent set-model|remove-model requires one agent ID');
      const patch = rest[0] === 'remove-model' ? { model: null, thinking: null } : { model: { provider: values.provider, model: values.model }, ...(values.thinking !== undefined ? { thinking: values.thinking } : {}) };
      saveAgent(config, rest[1], patch);
      stdout.write('Agent settings saved.\n'); return 0;
    }
    if (command === 'agent' && !AGENT_IDS.includes(rest[0])) throw new UsageError(`agent must be one of: ${AGENT_IDS.join(', ')}`);
    if (command === 'run' || command === 'agent') validateDockerModels(config, command === 'agent' ? [rest[0]] : activeRoles(config, values['no-plan']));
    const io = { stdout, stderr, env, cwd, begin };
    switch (command) {
      case 'projects':
      case 'chats':
        return cmdProjects(command, rest, values, config, io);
      case 'run':
        return await cmdRun(rest.join(' '), values, config, io);
      case 'agent':
        return await cmdAgent(rest[0], rest.slice(1).join(' '), config, io);
      case 'demo':
        return await cmdDemo(values, io);
      case 'dashboard':
        return await cmdDashboard(values, config, io);
      case 'app-server':
        return await cmdVisualize(values, config, io, true);
      case 'visualize':
        return await cmdVisualize(values, config, io);
      case 'doctor':
        return await runDoctor({ config, env, stdout });
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err.status || err instanceof UsageError || err instanceof ConfigError || err instanceof PiNotFoundError || err?.code?.startsWith?.('ERR_PARSE_ARGS')) {
      const message = err?.code?.startsWith?.('ERR_PARSE_ARGS') && ['login', 'provider'].includes(argv[0])
        ? 'Invalid authentication options; enter keys through hidden prompt or stdin, never argv'
        : err.message;
      stderr.write(`${c.red('scranton:')} ${message}\n`);
      if (!(err instanceof ConfigError) && !(err instanceof PiNotFoundError)) stderr.write('Run "scranton help" for usage.\n');
      return 2;
    }
    throw err;
  } finally {
    if (!begun) await startup.refuse();
  }
}

/** Ctrl+C: first press aborts gracefully, second one exits at once. */
function onInterrupt(handler) {
  let pressed = false;
  const listener = () => {
    if (pressed) process.exit(130);
    pressed = true;
    handler();
  };
  process.on('SIGINT', listener);
  return () => process.off('SIGINT', listener);
}

async function execute(orchestrator, request, { stderr, env = process.env, acquire = acquireRunLease }) {
  const hiveDir = orchestrator.config.hiveDir;
  const dispose = guardParent({ hiveDir, env, abort: (reason) => orchestrator.abort(reason) });
  let lease;
  let clean = false;
  let stopHeartbeat;
  let cleanupReason = 'Run ended without verified cleanup';
  try {
    if (env.SCRANTON_PARENT_GUARD !== '1') lease = acquire(hiveDir, { runId: orchestrator.runId, startedAt: new Date().toISOString(), request, workspace: orchestrator.config.workspace });
    stopHeartbeat = startRunHeartbeat(hiveDir, lease?.token ?? env.SCRANTON_RUN_LEASE);
  } catch (err) {
    dispose();
    if (lease) releaseRunLease(hiveDir, lease.token);
    if (err.code === 'EEXIST') {
      stderr.write('scranton: Hive is already owned by another run or recovery is required. Verify prior processes/containers have stopped before explicit recovery; ownership was not changed.\n');
      return 1;
    }
    throw err;
  }
  const off = onInterrupt(() => {
    stderr.write('\nInterrupting - stopping the active agent...\n');
    orchestrator.abort();
  });
  try {
    const result = await orchestrator.run(request);
    clean = result.cleanupComplete !== false && orchestrator.cleanupComplete !== false;
    cleanupReason = result.summary || cleanupReason;
    if (orchestrator.standaloneAgent) {
      orchestrator.stdout.write(`${result.text ?? ''}\nkeyword: ${result.keyword ? `[${result.keyword}]` : '(none)'}\n`);
      if (result.status === 'failed') stderr.write(`scranton: ${result.summary}\n`);
    }
    if (result.status === 'success') return 0;
    return result.status === 'aborted' && result.signaled ? 130 : 1;
  } finally {
    off();
    stopHeartbeat(clean ? undefined : orchestrator.cleanupReason ?? cleanupReason);
    dispose({ clean });
    if (clean && lease) releaseRunLease(hiveDir, lease.token);
  }
}

async function readApiKey(stdin, stderr) {
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) { text += chunk; if (text.length > 4098) throw Error('API key input too long'); }
    return text.trim();
  }
  if (typeof stdin.setRawMode !== 'function') throw Error('Hidden input unavailable');
  stderr.write('API key (hidden): ');
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode(true); stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let text = '';
      const done = (error) => { stdin.off('data', data); stdin.off('end', end); stdin.off('error', failed); error ? reject(error) : resolve(text); };
      const end = () => done(Error('Input closed'));
      const failed = () => done(Error('Input failed'));
      const data = (chunk) => {
        for (const char of chunk.toString()) {
          if (char === '\r' || char === '\n') return done();
          if (char === '\x03') return done(Error('Cancelled'));
          if (char === '\x7f' || char === '\b') text = text.slice(0, -1);
          else text += char;
          if (text.length > 4096) return done(Error('API key input too long'));
        }
      };
      stdin.on('data', data); stdin.once('end', end); stdin.once('error', failed);
    });
  } finally { stdin.setRawMode(wasRaw); stdin.pause(); stderr.write('\n'); }
}

async function cmdAuth(command, args, values, { stdout, stderr, stdin, auth }) {
  const aliases = { claude: 'anthropic', chatgpt: 'openai', anthropic: 'anthropic', openai: 'openai', gemini: 'google' };
  if (command === 'accounts') {
    if (args.length) throw new UsageError('accounts takes no arguments');
    const accounts = await auth.listAccounts();
    for (const account of accounts) stdout.write(`${account.label}: ${account.status} (${account.kind ?? 'none'})${account.renewFailedAt ? ` - renewal failed ${account.renewFailedAt}; sign in again` : account.renewsOnUse ? ' - renews automatically on use' : account.expiresAt ? ` - access token expires ${account.expiresAt}` : ''}${account.detail ? ` - ${account.detail}` : ''}\n`);
    return accounts.some((account) => account.status === 'error') ? 1 : 0;
  }
  if (command === 'provider') {
    const [action, id] = args;
    if (args.length !== 2 || !['add', 'remove'].includes(action) || !/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw new UsageError('provider needs add|remove and a provider ID');
    if (action === 'add' && (!values['base-url'] || !values.api || Boolean(values.models) === Boolean(values.discover))) throw new UsageError('provider add requires --base-url, --api and exactly one of --models or --discover');
    try {
      if (action === 'remove') await auth.removeProvider(id);
      else {
        const key = await readApiKey(stdin, stderr);
        const definition = { id, label: values.label ?? id, baseUrl: values['base-url'], api: values.api };
        const models = values.discover ? (await auth.discoverModels({ ...definition, key })).models : values.models.split(',').map((id) => ({ id: id.trim() }));
        await auth.addProvider({ ...definition, models, key });
      }
      stdout.write(action === 'add' ? 'Provider added. API keys are long-lived and readable by the launched agent.\n' : 'Managed provider removed.\n');
      return 0;
    } catch (err) { stderr.write(`${err.status ? err.message : 'Control operation failed'}\n`); return 1; }
  }
  const provider = Object.hasOwn(aliases, args[0]) ? aliases[args[0]] : args[0];
  if (args.length !== 1 || typeof provider !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(provider)) throw new UsageError(`${command} needs one provider ID`);
  if (command === 'login' && (values['api-key'] || provider === 'google')) {
    try {
      await auth.setApiKey(provider, await readApiKey(stdin, stderr));
      stdout.write('API key stored. API keys are long-lived and readable by the launched agent.\n'); return 0;
    } catch (err) { stderr.write(`${err.status ? err.message : 'Control operation failed'}\n`); return 1; }
  }
  if (command === 'login' && !['anthropic', 'openai'].includes(provider)) throw new UsageError('Use --api-key for this provider');
  if (command === 'logout') {
    try { await auth.logout(provider); stdout.write('Stored credential removed. Environment API keys, if set, remain active.\n'); return 0; }
    catch (err) { stderr.write(`${err.status ? err.message : 'Control operation failed'}\n`); return 1; }
  }
  const lines = [];
  const rl = createInterface({ input: stdin });
  rl.on('line', (line) => lines.push(line));
  let lastUrl, lastState;
  const { id } = auth.startLogin(provider);
  const off = onInterrupt(() => { void auth.cancel(id); });
  try {
    for (;;) {
      const session = auth.getLogin();
      if (session.authUrl && session.authUrl !== lastUrl) { lastUrl = session.authUrl; stdout.write(`Sign in: ${lastUrl}\n`); }
      if (session.state === 'waiting_code' && lastState !== session.state) stdout.write('Paste the authorization code / final redirect URL, or complete sign-in in your browser:\n');
      lastState = session.state;
      if (session.state === 'waiting_code' && lines.length) auth.input(id, lines.shift());
      if (['done', 'failed', 'cancelled'].includes(session.state)) {
        await auth.waitForLogin();
        stdout.write(`${session.state === 'done' ? 'Signed in.' : session.error ?? 'Sign-in cancelled.'}\n`);
        return session.state === 'done' ? 0 : 1;
      }
      await sleep(50);
    }
  } catch { stderr.write('Sign-in failed; try again.\n'); return 1; }
  finally { off(); rl.close(); await auth.close(); }
}

function cmdProjects(command, args, values, config, { stdout }) {
  const registry = createProjectRegistry({ dataDir: config.dataDir ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), '.local', 'share'), 'dev.scranton.desktop') });
  if (command === 'chats') {
    if (args.length !== 1) throw new UsageError('chats needs a project ID');
    stdout.write(JSON.stringify({ chats: registry.listChats(args[0]) }, null, 2) + '\n');
  } else if (args[0] === 'list' && args.length === 1) stdout.write(JSON.stringify({ projects: registry.listProjects() }, null, 2) + '\n');
  else if (args[0] === 'add' && args.length === 2) stdout.write(JSON.stringify({ project: registry.addProject({ name: args[1], workspace: values.workspace && path.resolve(config.cwd, values.workspace), create: values.create }) }, null, 2) + '\n');
  else if (args[0] === 'remove' && args.length === 2) { registry.removeProject(args[1], { deleteHistory: values['delete-history'] }); stdout.write('Project removed. Workspace files were not changed.\n'); }
  else throw new UsageError('projects needs list|add <name>|remove <id>');
  return 0;
}

async function cmdRun(request, values, config, { stdout, stderr, env, begin }) {
  if (!request.trim()) throw new UsageError('run needs a request, e.g. scranton run "Build a todo CLI"');
  let acquire = acquireRunLease;
  if (!config.dataDir && (values.project || values.chat)) throw new UsageError('--project and --chat require --data');
  let threadContext = '';
  if (values['thread-context']) {
    try {
      const file = path.resolve(config.cwd, values['thread-context']);
      if (statSync(file).size > 65536) throw Error();
      const context = JSON.parse(readFileSync(file, 'utf8'));
      if (context.v !== 1 || typeof context.text !== 'string' || context.text.length > 8000) throw Error();
      threadContext = context.text;
    } catch { throw new UsageError('Invalid thread context file'); }
  }
  if (config.dataDir) {
    if (!values.project) throw new UsageError('--data run requires --project');
    if (values.hive || values.workspace) throw new UsageError('Registry runs use the project workspace and chat hive');
    const registry = createProjectRegistry({ dataDir: config.dataDir });
    const project = registry.getProject(values.project);
    const chat = values.chat ? registry.getChat(project.id, values.chat) : registry.createChat(project.id, { title: derivedChatTitle(request) });
    if (!values['thread-context']) threadContext = formatThreadContext(listRuns(chat.hiveDir), { maxChars: 8000 });
    config = loadConfig({ cwd: PACKAGE_ROOT, env, flags: { ...toFlags(values), config: undefined, workspace: project.workspace, hive: chat.hiveDir } });
    acquire = (hive, info) => registry.locked(() => {
      registry.getChat(project.id, chat.id);
      if (readRunLease(hive)) throw Object.assign(Error('Chat is already owned'), { code: 'EEXIST' });
      const running = registry.listProjects().flatMap((p) => registry.listChats(p.id)).filter((c) => readRunLease(c.hiveDir)).length;
      if (running >= config.maxConcurrentRuns) throw Object.assign(Error('too_many_runs'), { status: 429 });
      return acquireRunLease(hive, info);
    });
    registry.updateChat(project.id, chat.id, {});
  }
  const orchestrator = new Orchestrator({
    config,
    threadContext,
    noPlan: Boolean(values['no-plan']),
    onBreaker: policyOf(values, config),
    listener: createTerminalLog({ stream: stdout, env }),
    extraEnv: env,
    stdout
  });
  await begin();
  return execute(orchestrator, request, { stderr, env, acquire });
}

async function cmdDemo(values, { stdout, stderr, env, cwd, begin }) {
  const scenario = values.scenario ?? 'flaky';
  if (!SCENARIOS.includes(scenario)) throw new UsageError(`--scenario must be one of: ${SCENARIOS.join(', ')}`);
  const delay = Number(values.delay ?? 600);
  if (!Number.isFinite(delay) || delay < 0) throw new UsageError('--delay must be a number of milliseconds');
  const flags = { ...toFlags(values), workspace: values.workspace ?? 'demo-workspace' };
  const config = loadConfig({ cwd, env, flags });
  config.pi = { ...config.pi, command: [process.execPath, path.join(PACKAGE_ROOT, 'tools', 'fake-pi.js')], commandSource: 'config' };
  config.execution.sandbox.mode = 'host';
  config.execution.simulated = true;
  config.pi.transport = 'rpc';
  stdout.write(`Simulated trusted-host demo with the fake pi - scenario "${scenario}", ${delay} ms between steps.\n`);
  const orchestrator = new Orchestrator({
    config,
    noPlan: Boolean(values['no-plan']),
    onBreaker: policyOf(values, config),
    listener: createTerminalLog({ stream: stdout, env }),
    extraEnv: { ...env, FAKE_PI_SCENARIO: scenario, FAKE_PI_DELAY_MS: String(delay) },
    stdout
  });
  await begin();
  return execute(orchestrator, 'Build a tiny todo CLI', { stderr, env });
}

async function cmdAgent(agentId, task, config, { stdout, stderr, env, begin }) {
  if (!AGENT_IDS.includes(agentId)) throw new UsageError(`agent needs one of: ${AGENT_IDS.join(', ')}`);
  if (!task.trim()) throw new UsageError(`agent ${agentId} needs a task, e.g. scranton agent ${agentId} "say hi"`);
  // Standalone agents retain the same lease and sandbox guarantees as a run.
  const orchestrator = new Orchestrator({ config, noPlan: true, extraEnv: env, stdout,
    listener: createTerminalLog({ stream: stdout, env }) });
  orchestrator.standaloneAgent = agentId;
  await begin();
  return execute(orchestrator, task, { stderr, env });
}

async function loadUiModule(rel, what, stderr) {
  const file = path.join(PACKAGE_ROOT, rel);
  try {
    return await import(pathToFileURL(file).href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(path.basename(file))) {
      stderr.write(`scranton: the ${what} is not available (missing ${rel}). Is this checkout complete?\n`);
      return null;
    }
    throw err;
  }
}

async function cmdDashboard(values, config, { stdout, stderr }) {
  const mod = await loadUiModule('src/dashboard/index.js', 'terminal dashboard', stderr);
  if (!mod) return 1;
  await mod.runDashboard({ hiveDir: config.hiveDir, once: Boolean(values.once), ascii: Boolean(values.ascii), stdout });
  return 0;
}

async function cmdVisualize(values, config, { stdout, stderr, env }, app = false) {
  const mod = await loadUiModule('src/server/visualizer-server.js', 'visualizer server', stderr);
  if (!mod) return 1;
  const port = values.port === undefined ? (app ? 0 : 1725) : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be 0-65535');
  const host = app ? '127.0.0.1' : values.host ?? '127.0.0.1';
  if ((app || values.control || config.dataDir) && host.toLowerCase() !== 'localhost' && !isLoopbackAddress(host)) {
    throw new UsageError('--control requires a loopback --host (localhost, 127.x.x.x or ::1)');
  }
  let server;
  try {
    server = await mod.startVisualizerServer({
      hiveDir: config.hiveDir,
      dataDir: config.dataDir,
      maxConcurrentRuns: config.maxConcurrentRuns,
      legacyWorkspace: values['legacy-workspace'],
      publicDir: path.join(PACKAGE_ROOT, 'visualizer', 'public'),
      port,
      host,
      control: app || values.control || config.dataDir ? { workspace: config.workspace, gates: values.gates } : undefined
    });
  } catch (err) {
    if (err?.name !== 'ServerStartError') throw err;
    stderr.write(`${styler(stderr, env).red('scranton:')} ${err.message}\n`);
    return 1;
  }
  if (app) stdout.write(`${JSON.stringify({ ready: true, url: server.url, pid: process.pid, hive: config.hiveDir, workspace: config.workspace })}\n`);
  else stdout.write(`Visualizer running at ${server.url}\nWatching ${config.hiveDir} - press Ctrl+C to stop.\n`);
  await new Promise((resolve) => {
    let rl;
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      rl?.removeAllListeners('close');
      rl?.close();
      if (app) process.stdin.destroy();
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    if (app) {
      rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => { if (line.trim() === 'quit') done(); });
      rl.once('close', done);
      if (process.stdin.readableEnded) done();
    }
  });
  await server.close();
  return 0;
}

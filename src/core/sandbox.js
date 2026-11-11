import { startAntigravityBroker } from './antigravity/broker.js';
import { activeRoles } from './workflow.js';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createAuthService } from './auth.js';
import { PROVIDER_ENV_NAMES } from './providers.js';
import { findOnPath } from './pi-command.js';

export const CREDENTIAL_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY',
  'CEREBRAS_API_KEY', 'AZURE_OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID',
  ...Object.values(PROVIDER_ENV_NAMES).flat()
]);
const hostEnvNames = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];
const contains = (root, file) => { const rel = path.relative(root, file); return !rel || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

function config(value = {}) {
  for (const key of Object.keys(value)) if (!['mode', 'image', 'network', 'credentialEnvNames'].includes(key)) throw new Error(`Unsupported sandbox setting: ${key}`);
  const result = { mode: 'docker', image: 'scranton-sandbox:1.5.0-r2', network: 'bridge', ...value };
  if (!['host', 'docker'].includes(result.mode)) throw new Error('Sandbox mode must be docker or host');
  if (!['bridge', 'none'].includes(result.network)) throw new Error('Sandbox network must be bridge or none');
  if (typeof result.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(result.image)) throw new Error('Invalid sandbox image');
  const names = result.credentialEnvNames ?? CREDENTIAL_ENV_NAMES;
  if (!Array.isArray(names) || names.some((name) => !CREDENTIAL_ENV_NAMES.includes(name))) throw new Error('Credential environment names must be from the explicit provider allowlist');
  return { ...result, credentialEnvNames: [...new Set(names)] };
}

export function checkedPath(value, directory, { platform = process.platform, fs: hostFs = fs, path: hostPath = path } = {}) {
  const fs = hostFs, path = hostPath;
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[,\r\n\x00]/.test(value)) throw new Error('Sandbox mount paths must be absolute and cannot contain commas or control characters');
  let full = path.resolve(value);
  if (platform === 'darwin') {
    // macOS owns these root aliases; no user-selected link is canonicalized.
    for (const alias of ['/var', '/tmp']) {
      if (full !== alias && !full.startsWith(`${alias}/`)) continue;
      if (fs.lstatSync(alias).isSymbolicLink()) {
        const target = `/private${alias}`;
        if (path.resolve(path.dirname(alias), fs.readlinkSync(alias)) !== target || fs.realpathSync.native(alias) !== target) throw new Error('Sandbox link/reparse mount rejected');
        full = target + full.slice(alias.length);
      }
      break;
    }
  }
  let current = path.parse(full).root;
  for (const part of path.relative(current, full).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) throw new Error('Sandbox link/reparse mount rejected');
  }
  const st = fs.lstatSync(full);
  if (directory ? !st.isDirectory() : !st.isFile() || st.nlink > 1) throw new Error('Invalid sandbox mount type');
  return full;
}

function dockerEnv(source = process.env) {
  return Object.fromEntries(hostEnvNames.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]));
}

async function runDocker(executable, args, env) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { const failure = new Error('Docker command failed or timed out'); failure.code = error.code; reject(failure); }
      else resolve(stdout.trim());
    });
  });
}

export async function checkSandbox(sandbox = {}, { run = runDocker, executable = findOnPath('docker') } = {}) {
  const settings = config(sandbox);
  if (settings.mode === 'host') return { available: true, mode: 'host', reason: 'Explicit trusted-host execution; no container boundary' };
  if (!executable) return { available: false, mode: 'docker', reason: 'Docker CLI not found; install/configure a Linux Docker engine explicitly, or select trusted-host mode' };
  try {
    const engine = await run(executable, ['info', '--format', '{{.OSType}}'], dockerEnv());
    if (engine !== 'linux') return { available: false, mode: 'docker', reason: 'A Linux Docker engine is required' };
  } catch { return { available: false, mode: 'docker', reason: 'Docker is installed but its engine is not responding; start Docker Desktop and try again' }; }
  try {
    const image = await run(executable, ['image', 'inspect', '--format', '{{.Os}}', settings.image], dockerEnv());
    if (image !== 'linux') return { available: false, mode: 'docker', reason: 'A locally available Linux sandbox image is required (no automatic pull)' };
    return { available: true, mode: 'docker', image: settings.image, network: settings.network };
  } catch {
    const recipe = fileURLToPath(new URL('../../sandbox/', import.meta.url)).replace(/[\\/]$/, '');
    return { available: false, mode: 'docker', reason: `Docker sandbox image ${settings.image} is not available locally; build it once: docker build -t ${settings.image} "${recipe}"` };
  }
}

async function removeContainer(executable, name, run) {
  let removalFailed = false;
  try { await run(executable, ['rm', '-f', name], dockerEnv()); } catch { removalFailed = true; }
  const remaining = await run(executable, ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], dockerEnv());
  if (remaining) throw new Error(`Container cleanup could not be verified${removalFailed ? ' after removal failure' : ''}`);
}

export async function cleanupRunContainers(runId, workspaces = [], { run = runDocker, executable = findOnPath('docker') } = {}) {
  const warning = 'Docker is not reachable; containers of this run could not be checked';
  let names;
  try {
    if (!executable) throw Error();
    names = await run(executable, ['container', 'ls', '--all', '--format', '{{.Names}}'], dockerEnv());
  } catch { return [warning]; }
  for (const name of names.split(/\r?\n/).filter((name) => /^scranton-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name))) {
    let container;
    try { [container] = JSON.parse(await run(executable, ['container', 'inspect', name], dockerEnv())); }
    catch { throw Error('Container ownership could not be checked'); }
    const label = container?.Config?.Labels?.['scranton.run'];
    const legacyMatch = !label && container?.Mounts?.some((m) => m.Destination === '/workspace' && workspaces.includes(m.Source));
    if (label === runId || legacyMatch) await removeContainer(executable, name, run);
  }
  return [];
}

export function validateDockerModels(config, roles = activeRoles(config)) {
  if (config.execution?.sandbox?.mode !== 'docker') return;
  const missing = roles.filter((role) => !config.agents[role]?.provider || !config.agents[role]?.model);
  if (missing.length) throw Object.assign(new Error(`Docker requires an explicit provider and model for ${missing.join(', ')}; set the agent default for each role in Agents (pi default cannot be used in the Docker sandbox), or set SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL`), { status: 400 });
}

/** Only private worktree/session directories and exact managed files cross this boundary. */
export async function prepareSandbox(options, dependencies = {}) {
  for (const key of Object.keys(options)) if (!['sandbox', 'workspace', 'sessionDir', 'systemPromptFile', 'extensionFile', 'env', 'instanceId', 'runId', 'cwd', 'inboxFile', 'provider', 'agentTimeoutMinutes'].includes(key)) throw new Error(`Unsupported sandbox launch setting: ${key}`);
  const { sandbox = {}, workspace, sessionDir, systemPromptFile, extensionFile, env = {} } = options;
  const settings = config(sandbox);
  if (settings.mode === 'host') return { cwd: workspace, env, sessionDir, systemPromptFile, extensionFile };
  const antigravity = options.provider === 'google-antigravity';
  if (antigravity && settings.network !== 'bridge') throw new Error('Google Antigravity Docker inference requires bridge networking');
  const executable = dependencies.executable ?? findOnPath('docker');
  const run = dependencies.run ?? runDocker;
  const available = await checkSandbox(settings, { executable, run });
  if (!available.available) throw new Error(available.reason);
  const checkPath = (value, directory) => checkedPath(value, directory, dependencies.pathHost);
  const work = checkPath(workspace, true);
  const session = checkPath(sessionDir, true);
  const prompt = checkPath(systemPromptFile, false);
  const extension = extensionFile ? checkPath(extensionFile, false) : null;
  if (contains(work, session) || contains(session, work)) throw new Error('Workspace and session mounts must be separate');
  const gitFile = path.join(work, '.git');
  if (!fs.lstatSync(gitFile).isFile() || !/^gitdir: /.test(fs.readFileSync(gitFile, 'utf8'))) throw new Error('Docker requires a private Git worktree, not the host repository');
  checkPath(gitFile, false);
  const credentials = { ...env };
  let customModels;
  const credentialNames = [...settings.credentialEnvNames];
  if (options.provider && !antigravity) {
    const auth = dependencies.auth ?? createAuthService({ env });
    const accounts = await auth.listAccounts();
    if (auth.resolveDockerCredential) {
      const account = accounts.find((a) => a.id === options.provider);
      const expected = account?.custom ? `SCRANTON_PROVIDER_${account.id.toUpperCase().replaceAll('-', '_')}_KEY`
        : account?.kind === 'oauth' && account.id === 'anthropic' ? 'ANTHROPIC_OAUTH_TOKEN' : PROVIDER_ENV_NAMES[options.provider]?.[0];
      if (!expected) throw new Error('Provider credential unavailable; sign in again before launching Docker');
      if (!account?.custom && !credentialNames.includes(expected)) throw new Error(`sandbox.credentialEnvNames must include ${expected} for this provider`);
      const minutes = options.agentTimeoutMinutes ?? 20;
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Invalid agent timeout');
      const resolved = await auth.resolveDockerCredential(options.provider, { minExpiryMs: (minutes + 10) * 60000 });
      if (resolved.name !== expected || typeof resolved.value !== 'string' || !resolved.value) throw new Error('Provider credential unavailable; sign in again before launching Docker');
      for (const key of Object.keys(credentials)) delete credentials[key];
      credentials[expected] = resolved.value;
      const metadataNames = options.provider.startsWith('cloudflare-') ? ['CLOUDFLARE_ACCOUNT_ID', ...(options.provider === 'cloudflare-ai-gateway' ? ['CLOUDFLARE_GATEWAY_ID'] : [])] : [];
      for (const [name, value] of Object.entries(resolved.extraEnv ?? {})) {
        if (!metadataNames.includes(name) || !credentialNames.includes(name) || typeof value !== 'string') throw new Error('Provider metadata environment is not allowlisted');
        credentials[name] = value;
      }
      if (account?.custom) { credentialNames.push(expected); customModels = resolved.models; if (!customModels) throw new Error('Missing custom provider models'); }
    } else {
    const selectedNames = PROVIDER_ENV_NAMES[options.provider] ?? [];
    for (const key of Object.keys(credentials)) if (!selectedNames.includes(key)) delete credentials[key];
    for (const account of accounts) {
      if (options.provider !== account.id || account.kind !== 'oauth') continue;
      const tokenEnv = account.id === 'anthropic' ? 'ANTHROPIC_OAUTH_TOKEN' : 'OPENAI_API_KEY';
      if (!settings.credentialEnvNames.includes(tokenEnv)) throw new Error(`sandbox.credentialEnvNames must include ${tokenEnv} for this subscription`);
      const minutes = options.agentTimeoutMinutes ?? 20;
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Invalid agent timeout');
      let token;
      try { token = await auth.mintAccessToken(account.id, { minExpiryMs: (minutes + 10) * 60000 }); }
      catch { throw new Error('Subscription token unavailable; sign in again before launching Docker'); }
      if (typeof token !== 'string' || !token) throw new Error('Subscription token unavailable; sign in again before launching Docker');
      if (account.id === 'anthropic') { delete credentials.ANTHROPIC_API_KEY; delete credentials.ANTHROPIC_AUTH_TOKEN; credentials.ANTHROPIC_OAUTH_TOKEN = token; }
      else credentials.OPENAI_API_KEY = token;
    }
    if (accounts.some((a) => a.id === options.provider && a.status === 'error')) throw new Error('Cannot read subscription credentials; sign in again before launching Docker');
    }
  }
  if (antigravity) for (const key of Object.keys(credentials)) delete credentials[key];
  const brokerExtension = antigravity ? checkPath(fileURLToPath(new URL('./antigravity/docker-extension.js', import.meta.url)), false) : null;
  const name = `scranton-${randomUUID()}`;
  // Mask the host-only worktree pointer. The private repository is never mounted.
  const mask = path.join(path.dirname(prompt), `git-mask-${randomUUID()}`);
  fs.writeFileSync(mask, 'Git metadata is managed outside the container.\n', { flag: 'wx', mode: 0o444 });
  let modelsFile;
  if (customModels) {
    modelsFile = path.join(path.dirname(prompt), `models-${randomUUID()}.json`);
    fs.writeFileSync(modelsFile, `${JSON.stringify(customModels, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  }
  const uid = process.getuid?.() || 10001;
  const gid = process.getgid?.() || uid;
  const args = ['run', '--interactive', '--rm', '--pull=never', '--name', name, '--label', `scranton.run=${options.runId}`,  '--init', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--user', `${uid}:${gid}`, '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--network', settings.network,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777', '--tmpfs', `/home/pi:rw,noexec,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=700`, '--workdir', '/workspace', '--entrypoint', '/usr/local/bin/pi'];
  const mount = (source, target, readonly = false) => args.push('--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`);
  mount(work, '/workspace');
  mount(session, '/session');
  mount(prompt, '/scranton/prompt.md', true);
  if (extension) mount(extension, '/scranton/extension.js', true);
  if (brokerExtension) mount(brokerExtension, '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/scranton-antigravity.mjs', true);
  mount(mask, '/workspace/.git', true);
  if (modelsFile) mount(modelsFile, '/home/pi/.pi/agent/models.json', true);
  args.push('--env', 'HOME=/home/pi', '--env', 'PI_CODING_AGENT_DIR=/home/pi/.pi/agent');
  const launchEnv = dockerEnv();
  for (const key of new Set(credentialNames)) if (typeof credentials[key] === 'string' && credentials[key]) { launchEnv[key] = credentials[key]; args.push('--env', key); }
  for (const key of ['SCRANTON_AGENT', 'SCRANTON_ROLE_KIND', 'SCRANTON_PASS_KEYWORD', 'SCRANTON_FAIL_KEYWORD', 'SCRANTON_CONVERSATION']) if (typeof env[key] === 'string') { launchEnv[key] = env[key]; args.push('--env', key); }
  let broker;
  if (antigravity) {
    const minutes = options.agentTimeoutMinutes ?? 20;
    if (!Number.isFinite(minutes) || minutes <= 0) { fs.rmSync(mask, { force: true }); throw new Error('Invalid agent timeout'); }
    try {
      let brokerHost = '127.0.0.1';
      if (process.platform === 'linux') {
        brokerHost = await run(executable, ['network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', 'bridge'], dockerEnv());
        if (isIP(brokerHost) !== 4) throw new Error('Cannot resolve local Docker bridge for Antigravity broker');
      }
      const auth = dependencies.auth ?? createAuthService({ env });
      try { await auth.mintAccessToken('google-antigravity', { minExpiryMs: 60000 }); }
      catch { throw new Error('Google Antigravity sign-in unavailable; sign in again in Accounts before launching Docker'); }
      broker = await (dependencies.startBroker ?? startAntigravityBroker)({ host: brokerHost, auth, lifetimeMs: (minutes + 10) * 60000 });
    } catch (error) { fs.rmSync(mask, { force: true }); throw error; }
    args.push('--add-host', 'host.docker.internal:host-gateway');
    launchEnv.SCRANTON_ANTIGRAVITY_BROKER = `http://host.docker.internal:${broker.port}/inference`;
    launchEnv.SCRANTON_ANTIGRAVITY_CAPABILITY = broker.capability;
    args.push('--env', 'SCRANTON_ANTIGRAVITY_BROKER', '--env', 'SCRANTON_ANTIGRAVITY_CAPABILITY');
  }
  args.push(settings.image);
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    await broker?.close();
    await removeContainer(executable, name, run);
    fs.rmSync(mask, { force: true });
    if (modelsFile) { fs.chmodSync(modelsFile, 0o600); fs.rmSync(modelsFile, { force: true }); }
  })();
  return {
    spec: { argv: [executable], shell: false, source: 'sandbox', ...(antigravity ? { providerExtension: '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/scranton-antigravity.mjs' } : {}), description: `Docker sandbox (${settings.network} network)` },
    argsPrefix: args, cwd: work, env: launchEnv, systemPromptFile: '/scranton/prompt.md',
    sessionDir: '/session', extensionFile: extension ? '/scranton/extension.js' : undefined, cleanup
  };
}

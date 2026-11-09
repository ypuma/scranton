import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, windowsBashAvailable } from './config.js';
import { execPi, findLocalPi, resolvePiCommand } from './pi-command.js';
import { styler } from './log.js';
import { AGENT_IDS } from './state.js';
import { activeRoles } from './workflow.js';
import { isFile } from './util.js';
import { createAuthService } from './auth.js';
import { probePipeline } from './pipeline-command.js';

/** `a.b.c >= x.y.z` for ranges of the form ">=x.y.z" (the only form our package.json files use). */
export function satisfiesMin(version, range) {
  const min = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(String(range ?? ''));
  if (!min) return true;
  const have = String(version).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== Number(min[i + 1])) return (have[i] ?? 0) > Number(min[i + 1]);
  }
  return true;
}

function writable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.scranton-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
}

/** Environment check. Returns the process exit code (0 = no failures, 1 = at least one). */
export async function runDoctor({ config, env = process.env, stdout = process.stdout, platform = process.platform, auth = createAuthService({ env }) }) {
  const c = styler(stdout, env);
  let failures = 0;
  const report = (level, text) => {
    if (level === 'fail') failures += 1;
    const tag = { ok: c.green('[ ok ]'), warn: c.yellow('[warn]'), fail: c.red('[FAIL]'), info: c.dim('[info]') }[level];
    stdout.write(`${tag} ${text}\n`);
  };

  const ownPkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const nodeOk = satisfiesMin(process.versions.node, ownPkg.engines?.node);
  report(nodeOk ? 'ok' : 'fail', `Node ${process.versions.node} (Scranton needs ${ownPkg.engines?.node})`);

  const local = findLocalPi();
  if (local) {
    const piPkg = JSON.parse(fs.readFileSync(path.join(local.dir, 'package.json'), 'utf8'));
    const piNode = piPkg.engines?.node;
    report(satisfiesMin(process.versions.node, piNode) ? 'ok' : 'fail', `pi ${piPkg.version} needs Node ${piNode ?? '(unspecified)'}`);
  }

  let spec = null;
  try {
    spec = resolvePiCommand({ config, env, platform });
    report('ok', `pi resolved via ${spec.description}`);
  } catch (err) {
    report('fail', err.message);
  }

  if (spec) {
    const v = await execPi(spec, ['--version'], { env });
    if (v.code === 0) report('ok', `pi --version: ${v.stdout.trim().split(/\r?\n/).pop()}`);
    else report('fail', `pi --version failed: ${v.error ?? `exit ${v.code}`} ${v.stderr.trim().slice(0, 200)}`);
  }

  const pipeline = await probePipeline({ env });
  report('warn', pipeline.available ? `Pipeline engine ${pipeline.version} (${pipeline.source}, optional)` : `Pipeline engine (optional): ${pipeline.reason}`);

  if (platform === 'win32') {
    if (windowsBashAvailable(env)) report('ok', "Git Bash found (pi's bash tool works)");
    else report('warn', 'No Git Bash found: pi cannot run its bash tool. Scranton uses the powershell tool by default; install Git for Windows for bash.');
  }

  report('info', config.configPath ? `config file: ${config.configPath}` : 'config file: none (defaults, env and flags only)');
  for (const w of config.warnings) report('warn', w);
  report('info', `maxFailedCycles=${config.maxFailedCycles}, agent timeout=${config.agentTimeoutMinutes} min, minimalContext=${config.pi.minimalContext}`);

  if (config.execution) {
    const { checkSandbox } = await import('./sandbox.js');
    const sandbox = await checkSandbox(config.execution.sandbox);
    report(sandbox.available ? (sandbox.mode === 'host' ? 'warn' : 'ok') : 'fail', sandbox.reason ?? `Sandbox image ready: ${sandbox.image}`);
    report('info', `Execution: ${config.pi.transport}, ${config.execution.isolation}, maxParallel=${config.execution.maxParallel}`);
  }

  for (const account of await auth.listAccounts()) {
    report(account.status === 'error' ? 'warn' : 'info', `${account.label}: ${account.status} (${account.kind ?? 'none'})${account.renewFailedAt ? ` - renewal failed ${account.renewFailedAt}; sign in again` : account.renewsOnUse ? ' - renews automatically on use' : ''}`);
  }

  const checked = new Map();
  for (const id of AGENT_IDS) {
    const a = config.agents[id];
    const model = a.model ? `${a.provider ? `${a.provider}/` : ''}${a.model}${a.thinking ? `:${a.thinking}` : ''}` : "(pi's default)";
    report(isFile(a.skill) ? 'info' : 'fail', `${id}: model ${model}, tools ${a.tools.join(',')}, skill ${a.skill}${isFile(a.skill) ? '' : ' (MISSING)'}`);
    if (!a.model || !spec) continue;
    const key = `${a.provider ?? ''}\n${a.model}`;
    if (!checked.has(key)) {
      const args = ['auth', 'check', '--no-refresh', '--model', a.model, ...(a.provider ? ['--provider', a.provider] : []), '--json'];
      checked.set(key, execPi(spec, args, { env }));
    }
    const r = await checked.get(key);
    let status = null;
    try {
      status = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()).status;
    } catch {
      // not JSON: reported below
    }
    if (status === 'ready') report('ok', `${id}: credentials ready for ${a.model}`);
    else report('fail', `${id}: credentials for ${a.model} are ${status ?? 'unknown'} (sign in or check provider configuration)`);
  }
  const missing = (config.workflowWarning ? [] : activeRoles(config)).filter((id) => !config.agents[id]?.provider || !config.agents[id]?.model);
  if (config.execution?.sandbox?.mode === 'docker' && missing.length) {
    report('warn', `Docker requires an explicit provider and model for ${missing.join(', ')}; choose a model for each role in Options → Models (pi default cannot be used in the Docker sandbox), or set SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL`);
  } else if (!AGENT_IDS.some((id) => config.agents[id].model)) {
    report('warn', 'No model configured: pi will use its own default and credentials were not verified. Set SCRANTON_<AGENT>_MODEL to check them.');
  }

  for (const [label, dir] of [['hive', config.hiveDir], ['workspace', config.workspace]]) {
    try {
      writable(dir);
      report('ok', `${label} writable: ${dir}`);
    } catch (err) {
      report('fail', `${label} not writable: ${dir} (${err.code ?? err.message})`);
    }
  }

  stdout.write(failures ? `\n${c.red(`${failures} problem${failures === 1 ? '' : 's'} found.`)}\n` : `\n${c.green('All good.')}\n`);
  return failures ? 1 : 0;
}

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, windowsBashAvailable } from './config.js';
import { styler } from './log.js';
import { activeRoles } from './workflow.js';
import { isFile } from './util.js';
import { createAuthService } from './auth.js';
import { available } from './sandbox-native/index.js';
import { selectModel } from './agent/model.js';
import { checkSandbox } from './sandbox.js';

export function satisfiesMin(version, range) {
  const min = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(String(range ?? ''));
  if (!min) return true;
  const have = String(version).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== Number(min[i + 1])) return (have[i] ?? 0) > Number(min[i + 1]);
  }
  return true;
}
function onPath(command, env, platform) {
  const value = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  return value.split(platform === 'win32' ? ';' : ':').filter(Boolean).some((dir) =>
    (platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']).some((suffix) => {
      try { const file = path.join(dir.replace(/^"|"$/g, ''), command + suffix); return fs.statSync(file).isFile() && (platform === 'win32' || (fs.accessSync(file, fs.constants.X_OK), true)); } catch { return false; }
    }));
}
function writable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.scranton-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true });
}
export async function runDoctor({ config, env = process.env, stdout = process.stdout, platform = process.platform,
  auth, sandboxAvailable = available, dockerAvailable = checkSandbox }) {
  const ownAuth = !auth; auth ??= createAuthService({ env });
  const c = styler(stdout, env);
  let failures = 0, warnings = 0;
  const report = (level, text) => {
    if (level === 'fail') failures++;
    if (level === 'warn') warnings++;
    const tag = { ok: c.green('[ ok ]'), warn: c.yellow('[warn]'), fail: c.red('[FAIL]'), info: c.dim('[info]') }[level];
    stdout.write(`${tag} ${text}\n`);
  };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    report(satisfiesMin(process.versions.node, pkg.engines?.node) ? 'ok' : 'fail', `Node ${process.versions.node} (Scranton needs ${pkg.engines?.node})`);
    for (const command of ['rg', 'fd']) report(onPath(command, env, platform) ? 'ok' : 'info', onPath(command, env, platform) ? `${command} found on PATH` : `${command} not on PATH; tools use native search fallback`);
    report('info', `PowerShell: ${onPath('pwsh', env, platform) || onPath('powershell', env, platform) ? 'available' : 'not found'}`);
    const sandbox = await sandboxAvailable({ env, platform });
    const mode = config.execution?.sandbox?.mode ?? 'scranton';
    const bash = sandbox.tools?.bash;
    report('info', platform === 'win32' && mode === 'scranton'
      ? `Git Bash: unavailable in the Windows Scranton sandbox: ${bash?.reason ?? 'Low-integrity mode cannot use the host Git Bash object namespace; use powershell'}`
      : `Git Bash: ${platform === 'win32' ? windowsBashAvailable(env) ? 'available' : 'not found' : onPath('bash', env, platform) ? 'bash available' : 'not found'}`);
    report(sandbox.available ? 'ok' : mode === 'scranton' ? 'fail' : 'warn', sandbox.available ? `Native sandbox available (${sandbox.backend})` : `Native sandbox unavailable: ${sandbox.reason}`);
    if (mode === 'host') report('warn', 'Trusted host execution is not OS isolation');
    if (mode === 'docker') {
      const docker = await dockerAvailable(config.execution.sandbox);
      report(docker.available ? 'ok' : 'fail', docker.available ? `Docker tool executor ready: ${docker.image}` : docker.reason);
      report('info', 'Only tools run inside Docker; the agent loop, LLM calls and credentials stay on the host');
    }
    report('info', config.configPath ? `config file: ${config.configPath}` : 'config file: none (defaults, env and flags only)');
    for (const warning of config.warnings ?? []) report('warn', warning);
    report('info', `maxFailedCycles=${config.maxFailedCycles}, agent timeout=${config.agentTimeoutMinutes} min`);
    // listModels waits for the one-time import, but does not resolve or refresh tokens.
    let catalog = { providers: [] }, accounts = [];
    try { catalog = await auth.listModels(); accounts = await auth.listAccounts(); }
    catch { report('fail', 'Could not inspect credentials; check the credential store'); }
    for (const account of accounts) report(account.status === 'error' || account.status === 'expired' ? 'warn' : 'info',
      `${account.label}: ${account.status} (${account.kind ?? 'none'})${account.renewFailedAt ? ` - renewal failed ${account.renewFailedAt}; sign in again` : account.renewsOnUse ? ' - renews automatically on use' : ''}`);
    let automatic;
    try { const m = selectModel({}, { listAccounts: () => accounts }); automatic = { provider: m.provider, model: m.id }; report('ok', `Automatic model: ${m.provider}/${m.id}`); }
    catch { report('warn', 'Automatic model: unavailable; sign in to Claude, ChatGPT, Gemini or Google Antigravity'); }
    for (const id of config.workflowWarning ? [] : activeRoles(config)) {
      try {
      const a = config.agents[id];
      const ref = a.provider || a.model ? { provider: a.provider, model: a.model } : automatic;
      const found = ref && catalog.providers.find((p) => p.id === ref.provider)?.models.some((m) => m.id === ref.model);
      report(found ? 'ok' : 'fail', `${id}: model ${ref ? `${ref.provider}/${ref.model}` : 'Automatic (unavailable)'}${a.thinking ? `:${a.thinking}` : ''}; credentials ${found ? 'ready (offline)' : 'unavailable or model unknown; configure an account and model'}`);
      report(isFile(a.skill) ? 'info' : 'fail', `${id}: tools ${a.tools.join(',')}, skill ${a.skill}${isFile(a.skill) ? '' : ' (MISSING)'}`);
      } catch { report('fail', `${id}: could not inspect role model, tools or skill`); }
    }
  } catch { report('fail', 'Could not inspect Scranton configuration or credentials; check the credential store'); }
  finally { if (ownAuth) await auth.close(); }
  for (const [label, dir] of [['hive', config.hiveDir], ['workspace', config.workspace]]) {
    try { writable(dir); report('ok', `${label} writable: ${dir}`); }
    catch { report('fail', `${label} not writable: ${dir}`); }
  }
  stdout.write(`\n${failures ? c.red(`${failures} problem${failures === 1 ? '' : 's'} found.`) : warnings ? c.yellow(`${warnings} warning${warnings === 1 ? '' : 's'} found; the run can start.`) : c.green('All good.')}\n`);
  return failures ? 1 : 0;
}

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE_ROOT, parseCommandSpec } from './config.js';
import { killTree } from './process-tree.js';
import { credentialsDirectory } from './credentials/store.js';

export function resolvePipelineCommand({ env = process.env, root = PACKAGE_ROOT, platform = process.platform, arch = process.arch } = {}) {
  if (env.SCRANTON_PIPELINE_COMMAND !== undefined) {
    const value = env.SCRANTON_PIPELINE_COMMAND;
    if (typeof value !== 'string' && (!Array.isArray(value) || value.some((a) => typeof a !== 'string'))) throw Error('Invalid SCRANTON_PIPELINE_COMMAND');
    const argv = parseCommandSpec(value, 'SCRANTON_PIPELINE_COMMAND');
    if (!argv?.length || argv.some((a) => !a.trim() || a.includes('\0'))) throw Error('Invalid SCRANTON_PIPELINE_COMMAND');
    return { argv, source: 'env' };
  }
  root = path.resolve(root);
  const runtime = path.join(root, 'engine-runtime'), manifest = path.join(runtime, 'launch.json');
  if (fs.lstatSync(runtime, { throwIfNoEntry: false }) || fs.existsSync(path.join(root, 'packaging-manifest.json'))) {
    if (fs.lstatSync(manifest, { throwIfNoEntry: false })) {
      let launch;
      try { launch = JSON.parse(fs.readFileSync(manifest, 'utf8')); }
      catch { throw Error('Invalid Pipeline launch.json: cannot read launch manifest'); }
      if (!launch || Array.isArray(launch) || launch.schema !== 1 ||
          Object.keys(launch).sort().join(',') !== 'arch,args,executable,platform,schema' ||
          !['win32', 'darwin', 'linux'].includes(launch.platform) || !['x64', 'arm64'].includes(launch.arch)) throw Error('Invalid Pipeline launch.json: unsupported schema or target');
      if (launch.platform !== platform || launch.arch !== arch) throw Error(`Pipeline runtime target mismatch: bundle ${launch.platform}/${launch.arch}, host ${platform}/${arch}`);
      const expected = platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
      if (launch.executable !== expected || !Array.isArray(launch.args) ||
          JSON.stringify(launch.args) !== JSON.stringify(['-I', '-B', 'bootstrap.py'])) throw Error('Invalid Pipeline launch.json: executable or args');
      const exe = bundledFile(runtime, launch.executable), bootstrap = bundledFile(runtime, launch.args[2]);
      return { argv: [exe, '-I', '-B', bootstrap], source: 'bundled' };
    }
    // Old Windows bundles predate launch.json; never bypass a present invalid manifest.
    const legacy = path.join(runtime, 'python/python.exe');
    if (platform === 'win32' && arch === 'x64' && fs.statSync(legacy, { throwIfNoEntry: false })?.isFile()) {
      return { argv: [bundledFile(runtime, 'python/python.exe'), '-m', 'scranton_pipeline'], source: 'bundled' };
    }
    throw Error('Pipeline runtime launch.json is missing; reinstall the packaged runtime');
  }
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw Error(`Unsupported Pipeline runtime target: ${platform}/${arch}`);
  const suffix = platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  for (const venv of ['.scratch/pipeline/venv', 'engine/.venv']) {
    const exe = path.join(root, venv, suffix);
    if (fs.statSync(exe, { throwIfNoEntry: false })?.isFile()) return { argv: [exe, '-m', 'scranton_pipeline'], source: 'dev' };
  }
  throw Error('No bundled or development Pipeline runtime found');
}

function bundledFile(runtime, relative) {
  const file = path.resolve(runtime, relative);
  try {
    const real = fs.realpathSync(file), base = fs.realpathSync(runtime), rel = path.relative(base, real);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(real).isFile()) throw Error();
  } catch { throw Error('Invalid Pipeline launch.json: runtime file missing or outside engine-runtime'); }
  return file;
}

export function pipelineChildEnv(env = process.env) {
  // Do not propagate unrelated provider credentials into the engine or its checks.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !/API_KEY|TOKEN|SECRET|PASSWORD|^SCRANTON_PIPELINE_KEY_|^SCRANTON_PROVIDER_.*_KEY$|^SCRANTON_(RUN_LEASE|PARENT_GUARD)$/i.test(k)));
  if (env.SCRANTON_CREDENTIALS_DIR) childEnv.SCRANTON_CREDENTIALS_DIR = credentialsDirectory({ env });
  return childEnv;
}
export function spawnPipeline(spec, args, env = process.env) {
  // Resume rebinds saved bridge paths after upgrades without rewriting the audited config.
  return spawn(spec.argv[0], [...spec.argv.slice(1), ...args], { cwd: PACKAGE_ROOT, env: {
    ...env, // Includes the same SCRANTON_SANDBOX_HELPER override that Team inherits from Tauri.
    SCRANTON_PIPELINE_COMPLETION_COMMAND: JSON.stringify([process.execPath, path.join(PACKAGE_ROOT, 'tools/pipeline-complete.js')]),
    SCRANTON_PIPELINE_NATIVE_COMMAND: JSON.stringify([process.execPath, path.join(PACKAGE_ROOT, 'tools/pipeline-sandbox.js')]),
  }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
}
export function execPipeline(spec, args, { env = process.env, timeoutMs = 15000, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ code: null, value: null, error: 'Pipeline command cancelled', stderr: '' }); return; }
    const child = spawnPipeline(spec, args, pipelineChildEnv(env));
    let stdout = '', stderr = '', error = null;
    const stop = (message) => { error = message; void killTree(child); };
    const abort = () => stop('Pipeline command cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(args[0] === 'sandbox' && args[1] === 'check'
      ? args[2] === '--mode' && args[3] === 'scranton' ? 'Scranton sandbox did not answer in time' : 'Docker did not answer in time'
      : 'Pipeline command timed out'), timeoutMs);
    child.stdin.on('error', () => {}); child.stdin.end();
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-1024 * 1024); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8192); });
    child.on('error', () => { error = 'Pipeline command could not start'; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      let value = null;
      try { value = JSON.parse(stdout.trim()); } catch {}
      resolve({ code, value, error: error ?? (value ? null : 'Pipeline command returned invalid JSON'), stderr });
    });
  });
}
const probes = new Map();
export async function probePipeline(options = {}) {
  let spec;
  try { spec = resolvePipelineCommand(options); }
  catch (e) { return { available: false, reason: e.message, version: null, source: null }; }
  const key = JSON.stringify(spec.argv);
  if (probes.has(key)) return probes.get(key);
  const pending = execPipeline(spec, ['version'], options).then((r) => {
    const available = r.code === 0 && typeof r.value?.version === 'string';
    if (!available) probes.delete(key);
    return { available, reason: available ? null : r.error ?? 'Pipeline version probe failed', version: available ? r.value.version : null, source: spec.source };
  });
  probes.set(key, pending);
  return pending;
}

export async function probePipelineSandbox(spec, { image, ...options } = {}) {
  const fallback = { default_image: null, docker: { available: false, version: null, reason: 'Pipeline sandbox check is unavailable or returned invalid data (engine upgrade may be required)' }, image: { name: image ?? null, present: false } };
  try {
    const r = await execPipeline(spec, ['sandbox', 'check', ...(image ? ['--image', image] : [])], { timeoutMs: 45000, ...options }), v = r.value;
    if (r.error === 'Docker did not answer in time') return { ...fallback, docker: { ...fallback.docker, reason: r.error } };
    if (r.code !== 0 || typeof v?.default_image !== 'string' || !v.default_image || typeof v.docker?.available !== 'boolean' || typeof v.image?.name !== 'string' || typeof v.image?.present !== 'boolean' || ![null, 'string'].includes(v.docker.version === null ? null : typeof v.docker.version) || ![null, 'string'].includes(v.docker.reason === null ? null : typeof v.docker.reason)) return fallback;
    return { default_image: v.default_image, docker: { available: v.docker.available, version: v.docker.version, reason: v.docker.reason }, image: { name: v.image.name, present: v.image.present } };
  } catch { return fallback; }
}
export function unavailablePipelineNative(reason, platform = process.platform) {
  const mode = () => ({ available: false, reason, backend: null, checkNetwork: null, setupNetworkAllowed: false });
  return { platform, available: false, reason, modes: { low: mode(), strict: mode() } };
}

export async function probePipelineNative(spec, { windowsMode, ...options } = {}) {
  const fallback = 'Scranton sandbox check is unavailable or returned invalid data (engine upgrade may be required)';
  try {
    const r = await execPipeline(spec, ['sandbox', 'check', '--mode', 'scranton', ...(windowsMode ? ['--windows-mode', windowsMode] : [])], {
      // The engine can spend 30 seconds on each mode, plus process cleanup.
      timeoutMs: windowsMode ? 45000 : 90000, ...options,
    });
    const native = r.value?.native;
    if (r.error || r.code !== 0 || typeof native?.platform !== 'string' || !native.platform) {
      return unavailablePipelineNative(r.error === 'Scranton sandbox did not answer in time' ? r.error : fallback);
    }
    const result = unavailablePipelineNative(fallback, native.platform);
    for (const mode of windowsMode ? [windowsMode] : ['low', 'strict']) {
      const p = native[mode], backend = mode === 'low' ? 'low-integrity' : 'appcontainer', checkNetwork = mode === 'low' ? 'allow' : 'none';
      if (p?.protocol !== 1 || p.windows_mode !== mode) continue;
      if (native.platform === 'win32' && p.available === true && p.reason === null && p.backend === backend && p.check_network === checkNetwork && p.setup_network_allowed === (mode === 'low')) {
        result.modes[mode] = { available: true, reason: null, backend, checkNetwork, setupNetworkAllowed: p.setup_network_allowed };
      } else if (p.available === false && typeof p.reason === 'string' && p.reason.trim()) {
        result.modes[mode].reason = p.reason.trim().slice(0, 1024);
      }
    }
    result.available = Object.values(result.modes).some((p) => p.available);
    result.reason = result.available ? null : result.modes[windowsMode ?? 'low'].reason;
    return result;
  } catch { return unavailablePipelineNative(fallback); }
}

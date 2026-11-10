import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE_ROOT, parseCommandSpec } from './config.js';
import { killTree } from './pi-command.js';

export function resolvePipelineCommand({ env = process.env, root = PACKAGE_ROOT } = {}) {
  if (env.SCRANTON_PIPELINE_COMMAND) {
    const argv = parseCommandSpec(env.SCRANTON_PIPELINE_COMMAND, 'SCRANTON_PIPELINE_COMMAND');
    if (!argv?.length || argv.some((a) => !a || a.includes('\0'))) throw Error('Invalid SCRANTON_PIPELINE_COMMAND');
    return { argv, source: 'env' };
  }
  for (const [source, rel] of [['bundled', 'engine-runtime/python/python.exe'], ['dev', '.scratch/pipeline/venv/Scripts/python.exe']]) {
    const exe = path.join(root, rel);
    if (fs.existsSync(exe)) return { argv: [exe, '-m', 'scranton_pipeline'], source };
  }
  throw Error('No bundled or development Pipeline runtime found');
}

export function pipelineChildEnv(env = process.env) {
  // Do not propagate unrelated provider credentials into the engine or its checks.
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/API_KEY|TOKEN|SECRET|PASSWORD|^SCRANTON_PIPELINE_KEY_|^SCRANTON_PROVIDER_.*_KEY$|^SCRANTON_(RUN_LEASE|PARENT_GUARD)$/i.test(k)));
}
export function spawnPipeline(spec, args, env = process.env) {
  return spawn(spec.argv[0], [...spec.argv.slice(1), ...args], { cwd: PACKAGE_ROOT, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
}
export function execPipeline(spec, args, { env = process.env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnPipeline(spec, args, pipelineChildEnv(env));
    let stdout = '', stderr = '', error = null;
    const timer = setTimeout(() => { error = args[0] === 'sandbox' && args[1] === 'check' ? 'Docker did not answer in time' : 'Pipeline command timed out'; void killTree(child); }, timeoutMs);
    child.stdin.on('error', () => {}); child.stdin.end();
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-1024 * 1024); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8192); });
    child.on('error', () => { error = 'Pipeline command could not start'; });
    child.on('close', (code) => {
      clearTimeout(timer);
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

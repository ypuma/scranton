#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { createOwnedDirectory, createSandbox, credentialHardening, credentialLocations, recoverWindowsProfile } from '../src/core/sandbox-native/index.js';

const protocol = 1;
const marker = '.scranton-sandbox-owned';
const windows = process.platform === 'win32';
const unsupported = 'Scranton sandbox for Pipeline is available on Windows only in this version';
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|windir|PATHEXT|PATH|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOME|SCRANTON_SANDBOX_HELPER|SCRANTON_CREDENTIALS_DIR)$/i.test(name)));
// The caller must strip NODE_OPTIONS before Node itself starts. Do not re-export
// any extra environment to host-side helper setup or probe processes.
for (const name of Object.keys(process.env)) if (!Object.hasOwn(env, name)) delete process.env[name];
const system = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1] ?? 'C:\\Windows';
const exe = name => path.join(system, 'System32', name);
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const overlaps = (a, b) => within(a, b) || within(b, a);
const same = (a, b) => path.relative(a, b) === '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validMode = mode => mode === 'low' || mode === 'strict';
const out = value => process.stdout.write(`${JSON.stringify({ protocol, ...value })}\n`);

class Fault extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function requireThat(ok, code, message) { if (!ok) throw new Fault(code, message); }
function absolute(value) {
  requireThat(typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value), 'protocol', 'Expected an absolute local path');
  if (windows) requireThat(/^[a-z]:[\\/]/i.test(value) && !/[:*?"<>|]/.test(value.slice(2)) && !value.slice(3).split(/[\\/]/).some(part => /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)), 'protocol', 'Unsafe Windows path');
  return path.resolve(value);
}
function fileStat(file) { return fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }); }
function directory(dir) {
  requireThat(fileStat(dir)?.isDirectory(), 'ownership', 'Directory must exist and must not be a link');
  for (let current = path.dirname(dir); ; current = path.dirname(current)) {
    requireThat(fileStat(current)?.isDirectory(), 'ownership', 'Directory ancestors must not be links');
    if (path.dirname(current) === current) break;
  }
  requireThat(same(fs.realpathSync.native(dir), dir), 'ownership', 'Directory must use its canonical path');
  return dir;
}
function input(file) {
  directory(path.dirname(file));
  const stat = fileStat(file);
  requireThat(stat?.isFile() && stat.nlink === 1n && stat.size <= 1024n * 1024n, 'protocol', 'Expected a bounded regular control file');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Fault('protocol', 'Invalid control file JSON'); }
}
function newFile(file) {
  directory(path.dirname(file));
  requireThat(!fileStat(file), 'protocol', 'Control output must not already exist');
  return file;
}
function atomic(file, value) {
  const temp = path.join(path.dirname(file), `.pns-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    newFile(file);
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function identity(dir) {
  directory(dir);
  const { dev, ino, birthtimeNs } = fileStat(dir);
  requireThat(ino !== 0n, 'ownership', 'Filesystem does not expose a stable directory identity');
  return `${dev}:${ino}:${birthtimeNs}`;
}
const allocationFile = dir => path.join(path.dirname(dir), `.scranton-sandbox-allocation-${path.basename(dir)}.json`);
function allocate(dir) {
  newFile(dir);
  const proof = newFile(allocationFile(dir));
  createOwnedDirectory(dir);
  try { atomic(proof, { protocol, id: identity(dir) }); }
  catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  return dir;
}
function allocated(dir) {
  const id = identity(dir);
  let proof;
  try { proof = input(allocationFile(dir)); } catch {}
  requireThat(shape(proof, ['protocol', 'id']) && proof.protocol === protocol && proof.id === id, 'ownership', 'Root was not allocated by this runner or has been replaced');
  const ownedMarker = path.join(dir, marker);
  const stat = fileStat(ownedMarker);
  requireThat(stat?.isFile() && stat.nlink === 1n && stat.size === 20n && fs.readFileSync(ownedMarker, 'utf8') === 'scranton-sandbox-v1\n', 'ownership', 'Missing or invalid owned-root marker');
  return id;
}
function readRequest(requestFile, request) {
  requireThat(shape(request, ['protocol', 'root', 'temp_parent', 'cwd', 'argv', 'env', 'network', 'windows_mode', 'deadline_ms', 'receipt', 'record']) && request.protocol === protocol, 'protocol', 'Invalid exec request shape or protocol');
  const { argv, network, windows_mode: mode, deadline_ms: deadline } = request;
  requireThat(validMode(mode) && typeof network === 'boolean', 'protocol', 'Invalid Windows mode or network setting');
  requireThat(Number.isSafeInteger(deadline) && deadline > 0 && deadline <= 0x7fffffff, 'protocol', 'Invalid deadline_ms');
  requireThat(Array.isArray(argv) && argv.length > 0 && argv.every(arg => typeof arg === 'string' && !arg.includes('\0')), 'protocol', 'Expected a nonempty argv array of strings');
  const keys = object(request.env) ? Object.keys(request.env) : [];
  requireThat(object(request.env) && keys.every(key => /^[^=\x00-\x1f]+$/.test(key) && typeof request.env[key] === 'string' && !request.env[key].includes('\0') && (!/^NODE_/i.test(key) || /^NODE_ENV$/i.test(key)) && !/^(SCRANTON_|PI_CODING_AGENT_DIR$)|API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:^|_)AUTH(?:_|$)/i.test(key)) && new Set(keys.map(key => key.toUpperCase())).size === keys.length, 'protocol', 'Invalid payload environment');
  const root = absolute(request.root), cwd = absolute(request.cwd), parent = absolute(request.temp_parent);
  const receipt = absolute(request.receipt), record = absolute(request.record);
  requireThat(within(root, cwd) && !within(root, parent), 'ownership', 'Cwd must be in the allocated root; private temp parent must be disjoint');
  const controls = [requestFile, receipt, record];
  requireThat(controls.every((file, i) => !within(root, file) && !same(file, allocationFile(root)) && !controls.slice(0, i).some(other => same(file, other))), 'ownership', 'Control files must be distinct and outside the sandbox root');
  requireThat(credentialLocations({ env }).every(dir => !within(dir, parent) && ![root, ...controls].some(file => overlaps(file, dir))), 'ownership', 'Sandbox paths must not overlap credentials');
  const rootId = allocated(root);
  directory(cwd); directory(parent); newFile(record);
  requireThat(windows, 'policy', unsupported);
  requireThat(mode !== 'strict' || !network, 'policy', 'Strict sandbox cannot allow setup network access');
  let file = absolute(argv[0]), args = argv.slice(1);
  requireThat(fs.statSync(file, { throwIfNoEntry: false })?.isFile(), 'launch', 'Executable does not exist or is not a regular file');
  if (/\.(cmd|bat)$/i.test(file)) {
    requireThat(args.every(arg => /^[A-Za-z0-9_./:=+,@\\-]+$/.test(arg)) && !/["&|<>^%!\r\n]/.test(file), 'policy', 'Windows shims require simple arguments without whitespace, quotes or shell metacharacters');
    args = ['/d', '/s', '/c', `"${file}"`, ...args];
    file = exe('cmd.exe');
  }
  return { root, rootId, cwd, parent, record, receipt, file, args, mode, deadline, payloadEnv: request.env };
}

function waitChild(child) {
  return new Promise(resolve => {
    let error;
    child.once('error', failure => { error = failure; });
    child.once('close', (code, signal) => resolve({ code, signal, error }));
  });
}
const exited = code => ({ state: 'exited', code, error: null });
const outcome = state => ({ state, code: null, error: null });
const failure = (error, fallback) => ({ state: 'error', code: null, error: { code: error instanceof Fault ? error.code : fallback, message: error instanceof Fault ? error.message : ({ ownership: 'Cannot verify sandbox path ownership', protocol: 'Cannot read or validate exec request', policy: 'Native sandbox setup failed; verify the helper and sandbox paths', launch: 'Native helper could not launch or report the tool exit', cleanup: 'Native sandbox cleanup failed; retry recovery' })[fallback] } });

async function execute(requestFile, started) {
  let receipt, request, r, sandbox, temp, state, status, record, child, timer, stopState, warning;
  const deadline = () => { if (r && performance.now() - started >= r.deadline) stop('timed_out'); };
  function stop(reason) {
    stopState ??= reason;
    child?.kill('SIGKILL');
  }
  const stopped = () => stop('stopped');
  try {
    request = input(requestFile);
    if (object(request)) {
      // A receipt target is still useful for invalid requests, but never follow
      // a link, replace a file or publish through the proposed writable root.
      const candidate = newFile(absolute(request.receipt));
      let proposedRoot;
      try { proposedRoot = absolute(request.root); } catch {}
      requireThat(!proposedRoot || !within(proposedRoot, candidate), 'ownership', 'Receipt must stay outside the proposed writable root');
      const credentials = credentialLocations({ env });
      requireThat(!credentials.some(dir => overlaps(dir, candidate)), 'ownership', 'Receipt overlaps credentials');
      receipt = candidate;
    }
    r = readRequest(requestFile, request);
    process.stdin.once('data', stopped).once('end', stopped).once('error', stopped).resume();
    timer = setTimeout(() => stop('timed_out'), Math.max(0, r.deadline - (performance.now() - started)));
    await yieldIO();
    deadline();
    if (!stopState) {
      await credentialHardening({ runId: 'pipeline', discardUnchanged: true })(env).catch(() => { throw new Fault('policy', 'Cannot harden Scranton credential store; verify its path and helper'); });
      temp = createOwnedDirectory(path.join(r.parent, `pns-temp-${randomUUID()}`));
      status = newFile(path.join(path.dirname(r.record), `.pns-status-${randomUUID()}`));
      sandbox = createSandbox({
        worktree: r.root, tempDir: temp, windowsMode: r.mode, network: r.mode === 'low', env, pipelineStatus: status,
        beforeProfileCreate: name => {
          atomic(r.record, { protocol, name, root: r.root, root_id: r.rootId, temp, temp_id: identity(temp), status });
          record = r.record;
        },
      });
      try { sandbox.prepare(); }
      catch (error) {
        if (error.code === 'SANDBOX_WORKSPACE_LINK') throw new Fault('workspace_link', 'The workspace contains a link or junction. Use Docker for projects with links or junctions.');
        throw new Fault('policy', 'Native sandbox setup failed; verify the helper and sandbox paths');
      }
      await yieldIO();
      deadline();
    }
    if (stopState) state = outcome(stopState);
    else {
      // Inherit the outer streams directly; never buffer or decode payload data here.
      child = sandbox.spawn(r.file, r.args, { cwd: r.cwd, env: r.payloadEnv, stdio: ['ignore', 'inherit', 'inherit'] });
      const result = await waitChild(child);
      child = undefined;
      deadline();
      if (stopState) state = outcome(stopState);
      else if (!result.error && !result.signal && Number.isInteger(result.code) && fileStat(status)?.isFile() && fs.readFileSync(status, 'utf8') === 'exited\n') state = exited(result.code);
      else state = failure(null, 'launch');
    }
  } catch (error) { state = failure(error, r ? 'launch' : 'protocol'); }
  finally {
    clearTimeout(timer);
    process.stdin.pause();
    try {
      if (await sandbox?.dispose() === false) warning = 'ace_cleanup_incomplete';
      if (record) fs.unlinkSync(record); // Profile reap succeeded even if ACE cleanup was partial.
      if (temp) fs.rmSync(temp, { recursive: true });
      if (status) fs.rmSync(status, { force: true });
    } catch { state = failure(null, 'cleanup'); }
  }
  if (!receipt) throw new Error('No safe receipt target');
  atomic(receipt, { protocol, ...state, ...(warning ? { warning } : {}) });
}

function recover(record) {
  directory(path.dirname(record));
  if (!fileStat(record)) return { recovered: false };
  const value = input(record);
  requireThat(windows && shape(value, ['protocol', 'name', 'root', 'root_id', 'temp', 'temp_id', 'status']) && value.protocol === protocol && typeof value.name === 'string' && /^scranton_[a-f0-9]{32}$/.test(value.name), 'protocol', 'Invalid strict recovery record');
  const root = absolute(value.root), temp = absolute(value.temp), status = absolute(value.status);
  requireThat(!overlaps(root, temp) && ![root, temp].some(dir => [record, status].some(file => within(dir, file))) && same(path.dirname(record), path.dirname(status)) && /^\.pns-status-[0-9a-f-]{36}$/.test(path.basename(status)) && /^pns-temp-[0-9a-f-]{36}$/.test(path.basename(temp)), 'ownership', 'Unsafe recovery record paths');
  requireThat(credentialLocations({ env }).every(dir => ![root, temp, record, status].some(file => overlaps(dir, file))), 'ownership', 'Recovery paths overlap credentials');
  const roots = [];
  let incomplete = false;
  try {
    if (fileStat(root)) {
      // Use host-side identity, not the writable marker.
      const proof = input(allocationFile(root));
      requireThat(proof.protocol === protocol && proof.id === value.root_id && identity(root) === value.root_id, 'ownership', 'Recovery root identity changed');
      roots.push(root);
    }
  } catch { incomplete = true; }
  try {
    if (fileStat(temp)) {
      requireThat(identity(temp) === value.temp_id, 'ownership', 'Recovery temp identity changed');
      roots.push(temp);
    }
  } catch { incomplete = true; }
  if (!recoverWindowsProfile(value.name, roots, { env })) incomplete = true;
  fs.unlinkSync(record);
  if (roots.includes(temp)) fs.rmSync(temp, { recursive: true });
  fs.rmSync(status, { force: true });
  return { recovered: true, ...(incomplete ? { warning: 'ace_cleanup_incomplete' } : {}) };
}

const ps = exe('WindowsPowerShell/v1.0/powershell.exe');
const psArgs = script => ['-NoProfile', '-NonInteractive', '-Command', script];
async function canary(launch, script, cwd) {
  const canaryEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(SCRANTON_)/i.test(name)));
  const child = launch(ps, psArgs(script), { cwd, env: canaryEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  child.stdout.on('data', chunk => { if (stdout.length < 4096) stdout += chunk; });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { return { ...await waitChild(child), stdout }; } finally { clearTimeout(timer); }
}
async function probe(mode, scratch) {
  const base = { available: false, backend: null, windows_mode: mode, check_network: null, setup_network_allowed: false };
  if (!windows) return { ...base, reason: unsupported };
  let sandbox, fixture, server, result, stage = 'Cannot create a private Windows sandbox probe fixture';
  try {
    directory(scratch);
    requireThat(credentialLocations({ env }).every(dir => !within(dir, scratch)), 'ownership', 'Probe scratch must not be inside credentials');
    fixture = fs.mkdtempSync(path.join(scratch, 'pns-probe-'));
    const worktree = createOwnedDirectory(path.join(fixture, 'work'));
    const tempDir = createOwnedDirectory(path.join(fixture, 'temp'));
    const outside = path.join(fixture, 'outside');
    fs.writeFileSync(outside, 'unchanged');
    const literal = value => `'${value.replaceAll("'", "''")}'`;
    const inside = path.join(worktree, 'inside');
    let script = `$ErrorActionPreference='Stop'; Set-Content -LiteralPath ${literal(inside)} -Value 'inside'; try { Set-Content -LiteralPath ${literal(outside)} -Value 'modified'; exit 19 } catch [System.UnauthorizedAccessException] { Write-Output 'WRITE_BLOCKED' };`;
    if (mode === 'strict') {
      stage = 'Windows sandbox probe could not establish its host loopback control';
      let accepts = 0;
      server = createServer(socket => { accepts++; socket.on('error', () => {}); socket.end(); });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const connect = `$c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',${server.address().port})`;
      const positive = await canary(spawn, `$ErrorActionPreference='Stop'; ${connect}; Write-Output 'CONNECTED'; $c.Dispose()`, worktree);
      requireThat(positive.code === 0 && positive.stdout.trim() === 'CONNECTED' && accepts === 1, 'policy', stage);
      script += ` $c=New-Object Net.Sockets.TcpClient; try { $attempt=$c.ConnectAsync('127.0.0.1',${server.address().port}); if ($attempt.Wait(1200)) { exit 20 } } catch { if ($_.Exception.GetBaseException().SocketErrorCode -notin @('AccessDenied','TimedOut')) { exit 21 } } finally { $c.Dispose() }; Write-Output 'NETWORK_BLOCKED'; exit 0`;
      stage = 'Cannot prepare strict Windows AppContainer; verify the helper and Windows AppContainer support';
      sandbox = createSandbox({ worktree, tempDir, windowsMode: mode, network: false, env, pipelineStatus: path.join(fixture, 'status'), beforeProfileCreate: name => atomic(path.join(fixture, 'probe-profile.json'), { protocol, name }) });
      sandbox.prepare();
      stage = 'Strict Windows sandbox canary failed its filesystem or loopback boundary';
      const check = await canary(sandbox.spawn, script, worktree);
      requireThat(check.code === 0 && check.stdout.trim().replaceAll('\r', '') === 'WRITE_BLOCKED\nNETWORK_BLOCKED' && accepts === 1, 'policy', stage);
    } else {
      stage = 'Cannot prepare Windows Low sandbox; verify the helper and Windows Low integrity support';
      sandbox = createSandbox({ worktree, tempDir, windowsMode: mode, env, pipelineStatus: path.join(fixture, 'status') });
      sandbox.prepare();
      stage = 'Windows Low sandbox canary failed its filesystem boundary';
      const check = await canary(sandbox.spawn, script + 'exit 0', worktree);
      requireThat(check.code === 0 && check.stdout.trim() === 'WRITE_BLOCKED', 'policy', stage);
    }
    requireThat(fs.readFileSync(inside, 'utf8').trim() === 'inside' && fs.readFileSync(outside, 'utf8') === 'unchanged', 'policy', stage);
    result = { ...base, available: true, backend: mode === 'low' ? 'low-integrity' : 'appcontainer', check_network: mode === 'low' ? 'allow' : 'none', setup_network_allowed: mode === 'low', reason: null };
  } catch { result = { ...base, reason: stage }; }
  finally {
    server?.close();
    try { await sandbox?.dispose(); if (fixture) fs.rmSync(fixture, { recursive: true }); }
    catch { result = { ...base, reason: 'Windows sandbox probe cleanup failed' }; }
  }
  return result;
}

function flags(verb, args) {
  const required = ({ probe: ['--windows-mode', '--scratch'], allocate: ['--path'], exec: ['--request'], recover: ['--record'] })[verb];
  requireThat(Array.isArray(required) && args.length === (required.length + 1) * 2, 'protocol', 'Invalid verb or flags');
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    requireThat(!options.has(args[i]) && (args[i] === '--protocol' || required.includes(args[i])), 'protocol', 'Unexpected or duplicate flag');
    options.set(args[i], args[i + 1]);
  }
  requireThat(options.get('--protocol') === '1', 'protocol', 'Unsupported protocol');
  return options;
}

try {
  const started = performance.now();
  const [verb, ...args] = process.argv.slice(2);
  const options = flags(verb, args);
  switch (verb) {
    case 'probe': {
      const mode = options.get('--windows-mode');
      requireThat(validMode(mode), 'protocol', 'Invalid Windows mode');
      out(await probe(mode, absolute(options.get('--scratch'))));
      break;
    }
    case 'allocate': out({ path: allocate(absolute(options.get('--path'))), marker }); break;
    case 'exec': await execute(absolute(options.get('--request')), started); break;
    case 'recover': out(recover(absolute(options.get('--record')))); break;
  }
} catch { process.exitCode = 1; }

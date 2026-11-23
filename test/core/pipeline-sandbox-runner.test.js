import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveSandboxHelper } from '../../src/core/sandbox-native/index.js';

const win = process.platform === 'win32';
const windows = { skip: !win && 'Windows token, Job and AppContainer integration' };
const base = path.resolve('.scratch/pns-runner');
const script = path.resolve('tools/pipeline-sandbox.js');
const marker = '.scranton-sandbox-owned';
const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const powershell = code => [ps, '-NoProfile', '-NonInteractive', '-Command', code];
const node = code => [process.execPath, '-e', code];
const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
fs.mkdirSync(base, { recursive: true });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(base, 'runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SYSTEMROOT|WINDIR|PATHEXT|PATH|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOME)$/i.test(key)));
  const helper = win ? resolveSandboxHelper() : null;
  if (helper) env.SCRANTON_SANDBOX_HELPER = helper;
  env.SCRANTON_CREDENTIALS_DIR = path.join(dir, 'credentials');
  env.PI_CODING_AGENT_DIR = path.join(dir, 'pi');
  fs.mkdirSync(env.SCRANTON_CREDENTIALS_DIR);
  const control = path.join(dir, 'control');
  const temp = path.join(dir, 'temp');
  fs.mkdirSync(control); fs.mkdirSync(temp);
  const root = path.join(dir, 'work tree');
  const run = (verb, ...args) => spawnSync(process.execPath, [script, verb, '--protocol', '1', ...args], { env, encoding: 'utf8', timeout: 15000 });
  assert.deepEqual(JSON.parse(run('allocate', '--path', root).stdout), { protocol: 1, path: root, marker });
  let count = 0;
  return { dir, env, helper, control, root, run, request(patch = {}) {
    const id = ++count;
    const file = path.join(control, `request-${id}`);
    const receipt = path.join(control, `receipt-${id}`);
    const record = path.join(control, `record-${id}`);
    const value = { protocol: 1, root, temp_parent: temp, cwd: root, argv: node('process.exit(0)'), env: Object.fromEntries(Object.entries(env).filter(([key]) => !/^(SCRANTON_|PI_)/.test(key))), network: false, windows_mode: 'low', deadline_ms: 10000, receipt, record, ...patch };
    fs.writeFileSync(file, JSON.stringify(value));
    return { file, value, receipt, record, launch(extraEnv = {}) {
      const child = spawn(process.execPath, [script, 'exec', '--protocol', '1', '--request', file], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      const done = capture(child).then(result => ({ ...result, receipt: fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null }));
      return { child, done };
    } };
  } };
}
function capture(child) {
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  return once(child, 'close').then(([code, signal]) => ({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
}
const exited = code => ({ protocol: 1, state: 'exited', code, error: null });
function assertRunner(result, expected) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 0, result.stderr.toString());
  assert.deepEqual(result.receipt, expected);
}
function findPid(child) {
  return new Promise((resolve, reject) => {
    let text = '';
    function data(chunk) {
      text += chunk;
      const match = /^(\d+)\r?\n/.exec(text);
      if (match) { clearTimeout(timer); child.stdout.off('data', data); resolve(Number(match[1])); }
    }
    const timer = setTimeout(() => reject(new Error(`Tool did not report its child PID: ${text}`)), 6000);
    child.stdout.on('data', data);
    child.once('close', () => { clearTimeout(timer); reject(new Error(`Runner closed without a child PID: ${text}`)); });
  });
}
async function assertDead(pid) {
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(20);
  }
  assert.fail(`Tool descendant ${pid} survived`);
}
const tree = node(`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); c.on('spawn',()=>console.log(c.pid)); setInterval(()=>{},1000);`);

test('protocol rejects unknown versions/flags, malformed files, forged ownership, and unsafe destinations', async t => {
  const f = fixture(t);
  const bad = f.run('allocate', '--path', 'relative');
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.equal(bad.stderr, '');
  assert.equal(f.run('probe', '--windows-mode', 'strict', '--scratch', f.dir, '--protocol', '2').status, 1);
  const other = path.join(f.dir, 'forged'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, marker), 'scranton-sandbox-v1\n');
  for (const [patch, classification] of [
    [{ protocol: 2 }, 'protocol'], [{ cwd: f.dir }, 'ownership'], [{ root: other, cwd: other }, 'ownership'],
    [{ windowsVerbatimArguments: true }, 'protocol'], [{ shell: true }, 'protocol'],
    [{ env: { A: 1 } }, 'protocol'], [{ env: { PATH: 'a', Path: 'b' } }, 'protocol'],
    [{ env: { SCRANTON_PIPELINE_KEY_PLANNER: 'fake' } }, 'protocol'], [{ env: { node_options: 'unused' } }, 'protocol'], [{ deadline_ms: 0 }, 'protocol'],
  ]) {
    const result = await f.request(patch).launch().done;
    assert.equal(result.code, 0); assert.equal(result.stdout.length + result.stderr.length, 0);
    assert.equal(result.receipt.state, 'error'); assert.equal(result.receipt.error.code, classification);
  }
  const malformed = f.request(); fs.writeFileSync(malformed.file, '{malformed');
  assert.equal((await malformed.launch().done).code, 1);
  const sentinel = path.join(f.control, 'do-not-overwrite'); fs.writeFileSync(sentinel, 'original');
  assert.equal((await f.request({ receipt: sentinel }).launch().done).code, 1);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original');
  assert.equal((await f.request({ receipt: path.join(f.root, 'not-a-receipt') }).launch().done).code, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'not-a-receipt')), false);
  fs.renameSync(f.root, `${f.root}-old`); fs.mkdirSync(f.root);
  fs.copyFileSync(path.join(`${f.root}-old`, marker), path.join(f.root, marker));
  assert.equal((await f.request().launch().done).receipt.error.code, 'ownership');
});

test('allocate is exclusive and refuses linked paths/parents', (t) => {
  const f = fixture(t);
  assert.equal(f.run('allocate', '--path', f.root).status, 1);
  const target = path.join(f.dir, 'target'); fs.mkdirSync(target);
  const link = path.join(f.dir, 'link'); fs.symlinkSync(target, link, win ? 'junction' : 'dir');
  assert.equal(f.run('allocate', '--path', link).status, 1);
  assert.equal(f.run('allocate', '--path', path.join(link, 'child')).status, 1);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('probe returns exact mode-specific readiness; unsupported hosts fail closed', t => {
  const f = fixture(t);
  if (win) assert.ok(f.helper, 'Build the Windows helper before testing');
  for (const mode of ['low', 'strict']) {
    const start = performance.now();
    const result = f.run('probe', '--windows-mode', mode, '--scratch', f.dir);
    t.diagnostic(`${mode} probe: ${Math.round(performance.now() - start)} ms`);
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    const low = mode === 'low';
    assert.deepEqual(JSON.parse(result.stdout), { protocol: 1, available: win, backend: win ? (low ? 'low-integrity' : 'appcontainer') : null, windows_mode: mode, check_network: win ? (low ? 'allow' : 'none') : null, setup_network_allowed: win && low, reason: win ? null : 'Scranton sandbox for Pipeline is available on Windows only in this version' });
  }
  assert.ok(!fs.readdirSync(f.dir).some(name => name.startsWith('pns-probe-')));
});

test('exited 124 and 125 are normal; a real CreateProcess failure is silent and typed', windows, async t => {
  const f = fixture(t);
  for (const code of [0, 124, 125]) assertRunner(await f.request({ argv: node(`process.exit(${code})`) }).launch().done, exited(code));
  const invalid = path.join(f.dir, 'not-an-exe.exe'); fs.writeFileSync(invalid, 'not PE');
  const result = await f.request({ argv: [invalid] }).launch().done;
  assert.equal(result.receipt?.error.code, 'launch');
  assertRunner(result, { protocol: 1, state: 'error', code: null, error: result.receipt.error });
  const relative = await f.request({ argv: ['node'] }).launch().done;
  assert.equal(relative.receipt?.error.code, 'protocol');
});

test('byte-exact concurrent stdout/stderr, payload-only env and private TEMP', windows, async t => {
  const f = fixture(t);
  const r = f.request({ argv: node(`const fs=require('node:fs'); if(Object.keys(process.env).map(k=>k.toUpperCase()).sort().join(',') !== 'NODE_ENV,ONLY_PAYLOAD,SYSTEMROOT,TEMP,TMP,TMPDIR,WINDIR' || process.env.NODE_ENV !== 'test' || process.env.ONLY_PAYLOAD !== 'visible' || process.env.TEMP !== process.env.TMP || !fs.existsSync(process.env.TEMP+'\\\\.scranton-sandbox-owned')) process.exit(42); process.stdout.write(Buffer.alloc(524288,0x00)); process.stderr.write(Buffer.alloc(655360,0xff));`) });
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  r.value.env = { NODE_ENV: 'test', ONLY_PAYLOAD: 'visible', SystemRoot: system, windir: system, TEMP: 'ignored' };
  fs.writeFileSync(r.file, JSON.stringify(r.value));
  const result = await r.launch({ SCRANTON_PIPELINE_KEY_PLANNER: 'fake', EXTERNAL_FOO: 'fake' }).done;
  assert.equal(result.code, 0); assert.deepEqual(result.receipt, exited(0), result.stderr.subarray(0, 200).toString());
  assert.deepEqual(result.stdout, Buffer.alloc(524288, 0)); assert.deepEqual(result.stderr, Buffer.alloc(655360, 255));
  assert.deepEqual(fs.readdirSync(r.value.temp_parent), []);
});

test('EOF and a byte each stop the Job, including the tool grandchild', windows, async t => {
  const f = fixture(t);
  for (const action of ['end', 'write']) {
    const { child, done } = f.request({ argv: tree }).launch();
    const pid = await findPid(child);
    assert.doesNotThrow(() => process.kill(pid, 0));
    child.stdin[action](action === 'write' ? 'x' : undefined);
    assertRunner(await done, { protocol: 1, state: 'stopped', code: null, error: null });
    await assertDead(pid);
  }
});

test('runner backstop times out and kills a grandchild without a parent stop', windows, async t => {
  const f = fixture(t);
  const { child, done } = f.request({ argv: tree, deadline_ms: 4000 }).launch();
  const pid = await findPid(child);
  assertRunner(await done, { protocol: 1, state: 'timed_out', code: null, error: null });
  await assertDead(pid);
});

test('strict denies loopback reachable on host; outside sibling is unchanged', windows, async t => {
  const f = fixture(t);
  const outside = path.join(f.dir, 'sibling'); fs.writeFileSync(outside, 'sibling bytes');
  const inside = path.join(f.root, 'inside');
  const server = createServer(socket => { accepts++; socket.end(); });
  let accepts = 0;
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const client = `$c=New-Object Net.Sockets.TcpClient; $p=$c.ConnectAsync('127.0.0.1',${server.address().port}); try { if ($p.Wait(1400)) { 'connected' } else { 'blocked' } } catch { if ($_.Exception.GetBaseException().SocketErrorCode -notin @('AccessDenied','TimedOut')) { exit 4 }; 'blocked' } finally { $c.Dispose() }; exit 0`;
  const [exe, ...args] = powershell(client);
  const positive = await capture(spawn(exe, args, { env: f.request().value.env }));
  assert.equal(positive.code, 0); assert.equal(positive.stdout.toString().trim(), 'connected'); assert.equal(accepts, 1);
  const payload = `$ErrorActionPreference='Stop'; [IO.File]::WriteAllText(${psLiteral(inside)},'inside'); try { [IO.File]::WriteAllText(${psLiteral(outside)},'bad'); exit 3 } catch { if ($_.Exception.GetBaseException() -isnot [UnauthorizedAccessException]) { exit 2 } }; ${client}`;
  const strict = f.request({ argv: powershell(payload), windows_mode: 'strict' });
  const result = await strict.launch().done;
  assertRunner(result, exited(0)); assert.equal(result.stdout.toString().trim(), 'blocked'); assert.equal(accepts, 1);
  assert.equal(fs.readFileSync(inside, 'utf8'), 'inside'); assert.equal(fs.readFileSync(outside, 'utf8'), 'sibling bytes');
  assert.ok(!fs.existsSync(strict.record));
  const disallowed = await f.request({ network: true, windows_mode: 'strict' }).launch().done;
  assert.equal(disallowed.receipt?.error.code, 'policy');
});

test('recover reaps a leftover strict profile and its ACE, and is idempotent', windows, async t => {
  const f = fixture(t);
  const r = f.request({ argv: powershell(`'ready'; Start-Sleep -Seconds 60`), windows_mode: 'strict' });
  const { child, done } = r.launch();
  // Stop the helper first via the outer Job in the dedicated Python harness;
  // here simulate the disk state after abrupt death by preserving the record.
  const ready = await once(child.stdout, 'data');
  assert.match(String(ready[0]), /ready/);
  const record = fs.readFileSync(r.record, 'utf8');
  child.stdin.end();
  assertRunner(await done, { protocol: 1, state: 'stopped', code: null, error: null });
  const value = JSON.parse(record);
  const profile = spawnSync(f.helper, ['profile-create', '--name', value.name], { encoding: 'utf8' });
  assert.equal(profile.status, 0);
  const sid = profile.stdout.trim();
  const acl = path.join(process.env.SystemRoot, 'System32/icacls.exe');
  assert.equal(spawnSync(acl, [f.root, '/grant', `*${sid}:(OI)(CI)(M)`]).status, 0);
  t.after(() => spawnSync(f.helper, ['pipeline-profile-reap', '--name', value.name]));
  const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
  const original = path.join(f.root, 'file'); fs.writeFileSync(original, 'ordinary file');
  for (const file of [outside, original]) assert.equal(spawnSync(acl, [file, '/grant', `*${sid}:(M)`]).status, 0);
  fs.symlinkSync(outside, path.join(f.root, 'dependency'), 'junction');
  fs.writeFileSync(r.record, record);
  const recovered = f.run('recover', '--record', r.record);
  assert.equal(recovered.status, 0);
  assert.deepEqual(JSON.parse(recovered.stdout), { protocol: 1, recovered: true, warning: 'ace_cleanup_incomplete' });
  for (const file of [f.root, original]) assert.ok(!spawnSync(acl, [file], { encoding: 'utf8' }).stdout.includes(sid));
  assert.ok(spawnSync(acl, [outside], { encoding: 'utf8' }).stdout.includes(sid));
  assert.equal(spawnSync(f.helper, ['profile-create', '--name', value.name]).status, 0, 'previous profile must be gone');
  assert.deepEqual(JSON.parse(f.run('recover', '--record', r.record).stdout), { protocol: 1, recovered: false });
});

test('Windows hard-linked workspace files fail closed with workspace_link', windows, async t => {
  const f = fixture(t);
  const original = path.join(f.dir, 'original');
  const link = path.join(f.root, 'hard-link');
  fs.writeFileSync(original, 'ordinary bytes');
  fs.linkSync(original, link);
  const result = await f.request({ argv: node('console.log("unexpected launch")') }).launch().done;
  assert.equal(result.receipt?.error?.code, 'workspace_link');
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length + result.stderr.length, 0);
  assert.equal(fs.readFileSync(original, 'utf8'), 'ordinary bytes');
});

test('Windows shims preserve simple arguments and reject raw shell operands', windows, async t => {
  const f = fixture(t);
  const shim = path.join(f.dir, 'shim with spaces.cmd');
  fs.writeFileSync(shim, '@echo off\r\necho %1\r\nexit /b 124\r\n');
  const good = await f.request({ argv: [shim, 'simple=value'] }).launch().done;
  assertRunner(good, exited(124));
  assert.equal(good.stdout.toString().trim(), 'simple');
  for (const arg of ['two words', 'a&b', '%PATH%', '"quoted"']) {
    const failed = await f.request({ argv: [shim, arg] }).launch().done;
    assert.equal(failed.receipt?.error.code, 'policy');
    assert.equal(failed.stdout.length + failed.stderr.length, 0);
  }
});

test('Low launch hardens only the disposable Scranton credential store', windows, async t => {
  const f = fixture(t);
  const secret = path.join(f.env.SCRANTON_CREDENTIALS_DIR, 'fake-secret');
  const ordinary = path.join(f.dir, 'ordinary');
  fs.writeFileSync(secret, 'fixture password'); fs.writeFileSync(ordinary, 'ordinary readable data');
  const argv = node(`const fs=require('node:fs'); if(fs.readFileSync(${JSON.stringify(ordinary)},'utf8') !== 'ordinary readable data') process.exit(2); try { fs.readFileSync(${JSON.stringify(secret)}); process.exit(3); } catch(error) { if(error.code !== 'EACCES' && error.code !== 'EPERM') process.exit(4); }`);
  assertRunner(await f.request({ argv }).launch().done, exited(0));
  const backups = path.join(f.dir, 'credential-label-backups');
  const first = fs.readdirSync(backups);
  assert.equal(first.length, 1, 'retain the snapshot containing the original labels');
  const inherited = path.join(f.env.SCRANTON_CREDENTIALS_DIR, 'new-directory');
  fs.mkdirSync(inherited);
  fs.writeFileSync(path.join(inherited, 'new-file'), 'new fixture credential');
  assertRunner(await f.request({ argv }).launch().done, exited(0));
  assert.deepEqual(fs.readdirSync(backups), first);
});

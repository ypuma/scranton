import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, fakeCli } from './fake-cli.js';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSandbox, containerArgs, available } from '../../../src/core/sandbox-docker/index.js';
import { stopSource } from '../../../src/core/sandbox-docker/command.js';
import { DEFAULT_DOCKER_IMAGE } from '../../../src/core/sandbox.js';

test('exact hardening argv, mounts and network mapping; no credential projection', async t => {
  for (const [network, expected] of [['allow', 'bridge'], ['bridge', 'bridge'], ['none', 'none']]) {
    const f = fixture(t);
    const sandbox = createSandbox({ ...f, runId: 'run', network, env: { PATH: process.env.PATH, OPENAI_API_KEY: 'SECRET', UNKNOWN_AUTH: 'SECRET', SCRANTON_ANTIGRAVITY_CAPABILITY: 'SECRET' } }, f.deps);
    sandbox.prepare(); sandbox.prepare();
    const args = f.calls.find(c => c.args[0] === 'run').args;
    const mask = path.join(f.tempDir, fs.readdirSync(f.tempDir)[0]);
    assert.deepEqual(args, ['run', '--detach', '--rm', '--pull=never', '--name', sandbox.containerName, '--label', 'scranton.run=run', '--init', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--network', expected, '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777', '--workdir', '/workspace', '--mount', `type=bind,source=${f.worktree},target=/workspace`, '--mount', `type=bind,source=${mask},target=/workspace/.git,readonly`, '--env', 'HOME=/tmp', '--entrypoint', '/bin/sleep', DEFAULT_DOCKER_IMAGE, 'infinity']);
    assert.doesNotMatch(JSON.stringify(f.calls), /SECRET|API_KEY|CAPABILITY|broker|prompt|session/);
    await sandbox.dispose(); await sandbox.dispose();
    assert.equal(f.calls.filter(c => c.args[0] === 'rm').length, 1); assert.deepEqual(fs.readdirSync(f.tempDir), []);
  }
});
test('unprepared, missing CLI/image/engine, invalid settings and unsafe mounts fail closed', async t => {
  const f = fixture(t);
  const sandbox = createSandbox(f, f.deps);
  assert.throws(() => sandbox.spawn('/bin/bash', []), /prepared/);
  assert.throws(() => createSandbox({ ...f, network: 'host' }), /network/);
  assert.throws(() => createSandbox({ ...f, image: 'x --privileged' }), /image/);
  assert.throws(() => createSandbox(f, { executable: null }).prepare(), /CLI not found/);
  for (const fail of ['info', 'image']) {
    assert.throws(() => createSandbox(f, { ...f.deps, runSync: (_exe, args) => { if (args[0] === fail) throw Error('not available'); return 'linux'; } }).prepare(), /not available/);
  }
  assert.equal(f.calls.filter(c => c.args[0] === 'run').length, 0);
  assert.throws(() => createSandbox({ ...f, tempDir: f.worktree }, f.deps).prepare(), /disjoint/);
  sandbox.prepare();
  assert.throws(() => sandbox.spawn('/bin/bash', [], { shell: true }), /Unsafe/);
  assert.throws(() => sandbox.spawn('/bin/bash', [], { cwd: f.root }), /inside/);
  assert.throws(() => sandbox.spawn('C:\\Windows\\powershell.exe', []), /not available/);
  await sandbox.dispose(); assert.throws(() => sandbox.prepare(), /disposed/);
});

test('fake Docker CLI lifecycle preserves output, exit and cwd mapping, ignores tool env', async t => {
  const f = fakeCli(t), sandbox = createSandbox(f, f.deps); sandbox.prepare();
  const sub = path.join(f.worktree, 'sub'); fs.mkdirSync(sub);
  const child = sandbox.spawn('C:\\Git\\bin\\bash.exe', ['-c', 'exit 7'], { cwd: sub, env: { TOKEN: 'SECRET' } });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const [code] = await once(child, 'close'); assert.equal(code, 7); assert.equal(out, 'stdout\n'); assert.equal(err, 'stderr\n');
  const args = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse).find(a => a[0] === 'exec');
  assert.deepEqual(args.slice(0, 8), ['exec', '--interactive', '--workdir', '/workspace/sub', sandbox.containerName, '/usr/local/bin/node', '-e', args[7]]);
  assert.match(args[8], /^\/tmp\/scranton-exec-/);
  assert.deepEqual(args.slice(9), ['/bin/bash', '-c', 'exit 7']);
  await sandbox.dispose();
});
for (const kind of ['kill', 'timeout', 'abort', 'dispose']) test(`fake Docker ${kind} cleans command before close and disposal removes container`, async t => {
  const f = fakeCli(t), sandbox = createSandbox(f, f.deps); sandbox.prepare();
  const controller = new AbortController();
  const child = sandbox.spawn('/bin/bash', ['hold'], { ...(kind === 'timeout' ? { timeout: 500 } : {}), signal: controller.signal });
  const closed = once(child, 'close');
  while (!fs.existsSync(f.pid)) await new Promise(resolve => setTimeout(resolve, 10));
  if (kind === 'kill') child.kill('SIGKILL');
  if (kind === 'abort') controller.abort();
  if (kind === 'dispose') await sandbox.dispose();
  await closed; await sandbox.dispose();
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === 'rm').length, 1);
  assert.ok(calls.some(args => args[0] === 'container' && args.includes(`name=^/${sandbox.containerName}$`)));
  assert.throws(() => process.kill(Number(fs.readFileSync(f.pid, 'utf8')), 0));
});
test('failed setup and disposal verify cleanup instead of silently succeeding', async t => {
  const f = fixture(t);
  const failed = createSandbox(f, { ...f.deps, runSync: (_exe, args) => { if (args[0] === 'run') throw Error('launch failed'); return ['info', 'image'].includes(args[0]) ? 'linux' : args[0] === 'inspect' ? 'true' : ''; } });
  assert.throws(() => failed.prepare(), /launch failed/); assert.deepEqual(fs.readdirSync(f.tempDir), []);
  const sandbox = createSandbox(f, { ...f.deps, run: async () => 'still-present' }); sandbox.prepare();
  await assert.rejects(sandbox.dispose(), /could not be verified/); assert.equal(fs.readdirSync(f.tempDir).length, 1);
});
test('real container tool boundary (only with locally present own image)', async t => {
  const status = await available();
  if (!status.available) { t.skip(status.reason); return; }
  const f = fixture(t), sandbox = createSandbox({ worktree: f.worktree, tempDir: f.tempDir, network: 'none' });
  t.after(() => sandbox.dispose()); sandbox.prepare();
  const child = sandbox.spawn('/bin/bash', ['-c', 'id -u; printf output; printf error >&2; test -z "$OPENAI_API_KEY"; test ! -w /workspace/.git; ! touch /outside; touch /workspace/inside; exit 9']);
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  assert.equal((await once(child, 'close'))[0], 9); assert.match(output, /10001/); assert.match(output, /output/); assert.match(output, /error/);
  assert.ok(fs.existsSync(path.join(f.worktree, 'inside')));
});

test('tool-layer timeout calls adapter kill rather than killing only Docker CLI', async t => {
  const { runTool } = await import('../../../src/core/tools/index.js');
  const f = fakeCli(t), sandbox = createSandbox(f, f.deps); sandbox.prepare();
  t.after(() => sandbox.dispose());
  const result = await runTool('bash', { command: 'hold', timeout: 0.5 }, { root: f.worktree, allow: ['bash'], spawn: sandbox.spawn });
  assert.equal(result.isError, true); assert.match(result.content, /timed out/);
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(!calls.some(args => args[0] === 'rm'));
  assert.ok(calls.some(args => args.includes(stopSource)));
  assert.throws(() => process.kill(Number(fs.readFileSync(f.pid, 'utf8')), 0));
  const next = sandbox.spawn('/bin/bash', ['-c', 'exit 7']);
  assert.equal((await once(next, 'close'))[0], 7);
  assert.throws(() => process.kill(Number(fs.readFileSync(f.pid, 'utf8')), 0));
  await sandbox.dispose();
});

test('a lost idle container fails clearly without launching a tool', async t => {
  const f = fixture(t);
  const sandbox = createSandbox(f, { ...f.deps, runSync: (...args) => {
    if (args[1][0] === 'inspect') throw Error('no such container');
    return f.deps.runSync(...args);
  }, spawn() { assert.fail('Must not launch into a dead container'); } });
  sandbox.prepare();
  assert.throws(() => sandbox.spawn('/bin/bash'), /no longer running or reachable/);
  await sandbox.dispose();
});

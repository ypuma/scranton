import { isolationTestEnv } from './isolation-test-root.js';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../../src/core/cli.js';
import { runDoctor, satisfiesMin } from '../../src/core/doctor.js';
import { loadConfig } from '../../src/core/config.js';
import { parseMessage } from '../../src/core/hive.js';
import { FAKE_PI, ROOT, fakeConfig, readEvents, tempDir } from './helpers.js';

function capture() {
  const out = { text: '' };
  const stream = { isTTY: false, write: (s) => (out.text += s) };
  return { out, stream };
}

async function cli(t, args, env = {}) {
  const dir = tempDir(t);
  const o = capture();
  const e = capture();
  const code = await runCli(
    [...args, '--trusted-host', '--hive', path.join(dir, 'hive'), '--workspace', path.join(dir, 'ws')],
    { stdout: o.stream, stderr: e.stream, cwd: dir, env: { PATH: process.env.PATH, ...env } }
  );
  return { code, stdout: o.out.text, stderr: e.out.text, dir };
}

const fakePiEnv = (extra = {}) => ({ SCRANTON_PI_COMMAND: JSON.stringify([process.execPath, FAKE_PI]), FAKE_PI_DELAY_MS: '0', ...extra });

test('help lists the commands', async () => {
  const o = capture();
  assert.equal(await runCli(['help'], { stdout: o.stream, stderr: o.stream }), 0);
  assert.match(o.out.text, /audited, isolated agent/);
  assert.doesNotMatch(o.out.text, /Phase 1|no events\/state/);
  for (const word of ['run', 'agent', 'demo', 'dashboard', 'visualize', 'doctor', '--on-breaker', '--no-plan']) assert.ok(o.out.text.includes(word), word);
});

test('usage errors exit 2 with a message', async (t) => {
  for (const args of [['frobnicate'], ['run'], ['agent', 'kevin', 'x'], ['agent', 'dwight'], ['demo', '--scenario', 'nope'], ['run', 'x', '--on-breaker', 'maybe'], ['run', 'x', '--bogus']]) {
    const r = await cli(t, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /scranton:/, args.join(' '));
  }
});

test('invalid configuration is a clean exit 2, not a stack trace', async (t) => {
  const r = await cli(t, ['run', 'x'], { SCRANTON_MAX_FAILED_CYCLES: 'many' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /maxFailedCycles must be a positive integer/);
});

test('run: full happy run through the CLI with SCRANTON_PI_COMMAND, exit 0', async (t) => {
  const r = await cli(t, ['run', 'Build a tiny todo CLI', '--max-cycles', '2'], fakePiEnv({ FAKE_PI_SCENARIO: 'flaky' }));
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Plan: 3 milestones/);
  assert.match(r.stdout, /FAIL .*m2 cycle 1/);
  assert.match(r.stdout, /Run finished: success/);
  assert.ok(!r.stdout.includes('\x1b['), 'no ANSI colour on a non-TTY');
  const events = readEvents(path.join(r.dir, 'hive'));
  assert.equal(events[0].maxFailedCycles, 2, '--max-cycles reaches run_started');
  assert.notEqual(events[0].execution.simulated, true);
});

test('run: a partial run exits 1; no pi at all is a clear error', async (t) => {
  const partial = await cli(t, ['run', 'x', '--no-plan', '--on-breaker', 'skip'], fakePiEnv({ FAKE_PI_FAIL: 'exit1' }));
  assert.equal(partial.code, 1);
  assert.match(partial.stdout, /Run finished: partial/);
  const none = await cli(t, ['run', 'x'], { SCRANTON_PI_COMMAND: JSON.stringify(['scranton-no-such-pi']) });
  assert.equal(none.code, 1);
  assert.match(none.stdout + none.stderr, /spawn scranton-no-such-pi ENOENT/);
});

test('demo: runs the fake pi in ./demo-workspace style dirs and succeeds', async (t) => {
  const r = await cli(t, ['demo', '--scenario', 'happy', '--delay', '0']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Simulated trusted-host demo with the fake pi - scenario "happy"/);
  assert.ok(fs.existsSync(path.join(r.dir, 'ws', 'todo.js')));
  assert.equal(readEvents(path.join(r.dir, 'hive'))[0].execution.simulated, true);
});

test('agent: isolated single run writes an audited inbox and prints text + keyword', async (t) => {
  const r = await cli(t, ['agent', 'dwight', 'implement something small'], fakePiEnv());
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /\[TASK_COMPLETE\]/);
  assert.match(r.stdout, /keyword: \[TASK_COMPLETE\]/);
  const inbox = parseMessage(fs.readFileSync(path.join(r.dir, 'hive', 'dwight', 'inbox.md'), 'utf8'));
  assert.deepEqual([inbox.header.from, inbox.header.kind], ['human', 'task']);
  assert.match(inbox.body, /^implement something small/);
  assert.match(inbox.body, /You are dwight/);
  assert.ok(fs.existsSync(path.join(r.dir, 'hive', 'events.jsonl')));
  assert.ok(fs.existsSync(path.join(r.dir, 'hive', 'state.json')));
  assert.equal(fs.existsSync(path.join(r.dir, 'hive', 'control', 'owner.json')), false);
});

test('agent: an infrastructure failure is reported on stderr with exit 1', async (t) => {
  const r = await cli(t, ['agent', 'angela', 'check it'], fakePiEnv({ FAKE_PI_FAIL: 'exit1' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pi exited with code 1; pi stderr: fake-pi: No API key found/);
});

test('dashboard / visualize report a missing module instead of crashing', async (t) => {
  const have = fs.existsSync(path.resolve('src/dashboard/index.js'));
  if (have) return t.skip('dashboard module exists in this checkout');
  const r = await cli(t, ['dashboard', '--once']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /terminal dashboard is not available/);
});

test('visualize: a busy port is a friendly message and exit 1, not an unexpected error', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const { port } = blocker.address();
  const r = await cli(t, ['visualize', '--port', String(port)]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /scranton: .*already in use.*--port/);
  assert.ok(!/\n\s+at /.test(r.stderr), 'no stack trace');
  assert.equal(r.stdout, '');
});

test('bin/scranton.js: a busy port exits 1 with the message, without "unexpected error"', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const dir = tempDir(t);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'scranton.js'), 'visualize', '--port', String(blocker.address().port), '--hive', path.join(dir, 'hive')], { cwd: dir, env: isolationTestEnv(), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already in use.*--port/);
  assert.ok(!r.stderr.includes('unexpected error'));
});

test('doctor: fake pi with a configured model passes; a missing pi fails with exit 1', async (t) => {
  const dir = tempDir(t);
  const stdout = capture();
  const config = fakeConfig(dir);
  config.agents.dwight.model = 'fake/model';
  assert.equal(await runDoctor({ config, env: { PATH: process.env.PATH }, stdout: stdout.stream, auth: { async listAccounts() { return []; } } }), 0, stdout.out.text);
  assert.match(stdout.out.text, /pi --version: fake-pi 0\.0\.0/);
  assert.match(stdout.out.text, /dwight: credentials ready for fake\/model/);
  assert.match(stdout.out.text, /warnings found; the run can start\./);
  assert.doesNotMatch(stdout.out.text, /All good\./);

  const bad = capture();
  const badConfig = fakeConfig(dir, { command: ['scranton-no-such-pi'] });
  assert.equal(await runDoctor({ config: badConfig, env: { PATH: process.env.PATH }, stdout: bad.stream, auth: { async listAccounts() { return []; } } }), 1);
  assert.match(bad.out.text, /\[FAIL\] pi --version failed/);
});

test('doctor: an unwritable workspace is a failure', async (t) => {
  const dir = tempDir(t);
  const blocker = path.join(dir, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const config = loadConfig({ cwd: dir, env: {}, hasBash: true, fileConfig: { workspace: path.join(blocker, 'sub'), hiveDir: path.join(dir, 'hive'), pi: { command: [process.execPath, FAKE_PI] } } });
  const out = capture();
  assert.equal(await runDoctor({ config, env: { PATH: process.env.PATH }, stdout: out.stream, auth: { async listAccounts() { return []; } } }), 1);
  assert.match(out.out.text, /\[FAIL\] workspace not writable/);
});

test('satisfiesMin compares >=x.y.z ranges', () => {
  assert.equal(satisfiesMin('24.1.0', '>=22.19.0'), true);
  assert.equal(satisfiesMin('22.19.0', '>=22.19.0'), true);
  assert.equal(satisfiesMin('22.18.9', '>=22.19.0'), false);
  assert.equal(satisfiesMin('21.99.99', '>=22.19.0'), false);
  assert.equal(satisfiesMin('1.0.0', undefined), true);
});

test('guarded CLI flushes startup refusal on pre-work exits and begins before execution', async (t) => {
  const { fork } = await import('node:child_process');
  const root = path.resolve('.scratch/fix-core');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [args, expected] of [
    [['help'], 'scranton-startup-refused'],
    [['run', 'x', '--bogus'], 'scranton-startup-refused'],
    [['run', 'x', '--config', 'missing.json'], 'scranton-startup-refused'],
    [['run', 'x', '--trusted-host'], 'scranton-startup-begun']
  ]) {
    const messages = [];
    const child = fork(path.join(ROOT, 'bin/scranton.js'), args, {
      cwd: dir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: isolationTestEnv({ SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: 'startup-test-token' })
    });
    child.on('message', (message) => messages.push(message));
    await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.deepEqual(messages, [{ type: expected, token: 'startup-test-token' }], args.join(' '));
    assert.equal(fs.existsSync(path.join(dir, 'hive')), false, 'no work before lease validation');
  }
});


function finalScratch(t) {
  const root = path.resolve('.scratch/fix-final-core');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('CLI retains guarded and unmanaged leases when interrupted disposal is uncertain', async (t) => {
  const { Orchestrator } = await import('../../src/core/orchestrator.js');
  const { acquireRunLease, readRunLease } = await import('../../src/core/run-lease.js');
  t.mock.method(Orchestrator.prototype, 'run', async function () {
    this.cleanupComplete = false;
    return { status: 'aborted', signaled: true, summary: 'Primary interruption', cleanupComplete: false };
  });
  for (const guarded of [false, true]) {
    const dir = finalScratch(t), hiveDir = path.join(dir, 'hive');
    const lease = guarded ? acquireRunLease(hiveDir, { runId: 'parent-run' }) : null;
    const out = capture();
    const code = await runCli(['run', 'x', '--trusted-host', '--hive', hiveDir, '--workspace', path.join(dir, 'ws')], {
      cwd: dir, stdout: out.stream, stderr: out.stream,
      env: guarded ? { SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: lease.token } : {}
    });
    assert.equal(code, 130);
    assert.ok(readRunLease(hiveDir)?.token);
    if (guarded) assert.equal(readRunLease(hiveDir).token, lease.token);
  }
});

test('existing CLI lease is a friendly refusal and leaves foreign ownership and workspace intact', async (t) => {
  const { acquireRunLease } = await import('../../src/core/run-lease.js');
  const dir = finalScratch(t), hiveDir = path.join(dir, 'hive'), workspace = path.join(dir, 'ws');
  acquireRunLease(hiveDir, { runId: 'foreign-run' });
  const file = path.join(hiveDir, 'control', 'owner.json');
  const before = fs.readFileSync(file);
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'user.txt'), 'keep');
  const out = capture();
  const code = await runCli(['run', 'x', '--trusted-host', '--hive', hiveDir, '--workspace', workspace],
    { cwd: dir, stdout: out.stream, stderr: out.stream, env: {} });
  assert.equal(code, 1);
  assert.match(out.out.text, /Hive is already owned.*recovery is required/);
  assert.doesNotMatch(out.out.text, /EEXIST|\n\s+at /);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readFileSync(path.join(workspace, 'user.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(hiveDir, 'events.jsonl')), false);
});

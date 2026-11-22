import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { acquireRunLease, readRunLease } from '../../src/core/run-lease.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { EventRecorder } from '../../src/core/events.js';
import { recoverOrphan } from '../../src/core/run-recovery.js';
import { formatRunSummary, quotePathArgument } from '../../src/core/run-summary.js';

const root = path.resolve('.scratch/usability/fix3/cli');
fs.mkdirSync(root, { recursive: true });
const previous = { SCRANTON_ISOLATION_ROOT: process.env.SCRANTON_ISOLATION_ROOT, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.SCRANTON_ISOLATION_ROOT = path.join(root, 'iso');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi');
after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
function fixture(t, base = root) {
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hive = path.join(dir, 'hive'), ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PI_CODING_AGENT_DIR: path.join(dir, 'pi'), SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'),
    SCRANTON_FAKE_MODE: '1', SCRANTON_ISOLATION_ROOT: path.join(dir, 'iso'),
    SCRANTON_FAKE_DELAY_MS: '0', SCRANTON_FAKE_DETERMINISTIC: '1', SCRANTON_FAKE_SCENARIO: 'happy' };
  const io = { cwd: dir, env, stdout: { write(s) { io.out += s; } }, stderr: { write(s) { io.err += s; } }, out: '', err: '' };
  return { dir, hive, ws, io, args: ['--hive', hive, '--workspace', ws, '--trusted-host'] };
}
function orphan(f, pid, extra = {}) {
  const lease = acquireRunLease(f.hive, { runId: 'interrupted-run', workspace: f.ws, request: 'old request', startedAt: new Date().toISOString() });
  if (pid) fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid, at: new Date(Date.now() - (pid === process.pid ? 0 : 60000)).toISOString(), ...extra }));
  return lease;
}
async function deadPid() {
  const child = spawn(process.execPath, ['--version'], { stdio: 'ignore' });
  const pid = child.pid; await once(child, 'close'); return pid;
}
function successful(t, requests = []) {
  t.mock.method(Orchestrator.prototype, 'run', async function (request) { requests.push(request); return { status: 'success', summary: 'Done' }; });
}

test('gone owner is recovered automatically and archived before the next fake run', async (t) => {
  const f = fixture(t); orphan(f, await deadPid());
  assert.equal(await runCli(['run', 'next', '--no-plan', ...f.args], f.io), 0, f.io.err);
  assert.match(f.io.err, /Recovered interrupted run interrupted-run; starting a new run\./);
  assert.equal(readRunLease(f.hive), null);
  const events = fs.readFileSync(path.join(f.hive, 'runs/interrupted-run/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).status, 'aborted');
  assert.equal(events.at(-1).summary, "Interrupted: the run's process ended without finishing");
});

test('unknown and alive ownership are retained with an exact recovery command', async (t) => {
  for (const alive of [false, true]) {
    const f = fixture(t), lease = orphan(f, alive ? process.pid : null);
    assert.equal(await runCli(['run', 'next', ...f.args], f.io), 1);
    assert.match(f.io.err, new RegExp(`Owner state: ${alive ? 'alive' : 'unknown'}`));
    assert.ok(f.io.err.includes(`scranton recover --hive ${quotePathArgument(f.hive)}`));
    assert.equal(readRunLease(f.hive).token, lease.token);
  }
});

test('recover inspects, refuses live owners and requires explicit confirmation for unknown owners', async (t) => {
  const f = fixture(t), lease = orphan(f, process.pid);
  assert.equal(await runCli(['recover', '--hive', f.hive, '--confirm-stopped'], f.io), 1);
  assert.match(f.io.out, /Owner state: alive/);
  assert.equal(readRunLease(f.hive).token, lease.token);
  fs.rmSync(path.join(f.hive, 'control/heartbeat.json'));
  assert.equal(await runCli(['recover', '--hive', f.hive], f.io), 1);
  assert.equal(readRunLease(f.hive).token, lease.token);
  assert.equal(await runCli(['recover', '--hive', f.hive, '--confirm-stopped'], f.io), 0, f.io.err);
  assert.equal(readRunLease(f.hive), null);
  assert.match(f.io.out, /Recovered run interrupted-run; recorded as aborted\./);
});

test('plain request files preserve whitespace except one trailing newline and are never deleted', async (t) => {
  const f = fixture(t), requests = []; successful(t, requests);
  for (const text of ['Build a CLI\r\n', '[1,2]\n', 'null\n', '42\n', '"a string"\n', '  hello\n\n']) {
    const file = path.join(f.dir, 'prompt.txt'); fs.writeFileSync(file, text);
    assert.equal(await runCli(['run', '--request-file', file, ...f.args], f.io), 0, f.io.err);
    assert.equal(requests.at(-1), text.replace(/\r?\n$/, ''));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('request object envelopes stay strict; positional and file requests share validation', async (t) => {
  const f = fixture(t), requests = []; successful(t, requests);
  for (const text of ['{}', '{"v":1,"request":"ok","extra":true}', '{"v":2,"request":"ok"}', ' ', 'x'.repeat(32769)]) {
    const file = path.join(f.dir, 'prompt'); fs.writeFileSync(file, text);
    assert.equal(await runCli(['run', '--request-file', file, ...f.args], f.io), 2);
  }
  assert.equal(await runCli(['run', 'x'.repeat(32769), ...f.args], f.io), 2);
  const file = path.join(f.dir, 'envelope'); fs.writeFileSync(file, JSON.stringify({ v: 1, request: 'enveloped' }));
  assert.equal(await runCli(['run', '--request-file', file, ...f.args], f.io), 0);
  assert.equal(requests.at(-1), 'enveloped');
});

test('final human summary uses recorded milestones, exact integrated files and usage, on stderr', async (t) => {
  const f = fixture(t);
  assert.equal(await runCli(['run', 'build', '--no-plan', ...f.args], f.io), 0, f.io.err);
  assert.match(f.io.err, /Outcome: success/);
  assert.match(f.io.err, /Milestones: 1 passed, 0 failed/);
  assert.match(f.io.err, /Workspace changes: 1 file\n  todo.js/);
  assert.match(f.io.err, /Duration: \d+(\.\d+)? s/);
  assert.match(f.io.err, /Usage: \d+ input \+ \d+ output tokens; recorded cost: /);
  assert.ok(f.io.err.includes(`Log: ${path.join(f.hive, 'events.jsonl')}`));
  assert.doesNotMatch(f.io.out, /Workspace changes:/);
});

// Restore the implicit registry fallback in runCli to fail the refusal/no-chat assertions.
test('project selection requires explicit data, suggests the default and announces explicit continuation', async (t) => {
  const f = fixture(t); successful(t);
  f.io.env.APPDATA = path.join(f.dir, 'appdata');
  const data = path.join(f.io.env.APPDATA, 'dev.scranton.desktop');
  const registry = createProjectRegistry({ dataDir: data }), project = registry.addProject({ name: 'Default registry', workspace: f.ws });
  const context = path.join(f.dir, 'context.json'); fs.writeFileSync(context, JSON.stringify({ v: 1, text: '' }));
  assert.equal(await runCli(['run', 'build', '--project', project.id, '--thread-context', context], f.io), 2, f.io.err);
  assert.match(f.io.err, /--project and --chat require --data or inherited SCRANTON_DATA/);
  assert.ok(f.io.err.includes(`scranton run "<request>" --data "${data}" --project ${project.id}`), f.io.err);
  assert.deepEqual(registry.listChats(project.id), []);
  assert.equal(await runCli(['run', 'build', '--data', data, '--project', project.id, '--thread-context', context], f.io), 0, f.io.err);
  const chat = registry.listChats(project.id)[0];
  assert.ok(chat);
  assert.ok(f.io.err.includes(`Project: ${project.id}; chat: ${chat.id}; continue: scranton run "<request>" --data ${quotePathArgument(data)} --project ${project.id} --chat ${chat.id}`));
  f.io.out = '';
  assert.equal(await runCli(['projects', 'list'], f.io), 0);
  assert.equal(JSON.parse(f.io.out).projects[0].id, project.id);
  assert.equal(JSON.parse(f.io.out).dataDir, data);
});

test('standalone agent names its private output and does not imply workspace integration', async (t) => {
  const f = fixture(t);
  assert.equal(await runCli(['agent', 'dwight', 'write something', ...f.args], f.io), 0, f.io.err);
  const state = JSON.parse(fs.readFileSync(path.join(f.hive, 'state.json'))), worktree = state.instances.dwight.worktree;
  assert.ok(fs.existsSync(path.join(worktree, 'work.md')));
  assert.deepEqual(fs.readdirSync(f.ws), []);
  assert.ok(f.io.err.includes(`Private worktree: ${worktree}\nWorkspace was not changed; inspect or copy the private files to use this result.`));
});

async function interrupted(t, twice) {
  const f = fixture(t), entry = path.join(f.dir, 'interrupt.mjs'), pids = path.join(f.dir, 'pids.json');
  const cli = new URL('../../src/core/cli.js', import.meta.url).href;
  fs.writeFileSync(entry, `import { runCli } from ${JSON.stringify(cli)};\nprocess.on('message', () => { process.emit('SIGINT'); ${twice ? "process.emit('SIGINT');" : ''} });\nprocess.exitCode = await runCli(process.argv.slice(2));\nprocess.disconnect();\n`);
  const child = fork(entry, ['run', 'hang', '--no-plan', ...f.args], { cwd: f.dir, env: { ...f.io.env, SCRANTON_FAKE_LOG: pids, SCRANTON_FAKE_FAIL: 'hang' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let err = ''; child.stderr.on('data', (s) => err += s); child.stdout.resume();
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  for (let i = 0; !fs.existsSync(pids) && i < 300; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(pids), err);
  child.send('interrupt');
  const [code] = await closed;
  assert.equal(code, 130, err);
  assert.equal(readRunLease(f.hive), null, err);
}

test('first Ctrl+C stops the own scripted workflow and releases ownership', { timeout: 30000 }, async (t) => interrupted(t, false));
test('second Ctrl+C waits for the own scripted workflow and releases ownership', { timeout: 30000 }, async (t) => interrupted(t, true));

test('automatic recovery refuses unknown owners even if called without a CLI precheck', async (t) => {
  const f = fixture(t), lease = orphan(f, await deadPid(), { cleanup: 'unresolved', reason: 'Unverified cleanup' });
  await assert.rejects(recoverOrphan(f.hive, lease.runId, 'automatic', undefined, { automatic: true }), /Automatic recovery requires a gone owner/);
  assert.equal(readRunLease(f.hive).token, lease.token);
});

test('automatic recovery rechecks gone status after asynchronous Docker cleanup', async (t) => {
  const f = fixture(t), lease = orphan(f, await deadPid());
  const recorder = new EventRecorder({ hiveDir: f.hive, runId: lease.runId }); recorder.start();
  recorder.emit('run_started', { request: 'old', workspace: f.ws, execution: { sandbox: { mode: 'docker' } }, roles: [] });
  const docker = { executable: 'fake-docker', run: async () => {
    fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: process.pid, at: '2000-01-01T00:00:00.000Z' }));
    return '';
  } };
  await assert.rejects(recoverOrphan(f.hive, lease.runId, 'automatic', docker, { automatic: true }), /Run ownership changed during recovery/);
  assert.equal(readRunLease(f.hive).token, lease.token);
});

test('Docker cleanup warnings block CLI automatic recovery but explicit confirmation returns them', async (t) => {
  const f = fixture(t), lease = orphan(f, await deadPid());
  const recorder = new EventRecorder({ hiveDir: f.hive, runId: lease.runId }); recorder.start();
  recorder.emit('run_started', { request: 'old', workspace: f.ws, execution: { sandbox: { mode: 'docker' } }, roles: [] });
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH', previousPath = process.env[key];
  process.env[key] = '';
  t.after(() => { if (previousPath === undefined) delete process.env[key]; else process.env[key] = previousPath; });
  assert.equal(await runCli(['run', 'next', ...f.args], f.io), 1);
  assert.equal(readRunLease(f.hive).token, lease.token);
  assert.match(f.io.err, /Docker is not reachable; containers of this run could not be checked/);
  assert.equal(await runCli(['recover', '--hive', f.hive], f.io), 1);
  assert.equal(readRunLease(f.hive).token, lease.token);
  assert.equal(await runCli(['recover', '--hive', f.hive, '--confirm-stopped'], f.io), 0, f.io.err);
  assert.match(f.io.err, /Warning: Docker is not reachable; containers of this run could not be checked/);
  assert.equal(readRunLease(f.hive), null);
});

test('registry recovery resolves an existing chat without creating a new chat', async (t) => {
  const f = fixture(t), data = path.join(f.dir, 'data'), registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Recovery', workspace: f.ws }), chat = registry.createChat(project.id);
  orphan({ ...f, hive: chat.hiveDir }, await deadPid());
  assert.equal(await runCli(['recover', '--data', data, '--project', project.id, '--chat', chat.id], f.io), 0, f.io.err);
  assert.equal(registry.listChats(project.id).length, 1);
  assert.equal(readRunLease(chat.hiveDir), null);
});

test('summary lists only exact net integrated changes, caps paths and distinguishes unrecorded data', (t) => {
  const f = fixture(t), entry = (text, mode = '100644') => ({ data: Buffer.from(text), mode });
  const initial = new Map([['removed', entry('old')], ['same', entry('same')], ['mode-only', entry('same')]]);
  const integrated = new Map([['same', entry('same')], ['mode-only', entry('same', '100755')], ...Array.from({ length: 22 }, (_, i) => [`file-${i}`, entry('new')])]);
  const run = { config: { hiveDir: f.hive }, rec: { state: { milestones: [{ status: 'passed' }, { status: 'failed' }, { status: 'blocked' }] } }, worktrees: { initial, integrated } };
  const summary = formatRunSummary(run, { status: 'partial', summary: 'Some skipped' }, 1250);
  assert.match(summary, /Workspace changes: 24 files/);
  assert.equal(summary.split('\n').filter((s) => s.startsWith('  ') && !s.startsWith('  ...')).length, 20);
  assert.match(summary, /and 4 more/);
  assert.doesNotMatch(summary, /^  same$/m);
  assert.match(summary, /Usage \/ cost: not recorded/);
  assert.match(summary, /1 passed, 1 failed/);
  assert.match(formatRunSummary({ ...run, worktrees: null }, { status: 'failed' }, 0), /Workspace changes: not recorded/);
});

test('server-guarded runs do not gain human summary output', async (t) => {
  const f = fixture(t); successful(t);
  const lease = acquireRunLease(f.hive, { runId: 'parent-run' });
  f.io.env = { ...f.io.env, SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: lease.token };
  assert.equal(await runCli(['run', 'server request', ...f.args], f.io), 0);
  assert.equal(f.io.err, '');
  assert.equal(readRunLease(f.hive), null);
});

test('plain request files reject malformed UTF-8 and retain the bounded regular-file checks', async (t) => {
  const f = fixture(t); successful(t);
  const file = path.join(f.dir, 'prompt.txt');
  fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
  assert.equal(await runCli(['run', '--request-file', file, ...f.args], f.io), 2);
  fs.writeFileSync(file, 'x'.repeat(262145));
  assert.equal(await runCli(['run', '--request-file', file, ...f.args], f.io), 2);
  assert.equal(await runCli(['run', '--request-file', f.dir, ...f.args], f.io), 2);
  fs.writeFileSync(file, '\ufeffBuild a CLI\n');
  assert.equal(await runCli(['run', '--request-file', file, ...f.args], f.io), 0);
});

test('explicit registry runs announce the new chat id and continuation command', async (t) => {
  const f = fixture(t); successful(t);
  const data = path.join(f.dir, 'data'), registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Explicit registry', workspace: f.ws });
  const context = path.join(f.dir, 'context.json'); fs.writeFileSync(context, JSON.stringify({ v: 1, text: '' }));
  assert.equal(await runCli(['run', 'build', '--data', data, '--project', project.id, '--thread-context', context], f.io), 0, f.io.err);
  const chat = registry.listChats(project.id)[0];
  assert.ok(chat);
  assert.ok(f.io.err.includes(`Project: ${project.id}; chat: ${chat.id}; continue:`));
});

test('successful recovery removes the stale human request but a refused live recovery preserves it', async (t) => {
  const f = fixture(t, path.resolve('.scratch/usability/integration/recovery')), lease = orphan(f, process.pid);
  const request = path.join(f.hive, 'human/request.json'); fs.mkdirSync(path.dirname(request), { recursive: true });
  fs.writeFileSync(request, JSON.stringify({ v: 1, runId: lease.runId, requestSeq: 2 }));
  assert.equal(await runCli(['recover', '--hive', f.hive, '--confirm-stopped'], f.io), 1);
  assert.equal(fs.existsSync(request), true);
  fs.rmSync(path.join(f.hive, 'control/heartbeat.json'));
  assert.equal(await runCli(['recover', '--hive', f.hive, '--confirm-stopped'], f.io), 0, f.io.err);
  assert.equal(fs.existsSync(request), false);
});

test('fix2: fresh dead PID and foreign-host owners never auto-recover', async (t) => {
  const os = await import('node:os');
  for (const [age, host] of [[0, os.hostname()], [120000, 'another-host']]) {
    const f = fixture(t), lease = orphan(f, await deadPid(), { at: new Date(Date.now() - age).toISOString() });
    const file = path.join(f.hive, 'control/owner.json'); fs.writeFileSync(file, JSON.stringify({ ...lease, host }));
    successful(t);
    assert.equal(await runCli(['run', 'next', ...f.args], f.io), 1, f.io.err);
    assert.equal(readRunLease(f.hive).token, lease.token);
    assert.match(f.io.err, /process not found here/); assert.match(f.io.err, /heartbeat \d+ seconds old/);
    assert.ok(f.io.err.includes(`host: ${host}`)); assert.match(f.io.err, /wait and retry/);
    assert.match(f.io.err, /--confirm-stopped/);
  }
});

test('fix2: newly acquired lease records this host', async (t) => {
  const os = await import('node:os'), f = fixture(t);
  assert.equal(acquireRunLease(f.hive, { runId: 'hosted' }).host, os.hostname());
});

test('fix2: CLI recovery rechecks heartbeat age after async cleanup without changing server recovery', async (t) => {
  const f = fixture(t), lease = orphan(f, await deadPid());
  const recorder = new EventRecorder({ hiveDir: f.hive, runId: lease.runId }); recorder.start();
  recorder.emit('run_started', { request: 'old', workspace: f.ws, execution: { sandbox: { mode: 'docker' } }, roles: [] });
  const docker = { executable: 'fake-docker', run: async () => {
    fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: 2147483647, at: new Date().toISOString() }));
    return '';
  } };
  await assert.rejects(recoverOrphan(f.hive, lease.runId, 'automatic', docker, { automatic: true, local: true }), /Run ownership changed during recovery/);
  assert.equal(readRunLease(f.hive).token, lease.token);
});

function undoOrphan(f) {
  const recorder = new EventRecorder({ hiveDir: f.hive, runId: 'real-last-run' }); recorder.start();
  recorder.emit('run_started', { request: 'real request', workspace: f.ws, roles: [] });
  recorder.emit('run_finished', { status: 'success', summary: 'Real completed work' });
  const saved = Object.fromEntries(['events.jsonl', 'state.json'].map((name) => [name, fs.readFileSync(path.join(f.hive, name))]));
  const lease = acquireRunLease(f.hive, { runId: 'undo-crashed', mode: 'undo' });
  fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: 2147483647, at: '2000-01-01T00:00:00Z' }));
  return () => {
    for (const [name, bytes] of Object.entries(saved)) assert.deepEqual(fs.readFileSync(path.join(f.hive, name)), bytes, name);
    assert.equal(fs.existsSync(path.join(f.hive, 'runs')), false);
    assert.equal(fs.existsSync(path.join(f.hive, 'control/heartbeat.json')), false);
  };
}
for (const command of ['run', 'recover']) test(`fix3 item1: CLI ${command} recovers undo without changing the real last run`, async (t) => {
  const f = fixture(t), unchanged = undoOrphan(f); successful(t);
  assert.equal(await runCli(command === 'run' ? ['run', 'next', ...f.args] : ['recover', '--hive', f.hive], f.io), 0, f.io.err);
  unchanged(); assert.equal(readRunLease(f.hive), null);
  assert.doesNotMatch(f.io.out + f.io.err, /Recovered (?:interrupted )?run undo-crashed|recorded as aborted/);
});

test('fix3 item7: corrupt or empty ownership directs manual recovery in one line', async (t) => {
  for (const text of ['', '{bad']) {
    const f = fixture(t); fs.mkdirSync(path.join(f.hive, 'control'), { recursive: true });
    const file = path.join(f.hive, 'control/owner.json'); fs.writeFileSync(file, text);
    assert.equal(await runCli(['recover', '--hive', f.hive, '--confirm-stopped'], f.io), 1);
    assert.equal(f.io.err, 'scranton: The owner record is unreadable; follow the manual procedure in docs/CONTROL.md, section 6 (Unreadable owner record).\n');
    assert.equal(f.io.out, ''); assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

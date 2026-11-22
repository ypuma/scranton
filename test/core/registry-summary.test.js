import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { runCli } from '../../src/core/cli.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { acquireRunLease, releaseRunLease } from '../../src/core/run-lease.js';
import { quotePathArgument } from '../../src/core/run-summary.js';
import { prepareRestorePoint } from '../../src/core/restore-points.js';

const root = path.resolve('.scratch/relay-wave/undo-final/tests');
fs.mkdirSync(root, { recursive: true });
const previous = process.env.SCRANTON_ISOLATION_ROOT;
process.env.SCRANTON_ISOLATION_ROOT = path.join(root, 'isolation');
after(() => { if (previous === undefined) delete process.env.SCRANTON_ISOLATION_ROOT; else process.env.SCRANTON_ISOLATION_ROOT = previous; });
const cli = path.resolve('bin/scranton.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'project with spaces-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'workspace with spaces'), hive = path.join(dir, 'hive with spaces');
  fs.mkdirSync(ws);
  const context = path.join(dir, 'context.json');
  fs.writeFileSync(context, JSON.stringify({ v: 1, text: '' }));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    PI_CODING_AGENT_DIR: path.join(dir, 'pi'), SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'), SCRANTON_ISOLATION_ROOT: path.join(dir, 'isolation'),
    SCRANTON_FAKE_MODE: '1',
    SCRANTON_FAKE_DELAY_MS: '0', SCRANTON_FAKE_DETERMINISTIC: '1', SCRANTON_FAKE_SCENARIO: 'happy' };
  const io = { cwd: dir, env, out: '', err: '', stdout: { write(s) { io.out += s; } }, stderr: { write(s) { io.err += s; } } };
  return { dir, ws, hive, context, io };
}
function suggestion(f) {
  const lines = f.io.err.split('\n').filter((s) => s.startsWith('Undo: '));
  assert.equal(lines.length, 1, f.io.err);
  return lines[0].slice('Undo: '.length);
}
function executeSuggestion(f, command) {
  assert.match(command, /^scranton (undo|recover) /);
  return spawnSync(`${quotePathArgument(process.execPath)} ${quotePathArgument(cli)} ${command.slice('scranton '.length)}`, {
    cwd: f.dir, env: f.io.env, shell: true, encoding: 'utf8', windowsHide: true, timeout: 30000
  });
}

for (const mode of ['existing chat', 'new chat', 'inherited data']) test(`registry summary preserves scope for ${mode}; its quoted command enforces sibling guard`, { timeout: 60000 }, async (t) => {
  const f = fixture(t), data = path.join(f.dir, 'registry with spaces');
  const registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Summary', workspace: f.ws });
  let chat = mode === 'new chat' ? null : registry.createChat(project.id);
  const relativeData = path.relative(f.dir, data);
  if (mode === 'inherited data') f.io.env.SCRANTON_DATA = relativeData;
  const args = ['run', 'build', '--no-plan', '--trusted-host', '--thread-context', f.context,
    '--project', project.id, ...(chat ? ['--chat', chat.id] : []),
    ...(mode === 'inherited data' ? [] : ['--data', relativeData])];
  assert.equal(await runCli(args, f.io), 0, f.io.err);
  chat ??= registry.listChats(project.id)[0];
  const state = JSON.parse(fs.readFileSync(path.join(chat.hiveDir, 'state.json')));
  const command = suggestion(f);
  // Reverting the summary's scoped command to its old --hive line fails here.
  assert.equal(command, `scranton undo --data ${quotePathArgument(data)} --project ${project.id} --chat ${chat.id} --run ${state.runId}`);
  assert.doesNotMatch(command, /--hive/);
  assert.ok(fs.existsSync(path.join(f.ws, 'todo.js')));
  const sibling = registry.createChat(project.id), lease = acquireRunLease(sibling.hiveDir, { runId: 'sibling-active' });
  try {
    const blocked = executeSuggestion(f, command);
    assert.equal(blocked.error, undefined);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /A run is active in another chat of this project/);
    assert.ok(fs.existsSync(path.join(f.ws, 'todo.js')));
  } finally { releaseRunLease(sibling.hiveDir, lease.token); }
  const undone = executeSuggestion(f, command);
  assert.equal(undone.error, undefined);
  assert.equal(undone.status, 0, undone.stderr);
  assert.match(undone.stdout, /Removed: todo.js/);
  assert.equal(fs.existsSync(path.join(f.ws, 'todo.js')), false);
  assert.equal(registry.listChats(project.id).length, 2);
});

test('standalone summary keeps its quoted --hive command executable with spaces', { timeout: 60000 }, async (t) => {
  const f = fixture(t);
  assert.equal(await runCli(['run', 'build', '--no-plan', '--trusted-host', '--workspace', f.ws, '--hive', f.hive], f.io), 0, f.io.err);
  const state = JSON.parse(fs.readFileSync(path.join(f.hive, 'state.json'))), command = suggestion(f);
  assert.equal(command, `scranton undo --hive ${quotePathArgument(f.hive)} --run ${state.runId}`);
  assert.doesNotMatch(command, /--data|--project|--chat/);
  const undone = executeSuggestion(f, command);
  assert.equal(undone.error, undefined);
  assert.equal(undone.status, 0, undone.stderr);
  assert.match(undone.stdout, /Removed: todo.js/);
  assert.equal(fs.existsSync(path.join(f.ws, 'todo.js')), false);
});

function registryFixture(t, mode) {
  const f = fixture(t);
  f.io.env.APPDATA = path.join(f.dir, 'appdata with spaces');
  const data = mode === 'default data' ? path.join(f.io.env.APPDATA, 'dev.scranton.desktop') : path.join(f.dir, 'registry with spaces');
  const registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Follow-up', workspace: f.ws }), chat = registry.createChat(project.id);
  const relativeData = path.relative(f.dir, data);
  if (mode === 'inherited data') f.io.env.SCRANTON_DATA = relativeData;
  const args = ['--project', project.id, '--chat', chat.id, ...(mode === 'explicit data' ? ['--data', relativeData] : [])];
  const scope = `--data ${quotePathArgument(data)} --project ${project.id} --chat ${chat.id}`;
  return { ...f, data, registry, project, chat, args, scope };
}
function restorePoint(f) {
  const entry = (text) => ({ data: Buffer.from(text), mode: '100644' });
  const before = new Map([['file.txt', entry('before')]]), after = new Map([['file.txt', entry('after')]]);
  prepareRestorePoint({ hiveDir: f.chat.hiveDir, workspace: f.ws, runId: 'conflict-run', changes: ['file.txt'], before, initial: before, after }).commit();
  fs.writeFileSync(path.join(f.ws, 'file.txt'), 'human edit');
}
function followUp(text, marker) {
  const matches = text.split('\n').filter((line) => line.includes(marker));
  assert.equal(matches.length, 1, text);
  return matches[0].slice(matches[0].indexOf(marker) + marker.length).replace(/\.$/, '');
}

for (const mode of ['explicit data', 'inherited data', 'default data']) test(`registry conflict retry preserves ${mode} and cannot bypass a sibling lease`, async (t) => {
  const f = registryFixture(t, mode); restorePoint(f);
  assert.equal(await runCli(['undo', ...f.args, '--run', 'conflict-run'], f.io), 1, f.io.err);
  assert.match(f.io.err, /Conflict: file.txt: File no longer matches/);
  const command = followUp(f.io.err, 'to overwrite later edits: ');
  const sibling = f.registry.createChat(f.project.id), lease = acquireRunLease(sibling.hiveDir, { runId: 'sibling-active' });
  try {
    const blocked = executeSuggestion(f, command);
    assert.equal(blocked.error, undefined);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /A run is active in another chat of this project/);
    assert.equal(fs.readFileSync(path.join(f.ws, 'file.txt'), 'utf8'), 'human edit');
  } finally { releaseRunLease(sibling.hiveDir, lease.token); }
  assert.equal(command, `scranton undo ${f.scope} --run conflict-run --force`);
  assert.doesNotMatch(command, /--hive/);
  const undone = executeSuggestion(f, command);
  assert.equal(undone.error, undefined);
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(fs.readFileSync(path.join(f.ws, 'file.txt'), 'utf8'), 'before');
  assert.equal(f.registry.listChats(f.project.id).length, 2);
});

for (const mode of ['explicit data', 'inherited data', 'default data']) test(`registry undo and recover follow-ups preserve ${mode} without releasing ownership early`, async (t) => {
  const f = registryFixture(t, mode);
  assert.equal(await runCli(['undo', ...f.args], f.io), 1);
  const list = followUp(f.io.err, 'inspect with ');
  assert.equal(list, `scranton undo ${f.scope} --list`);
  const listed = executeSuggestion(f, list);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /No restore points available/);
  const lease = acquireRunLease(f.chat.hiveDir, { runId: 'undo-interrupted', mode: 'undo' });
  t.after(() => releaseRunLease(f.chat.hiveDir, lease.token));
  const owner = path.join(f.chat.hiveDir, 'control/owner.json');
  const saved = fs.readFileSync(owner);
  const heartbeat = path.join(f.chat.hiveDir, 'control/heartbeat.json');
  fs.writeFileSync(heartbeat, JSON.stringify({ v: 1, runId: lease.runId, pid: process.pid, at: new Date().toISOString() }));
  f.io.err = '';
  assert.equal(await runCli(['undo', ...f.args], f.io), 1);
  const recover = followUp(f.io.err, 'only if its process is gone: ');
  assert.equal(recover, `scranton recover ${f.scope}`);
  const live = executeSuggestion(f, recover);
  assert.equal(live.status, 1, live.stderr);
  assert.match(live.stderr, /The run is still running/);
  assert.deepEqual(fs.readFileSync(owner), saved);
  fs.writeFileSync(heartbeat, JSON.stringify({ v: 1, runId: lease.runId, pid: 2147483647, at: new Date().toISOString() }));
  f.io.err = '';
  assert.equal(await runCli(['undo', ...f.args], f.io), 1);
  assert.equal(followUp(f.io.err, 'inspect with '), recover);
  const inspected = executeSuggestion(f, recover);
  assert.equal(inspected.error, undefined);
  assert.equal(inspected.status, 1, inspected.stderr);
  assert.deepEqual(fs.readFileSync(owner), saved);
  const confirmed = followUp(inspected.stderr, 'or use ').split(' after making sure')[0];
  assert.equal(confirmed, `scranton recover ${f.scope} --confirm-stopped`);
  assert.doesNotMatch(inspected.stderr, /--hive/);
  const released = executeSuggestion(f, confirmed);
  assert.equal(released.error, undefined);
  assert.equal(released.status, 0, released.stderr);
  assert.match(released.stdout, /Released interrupted undo/);
  assert.equal(fs.existsSync(owner), false);
  assert.equal(f.registry.listChats(f.project.id).length, 1);
});

for (const mode of ['run', 'undo']) test(`registry run refusal keeps scope for ${mode} ownership recovery`, async (t) => {
  const f = registryFixture(t, 'explicit data');
  const lease = acquireRunLease(f.chat.hiveDir, { runId: 'interrupted', mode });
  t.after(() => releaseRunLease(f.chat.hiveDir, lease.token));
  fs.writeFileSync(path.join(f.chat.hiveDir, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: 2147483647, at: new Date().toISOString() }));
  assert.equal(await runCli(['run', 'build', '--no-plan', '--trusted-host', '--thread-context', f.context, ...f.args], f.io), 1, f.io.err);
  const command = followUp(f.io.err, 'or use ').split(' after making sure')[0];
  assert.equal(command, `scranton recover ${f.scope} --confirm-stopped`);
  assert.doesNotMatch(f.io.err, /--hive/);
  if (mode === 'run') assert.equal(followUp(f.io.err, 'Inspect/recover: '), `scranton recover ${f.scope}`);
});

test('registry failed recovery retains ownership and scopes its inspect command', async (t) => {
  const f = registryFixture(t, 'inherited data');
  const lease = acquireRunLease(f.chat.hiveDir, { runId: 'undo-interrupted', mode: 'undo' });
  t.after(() => releaseRunLease(f.chat.hiveDir, lease.token));
  const owner = path.join(f.chat.hiveDir, 'control/owner.json'), saved = fs.readFileSync(owner);
  fs.writeFileSync(path.join(f.chat.hiveDir, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: 2147483647, at: new Date().toISOString() }));
  fs.writeFileSync(path.join(f.chat.hiveDir, 'control/recovery.lock'), JSON.stringify({ pid: process.pid }));
  assert.equal(await runCli(['recover', ...f.args, '--confirm-stopped'], f.io), 1);
  assert.match(f.io.err, /Recovery is already in progress/);
  assert.match(f.io.err, /only after independently confirming all prior processes\/containers have stopped/);
  assert.equal(followUp(f.io.err, 'Ownership was retained. Inspect with ').split('; use ')[0], `scranton recover ${f.scope}`);
  assert.doesNotMatch(f.io.err, /--hive/);
  assert.deepEqual(fs.readFileSync(owner), saved);
});

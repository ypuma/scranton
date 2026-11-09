import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { createProjectRegistry } from '../../src/core/projects.js';

function fixture(t) {
  const root = path.resolve('.scratch/multiproject-backend'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function io(dir) {
  let text = ''; const stream = { isTTY: false, write(s) { text += s; } };
  const env = Object.fromEntries(['MICHAEL', 'DWIGHT', 'ANGELA'].flatMap((role) => [[`SCRANTON_${role}_PROVIDER`, 'openai'], [`SCRANTON_${role}_MODEL`, 'test-model']]));
  return { cwd: dir, env, stdout: stream, stderr: stream, get text() { return text; } };
}
test('projects CLI adds/lists/removes and chats lists using the explicit data directory', async (t) => {
  const dir = fixture(t), data = path.join(dir, 'data'), ws = path.join(dir, 'ws');
  let output = io(dir);
  assert.equal(await runCli(['projects', 'add', 'One', '--data', data, '--workspace', ws, '--create'], output), 0);
  const p = JSON.parse(output.text).project;
  output = io(dir); assert.equal(await runCli(['projects', 'list', '--data', data], output), 0); assert.equal(JSON.parse(output.text).projects[0].id, p.id);
  output = io(dir); assert.equal(await runCli(['chats', p.id, '--data', data], output), 0); assert.deepEqual(JSON.parse(output.text).chats, []);
  output = io(dir); assert.equal(await runCli(['projects', 'remove', p.id, '--data', data, '--delete-history'], output), 0);
  assert.ok(fs.statSync(ws).isDirectory());
});
test('run CLI selects project/chat and passes bounded context string to orchestrator', async (t) => {
  const dir = fixture(t), data = path.join(dir, 'data'), ws = path.join(dir, 'ws'); fs.mkdirSync(ws);
  const r = createProjectRegistry({ dataDir: data }), p = r.addProject({ name: 'Project', workspace: ws }), c = r.createChat(p.id);
  const context = path.join(dir, 'context.json'); fs.writeFileSync(context, JSON.stringify({ v: 1, text: 'Earlier thread' }));
  const invocations = [];
  t.mock.method(Orchestrator.prototype, 'run', async function (request) { invocations.push({ request, hive: this.config.hiveDir, workspace: this.config.workspace, context: this.threadContext }); return { status: 'success' }; });
  const output = io(dir);
  assert.equal(await runCli(['run', '--data', data, '--project', p.id, '--chat', c.id, '--thread-context', context, 'new goal'], output), 0, output.text);
  assert.deepEqual(invocations[0], { request: 'new goal', hive: c.hiveDir, workspace: ws, context: 'Earlier thread' });
  assert.equal(await runCli(['run', '--data', data, '--project', p.id, 'another goal'], io(dir)), 0);
  assert.equal(r.listChats(p.id).length, 2);
  fs.writeFileSync(context, '{"v":1,"text":42}');
  assert.equal(await runCli(['run', '--thread-context', context, 'goal'], io(dir)), 2);
});

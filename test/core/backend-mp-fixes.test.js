import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { createProjectRegistry } from '../../src/core/projects.js';

function fixture(t) {
  const root = path.resolve('.scratch/mp-fix-backend2');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('registry runs reject workspace-only data sources before loading execution settings', async (t) => {
  const dir = fixture(t), ws = path.join(dir, 'ws'), data = path.join(dir, 'data');
  fs.mkdirSync(ws);
  const registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Test', workspace: ws });
  const seen = [];
  t.mock.method(Orchestrator.prototype, 'run', async function () {
    seen.push(this.config);
    return { status: 'success' };
  });
  const keys = ['SCRANTON_DATA', 'SCRANTON_PI_COMMAND'];
  const prior = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => prior[i] === undefined ? delete process.env[key] : process.env[key] = prior[i]));
  keys.forEach((key) => delete process.env[key]);
  for (const source of ['dotenv', 'config']) {
    if (source === 'dotenv') fs.writeFileSync(path.join(ws, '.env'), `SCRANTON_DATA=${JSON.stringify(data)}\nSCRANTON_PI_COMMAND=workspace-pi\n`);
    else {
      fs.rmSync(path.join(ws, '.env'));
      fs.writeFileSync(path.join(ws, 'scranton.config.json'), JSON.stringify({ dataDir: data, pi: { command: ['workspace-pi'] }, execution: { sandbox: { mode: 'host' } } }));
    }
    let output = '';
    const stream = { write(s) { output += s; }, isTTY: false };
    const options = { cwd: ws, env: process.env, stdout: stream, stderr: stream };
    assert.equal(await runCli(['run', 'goal', '--project', project.id], options), 2, source);
    assert.match(output, /--data|SCRANTON_DATA/);
    assert.equal(seen.length, 0, 'no workspace-selected execution');
    assert.equal(process.env.SCRANTON_PI_COMMAND, undefined, 'workspace dotenv never mutates process env');
    assert.equal(process.env.SCRANTON_DATA, undefined);
    assert.equal(await runCli(['run', 'goal', '--project', project.id, '--data', data], { ...options, env: { ...options.env, ...Object.fromEntries(['MICHAEL', 'DWIGHT', 'ANGELA'].flatMap((role) => [[`SCRANTON_${role}_PROVIDER`, 'openai'], [`SCRANTON_${role}_MODEL`, 'test-model']])) } }), 0);
    assert.equal(seen.at(-1).pi, undefined);
    assert.equal(seen.at(-1).execution.sandbox.mode, 'scranton');
    seen.length = 0;
  }
});


test('history polling allocates by file size and decodes only bytes actually read', async (t) => {
  const { listRuns } = await import('../../src/core/thread.js');
  const dir = fixture(t);
  const event = JSON.stringify({ type: 'run_started', runId: 'small', request: 'Tiny history' }) + '\n';
  fs.writeFileSync(path.join(dir, 'events.jsonl'), event);
  const allocations = [];
  for (const method of ['alloc', 'allocUnsafe']) {
    const original = Buffer[method];
    t.mock.method(Buffer, method, function (size, ...args) { allocations.push(size); return original(size, ...args); });
  }
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', function (fd, buffer, offset, length, position) {
    return read(fd, buffer, offset, Math.min(length, 7), position);
  });
  assert.equal(listRuns(dir)[0].goal, 'Tiny history');
  assert.ok(allocations.length > 0);
  assert.ok(Math.max(...allocations) <= Buffer.byteLength(event) + 1, `oversized history allocation: ${Math.max(...allocations)}`);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  assert.deepEqual(listRuns(dir), []);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), event);
  fs.truncateSync(path.join(dir, 'events.jsonl'), 20 * 1024 * 1024 + 1);
  assert.deepEqual(listRuns(dir), [], 'oversized histories remain rejected');
});

import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../../src/core/cli.js';
import { loadConfig, PACKAGE_ROOT } from '../../src/core/config.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { createProjectRegistry } from '../../src/core/projects.js';

function fixture(t) {
  const base = path.resolve('.scratch/mp-fix-backend'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'cli-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws'); fs.mkdirSync(ws);
  const data = path.join(dir, 'data'), registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Test', workspace: ws });
  return { dir, ws, data, registry, project };
}
const modelsEnv = Object.fromEntries(['MICHAEL', 'DWIGHT', 'ANGELA'].flatMap((role) => [[`SCRANTON_${role}_PROVIDER`, 'openai'], [`SCRANTON_${role}_MODEL`, 'test-model']]));
const io = (cwd) => ({ cwd, env: modelsEnv, stdout: { write() {} }, stderr: { write() {} } });
test('registry CLI ignores agent-writable configuration even when invoked in workspace', async (t) => {
  const { ws, data, project } = fixture(t);
  fs.writeFileSync(path.join(ws, 'scranton.config.json'), JSON.stringify({ pi: { command: ['untrusted'] }, execution: { sandbox: { mode: 'host' } } }));
  let observed;
  t.mock.method(Orchestrator.prototype, 'run', async function () { observed = this.config; return { status: 'success' }; });
  assert.equal(await runCli(['run', '--data', data, '--project', project.id, 'goal'], io(ws)), 0);
  const trusted = loadConfig({ cwd: PACKAGE_ROOT, env: modelsEnv });
  assert.deepEqual(observed.pi, trusted.pi);
  assert.deepEqual(observed.execution, trusted.execution);
});

test('derived CLI chat titles normalize multiline and control whitespace', async (t) => {
  const { dir, data, project, registry } = fixture(t);
  t.mock.method(Orchestrator.prototype, 'run', async () => ({ status: 'success' }));
  assert.equal(await runCli(['run', '--data', data, '--project', project.id, 'First\nsecond\tthird\x00fourth'], io(dir)), 0);
  assert.equal(registry.listChats(project.id)[0].title, 'First second third fourth');
});

test('config dataDir enables the same loopback-only control bind restriction', async (t) => {
  const { dir, data } = fixture(t);
  fs.writeFileSync(path.join(dir, 'scranton.config.json'), JSON.stringify({ dataDir: data }));
  assert.equal(await runCli(['visualize', '--host', '0.0.0.0', '--port', '1771'], io(dir)), 2);
});

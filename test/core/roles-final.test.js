import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fakeConfig, readEvents } from './helpers.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { WorktreeManager } from '../../src/core/worktree.js';

const exec = promisify(execFile);
function fixture(t) {
  const root = path.resolve('.scratch/roles-final');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, config: fakeConfig(dir) };
}

test('unused pinned Hank prompt cannot break legacy runs or change their event sequence', async (t) => {
  const { dir, config } = fixture(t);
  const baseline = new Orchestrator({ config, noPlan: true, extraEnv: { FAKE_PI_SCENARIO: 'happy' } });
  assert.equal((await baseline.run('legacy')).status, 'success');
  const sequence = readEvents(config.hiveDir).map((e) => [e.type, e.agent, e.status, e.kind]);
  Object.assign(config.agents.hank, { skillSource: 'config', skill: path.join(dir, 'missing-hank.md') });
  const run = new Orchestrator({ config, noPlan: true, extraEnv: { FAKE_PI_SCENARIO: 'happy' } });
  const result = await run.run('legacy');
  assert.equal(result.status, 'success', 'unused pinned Hank prompt must not fail a legacy run');
  const events = readEvents(config.hiveDir);
  assert.deepEqual(Object.keys(events[0].prompts), ['dwight', 'angela']);
  assert.deepEqual(events.map((e) => [e.type, e.agent, e.status, e.kind]), sequence);
  assert.equal(fs.existsSync(path.join(config.hiveDir, 'hank', 'system.md')), false);
});

test('active pinned Hank prompt fails cleanly and releases lease; legacy retry ignores the same pin', async (t) => {
  const { dir, config } = fixture(t);
  const missing = path.join(dir, 'missing-hank.md');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ agents: { hank: { skill: missing } } }));
  const args = [path.resolve('bin/scranton.js'), 'demo', '--no-plan', '--delay', '0', '--scenario', 'happy', '--workspace', config.workspace, '--hive', config.hiveDir, '--config', file, '--gates'];
  await assert.rejects(exec(process.execPath, [...args, 'oscar+hank,angela'], { cwd: dir, env: process.env, timeout: 30000 }), (error) => error.code === 1);
  const events = readEvents(config.hiveDir);
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[0].prompts, undefined);
  assert.equal(events.some((e) => e.type === 'instance_started' || e.type === 'agent_finished'), false);
  assert.equal(events.at(-1).status, 'failed');
  assert.match(events.at(-1).summary, /Cannot read hank prompt/);
  assert.ok(events.at(-1).summary.includes(missing));
  assert.equal(fs.existsSync(path.join(config.hiveDir, 'control', 'owner.json')), false, 'failed prompt releases lease');
  const retry = await exec(process.execPath, [...args, 'angela'], { cwd: dir, env: process.env, timeout: 30000 }).then(() => true, () => false);
  assert.equal(retry, true, 'legacy retry must succeed with the same unreadable Hank pin');
  assert.equal(readEvents(config.hiveDir).at(-1).status, 'success');
  assert.equal(fs.existsSync(path.join(config.hiveDir, 'control', 'owner.json')), false);
});

test('prompt audit contains planner only when used and standalone role only', async (t) => {
  for (const standalone of [false, true]) {
    const { config } = fixture(t);
    const run = new Orchestrator({ config, extraEnv: { FAKE_PI_SCENARIO: 'happy' } });
    if (standalone) run.standaloneAgent = 'angela';
    assert.equal((await run.run('audit')).status, 'success');
    assert.deepEqual(Object.keys(readEvents(config.hiveDir)[0].prompts), standalone ? ['angela'] : ['michael', 'dwight', 'angela'], 'audit contains only invoked roles');
  }
});

test('failed gate ref cleanup never returns a deleted checkout on the next request', async (t) => {
  const { config } = fixture(t);
  fs.mkdirSync(config.workspace, { recursive: true });
  const manager = new WorktreeManager({ workspace: config.workspace, hiveDir: config.hiveDir, runId: 'ref-failure' });
  await manager.init();
  t.after(() => manager.close());
  await manager.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  const ref = await manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
  const old = await manager.createGateWorktree({ agent: 'hank', milestoneId: 'm1' });
  const git = manager.git.bind(manager);
  const mock = t.mock.method(manager, 'git', async (args, ...rest) => {
    if (args[0] === 'update-ref' && args[1] === '-d') throw new Error('Injected ref cleanup failure');
    return git(args, ...rest);
  });
  await assert.rejects(manager.createGateWorktree({ agent: 'hank', milestoneId: 'm1' }), /Injected ref cleanup failure/);
  assert.equal(fs.existsSync(old.dir), false);
  mock.mock.restore();
  const fresh = await manager.createWorktree({ agent: 'hank', milestoneId: 'm1', baseRef: ref });
  assert.equal(fs.existsSync(fresh.dir), true, 'next checkout request must return an existing folder');
  assert.notEqual(fresh.dir, old.dir);
  const gate = await manager.createGateWorktree({ agent: 'hank', milestoneId: 'm1' });
  assert.equal(fs.existsSync(gate.dir), true);
});

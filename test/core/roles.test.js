import './helpers.js';
import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../../src/core/config.js';
import { normalizeWorkflow } from '../../src/core/workflow.js';
import { resolvePrompt, stagePrompt, promptAudit, WHO_DECIDES } from '../../src/core/prompts.js';
import { createSandbox as createDockerSandbox } from '../../src/core/sandbox-docker/index.js';
import { startAgent } from '../../src/core/agent/index.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
const exec = promisify(execFile);
function setup(t, gates = 'oscar+hank,angela') {
  const root = path.resolve('.scratch/roles-backend'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'roles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ cwd: dir, env: {}, flags: { gates, trustedHost: true }, fileConfig: {  } });
  config.scripted = 'happy';
  return { dir, config };
}
const events = (config) => fs.readFileSync(path.join(config.hiveDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
test('workflow validates unknown/non-gate/duplicate/empty roles and CLI grammar', (t) => {
  for (const gates of [[], [[]], [['dwight']], [['unknown']], [['oscar'], ['oscar']], [['oscar', 'hank', 'angela', 'hank']]]) assert.throws(() => normalizeWorkflow({ gates }));
  for (const gates of ['', 'oscar++hank', ',angela', 'oscar,oscar', 'michael']) assert.throws(() => setup(t, gates));
  assert.deepEqual(setup(t).config.workflow.gates, [['oscar', 'hank'], ['angela']]);
});
test('prompt precedence, frontmatter stripping, delivery and audit hashes', (t) => {
  const { config } = setup(t);
  assert.equal(resolvePrompt(config, 'oscar').source, 'builtin');
  fs.mkdirSync(config.promptsDir, { recursive: true });
  fs.writeFileSync(path.join(config.promptsDir, 'oscar.md'), '---\nname: override\n---\nCustom [REVIEW_APPROVED]');
  assert.equal(resolvePrompt(config, 'oscar').text, 'Custom [REVIEW_APPROVED]');
  assert.equal(resolvePrompt(config, 'oscar').source, 'custom');
  assert.equal(fs.readFileSync(stagePrompt(config, { dir: config.hiveDir }, 'oscar'), 'utf8'), 'Custom [REVIEW_APPROVED]\n\n' + WHO_DECIDES + '\n');
  assert.match(promptAudit(config).oscar.sha256, /^[a-f0-9]{64}$/);
  config.agents.oscar.skillSource = 'config';
  assert.equal(resolvePrompt(config, 'oscar').editable, false);
  assert.equal(resolvePrompt(config, 'oscar').source, 'config');
});
test('Docker model selection is host-only and does not require explicit gate models', (t) => {
  const { config } = setup(t); config.execution.sandbox.mode = 'docker';
  for (const role of ['michael', 'dwight', 'oscar', 'hank']) Object.assign(config.agents[role], { provider: 'fake', model: 'fake' });
  config.workflow = { gates: [['oscar', 'hank']] };
  config.agents.hank.model = null;
  assert.doesNotThrow(() => loadConfig({cwd: config.cwd, env: {}, fileConfig: {execution: {sandbox: {mode: 'docker'}}, workflow: config.workflow}}));
});
for (const gates of ['oscar,hank,angela', 'oscar+hank,angela']) test(`real CLI scripted runtime passes ${gates}`, async (t) => {
  const { dir, config } = setup(t, gates);
  await exec(process.execPath, [path.resolve('bin/scranton.js'), 'run', 'Test gates', '--trusted-host', '--no-plan', '--gates', gates, '--workspace', config.workspace, '--hive', config.hiveDir], { cwd: dir, env: { ...process.env, SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy' }, timeout: 30000 });
  const es = events(config);
  assert.equal(es.at(-1).status, 'success');
  assert.deepEqual(es.filter((e) => e.type === 'gate_result').map((e) => e.agent).sort(), ['angela', 'hank', 'oscar']);
  const dirs = es.filter((e) => e.type === 'instance_started').map((e) => e.worktree);
  assert.equal(new Set(dirs).size, 4);
  assert.ok(es.findIndex((e) => e.type === 'milestone_integrated') > es.findLastIndex((e) => e.type === 'gate_result'));
  assert.match(es[0].prompts.oscar.sha256, /^[a-f0-9]{64}$/);
});
test('changes_once sends one combined report and passes cycle 2; security_issues trips once per stage', async (t) => {
  for (const scenario of ['changes_once', 'security_issues']) {
    const { config } = setup(t);
    const o = new Orchestrator({ config, noPlan: true, onBreaker: 'abort', extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: scenario } });
    const result = await o.run('test gates'); const es = events(config);
    if (scenario === 'changes_once') {
      assert.equal(result.status, 'success', result.summary);
      assert.equal(es.filter((e) => e.type === 'cycle_result' && e.result === 'failed').length, 1);
      const report = fs.readFileSync(path.join(config.hiveDir, 'dwight-m1', 'inbox.md'), 'utf8');
      assert.match(report, /Gate verification failed/); assert.match(report, /Code Reviewer's Review report/);
      assert.equal(report.includes("QA Tester's last QA report"), false, 'gate report keeps its own role label');
      assert.equal((report.match(/^# (?:Task|Bug report):/gm) ?? []).length, 1, 'one top-level task heading');
    } else {
      assert.equal(result.status, 'aborted');
      assert.deepEqual(es.filter((e) => e.type === 'cycle_result').map((e) => e.failedCycles), [1, 2]);
      assert.equal(es.find((e) => e.type === 'circuit_breaker' && e.state === 'tripped').cause, 'stalled');
      assert.equal(es.findLast((e) => e.type === 'progress_check').rule, 'repeat');
      assert.equal(es.filter((e) => e.type === 'hitl_request').length, 1);
      assert.equal(es.some((e) => e.type === 'gate_result' && e.agent === 'angela'), false);
    }
  }
});
test('parallel failures aggregate in listed order independent of finish order, repeated three times', { timeout: 180000 }, async (t) => {
  let reference, referenceState, referenceGates;
  const finishOrders = [];
  const stableState = (value) => JSON.parse(JSON.stringify(value, (key, item) => ['ts', 'updatedAt', 'runId', 'sessionId', 'worktree', 'workspace', 'startedAt', 'finishedAt', 'durationMs'].includes(key) ? undefined : item));
  for (const [oscar, hank] of [[0, 1], [1, 0], [0, 1]]) {
    const { config } = setup(t);
    const checkoutReadiness = [], stages = new Map();
    const o = new Orchestrator({ config, noPlan: true, onBreaker: 'abort', extraEnv: { SCRANTON_FAKE_DETERMINISTIC: '1', SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy', SCRANTON_FAKE_DELAY_MS: '0' }, startRunner: (options) => {
      if (['oscar', 'hank'].includes(options.agentId)) checkoutReadiness.push(['oscar', 'hank'].every((role) => o.worktrees.worktrees.has(`${role}-${options.milestone}`)));
      // One milestone exercises aggregation and retry without two unrelated successful milestones.
      const scenario = options.cycle === 1 ? { oscar: 'changes_once', hank: 'security_issues' }[options.agentId] ?? 'happy' : 'happy';
      const runner = startAgent({ ...options, scripted: scenario });
      if (['oscar', 'hank'].includes(options.agentId)) {
        const key = options.milestone + ':' + options.cycle;
        if (!stages.has(key)) stages.set(key, {});
        const stage = stages.get(key), first = oscar < hank ? 'oscar' : 'hank';
        stage[options.agentId] = runner.done;
        stage.ready ??= Promise.withResolvers();
        if (stage.oscar && stage.hank) stage.ready.resolve();
        stage.firstFinished ??= Promise.withResolvers();
        runner.done = (async () => {
          await stage.ready.promise;
          const results = await Promise.all([stage.oscar, stage.hank]);
          if (options.agentId !== first) await stage.firstFinished.promise;
          else setImmediate(() => stage.firstFinished.resolve());
          return results[options.agentId === 'oscar' ? 0 : 1];
        })();
      }
      return runner;
    } });
    assert.equal((await o.run('ordered')).status, 'success');
    assert.ok(checkoutReadiness.every(Boolean), 'all stage checkouts exist before parallel launch');
    const es = events(config);
    const finishOrder = es.filter((e) => e.type === 'agent_finished' && e.milestoneId === 'm1' && e.cycle === 1 && ['oscar', 'hank'].includes(e.agent)).map((e) => e.agent);
    assert.deepEqual(finishOrder, oscar < hank ? ['oscar', 'hank'] : ['hank', 'oscar'], 'forced gate finish order');
    finishOrders.push(finishOrder.join(','));
    const failed = es.find((e) => e.type === 'cycle_result' && e.result === 'failed');
    assert.equal(failed.reason, 'Stage 1 failed: Code Reviewer [CHANGES_REQUESTED], Security Auditor [SECURITY_ISSUES]');
    const archives = fs.readdirSync(path.join(config.hiveDir, 'dwight-m1', 'archive'));
    const reports = archives.map((f) => fs.readFileSync(path.join(config.hiveDir, 'dwight-m1', 'archive', f), 'utf8')).concat(fs.readFileSync(path.join(config.hiveDir, 'dwight-m1', 'inbox.md'), 'utf8'));
    const report = reports.find((s) => s.includes("Code Reviewer's Review report"));
    assert.ok(report.indexOf("Code Reviewer's Review report") < report.indexOf("Security Auditor's Security report"));
    const decisions = es.filter((e) => e.type === 'cycle_result').map(({ milestoneId, cycle, result, failedCycles, reason }) => ({ milestoneId, cycle, result, failedCycles, reason }));
    if (reference) assert.deepEqual(decisions, reference); else reference = decisions;
    const gateDecisions = es.filter((e) => e.type === 'gate_result').map(({ milestoneId, cycle, stage, agent, result, keyword }) => ({ milestoneId, cycle, stage, agent, result, keyword })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (referenceGates) assert.deepEqual(gateDecisions, referenceGates); else referenceGates = gateDecisions;
    const state = stableState(JSON.parse(fs.readFileSync(path.join(config.hiveDir, 'state.json'))));
    // Cumulative samples follow actual completion order; final totals do not.
    state.usage.series = [];
    if (referenceState) assert.deepEqual(state, referenceState); else referenceState = state;
  }
  assert.equal(new Set(finishOrders).size, 2, 'actual finish order changed');
});

test('blocked gate retry repeats only the paused stage without a failed cycle', async (t) => {
  const { config } = setup(t, 'oscar,hank,angela');
  let questions = 0;
  const o = new Orchestrator({ config, noPlan: true, hitl: async () => {
    questions++; o.extraEnv.SCRANTON_FAKE_SCENARIO = 'happy'; return { decision: 'retry' };
  }, extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy' }, listener: (e) => {
    if (e.type === 'gate_result' && e.agent === 'oscar') o.extraEnv.SCRANTON_FAKE_SCENARIO = 'blocked';
  } });
  assert.equal((await o.run('retry stage')).status, 'success');
  const es = events(config);
  assert.equal(questions, 1);
  assert.deepEqual(es.filter((e) => e.type === 'agent_finished').map((e) => e.agent), ['dwight', 'oscar', 'hank', 'hank', 'angela']);
  assert.equal(es.some((e) => e.type === 'cycle_result' && e.result === 'failed'), false);
});

test('saved custom prompt stays on host; Docker mounts only worktree and Git mask', async (t) => {
  const { WorktreeManager } = await import('../../src/core/worktree.js');
  const { createHash } = await import('node:crypto');
  const { config } = setup(t, 'oscar');
  fs.mkdirSync(config.promptsDir, { recursive: true });
  const text = 'Custom reviewer marker [REVIEW_APPROVED] [CHANGES_REQUESTED] [BLOCKED]';
  fs.writeFileSync(path.join(config.promptsDir, 'oscar.md'), text);
  const o = new Orchestrator({ config, noPlan: true, onBreaker: 'abort', extraEnv: { SCRANTON_FAKE_EXPECT_PROMPT: text, SCRANTON_FAKE_FAIL_ROLE: 'oscar' } });
  // Only the Code Reviewer is customized; the fixture validates its argv in a standalone invocation.
  o.standaloneAgent = 'oscar';
  assert.equal((await o.run('check prompt')).status, 'success');
  assert.equal(events(config)[0].prompts.oscar.sha256, createHash('sha256').update(text + '\n\n' + WHO_DECIDES).digest('hex'));
  assert.equal(JSON.stringify(events(config)).includes(text), false);
  const manager = new WorktreeManager({ workspace: config.workspace, hiveDir: config.hiveDir, runId: 'prompt-mount' });
  await manager.init(); t.after(() => manager.close());
  const checkout = await manager.createWorktree({ agent: 'oscar', milestoneId: 'm1' });
  const prompt = stagePrompt(config, { dir: config.hiveDir }, 'oscar');
  const tempDir = path.join(config.hiveDir, 'docker-temp'); fs.mkdirSync(tempDir);
  let args;
  const execution = createDockerSandbox({worktree: checkout.dir, tempDir}, {
    executable: path.resolve('.scratch/roles-backend/fake-docker.exe'),
    runSync: (_exe, argv) => { if (argv[0] === 'run') args = argv; return ['info', 'image'].includes(argv[0]) ? 'linux' : ''; },
    run: async () => ''
  });
  execution.prepare();
  const mounts = args.filter((_, i) => args[i - 1] === '--mount');
  assert.equal(mounts.length, 2);
  assert.ok(mounts.includes(`type=bind,source=${checkout.dir},target=/workspace`));
  assert.ok(mounts.some(m => m.endsWith('target=/workspace/.git,readonly')));
  for (const privatePath of [prompt, config.promptsDir, path.join(config.hiveDir, 'sessions')]) assert.equal(args.some(arg => arg.includes(privatePath)), false);
  assert.equal(fs.readFileSync(prompt, 'utf8'), text + '\n\n' + WHO_DECIDES + '\n');
  await execution.dispose();
});

test('parallel gate checkouts share exact developer ref; gate edits never integrate', async (t) => {
  const { WorktreeManager } = await import('../../src/core/worktree.js');
  const { config } = setup(t); fs.mkdirSync(config.workspace, { recursive: true });
  const manager = new WorktreeManager({ workspace: config.workspace, hiveDir: config.hiveDir, runId: 'gate-isolation' });
  await manager.init(); t.after(() => manager.close());
  const dev = await manager.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  fs.writeFileSync(path.join(dev.dir, 'source.txt'), 'developer');
  const ref = await manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
  const gates = await Promise.all(['oscar', 'hank', 'angela'].map((agent) => manager.createGateWorktree({ agent, milestoneId: 'm1' })));
  assert.equal(new Set(gates.map((g) => g.dir)).size, 3);
  for (const gate of gates) {
    assert.equal(manager.worktrees.get([...manager.worktrees].find(([, r]) => r.dir === gate.dir)[0]).base, ref);
    assert.equal(fs.readFileSync(path.join(gate.dir, 'source.txt'), 'utf8'), 'developer');
    fs.writeFileSync(path.join(gate.dir, 'source.txt'), 'gate mutation');
    fs.writeFileSync(path.join(gate.dir, 'gate-only.txt'), 'not approved');
  }
  await manager.integrateToTarget({ milestoneId: 'm1' });
  assert.equal(fs.readFileSync(path.join(config.workspace, 'source.txt'), 'utf8'), 'developer');
  assert.equal(fs.existsSync(path.join(config.workspace, 'gate-only.txt')), false);
});

test('missing configured prompt fails cleanly through CLI and releases its lease for the next run', async (t) => {
  const { dir, config } = setup(t, 'oscar');
  const file = path.join(dir, 'config.json');
  const missing = path.join(dir, 'missing-oscar.md');
  fs.writeFileSync(file, JSON.stringify({ agents: { oscar: { skill: missing } } }));
  const args = [path.resolve('bin/scranton.js'), 'run', 'Test gates', '--trusted-host', '--no-plan', '--gates', 'oscar', '--workspace', config.workspace, '--hive', config.hiveDir, '--config', file];
  await assert.rejects(exec(process.execPath, args, { cwd: dir, env: { ...process.env, SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy' }, timeout: 30000 }), (error) => error.code === 1);
  assert.equal(fs.existsSync(path.join(config.hiveDir, 'control', 'owner.json')), false, 'prompt refusal releases the lease');
  assert.equal(events(config).at(-1).type, 'run_finished', 'prompt refusal terminates the event stream');
  assert.equal(events(config).at(-1).status, 'failed');
  assert.ok(events(config).at(-1).summary.includes('oscar') && events(config).at(-1).summary.includes(missing));
  fs.writeFileSync(missing, 'Restored [REVIEW_APPROVED]');
  await exec(process.execPath, args, { cwd: dir, env: { ...process.env, SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy' }, timeout: 30000 });
  assert.equal(events(config).at(-1).status, 'success', 'same hive accepts the next run');
});

test('parallel blocked gates await siblings, choose listed first and retry only that stage', async (t) => {
  const { config } = setup(t, 'angela,oscar+hank');
  let questions = 0;
  const o = new Orchestrator({ config, noPlan: true, extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy', SCRANTON_FAKE_OSCAR_DELAY_MS: '400' }, listener: (e) => {
    if (e.type === 'gate_result' && e.agent === 'angela') o.extraEnv.SCRANTON_FAKE_SCENARIO = 'blocked';
  }, hitl: async ({ reason }) => {
    questions++;
    assert.match(reason, /^Code Reviewer:/, 'first blocked gate is chosen in listed order');
    assert.deepEqual(events(config).filter((e) => e.type === 'gate_result').map((e) => e.agent).sort(), ['angela', 'hank', 'oscar'], 'sibling finishes before pause');
    o.extraEnv.SCRANTON_FAKE_SCENARIO = 'happy';
    return { decision: 'retry' };
  } });
  assert.equal((await o.run('blocked parallel')).status, 'success');
  assert.equal(questions, 1);
  for (const [role, count] of [['dwight', 1], ['angela', 1], ['oscar', 2], ['hank', 2]]) assert.equal(events(config).filter((e) => e.type === 'agent_finished' && e.agent === role).length, count);
  assert.equal(events(config).some((e) => e.type === 'cycle_result' && e.result === 'failed'), false);
});

test('gate output without a keyword fails its stage and skips later stages', async (t) => {
  const { config } = setup(t); config.maxFailedCycles = 1;
  const o = new Orchestrator({ config, noPlan: true, onBreaker: 'abort', extraEnv: { SCRANTON_FAKE_MISSING_KEYWORD_ROLE: 'oscar' } });
  assert.equal((await o.run('missing keyword')).status, 'aborted');
  const es = events(config);
  assert.match(es.find((e) => e.type === 'cycle_result').reason, /^The Code Reviewer reported \[MISSING_KEYWORD\]:/);
  assert.equal(es.find((e) => e.type === 'gate_result' && e.agent === 'oscar').result, 'failed');
  assert.equal(es.some((e) => e.type === 'agent_finished' && e.agent === 'angela'), false);
});

test('abort drains parallel gate runners and leaves run_finished last', async (t) => {
  const { config } = setup(t);
  const running = new Set(), killed = new Set();
  const o = new Orchestrator({ config, noPlan: true, extraEnv: { SCRANTON_FAKE_OSCAR_DELAY_MS: '400', SCRANTON_FAKE_HANK_DELAY_MS: '400' }, startRunner: (options) => {
    const runner = startAgent(options), kill = runner.kill;
    runner.kill = (reason) => { if (['oscar', 'hank'].includes(options.agentId)) killed.add(options.agentId); return kill(reason); };
    return runner;
  }, listener: (e) => {
    if (e.type === 'agent_status' && e.status === 'thinking' && ['oscar', 'hank'].includes(e.agent)) {
      running.add(e.agent);
      if (running.size === 2) o.abort('test parallel abort');
    }
  } });
  assert.equal((await o.run('abort runners')).status, 'aborted');
  assert.equal(running.size, 2);
  assert.deepEqual([...killed].sort(), ['hank', 'oscar'], 'abort kills both parallel gate processes');
  assert.equal(o.active.size, 0, 'all gate runners cleaned up');
  assert.equal(o.cleanupComplete, true);
  assert.deepEqual(events(config).filter((e) => e.type === 'agent_finished' && ['oscar', 'hank'].includes(e.agent)).map((e) => e.agent).sort(), ['hank', 'oscar']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events(config).at(-1).type, 'run_finished', 'no event after run_finished');
});

test('abort waits for queued gate preparation without delivering after abort', async (t) => {
  const { WorktreeManager } = await import('../../src/core/worktree.js');
  const { config } = setup(t);
  const prepare = WorktreeManager.prototype.prepareGate;
  let prepared = false;
  const o = new Orchestrator({ config, noPlan: true, extraEnv: { SCRANTON_FAKE_OSCAR_DELAY_MS: '10000' } });
  t.mock.method(WorktreeManager.prototype, 'prepareGate', async function (options) {
    if (options.agent === 'hank') {
      o.abort('abort during second checkout');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const result = await prepare.call(this, options);
    if (options.agent === 'hank') prepared = true;
    return result;
  });
  assert.equal((await o.run('abort preparation')).status, 'aborted');
  assert.equal(prepared, true, 'run waits for second checkout preparation');
  const es = events(config);
  const abortEnd = es.findIndex((e) => e.type === 'run_finished');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(events(config).length, abortEnd + 1, 'no late preparation event');
  assert.equal(events(config).some((e) => e.type === 'hive_write' && e.to === 'hank'), false, 'no delivery after abort');
});

test('gate replacement removes old checkout and ref but close preserves latest diagnostics', async (t) => {
  const { WorktreeManager } = await import('../../src/core/worktree.js');
  const { config } = setup(t); fs.mkdirSync(config.workspace, { recursive: true });
  const manager = new WorktreeManager({ workspace: config.workspace, hiveDir: config.hiveDir, runId: 'bounded-gates' });
  await manager.init(); t.after(() => manager.close());
  await manager.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  await manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
  const old = await manager.createGateWorktree({ agent: 'oscar', milestoneId: 'm1' });
  fs.writeFileSync(path.join(old.dir, 'diagnostic.txt'), 'old');
  const latest = await manager.createGateWorktree({ agent: 'oscar', milestoneId: 'm1' });
  assert.equal(fs.existsSync(old.dir), false, 'superseded gate checkout removed');
  await assert.rejects(manager.git(['rev-parse', '--verify', old.ref]));
  fs.writeFileSync(path.join(latest.dir, 'diagnostic.txt'), 'latest');
  await manager.close();
  assert.equal(fs.readFileSync(path.join(latest.dir, 'diagnostic.txt'), 'utf8'), 'latest');
});

test('close waits for an already queued gate checkout', async (t) => {
  const { WorktreeManager } = await import('../../src/core/worktree.js');
  const { config } = setup(t); fs.mkdirSync(config.workspace, { recursive: true });
  const manager = new WorktreeManager({ workspace: config.workspace, hiveDir: config.hiveDir, runId: 'close-gates' });
  await manager.init();
  await manager.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  await manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
  const preparing = manager.createGateWorktree({ agent: 'hank', milestoneId: 'm1' });
  let prepared = false;
  const observed = preparing.then(() => { prepared = true; });
  await manager.close();
  assert.equal(prepared, true, 'close drains gate preparation');
  await observed;
});

test('live prompt PUT affects the next run only; launches and audit use the run snapshot', async (t) => {
  const { startVisualizerServer } = await import('../../src/server/visualizer-server.js');
  const { createHash } = await import('node:crypto');
  const { dir, config } = setup(t, 'oscar');
  const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'server-hive'), dataDir: path.join(dir, 'data'), publicDir: dir, port: 0, control: { auth: { close() {} } } });
  t.after(() => srv.close());
  config.promptsDir = path.join(dir, 'data', 'prompts');
  const put = async (text) => {
    const response = await fetch(srv.url + '/api/agents/oscar/prompt', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1' }, body: JSON.stringify({ text }) });
    assert.equal(response.status, 200);
  };
  const before = 'Original reviewer [REVIEW_APPROVED]', after = 'Updated reviewer [REVIEW_APPROVED]';
  await put(before);
  for (const expected of [before, after]) {
    const received = [];
    const o = new Orchestrator({ config, noPlan: true, onBreaker: 'abort', startRunner: (options) => {
      if (options.agentId === 'oscar') received.push(fs.readFileSync(options.systemPromptFile, 'utf8').trim());
      const runner = startAgent(options);
      if (options.agentId === 'dwight') {
        const done = runner.done;
        runner.done = done.then(async (result) => { await put(after); return result; });
      }
      return runner;
    } });
    assert.equal((await o.run('snapshot prompts')).status, 'success');
    assert.deepEqual(received, [expected + '\n\n' + WHO_DECIDES], 'later gate receives the run snapshot, not the live PUT');
    assert.equal(events(config)[0].prompts.oscar.sha256, createHash('sha256').update(expected + '\n\n' + WHO_DECIDES).digest('hex'), 'audit hashes delivered snapshot');
  }
});

test('gate feedback retains per-role labels without Angela attribution or duplicate Task heading', async () => {
  const { dwightMessage, gateBugReport } = await import('../../src/core/messages.js');
  const context = { milestone: { id: 'm1', title: 'Review', description: 'Implement', acceptanceCriteria: [] }, request: 'task' };
  const failures = [{ agent: 'oscar', text: 'Review failure' }, { agent: 'hank', text: 'Security failure' }];
  const feedback = dwightMessage({ kind: 'feedback', ...context, gateReports: failures, humanFeedback: 'Fix both' });
  assert.match(feedback, /Code Reviewer's Review report\n\nReview failure/, 'feedback labels the Code Reviewer report');
  assert.match(feedback, /Security Auditor's Security report\n\nSecurity failure/);
  assert.equal(feedback.includes("QA Tester's last QA report"), false);
  const report = gateBugReport({ failures, ...context });
  assert.equal(report.includes('# Task:'), false, 'combined report has no duplicate task heading');
  assert.equal(report.includes('Implement this milestone in your current working directory.'), false);
  assert.match(report, /## Milestone\n\nImplement/);
});

test('human feedback after a gate failure carries neutral gate reports to Dwight', async (t) => {
  const { config } = setup(t, 'oscar+hank'); config.maxFailedCycles = 1;
  const o = new Orchestrator({ config, noPlan: true, extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'changes_once' }, hitl: async () => ({ decision: 'feedback', feedback: 'Address the review' }) });
  assert.equal((await o.run('feedback reports')).status, 'success');
  const body = fs.readFileSync(path.join(config.hiveDir, 'dwight-m1', 'inbox.md'), 'utf8');
  assert.match(body, /Code Reviewer's Review report/);
  assert.equal(body.includes("QA Tester's last QA report"), false, 'Code Reviewer report is not attributed to the QA Tester');
  assert.match(body, /Address the review/);
});

test('Michael prompt API saves are idempotent and audit the single staged progress section', async t => {
  const { startVisualizerServer } = await import('../../src/server/visualizer-server.js');
  const { createHash } = await import('node:crypto');
  const { dir, config } = setup(t);
  const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'server-hive'), dataDir: path.join(dir, 'data'), publicDir: dir, port: 0, control: { auth: { close() {} } } });
  t.after(() => srv.close());
  config.promptsDir = path.join(dir, 'data', 'prompts');
  const put = async text => {
    const response = await fetch(srv.url + '/api/agents/michael/prompt', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1' }, body: JSON.stringify({ text }) });
    assert.equal(response.status, 200);
  };
  const generated = '## Progress checks\n\nWhen the current request is a progress check, its Required answer overrides planning or conversation instructions. Judge the supplied failure history only; return exactly one [PROGRESS] or [STALLED] keyword and one reason line. Do not plan or call tools.';
  await put('Custom Michael [PLAN_READY]\n\n' + generated + '\n\n' + generated);
  const file = path.join(config.promptsDir, 'michael.md');
  const saved = fs.readFileSync(file, 'utf8');
  assert.equal(saved, 'Custom Michael [PLAN_READY]\n', 'migrates only the exact previously generated text');
  const resolved = resolvePrompt(config, 'michael');
  assert.doesNotMatch(resolved.text, /## Progress checks/);
  await put(resolved.text);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.equal(resolvePrompt(config, 'michael').text, resolved.text);
  const empty = await fetch(srv.url + '/api/agents/michael/prompt', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1' }, body: JSON.stringify({ text: generated }) });
  assert.equal(empty.status, 400, 'generated instructions alone are not an editable prompt');
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.equal((fs.readFileSync(stagePrompt(config, { dir: config.hiveDir }, 'michael'), 'utf8').match(/## Progress checks/g) ?? []).length, 1);
  let staged;
  const o = new Orchestrator({ config, noPlan: true, startRunner(options) {
    staged = fs.readFileSync(options.systemPromptFile, 'utf8').trimEnd();
    return { done: Promise.resolve({ ok: true, keyword: 'PLAN_READY', text: '[PLAN_READY]', exitCode: 0, durationMs: 0 }), kill: async () => {} };
  } });
  o.standaloneAgent = 'michael';
  assert.equal((await o.run('Inspect prompt')).status, 'success');
  assert.equal((staged.match(/## Progress checks/g) ?? []).length, 1);
  assert.equal(events(config)[0].prompts.michael.sha256, createHash('sha256').update(staged).digest('hex'));
  assert.ok(events(config)[0].roles[0].keywords.includes('PROGRESS'));
  assert.equal(fs.readFileSync(file, 'utf8'), saved, 'staging never changes the editable source');
});

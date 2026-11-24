import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertContract, ofType, runFake, tempDir, types } from './helpers.js';

const feedbackHitl = (calls = []) => async (ctx) => {
  calls.push(ctx);
  return { decision: 'feedback', feedback: 'Store todos.json in the current directory.' };
};

test('happy path: three milestones pass in the contract event order', async (t) => {
  const run = await runFake(t, { scenario: 'happy' });
  assert.equal(run.result.status, 'success');
  assertContract(run.events, run.state);
  assert.equal(run.state.status, 'finished');
  assert.deepEqual(run.state.milestones.map((m) => m.status), ['passed', 'passed', 'passed']);
  assert.equal(run.state.breaker, 'closed');
  assert.deepEqual(ofType(run.events, 'cycle_result').map((e) => e.result), ['passed', 'passed', 'passed']);
  assert.deepEqual(ofType(run.events, 'milestone_finished').map((e) => e.status), ['passed', 'passed', 'passed']);
  assert.equal(ofType(run.events, 'run_finished')[0].status, 'success');

  // the typical-run prefix from the contract
  const first = run.events.slice(0, 5).map((e) => `${e.type}${e.agent ? `:${e.agent}` : ''}`);
  assert.deepEqual(first.slice(0, 3), ['run_started', 'agent_status:michael', 'hive_write']);
  const writes = ofType(run.events, 'hive_write').map((e) => `${e.from}>${e.to}:${e.kind}`);
  assert.deepEqual(writes.slice(0, 4), ['human>michael:plan_request', 'michael>dwight:task', 'dwight>angela:handoff', 'michael>dwight:task']);
  assert.equal(ofType(run.events, 'agent_finished').find((e) => e.agent === 'michael').keyword, 'PLAN_READY');

  // The Developer really wrote files into the workspace; mailboxes and plan exist
  for (const f of ['todo.js', 'cli.js', 'README.md', path.join('test', 'todo.test.js')]) {
    assert.ok(fs.existsSync(path.join(run.config.workspace, f)), f);
  }
  const hive = run.config.hiveDir;
  for (const f of ['michael/plan.json', 'michael/plan.md', 'dwight-m3/outbox.md', 'angela-m3/outbox.md', 'angela-m3/inbox.md']) {
    assert.ok(fs.existsSync(path.join(hive, f)), f);
  }
  assert.ok(fs.existsSync(path.join(hive, 'dwight-m1', 'inbox.md')), 'instance mailbox is retained');
  assert.match(fs.readFileSync(path.join(hive, 'angela-m3', 'inbox.md'), 'utf8'), /^---\nfrom: dwight\nto: angela-m3\nkind: handoff\nrunId: run-/);
});

test('scripted invocations record SCRANTON_* metadata, workspace and instance identity; the Hive has a durable database', async (t) => {
  const run = await runFake(t, { scenario: 'happy' });
  const dwightM2 = run.invocations.find((i) => i.role === 'dwight' && i.milestone === 'm2');
  assert.equal(dwightM2.scranton.SCRANTON_AGENT, 'dwight');
  assert.equal(dwightM2.scranton.SCRANTON_MILESTONE, 'm2');
  assert.equal(dwightM2.scranton.SCRANTON_CYCLE, '1');
  assert.equal(dwightM2.scranton.SCRANTON_RUN_ID, run.events[0].runId);
  assert.equal(dwightM2.cwd.toLowerCase(), run.config.workspace.toLowerCase());
  assert.equal(dwightM2.instanceId, 'dwight-m2');
  assert.equal(fs.existsSync(path.join(run.config.hiveDir, 'dbos.sqlite')), true);
  assert.equal(run.invocations.find((i) => i.role === 'michael').scranton.SCRANTON_MILESTONE, '');
});

test("Angela's argv never allows write or edit; Michael is read-only too; Dwight can write", async (t) => {
  const run = await runFake(t, { scenario: 'flaky' });
  const tools = (role) => run.invocations.filter((i) => i.role === role).map((i) => i.agentConfig.tools);
  assert.ok(tools('angela').length >= 4);
  for (const list of tools('angela')) {
    assert.ok(!list.includes('write') && !list.includes('edit'), list.join(','));
    assert.ok(list.includes('bash'));
  }
  for (const list of tools('michael')) assert.deepEqual(list, ['read', 'grep', 'find', 'ls']);
  for (const list of tools('dwight')) assert.ok(list.includes('write') && list.includes('edit'));
  for (const i of run.invocations) assert.match(i.message, /kind:/);
});

test('flaky: Angela fails m2 once, Dwight gets a bug report, then it passes', async (t) => {
  const run = await runFake(t, { scenario: 'flaky' });
  assert.equal(run.result.status, 'success');
  assertContract(run.events, run.state);
  const m2 = ofType(run.events, 'cycle_result').filter((e) => e.milestoneId === 'm2');
  assert.deepEqual(m2.map((e) => [e.cycle, e.result, e.failedCycles]), [[1, 'failed', 1], [2, 'passed', 0]]);
  const kinds = ofType(run.events, 'hive_write').map((e) => `${e.from}>${e.to}:${e.kind}`);
  assert.ok(kinds.includes('angela>dwight:bug_report'));
  assert.equal(ofType(run.events, 'circuit_breaker').length, 0);
  // the bug report carries the QA Tester's report
  const archived = fs.readdirSync(path.join(run.config.hiveDir, 'dwight-m2', 'archive'));
  const bug = archived.find((f) => f.includes('angela-bug_report'));
  assert.match(fs.readFileSync(bug ? path.join(run.config.hiveDir, 'dwight-m2', 'archive', bug) : path.join(run.config.hiveDir, 'dwight-m2', 'inbox.md'), 'utf8'), /Suspected file: cli\.js/);
  assert.equal(run.state.agents.angela.totals.runs, 4);
});

test('breaker: 3 failed cycles trip it, the injected human feedback resets it and the milestone passes', async (t) => {
  const calls = [];
  const run = await runFake(t, { scenario: 'breaker', config: { maxFailedCycles: 3, maxStalledCycles: 10 }, hitl: feedbackHitl(calls) });
  assert.equal(run.result.status, 'success');
  assertContract(run.events, run.state);

  assert.equal(calls.length, 1);
  assert.match(calls[0].reason, /^m2 reached the cycle limit \(3\): QA report for m2/);
  assert.ok(calls[0].reason.length <= 300);
  assert.match(calls[0].excerpt, /Suspected file: cli\.js/);
  assert.equal(calls[0].feedbackTarget, 'the Developer');

  const idx = (pred) => run.events.findIndex(pred);
  const tripped = idx((e) => e.type === 'circuit_breaker' && e.state === 'tripped');
  const blocked = idx((e) => e.type === 'agent_status' && e.agent === 'michael' && e.status === 'blocked' && e.activity === 'Needs a human!');
  const request = idx((e) => e.type === 'hitl_request');
  const response = idx((e) => e.type === 'hitl_response');
  const reset = idx((e) => e.type === 'circuit_breaker' && e.state === 'reset');
  const feedbackWrite = idx((e) => e.type === 'hive_write' && e.kind === 'feedback');
  assert.ok(tripped >= 0 && tripped < blocked && blocked < request && request < response && response < reset && reset < feedbackWrite, 'contract order');
  assert.deepEqual(
    [run.events[tripped].failedCycles, run.events[tripped].maxFailedCycles, run.events[reset].failedCycles],
    [3, 3, 0]
  );
  assert.equal(run.events[request].options.join(), 'feedback,retry,skip,abort');
  assert.equal(run.events[response].decision, 'feedback');
  assert.equal(run.events[response].feedback, 'Store todos.json in the current directory.');
  assert.deepEqual(
    ofType(run.events, 'cycle_result').filter((e) => e.milestoneId === 'm2').map((e) => [e.cycle, e.result, e.failedCycles]),
    [[1, 'failed', 1], [2, 'failed', 2], [3, 'failed', 3], [4, 'passed', 0]]
  );
  // the human note landed in the hive, and the Developer's feedback inbox holds the text + the QA Tester's report
  assert.ok(fs.existsSync(path.join(run.config.hiveDir, 'human', 'inbox.md')));
  const feedbackInbox = fs.readdirSync(path.join(run.config.hiveDir, 'dwight-m2', 'archive')).find((f) => f.includes('human-feedback'));
  const text = fs.readFileSync(feedbackInbox ? path.join(run.config.hiveDir, 'dwight-m2', 'archive', feedbackInbox) : path.join(run.config.hiveDir, 'dwight-m2', 'inbox.md'), 'utf8');
  assert.match(text, /Store todos\.json in the current directory/);
  assert.match(text, /QA Tester's last QA report/);
});

test('breaker: --on-breaker skip skips the milestone and the run is partial', async (t) => {
  const run = await runFake(t, { scenario: 'breaker', onBreaker: 'skip' });
  assert.equal(run.result.status, 'partial');
  assertContract(run.events, run.state);
  assert.deepEqual(run.state.milestones.map((m) => m.status), ['passed', 'skipped', 'blocked']);
  assert.equal(ofType(run.events, 'hitl_response')[0].decision, 'skip');
  assert.equal(ofType(run.events, 'run_finished')[0].status, 'partial');
  assert.equal(run.state.breaker, 'closed');
  assert.equal(run.state.failedCycles, 0);

  const seq = run.events
    .filter((e) => ['circuit_breaker', 'hitl_request', 'hitl_response', 'milestone_finished', 'milestone_started'].includes(e.type) && e.milestoneId === 'm2')
    .map((e) => [e.type, e.state ?? e.decision ?? e.status ?? ''].join(':'));
  assert.deepEqual(seq, [
    'milestone_started:',
    'circuit_breaker:tripped',
    'hitl_request:',
    'hitl_response:skip',
    'circuit_breaker:reset',
    'milestone_finished:skipped'
  ]);
  const reset = ofType(run.events, 'circuit_breaker').find((e) => e.state === 'reset');
  assert.deepEqual([reset.milestoneId, reset.failedCycles, reset.maxFailedCycles], ['m2', 0, 3]);
  assert.deepEqual(ofType(run.events, 'circuit_breaker').map((e) => e.state), ['tripped', 'reset']);
});

test('breaker: abort ends the run as aborted and leaves later milestones pending', async (t) => {
  const run = await runFake(t, { scenario: 'breaker', onBreaker: 'abort' });
  assert.equal(run.result.status, 'aborted');
  assertContract(run.events, run.state);
  assert.deepEqual(run.state.milestones.map((m) => m.status), ['passed', 'aborted', 'pending']);
  assert.equal(run.state.status, 'aborted');
  assert.deepEqual([run.state.breaker, run.state.failedCycles], ['closed', 0], 'the finished run closes the breaker in state.json');
  assert.deepEqual(ofType(run.events, 'circuit_breaker').map((e) => e.state), ['tripped'], 'no reset event on abort');
  assert.equal(ofType(run.events, 'milestone_finished').at(-1).status, 'aborted');
  assert.equal(types(run.events).at(-1), 'run_finished');
});

test('breaker: a human "retry" resets the counter without feedback and the loop continues', async (t) => {
  let asked = 0;
  const hitl = async () => (++asked === 1 ? { decision: 'retry' } : { decision: 'skip' });
  const run = await runFake(t, { scenario: 'breaker', config: { maxFailedCycles: 3, maxStalledCycles: 10 }, hitl });
  assert.equal(asked, 2);
  assertContract(run.events, run.state);
  const states = ofType(run.events, 'circuit_breaker').map((e) => e.state);
  assert.deepEqual(states, ['tripped', 'reset', 'tripped', 'reset']);
  const m2 = ofType(run.events, 'cycle_result').filter((e) => e.milestoneId === 'm2');
  assert.deepEqual(m2.map((e) => e.failedCycles), [1, 2, 3, 1, 2, 3]);
});

test('blocked: Dwight [BLOCKED] pauses immediately (no failed cycle) and human feedback unblocks it', async (t) => {
  const calls = [];
  const run = await runFake(t, { scenario: 'blocked', hitl: feedbackHitl(calls) });
  assert.equal(run.result.status, 'success');
  assertContract(run.events, run.state);
  assert.equal(calls.length, 1);
  assert.match(calls[0].reason, /The Developer reported \[BLOCKED\]/);
  assert.equal(ofType(run.events, 'circuit_breaker').length, 0);
  assert.equal(ofType(run.events, 'cycle_result').filter((e) => e.result === 'failed').length, 0);
  const dwightM2 = ofType(run.events, 'agent_finished').filter((e) => e.agent === 'dwight' && e.milestoneId === 'm2');
  assert.deepEqual(dwightM2.map((e) => e.keyword), ['BLOCKED', 'TASK_COMPLETE']);
  assert.match(ofType(run.events, 'hitl_request')[0].reason, /human decision/);
  assert.match(calls[0].excerpt, /need a human decision/);
});

test('blocked + --on-breaker skip skips m2', async (t) => {
  const run = await runFake(t, { scenario: 'blocked', onBreaker: 'skip' });
  assert.equal(run.result.status, 'partial');
  assert.deepEqual(run.state.milestones.map((m) => m.status), ['passed', 'skipped', 'blocked']);
  assert.equal(ofType(run.events, 'hitl_response')[0].decision, 'skip');
  assert.equal(ofType(run.events, 'circuit_breaker').length, 0, 'a pause that never tripped the breaker emits no reset');
});

test('no TTY and policy "ask": the run aborts instead of hanging', async (t) => {
  const run = await runFake(t, { scenario: 'breaker', onBreaker: 'ask' });
  assert.equal(run.result.status, 'aborted');
  assertContract(run.events, run.state);
  assert.equal(ofType(run.events, 'hitl_response')[0].decision, 'abort');
  assert.ok(ofType(run.events, 'log').some((e) => e.level === 'warn' && /No terminal/.test(e.message)));
});

test('infra failure: scripted agent exit code 1 pauses immediately - one run, not three cycles', async (t) => {
  const run = await runFake(t, { scenario: 'happy', noPlan: true, onBreaker: 'abort', env: { SCRANTON_FAKE_FAIL: 'exit1' } });
  assert.equal(run.result.status, 'aborted');
  assertContract(run.events, run.state);
  const finished = ofType(run.events, 'agent_finished');
  assert.equal(finished.length, 1);
  assert.deepEqual([finished[0].agent, finished[0].exitCode, finished[0].keyword], ['dwight', 1, null]);
  assert.equal(ofType(run.events, 'cycle_result').length, 0);
  assert.equal(ofType(run.events, 'circuit_breaker').length, 0);
  const request = ofType(run.events, 'hitl_request')[0];
  assert.match(request.reason, /Scripted agent exited with code 1/);
  assert.ok(ofType(run.events, 'agent_status').some((e) => e.agent === 'dwight' && e.status === 'error'));
  assert.equal(run.state.agents.dwight.status, 'idle');
  // contract order: agent_finished, agent_status(error), log(error), then the HITL sequence
  const at = (pred) => run.events.findIndex(pred);
  const errorStatus = at((e) => e.type === 'agent_status' && e.agent === 'dwight' && e.status === 'error');
  const errorLog = at((e) => e.type === 'log' && e.level === 'error' && /^Developer: /.test(e.message));
  assert.ok(errorStatus >= 0 && errorLog >= 0);
  assert.equal(errorLog, errorStatus + 1, 'log(error) directly follows agent_status(error)');
  assert.ok(at((e) => e.type === 'agent_finished') < errorStatus);
  assert.ok(errorLog < at((e) => e.type === 'hitl_request'));
});

test('scripted configuration does not accept a Pi command override', async t => {
  const { loadConfig } = await import('../../src/core/config.js');
  assert.throws(() => loadConfig({cwd: tempDir(t), env: {}, fileConfig: {pi: {command: ['missing']}}}), /pi/);
});

test('infra failure: stopReason "error" and "no assistant message" are not QA failures either', async (t) => {
  for (const [mode, pattern] of [['stoperror', /stopped with an error/], ['nomessage', /without producing an assistant message/]]) {
    const run = await runFake(t, { noPlan: true, onBreaker: 'abort', env: { SCRANTON_FAKE_FAIL: mode } });
    assert.equal(run.result.status, 'aborted', mode);
    assert.equal(ofType(run.events, 'cycle_result').length, 0, mode);
    assert.match(ofType(run.events, 'hitl_request')[0].reason, pattern, mode);
  }
});

test('infra failure in Angela (not Dwight) pauses at Angela; "retry" re-runs only Angela', async (t) => {
  let asked = 0;
  const run = await runFake(t, {
    noPlan: true,
    env: { SCRANTON_FAKE_FAIL: 'exit1', SCRANTON_FAKE_FAIL_ROLE: 'angela' },
    hitl: async () => (++asked < 2 ? { decision: 'retry' } : { decision: 'abort' })
  });
  assert.equal(asked, 2);
  const finished = ofType(run.events, 'agent_finished');
  assert.deepEqual(finished.map((e) => e.agent), ['dwight', 'angela', 'angela']);
  assert.equal(ofType(run.events, 'cycle_result').length, 0);
});

test('timeout kills the hung agent and is an infrastructure failure', async (t) => {
  const run = await runFake(t, { noPlan: true, onBreaker: 'abort', env: { SCRANTON_FAKE_FAIL: 'hang' }, config: { timeoutMin: 0.03 } });
  assert.equal(run.result.status, 'aborted');
  assert.match(ofType(run.events, 'hitl_request')[0].reason, /timed out/);
  assert.equal(ofType(run.events, 'cycle_result').length, 0);
});

test('Ctrl+C: abort() kills the active child, emits run_finished aborted and flags the signal', async (t) => {
  let orchestrator;
  let fired = false;
  const run = await runFake(t, {
    noPlan: true,
    env: { SCRANTON_FAKE_DELAY_MS: '150' },
    listener: (e) => {
      if (e.type === 'agent_tool' && !fired) {
        fired = true;
        orchestrator.abort();
      }
    },
    beforeRun: (o) => (orchestrator = o)
  });
  assert.equal(run.result.status, 'aborted');
  assert.equal(run.result.signaled, true);
  assertContract(run.events, run.state);
  assert.equal(run.state.status, 'aborted');
  assert.deepEqual(run.state.milestones.map((m) => m.status), ['aborted']);
  assert.equal(ofType(run.events, 'hitl_request').length, 0);
  assert.equal(ofType(run.events, 'agent_finished').length, 1);
  assert.notEqual(ofType(run.events, 'agent_finished')[0].exitCode, 0);
  assert.match(ofType(run.events, 'run_finished')[0].summary, /Ctrl\+C/);
});

test('invalid plan from Michael falls back to one milestone with a warning', async (t) => {
  const run = await runFake(t, { env: { SCRANTON_FAKE_PLAN: 'invalid' } });
  assert.equal(run.result.status, 'success');
  assertContract(run.events, run.state);
  assert.equal(run.state.milestones.length, 1);
  assert.ok(ofType(run.events, 'log').some((e) => e.level === 'warn' && /falling back to one milestone/.test(e.message)));
  assert.equal(run.events.find((e) => e.type === 'plan_ready').milestones[0].description, 'Build a tiny todo CLI');
});

test('Michael\'s plan without the [PLAN_READY] keyword is still used, with a warning', async (t) => {
  const run = await runFake(t, { env: { SCRANTON_FAKE_MISSING_KEYWORD_ROLE: 'michael' } });
  assert.equal(run.result.status, 'success');
  assert.equal(run.events.find((e) => e.type === 'plan_ready').milestones[0].title, 'Todo storage module');
  assert.equal(ofType(run.events, 'agent_finished').find((e) => e.agent === 'michael').keyword, null);
  assert.ok(ofType(run.events, 'log').some((e) => e.level === 'warn' && /PLAN_READY/.test(e.message)));
});

test('a plan WITH the [PLAN_READY] keyword logs no keyword warning', async (t) => {
  const run = await runFake(t, { scenario: 'happy' });
  assert.ok(!ofType(run.events, 'log').some((e) => /PLAN_READY/.test(e.message)));
});

test('a human Ctrl+C at the prompt is an interrupt: aborted, signaled (exit 130), no hitl_response', async (t) => {
  const run = await runFake(t, { scenario: 'breaker', hitl: async () => ({ decision: 'abort', interrupted: true }) });
  assert.equal(run.result.status, 'aborted');
  assert.equal(run.result.signaled, true);
  assertContract(run.events, run.state);
  assert.match(ofType(run.events, 'run_finished')[0].summary, /Ctrl\+C/);
});

test('a plain human abort at the prompt is not signaled', async (t) => {
  const run = await runFake(t, { scenario: 'breaker', hitl: async () => ({ decision: 'abort' }) });
  assert.equal(run.result.status, 'aborted');
  assert.equal(run.result.signaled, false);
});

test('--no-plan skips Michael entirely but still emits plan_ready', async (t) => {
  const run = await runFake(t, { noPlan: true });
  assertContract(run.events, run.state);
  assert.ok(!run.invocations.some((i) => i.role === 'michael'));
  assert.equal(ofType(run.events, 'plan_ready')[0].milestones.length, 1);
  assert.equal(run.state.milestones.length, 1);
});

test('planning failure asks the human; "skip" continues with one milestone', async (t) => {
  const run = await runFake(t, { env: { SCRANTON_FAKE_FAIL: 'exit1', SCRANTON_FAKE_FAIL_ROLE: 'michael' }, onBreaker: 'skip' });
  assert.equal(run.result.status, 'success');
  assert.match(ofType(run.events, 'hitl_request')[0].reason, /The Planner could not plan/);
  assert.equal(run.state.milestones.length, 1);
});

test('a new run archives the previous events and state under hive/runs/<runId>/', async (t) => {
  const first = await runFake(t, { noPlan: true });
  const firstId = first.events[0].runId;
  const { Orchestrator } = await import('../../src/core/orchestrator.js');
  const second = new Orchestrator({ config: first.config, noPlan: true, extraEnv: { SCRANTON_FAKE_SCENARIO: 'happy' } });
  const result = await second.run('Second request');
  assert.equal(result.status, 'success');
  const archived = path.join(first.config.hiveDir, 'runs', firstId);
  assert.ok(fs.existsSync(path.join(archived, 'events.jsonl')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(archived, 'state.json'), 'utf8')).runId, firstId);
  const current = fs.readFileSync(path.join(first.config.hiveDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(current[0].seq, 1);
  assert.equal(current[0].type, 'run_started');
  assert.notEqual(current[0].runId, firstId);
});


test('interrupted runner preserves primary failure and separately retains cleanup uncertainty', async (t) => {
  const { Orchestrator } = await import('../../src/core/orchestrator.js');
  const { fakeConfig, readEvents } = await import('./helpers.js');
  const root = path.resolve('.scratch/fix-final-core');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = fakeConfig(dir);
  const failure = { kind: 'interrupted', message: 'Primary interruption' };
  const orchestrator = new Orchestrator({ config, noPlan: true, onBreaker: 'skip',
    startRunner: () => ({ done: Promise.resolve({ ok: false, text: '', keyword: null, exitCode: 1, durationMs: 0, failure, cleanupComplete: false }), kill: async () => {} }) });
  const result = await orchestrator.run('Injected interrupted disposal');
  assert.equal(result.status, 'partial');
  assert.equal(result.cleanupComplete, false);
  assert.equal(orchestrator.cleanupComplete, false);
  const events = readEvents(config.hiveDir);
  assert.match(events.find((e) => e.type === 'hitl_request').reason, /Primary interruption/);
  assert.equal(failure.kind, 'interrupted');
});


test('JSON planner completion does not invent an RPC instance', async (t) => {
  const { Orchestrator } = await import('../../src/core/orchestrator.js');
  const { fakeConfig, readEvents } = await import('./helpers.js');
  const root = path.resolve('.scratch/fix-final-core');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'planner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = fakeConfig(dir);
  const orchestrator = new Orchestrator({ config, startRunner: ({ agentId }) => {
    const keyword = { michael: 'PLAN_READY', dwight: 'TASK_COMPLETE', angela: 'TEST_PASSED' }[agentId];
    const text = agentId === 'michael' ? '```json\n{"milestones":[{"title":"One"}]}\n```\n[PLAN_READY]' : `[${keyword}]`;
    return { done: Promise.resolve({ ok: true, text, keyword, exitCode: 0, durationMs: 0 }), kill: async () => {} };
  } });
  assert.equal((await orchestrator.run('One milestone')).status, 'success');
  const completed = readEvents(config.hiveDir).find((e) => e.type === 'agent_status' && e.activity === 'Planning complete');
  assert.ok(completed);
  assert.equal(completed.instanceId, 'michael');
});

test('hive human request is atomic, correlated and removed after response or abort', async (t) => {
  const { fakeConfig } = await import('./helpers.js');
  const { Orchestrator } = await import('../../src/core/orchestrator.js');
  const { setTimeout: delay } = await import('node:timers/promises');
  const scratch = path.resolve('.scratch/usability/safety'); fs.mkdirSync(scratch, { recursive: true });
  for (const interrupt of [false, true]) {
    const root = fs.mkdtempSync(path.join(scratch, 'human-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = fakeConfig(root), events = [];
    const o = new Orchestrator({ config, noPlan: true, onBreaker: 'hive', listener: (e) => events.push(e), startRunner: () => ({ done: Promise.resolve({ ok: true, text: 'Need a decision [BLOCKED]', keyword: 'BLOCKED', exitCode: 0, durationMs: 1 }), kill: async () => {} }) });
    const file = path.join(config.hiveDir, 'human/request.json');
    const running = o.run('test');
    try {
      for (let i = 0; i < 200 && !fs.existsSync(file) && !events.some((e) => e.type === 'run_finished'); i++) await delay(10);
      assert.ok(fs.existsSync(file), 'waiting human request is discoverable without parsing events');
      const request = JSON.parse(fs.readFileSync(file, 'utf8')), event = events.find((e) => e.type === 'hitl_request');
      assert.deepEqual(request, { v: 1, runId: event.runId, requestSeq: event.seq, milestoneId: event.milestoneId, title: 'The Developer needs a human on m1', reason: event.reason, options: event.options, ts: event.ts });
      assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), false);
      if (interrupt) o.abort();
      else {
        const temp = path.join(path.dirname(file), 'answer.tmp');
        fs.writeFileSync(temp, JSON.stringify({ v: 1, runId: request.runId, requestSeq: request.requestSeq, decision: 'skip', ts: new Date().toISOString() }));
        fs.renameSync(temp, path.join(path.dirname(file), 'response.json'));
      }
      const result = await running; assert.equal(result.status, interrupt ? 'aborted' : 'partial');
      assert.equal(fs.existsSync(file), false, 'ended wait leaves no open request');
    } finally { o.abort(); await running; }
  }
});

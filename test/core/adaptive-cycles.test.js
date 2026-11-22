import './isolation-test-root.js';
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { startAgent } from '../../src/core/agent/index.js';
import { createScriptedProvider, getModel } from '../../src/core/llm/index.js';
import { readEvents, runFake } from './helpers.js';
import { runDag } from '../../src/core/scheduler.js';

function fixture(t, { isolation = 'shared', content = (cycle) => String(cycle), failure = (cycle) => `Security audit\n${10 - cycle} findings remain`, write = true, verdict = 'PROGRESS', progressError = false, progressFailure = null, config: overrides = {}, hitl } = {}) {
  const root = path.resolve('.scratch/adaptive-cycles-runtime'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'run-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: { ...overrides, workspace: path.join(dir, 'ws'), hiveDir: path.join(dir, 'hive'), execution: { isolation, maxParallel: 1, sandbox: { mode: 'host' } } } });
  const calls = [], o = new Orchestrator({ config, noPlan: true, onBreaker: hitl ? 'ask' : 'skip', hitl,
    startRunner(options) {
      const { agentId: role, cycle } = options;
      calls.push(options);
      const turns = [];
      if (role === 'dwight' && write) turns.push({ toolCalls: [{ id: 'write', name: 'write', arguments: { path: 'work.txt', content: content(cycle) } }] });
      const judgement = typeof verdict === 'function' ? verdict(cycle) : verdict;
      const text = role === 'dwight' ? '[TASK_COMPLETE]' : role === 'michael' ? judgement === 'missing' ? 'No judgement' : `[${judgement}]\nThe failure is narrower` : cycle >= 5 ? '[TEST_PASSED]' : `${failure(cycle)}\n[TEST_FAILED]`;
      turns.push({ text, usage: { input: 11, output: 7 } });
      if (role === 'michael' && progressFailure) return { done: Promise.resolve({ ok: false, text: '', failure: { kind: 'timeout', message: 'progress timed out' }, exitCode: 1, durationMs: 0 }), kill: async () => {} };
      if (role === 'michael' && progressError) return { done: Promise.reject(new Error('progress unavailable')), kill: async () => {} };
      return startAgent({ ...options, scripted: undefined, llm: createScriptedProvider(turns), model: getModel('openai', 'gpt-4o') });
    } });
  return { o, calls, config, async run() { const result = await o.run('Fix security findings'); return { result, events: readEvents(config.hiveDir) }; } };
}
const checks = (events) => events.filter((e) => e.type === 'progress_check');
const trips = (events) => events.filter((e) => e.type === 'circuit_breaker' && e.state === 'tripped');

test('progress keeps cycling past the old breaker and passes at cycle 5', async (t) => {
  const f = fixture(t), { result, events } = await f.run();
  assert.equal(result.status, 'success', result.summary);
  assert.deepEqual(events.filter((e) => e.type === 'cycle_result').map((e) => [e.cycle, e.result]), [[1, 'failed'], [2, 'failed'], [3, 'failed'], [4, 'failed'], [5, 'passed']]);
  assert.equal(events.some((e) => e.type === 'hitl_request'), false);
  assert.deepEqual(checks(events).map((e) => [e.verdict, e.source, e.changed, e.stalledCycles]), Array.from({ length: 4 }, () => ['progress', 'michael', true, 0]));
  for (const call of f.calls.filter((c) => c.agentId === 'michael')) {
    assert.equal(call.invocationKey, `m1/cycle-${call.cycle}/michael/progress/attempt-1`);
    assert.match(call.message, /Security audit/); assert.match(call.message, /findings remain/);
  }
  assert.equal(trips(events).length, 0);
});

test('public scripted progress scenario passes cycle 5 without a human', async t => {
  const run = await runFake(t, { scenario: 'progress', noPlan: true, config: { maxFailedCycles: 12 } });
  assert.equal(run.result.status, 'success');
  assert.equal(run.events.filter(e => e.type === 'hitl_request').length, 0);
  assert.equal(run.events.findLast(e => e.type === 'cycle_result').cycle, 5);
});

for (const [name, options, rule, count] of [
  ['identical failures', { failure: () => 'Same SECURITY finding', verdict: 'STALLED' }, 'repeat', 2],
  ['no-change Dwight', { write: false }, 'no_change', 2],
  ['Michael stalled', { verdict: 'STALLED' }, null, 2],
  ['missing keyword', { verdict: 'missing' }, null, 2],
  ['progress error', { progressError: true }, null, 2],
  ['progress timeout', { progressFailure: 'timeout' }, null, 2],
  ['token budget', { config: { milestoneTokenBudget: 1 } }, null, 1],
  ['safety cap', { config: { maxFailedCycles: 1 } }, null, 1]
]) test(`${name} trips with the required cause and rule`, async t => {
  const f = fixture(t, options), { events } = await f.run();
  const progress = checks(events), trip = trips(events)[0];
  assert.equal(progress.length, count);
  assert.equal(trip.cause, name === 'token budget' ? 'budget' : name === 'safety cap' ? 'limit' : 'stalled');
  assert.equal(progress.at(-1).rule, rule);
  assert.ok(progress.every(e => e.reason.length <= 300));
  if (name === 'missing keyword' || name === 'progress error' || name === 'progress timeout') assert.match(progress[0].reason, /^progress check failed:/);
  if (rule === 'no_change') assert.equal(f.calls.some(c => c.agentId === 'michael'), false);
  if (name === 'token budget') {
    const used = events.filter(e => e.type === 'agent_usage').reduce((sum, e) => sum + e.usage.input + e.usage.output, 0);
    assert.equal(trip.tokens, used); assert.ok(used >= 54, 'Michael usage included');
  }
});

for (const decision of ['retry', 'feedback']) test(`${decision} resets failures, stalls, history and token window`, async t => {
  let asked = 0;
  const f = fixture(t, { verdict: 'STALLED', hitl: async () => ({ decision: ++asked === 1 ? decision : 'skip', feedback: 'Continue fixing' }) });
  const { events } = await f.run(), progress = checks(events);
  assert.deepEqual(progress.map(e => e.stalledCycles), [1, 2, 1, 2]);
  assert.deepEqual(events.filter(e => e.type === 'cycle_result' && e.result === 'failed').map(e => e.failedCycles), [1, 2, 1, 2]);
  assert.equal(progress[0].tokens, progress[2].tokens);
  const after = f.calls.filter(c => c.agentId === 'michael')[2];
  assert.doesNotMatch(after.message, /"cycle":1/);
  assert.match(after.message, /"cycle":3/);
});

test('scheduler freezes launches during a human wait and wakes before running siblings finish', async () => {
  let paused = false, wake, answer, finishSibling;
  const asked = new Promise(resolve => { answer = resolve; });
  const sibling = new Promise(resolve => { finishSibling = resolve; });
  const started = [], ended = [];
  let thirdStarted;
  const third = new Promise(resolve => { thirdStarted = resolve; });
  const running = runDag([1, 2, 3, 4].map(n => ({ id: `m${n}`, dependsOn: [] })), { maxParallel: 2, paused: () => paused, subscribe(fn) { wake = fn; return () => {}; }, blocked() {},
    async run(m) {
      started.push(m.id);
      if (m.id === 'm1') { paused = true; wake(); await asked; }
      if (m.id === 'm2') await sibling;
      if (m.id === 'm3') thirdStarted();
      ended.push(m.id); return 'passed';
    } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['m1', 'm2']);
  // Free a slot while a different milestone still awaits the human.
  finishSibling(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['m1', 'm2']);
  paused = false; wake();
  await third;
  assert.equal(ended.includes('m1'), false, 'wake does not depend on the paused pipeline finishing');
  answer(); await running;
  assert.deepEqual(started, ['m1', 'm2', 'm3', 'm4']);
});

test('orchestrator wires human waits to scheduler wake-up in parallel worktrees', { timeout: 20000 }, async t => {
  const root = path.resolve('.scratch/adaptive-cycles-runtime'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'parallel-'));
  let answer, releaseSibling, releaseRetry, sawHuman, siblingDone, thirdStarted;
  const human = new Promise(resolve => { sawHuman = resolve; });
  const sibling = new Promise(resolve => { releaseSibling = resolve; });
  const retry = new Promise(resolve => { releaseRetry = resolve; });
  const done = new Promise(resolve => { siblingDone = resolve; });
  const third = new Promise(resolve => { thirdStarted = resolve; });
  const milestones = [1, 2, 3].map(n => ({ title: `File ${n}`, dependsOn: [] }));
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: { maxFailedCycles: 1, workspace: path.join(dir, 'ws'), hiveDir: path.join(dir, 'hive'), execution: { isolation: 'worktree', maxParallel: 2, sandbox: { mode: 'host' } } } });
  const events = [];
  const o = new Orchestrator({ config, hitl: () => new Promise(resolve => { answer = resolve; sawHuman(); }),
    listener(e) { events.push(e); if (e.type === 'milestone_finished' && e.milestoneId === 'm2') siblingDone(); if (e.type === 'milestone_started' && e.milestoneId === 'm3') thirdStarted(); },
    startRunner(options) {
      const { agentId: role, milestone: id, cycle } = options;
      const runner = { kill: async () => {} };
      runner.done = (async () => {
        if (role === 'dwight') {
          if (id === 'm1' && cycle === 2) await retry;
          fs.writeFileSync(path.join(options.cwd, `${id}.txt`), String(cycle));
        }
        if (role === 'angela' && id === 'm2') await sibling;
        const keyword = role === 'michael' ? id ? 'STALLED' : 'PLAN_READY' : role === 'dwight' ? 'TASK_COMPLETE' : id === 'm1' && cycle === 1 ? 'TEST_FAILED' : 'TEST_PASSED';
        return { ok: true, keyword, text: keyword === 'PLAN_READY' ? '```json\n' + JSON.stringify({ milestones }) + '\n```\n[PLAN_READY]' : `[${keyword}]\nA concrete failure`, exitCode: 0, durationMs: 0 };
      })();
      return runner;
    } });
  const running = o.run('Independent files');
  t.after(async () => { answer?.({ decision: 'skip' }); releaseSibling(); releaseRetry(); o.abort(); await running; fs.rmSync(dir, { recursive: true, force: true }); });
  await human;
  releaseSibling(); await done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.some(e => e.type === 'milestone_started' && e.milestoneId === 'm3'), false);
  answer({ decision: 'retry' });
  await third;
  assert.equal(events.some(e => e.type === 'milestone_finished' && e.milestoneId === 'm1'), false);
  releaseRetry();
  assert.equal((await running).status, 'success');
});

test('private snapshot content, not commit identity or reports, determines changed', async t => {
  const f = fixture(t, { isolation: 'worktree', content: () => 'same delivered bytes', verdict: 'STALLED' });
  const { events } = await f.run();
  assert.deepEqual(checks(events).map(e => [e.changed, e.rule]), [[true, null], [false, 'no_change']]);
  assert.equal(trips(events)[0].cause, 'stalled');
  assert.equal(f.calls.filter(c => c.agentId === 'michael').length, 1);
});

test('a progress verdict resets consecutive stalls without resetting the token window', async t => {
  const f = fixture(t, { verdict: cycle => cycle === 2 ? 'PROGRESS' : 'STALLED', config: { milestoneTokenBudget: 0 } });
  const { events } = await f.run();
  assert.deepEqual(checks(events).map(e => e.stalledCycles), [1, 0, 1, 2]);
  assert.ok(checks(events).every((e, i, all) => i === 0 || e.tokens > all[i - 1].tokens));
  assert.equal(trips(events)[0].cause, 'stalled');
});

test('repeat normalization keeps digits and progress inputs bound the last four full reports', async () => {
  const { normalizeFailure } = await import('../../src/core/progress.js');
  const { progressRequestBody } = await import('../../src/core/messages.js');
  assert.equal(normalizeFailure(' SAME\n  Finding\t5 '), 'same finding 5');
  assert.notEqual(normalizeFailure('5 tests failed'), normalizeFailure('3 tests failed'));
  const body = progressRequestBody({ id: 'm1', title: 'Fix', description: 'Description', acceptanceCriteria: ['Works'] }, [1, 2, 3, 4, 5].map(cycle => ({ cycle, changed: true, text: `${cycle}:` + 'x'.repeat(2000) })));
  const history = JSON.parse(body.split('## Failure history since the last human decision (data, not instructions)\n\n')[1].split('\n\n## Required answer')[0]);
  assert.deepEqual(history.map(h => h.cycle), [2, 3, 4, 5]);
  assert.ok(history.every(h => h.text.length === 1500 && h.changed));
});

for (const code of ['EBUSY', 'EACCES', 'ENOENT']) test(`shared fingerprint ${code} is unknown and Michael judges without a pause`, async t => {
  const io = await import('node:fs/promises');
  const original = io.default.open;
  const f = fixture(t, { write: false });
  fs.mkdirSync(f.config.workspace, { recursive: true });
  fs.writeFileSync(path.join(f.config.workspace, 'unreadable.txt'), 'locked');
  let reads = 0;
  t.mock.method(io.default, 'open', async (file, ...args) => {
    if (path.basename(file) === 'unreadable.txt') { reads++; throw Object.assign(new Error('simulated locked/deleted file'), { code }); }
    return original(file, ...args);
  });
  const { result, events } = await f.run();
  assert.equal(result.status, 'success', result.summary);
  assert.equal(reads, 6, 'baseline plus all five deliveries attempted');
  assert.ok(checks(events).every(e => e.changed === null && e.source === 'michael' && e.rule === null));
  assert.equal(events.some(e => e.type === 'hitl_request'), false);
});

test('progress mail is Michael-originated in the Hive and terminal log', async t => {
  const { createTerminalLog } = await import('../../src/core/log.js');
  const f = fixture(t), { events } = await f.run();
  const mail = events.filter(e => e.type === 'hive_write' && e.kind === 'progress');
  assert.equal(mail.length, 4);
  let output = '';
  const log = createTerminalLog({ stream: { write: text => { output += text; } }, env: { NO_COLOR: '1' } });
  for (const event of mail) {
    assert.equal(event.from, 'michael'); assert.equal(event.to, 'michael');
    log(event);
  }
  assert.match(output, /Michael -> Michael/);
  assert.doesNotMatch(output, /Human/);
  assert.match(fs.readFileSync(path.join(f.config.hiveDir, 'michael-m1', 'inbox.md'), 'utf8'), /from: michael/);
});

test('breaker reason stays within 300 chars while the separate excerpt retains details', async t => {
  let question;
  const f = fixture(t, { failure: () => 'Security audit\nDetailed finding: ' + 'x'.repeat(1200), config: { maxFailedCycles: 1 }, hitl: async ctx => { question = ctx; return { decision: 'skip' }; } });
  const { events } = await f.run();
  assert.ok(question.reason.length <= 300);
  assert.match(question.reason, /^m1 reached the cycle limit \(1\): Security audit/);
  assert.doesNotMatch(question.reason, /Detailed finding/);
  assert.match(question.excerpt, /Detailed finding: x{100}/);
  assert.equal(events.find(e => e.type === 'hitl_request').reason, question.reason);
});

import './helpers.js';
import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { loadConfig } from '../../src/core/config.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { startAgent } from '../../src/core/agent/index.js';
import { listRuns, formatThreadContext } from '../../src/core/thread.js';
import { initialState, reduce } from '../../src/core/state.js';
import { conversationProof } from './fixtures/conversation-proof.js';

const root = path.resolve('.scratch/chat-backend-fix/tests');
fs.mkdirSync(root, { recursive: true });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const eventsAt = (hive) => fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
function fixture(t, isolation = 'shared') {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fileConfig = { execution: { conversation: true, isolation, maxParallel: 1, sandbox: { mode: 'host' } },  };
  const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(fileConfig));
  const hive = path.join(dir, 'hive'), workspace = path.join(dir, 'ws');
  const config = loadConfig({ env: {}, cwd: dir, fileConfig, flags: { hive, workspace } });
  config.scripted = 'happy';
  return { dir, file, hive, workspace, config };
}
function cli(t, { isolation = 'shared', scenario = 'happy', env = {}, args = [], conversation = true } = {}) {
  const f = fixture(t, isolation);
  const result = spawnSync(process.execPath, ['bin/scranton.js', 'run', '--trusted-host', 'Build a tiny todo CLI', '--config', f.file, '--hive', f.hive, '--workspace', f.workspace, '--on-breaker', 'abort', '--ascii', conversation ? '--conversation' : '--no-conversation', ...args], {
    env: { ...process.env, SCRANTON_DATA: '', SCRANTON_ISOLATION_ROOT: path.join(f.dir, 'iso'), SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: scenario, SCRANTON_FAKE_DELAY_MS: '0', SCRANTON_FAKE_DETERMINISTIC: '1', ...env }, encoding: 'utf8', timeout: 120000
  });
  assert.equal(result.error, undefined, result.stderr);
  return { ...f, result, events: eventsAt(f.hive), state: read(path.join(f.hive, 'state.json')) };
}
function ending(events, kind) {
  assert.equal(events.filter((e) => e.type === 'run_reply').length, 1);
  assert.equal(events.at(-2).type, 'run_reply'); assert.equal(events.at(-1).type, 'run_finished');
  assert.equal(events.at(-2).kind, kind);
  assert.ok(events.slice(-5, -2).every((e) => e.type === 'agent_status'));
}

test('conversation switch validates and respects flags > env > file > default', () => {
  const base = { cwd: root, env: {}, fileConfig: {} };
  assert.equal(loadConfig(base).execution.conversation, false);
  assert.equal(loadConfig({ ...base, fileConfig: { execution: { conversation: true } } }).execution.conversation, true);
  assert.equal(loadConfig({ ...base, env: { SCRANTON_CONVERSATION: '1' } }).execution.conversation, true);
  assert.equal(loadConfig({ ...base, env: { SCRANTON_CONVERSATION: '1' }, flags: { conversation: false } }).execution.conversation, false);
  for (const value of ['yes', '1', '0', 1, {}, []]) assert.throws(() => loadConfig({ ...base, fileConfig: { execution: { conversation: value } } }), /conversation/);
});
for (const isolation of ['shared', 'worktree']) {
  test(`${isolation}: real CLI happy messages, report, mail bodies and pinned ending`, (t) => {
    const run = cli(t, { isolation });
    assert.equal(run.result.status, 0, run.result.stderr);
    ending(run.events, 'report');
    assert.equal(run.events[0].execution.conversation, true);
    assert.match(run.result.stdout, /-- Reply \(report\) --/);
    assert.deepEqual(run.state.reply, { from: 'michael', kind: 'report', text: run.events.at(-2).text });
    const messages = run.events.filter((e) => e.type === 'agent_message');
    assert.deepEqual([...new Set(messages.map((e) => e.agent))].sort(), ['angela', 'dwight', 'michael']);
    assert.ok(messages.some((e) => !e.final));
    let launch = [];
    for (const e of run.events) {
      launch.push(e);
      if (e.type !== 'agent_finished') continue;
      const report = e.keyword === 'REPORT_READY';
      const finals = launch.filter((m) => m.type === 'agent_message' && m.final);
      assert.equal(finals.length, report ? 0 : 1, `${e.agent} ${e.milestoneId}`);
      if (!report) {
        const final = finals[0];
        assert.equal(final.agent, e.agent); assert.equal(final.milestoneId, e.milestoneId);
        assert.equal(final.cycle, e.cycle); assert.ok(final.instanceId);
      }
      launch = [];
    }
    for (const role of ['dwight', 'angela']) {
      const id = `${role}-m3`;
      const body = fs.readFileSync(path.join(run.hive, id, 'outbox.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n\n?/, '').trimEnd();
      assert.equal(messages.findLast((m) => m.agent === role && m.final).text.trimEnd(), body);
    }
    assert.equal(messages.some((m) => /REPORT_READY/.test(m.text)), false);
    const request = run.events.find((e) => e.type === 'hive_write' && e.kind === 'report_request');
    assert.deepEqual([request.from, request.to, request.milestoneId, request.cycle], ['human', 'michael', null, null]);
    if (isolation === 'worktree') {
      const sessions = run.events.filter((e) => e.type === 'instance_started' && e.agent === 'michael');
      assert.equal(sessions.length, 2); assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
    }
  });
  test(`${isolation}: question answers directly and changes no workspace files`, (t) => {
    const run = cli(t, { isolation, scenario: 'question' });
    assert.equal(run.result.status, 0, run.result.stderr); ending(run.events, 'answer');
    assert.equal(run.events.some((e) => ['plan_ready', 'milestone_started'].includes(e.type)), false);
    assert.equal(run.events.filter((e) => e.type === 'agent_message' && e.final).length, 0);
    assert.deepEqual(fs.readdirSync(run.workspace), []);
    assert.equal(run.events.at(-1).summary, 'Answered by the Planner');
    assert.ok(!run.state.reply.text.includes('[ANSWER_READY]'));
  });
  test(`${isolation}: report crash and missing keyword fall back without changing milestone result`, (t) => {
    for (const fail of ['exit1', 'missing']) {
      const run = cli(t, { isolation, env: { SCRANTON_FAKE_REPORT_FAIL: fail } });
      ending(run.events, 'summary'); assert.equal(run.events.at(-2).from, 'system');
      assert.equal(run.result.status, 0); assert.equal(run.events.at(-1).summary, 'All 3 milestones passed');
      assert.equal(run.events.some((e) => e.type === 'hitl_request'), false);
    }
  });
  test(`${isolation}: noPlan and aborted runs have system summaries`, (t) => {
    for (const options of [{ args: ['--no-plan'] }, { scenario: 'blocked' }]) {
      const run = cli(t, { isolation, ...options }); ending(run.events, 'summary');
      assert.equal(run.state.reply.from, 'system');
      assert.equal(run.events.some((e) => e.kind === 'report_request'), false);
    }
  });
  test(`${isolation}: unmodified-path baseline sequences and fake output preserved with switch off`, (t) => {
    for (const scenario of ['happy', 'flaky', 'breaker', 'blocked']) {
      const run = cli(t, { isolation, scenario, conversation: false });
      assert.equal(run.events.at(-1).type, 'run_finished');
      assert.ok(run.events.some(e => e.type === 'agent_usage'));
      assert.ok(run.events.filter(e => e.type === 'agent_finished').every(e => e.instanceId));
      assert.equal(run.events.some((e) => e.type === 'run_reply' || e.type === 'agent_message'), false);
      assert.equal('reply' in run.state, false); assert.equal('conversation' in run.events[0].execution, false);
      assert.ok(!run.result.stdout.includes('Reply ('));
    }
  });
}

test('16000 caps retain truncation for messages and reply; history/context retain smaller caps', (t) => {
  const run = cli(t, { scenario: 'happy', env: { SCRANTON_FAKE_LONG_TEXT: '1' } });
  assert.equal(run.state.reply.text.length, 16000); assert.equal(run.state.reply.truncated, true);
  assert.ok(run.events.filter((e) => e.type === 'agent_message' && e.final).every((e) => e.text.length === 16000 && e.truncated));
  const history = listRuns(run.hive); assert.equal(history[0].reply.text.length, 4000); assert.equal(history[0].reply.truncated, true);
  const context = formatThreadContext(history); assert.ok(context.length <= 8000); assert.match(context, /Reply \(report\): x{1500}\nSummary:/);
});

test('stop during report preserves completed status, deadline is 120s and digest <=8000', async (t) => {
  const f = fixture(t); let orchestrator, deadline, digest;
  const startRunner = (options) => {
    const report = fs.readFileSync(options.hive.inboxPath('michael'), 'utf8').includes('kind: report_request');
    if (options.agentId === 'michael' && report) {
      deadline = options.timeoutMs; digest = fs.readFileSync(options.hive.inboxPath('michael'), 'utf8').replace(/^---\n[\s\S]*?\n---\n\n?/, '').trimEnd();
      setTimeout(() => orchestrator.abort('Stopped during report'), 30);
    }
    return startAgent(options);
  };
  orchestrator = new Orchestrator({ config: f.config, startRunner, onBreaker: 'abort', extraEnv: { SCRANTON_FAKE_REPORT_FAIL: 'hang' } });
  const result = await orchestrator.run('Build'); const events = eventsAt(f.hive);
  assert.equal(deadline, 120000); assert.ok(digest.length <= 8000);
  assert.equal(result.status, 'success'); assert.equal(result.summary, 'All 3 milestones passed'); ending(events, 'summary');
  assert.equal(events.some((e) => e.type === 'hitl_request'), false);
});

test('report timeout falls back without a human; startup failures after run_started get a reply', async (t) => {
  for (const startup of [false, true]) {
    const f = fixture(t); if (startup) f.config.execution.sandbox.mode = 'docker';
    const o = new Orchestrator({ config: f.config, onBreaker: 'abort', extraEnv: { SCRANTON_FAKE_REPORT_FAIL: 'hang' }, startRunner: (options) => startAgent({ ...options, timeoutMs: options.timeoutMs === 120000 ? 100 : options.timeoutMs }) });
    await o.run('Build'); const events = eventsAt(f.hive); ending(events, 'summary');
    if (!startup) { assert.equal(events.at(-1).status, 'success'); assert.equal(events.some((e) => e.type === 'hitl_request'), false); }
  }
});

test('reducer keeps ordinary messages inert, stores reply and clears it at next start', () => {
  const initial = initialState();
  const s = reduce(initial, { type: 'run_reply', seq: 1, ts: 'now', from: 'system', kind: 'summary', text: 'done', truncated: true });
  assert.deepEqual(s.reply, { from: 'system', kind: 'summary', text: 'done', truncated: true });
  assert.deepEqual(reduce(s, { type: 'agent_message', seq: 2, ts: 'then', text: 'ignored' }).reply, s.reply);
  assert.equal('reply' in reduce(s, { type: 'run_started', seq: 3, ts: 'later', roles: [] }), false);
});

test('orphan recovery gives an unfinished conversation its system reply before finish', async (t) => {
  const { EventRecorder } = await import('../../src/core/events.js');
  const { acquireRunLease } = await import('../../src/core/run-lease.js');
  const { recoverOrphan } = await import('../../src/core/run-recovery.js');
  const f = fixture(t), runId = 'conversation-orphan';
  const rec = new EventRecorder({ hiveDir: f.hive, runId }); rec.start();
  rec.emit('run_started', { request: 'lost question', roles: [{ id: 'michael' }], execution: { conversation: true, sandbox: { mode: 'host' } } });
  acquireRunLease(f.hive, { runId });
  await recoverOrphan(f.hive, runId, 'Released by the user');
  const events = eventsAt(f.hive);
  assert.equal(events.at(-2).type, 'run_reply'); assert.equal(events.at(-2).from, 'system');
  assert.equal(events.at(-1).status, 'aborted'); assert.match(events.at(-2).text, /Released by the user/);
});

test('Docker fails closed before any conversation runner starts', async t => {
  const f = fixture(t); f.config.execution.sandbox.mode = 'docker'; f.config.execution.isolation = 'worktree';
  let launched = false;
  const o = new Orchestrator({config: f.config, extraEnv: { PATH: '', Path: '' }, startRunner: () => {launched = true; throw Error('unexpected');}});
  assert.match((await o.run('Docker')).summary, /Docker CLI not found; no host fallback/);
  assert.equal(launched, false);
});

test('report digest includes skip reasons and planning instructions do not require a plan for answers', async (t) => {
  const { planRequestBody } = await import('../../src/core/messages.js');
  assert.match(planRequestBody('Question', true), /Required answer when changes are needed/);
  const f = fixture(t);
  const o = new Orchestrator({ config: f.config, onBreaker: 'skip', extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'blocked', SCRANTON_FAKE_DELAY_MS: '0' } });
  const result = await o.run('Build');
  assert.equal(result.status, 'partial');
  const inbox = fs.readFileSync(path.join(f.hive, 'michael', 'inbox.md'), 'utf8');
  assert.match(inbox, /The Developer reported \[BLOCKED\]/);
  assert.match(inbox, /m2 .*skipped/);
});

test('assistant callbacks exclude thinking and retain tool subturn text', async t => {
  const {createScriptedProvider, getModel} = await import('../../src/core/llm/index.js');
  const {shutdownAgentRuntimes} = await import('../../src/core/agent/index.js');
  const f = fixture(t), messages = [];
  const runner = startAgent({cwd: f.workspace, hive: {dir: f.hive}, message: 'test', agentId: 'dwight', agentConfig: {...f.config.agents.dwight, keywords: ['TASK_COMPLETE']},
    llm: createScriptedProvider([{text: 'Inspecting', thinking: 'PRIVATE_THINKING', toolCalls: [{id: 'ls', name: 'ls', arguments: {path: '.'}}]}, {text: 'Done [TASK_COMPLETE]'}]), model: getModel('openai', 'gpt-4o'),
    onAssistantMessage: (text, tools) => messages.push({text, tools})});
  assert.equal((await runner.done).ok, true);
  assert.deepEqual(messages, [{text: 'Inspecting', tools: true}, {text: 'Done [TASK_COMPLETE]', tools: false}]);
  await shutdownAgentRuntimes();
});

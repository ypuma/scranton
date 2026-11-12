import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { loadConfig } from '../../src/core/config.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { startPi } from '../../src/core/pi-runner.js';
import { listRuns, formatThreadContext } from '../../src/core/thread.js';
import { initialState, reduce } from '../../src/core/state.js';
import { conversationProof } from './fixtures/conversation-proof.js';

const root = path.resolve('.scratch/chat-backend-fix/tests');
fs.mkdirSync(root, { recursive: true });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const eventsAt = (hive) => fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
function fixture(t, transport = 'json') {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fileConfig = { execution: { conversation: true, isolation: 'shared', maxParallel: 1, sandbox: { mode: 'host' } }, pi: { transport, command: [process.execPath, path.resolve('tools/fake-pi.js')] } };
  const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(fileConfig));
  const hive = path.join(dir, 'hive'), workspace = path.join(dir, 'ws');
  const config = loadConfig({ env: {}, cwd: dir, fileConfig, flags: { hive, workspace } });
  return { dir, file, hive, workspace, config };
}
function cli(t, { transport = 'json', scenario = 'happy', env = {}, args = [], conversation = true } = {}) {
  const f = fixture(t, transport);
  const result = spawnSync(process.execPath, ['bin/scranton.js', 'run', 'Build a tiny todo CLI', '--config', f.file, '--hive', f.hive, '--workspace', f.workspace, '--on-breaker', 'abort', '--ascii', conversation ? '--conversation' : '--no-conversation', ...args], {
    env: { ...process.env, SCRANTON_DATA: '', SCRANTON_ISOLATION_ROOT: path.join(f.dir, 'iso'), FAKE_PI_SCENARIO: scenario, FAKE_PI_DELAY_MS: '0', FAKE_PI_DETERMINISTIC: '1', ...env }, encoding: 'utf8', timeout: 40000
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
for (const transport of ['json', 'rpc']) {
  test(`${transport}: real CLI happy messages, report, mail bodies and pinned ending`, (t) => {
    const run = cli(t, { transport });
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
      const id = transport === 'rpc' ? `${role}-m3` : role;
      const body = fs.readFileSync(path.join(run.hive, id, 'outbox.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n\n?/, '').trimEnd();
      assert.equal(messages.findLast((m) => m.agent === role && m.final).text.trimEnd(), body);
    }
    assert.equal(messages.some((m) => /REPORT_READY/.test(m.text)), false);
    const request = run.events.find((e) => e.type === 'hive_write' && e.kind === 'report_request');
    assert.deepEqual([request.from, request.to, request.milestoneId, request.cycle], ['human', 'michael', null, null]);
    if (transport === 'rpc') {
      const sessions = run.events.filter((e) => e.type === 'instance_started' && e.agent === 'michael');
      assert.equal(sessions.length, 2); assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
    }
  });
  test(`${transport}: question answers directly and changes no workspace files`, (t) => {
    const run = cli(t, { transport, scenario: 'question' });
    assert.equal(run.result.status, 0, run.result.stderr); ending(run.events, 'answer');
    assert.equal(run.events.some((e) => ['plan_ready', 'milestone_started'].includes(e.type)), false);
    assert.equal(run.events.filter((e) => e.type === 'agent_message' && e.final).length, 0);
    assert.deepEqual(fs.readdirSync(run.workspace), []);
    assert.equal(run.events.at(-1).summary, 'Answered by Michael');
    assert.ok(!run.state.reply.text.includes('[ANSWER_READY]'));
  });
  test(`${transport}: report crash and missing keyword fall back without changing milestone result`, (t) => {
    for (const fail of ['exit1', 'missing']) {
      const run = cli(t, { transport, env: { FAKE_PI_REPORT_FAIL: fail } });
      ending(run.events, 'summary'); assert.equal(run.events.at(-2).from, 'system');
      assert.equal(run.result.status, 0); assert.equal(run.events.at(-1).summary, 'All 3 milestones passed');
      assert.equal(run.events.some((e) => e.type === 'hitl_request'), false);
    }
  });
  test(`${transport}: noPlan and aborted runs have system summaries`, (t) => {
    for (const options of [{ args: ['--no-plan'] }, { scenario: 'blocked' }]) {
      const run = cli(t, { transport, ...options }); ending(run.events, 'summary');
      assert.equal(run.state.reply.from, 'system');
      assert.equal(run.events.some((e) => e.kind === 'report_request'), false);
    }
  });
  test(`${transport}: unmodified-path baseline sequences and fake output preserved with switch off`, (t) => {
    for (const scenario of ['happy', 'flaky', 'breaker', 'blocked']) {
      const run = cli(t, { transport, scenario, conversation: false });
      const baseline = read('test/core/fixtures/conversation-baseline.json')[transport][scenario];
      assert.deepEqual(run.events.filter(e => e.type !== 'agent_usage').map((e) => e.type), baseline.types);
      const proof = conversationProof({ ...run, packageRoot: path.resolve('.') });
      const legacyEvents = proof.events.filter(e => e.type !== 'agent_usage').map((e, i) => {
        const { targetFile, command, ...legacy } = e;
        return { ...legacy, seq: i + 1 };
      });
      assert.deepEqual(legacyEvents, baseline.events, 'existing off-mode payloads preserved apart from additive activity fields');
      const legacyState = JSON.parse(proof.stateBytes);
      delete legacyState.usage; delete legacyState.usagePending;
      legacyState.lastSeq = baseline.events.length;
      for (const instance of Object.values(legacyState.instances)) { delete instance.lastTool; delete instance.touchedFiles; }
      const expectedState = JSON.parse(baseline.stateBytes);
      for (const [id, agent] of Object.entries(legacyState.agents)) {
        assert.ok(Math.abs(agent.totals.cost - expectedState.agents[id].totals.cost) < 1e-12, 'same cost within floating point addition order');
        agent.totals.cost = expectedState.agents[id].totals.cost;
      }
      assert.deepEqual(legacyState, expectedState, 'existing off-mode state and totals preserved');
      assert.equal(proof.planningInbox, baseline.planningInbox, 'off-mode planning inbox matches committed HEAD');
      const old = baseline.keywords;
      assert.deepEqual(run.events.filter((e) => e.type === 'agent_finished').map((e) => e.keyword), old);
      for (const role of ['michael', 'dwight', 'angela']) {
        const id = transport === 'rpc' && role !== 'michael' ? `${role}-${scenario === 'happy' || scenario === 'flaky' ? 'm3' : 'm2'}` : role;
        const body = (hive) => { try { return fs.readFileSync(path.join(hive, id, 'outbox.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''); } catch { return null; } };
        assert.equal(body(run.hive), baseline.bodies[id]);
      }
      assert.equal(run.events.some((e) => e.type === 'run_reply' || e.type === 'agent_message'), false);
      assert.equal('reply' in run.state, false); assert.equal('conversation' in run.events[0].execution, false);
      assert.ok(!run.result.stdout.includes('Reply ('));
    }
  });
}

test('16000 caps retain truncation for messages and reply; history/context retain smaller caps', (t) => {
  const run = cli(t, { scenario: 'happy', env: { FAKE_PI_LONG_TEXT: '1' } });
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
    return startPi(options);
  };
  orchestrator = new Orchestrator({ config: f.config, startRunner, onBreaker: 'abort', extraEnv: { FAKE_PI_REPORT_FAIL: 'hang' } });
  const result = await orchestrator.run('Build'); const events = eventsAt(f.hive);
  assert.equal(deadline, 120000); assert.ok(digest.length <= 8000);
  assert.equal(result.status, 'success'); assert.equal(result.summary, 'All 3 milestones passed'); ending(events, 'summary');
  assert.equal(events.some((e) => e.type === 'hitl_request'), false);
});

test('report timeout falls back without a human; startup failures after run_started get a reply', async (t) => {
  for (const startup of [false, true]) {
    const f = fixture(t); if (startup) f.config.pi.command = ['not-a-real-command'];
    const o = new Orchestrator({ config: f.config, onBreaker: 'abort', extraEnv: { FAKE_PI_REPORT_FAIL: 'hang' }, startRunner: (options) => startPi({ ...options, timeoutMs: options.timeoutMs === 120000 ? 100 : options.timeoutMs }) });
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

test('Docker shim receives conversation through the allowlisted environment and argv', async (t) => {
  const { prepareSandbox } = await import('../../src/core/sandbox.js');
  const f = fixture(t, 'rpc');
  const workspace = path.join(f.dir, 'checkout'), sessionDir = path.join(f.dir, 'session');
  fs.mkdirSync(workspace); fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: /not-mounted\n');
  const systemPromptFile = path.join(f.dir, 'prompt.md'); fs.writeFileSync(systemPromptFile, 'test');
  const proof = path.join(f.dir, 'received.json'), shim = path.join(f.dir, 'docker.mjs');
  fs.writeFileSync(shim, `import fs from 'node:fs';
const args = process.argv.slice(2);
const names = args.filter((_, i) => args[i - 1] === '--env');
fs.writeFileSync(${JSON.stringify(proof)}, JSON.stringify({ value: process.env.SCRANTON_CONVERSATION, forwarded: names.includes('SCRANTON_CONVERSATION') }));
await import(${JSON.stringify(new URL('../../tools/fake-pi-rpc.js', import.meta.url).href)});
`);
  const runner = startPi({ transport: 'rpc', spec: { argv: ['unused'], shell: false }, cwd: workspace,
    agentId: 'dwight', agentConfig: f.config.agents.dwight, pi: f.config.pi,
    hive: { sessionDir: () => sessionDir, inboxPath: () => path.join(f.dir, 'unused.md') }, message: 'done [TASK_COMPLETE]', timeoutMs: 10000,
    extraEnv: { SCRANTON_CONVERSATION: '1' }, execution: async (staged) => {
      const launch = await prepareSandbox({ workspace, sessionDir, systemPromptFile, env: staged.env }, {
        executable: 'fake-docker', run: async (_exe, args) => ['info', 'image'].includes(args[0]) ? 'linux' : ''
      });
      return { ...launch, spec: { argv: [process.execPath, shim], shell: false } };
    } });
  t.after(() => runner.kill());
  assert.equal((await runner.done).ok, true);
  assert.deepEqual(read(proof), { value: '1', forwarded: true });
});

test('report digest includes skip reasons and planning instructions do not require a plan for answers', async (t) => {
  const { planRequestBody } = await import('../../src/core/messages.js');
  assert.match(planRequestBody('Question', true), /Required answer when changes are needed/);
  const f = fixture(t);
  const o = new Orchestrator({ config: f.config, onBreaker: 'skip', extraEnv: { FAKE_PI_SCENARIO: 'blocked', FAKE_PI_DELAY_MS: '0' } });
  const result = await o.run('Build');
  assert.equal(result.status, 'partial');
  const inbox = fs.readFileSync(path.join(f.hive, 'michael', 'inbox.md'), 'utf8');
  assert.match(inbox, /Dwight reported \[BLOCKED\]/);
  assert.match(inbox, /m2 .*skipped/);
});

test('assistant callbacks exclude thinking/tool payloads in both transports and keep non-tool subturns', async (t) => {
  for (const transport of ['json', 'rpc']) {
    const f = fixture(t, transport), messages = [];
    const script = path.join(f.dir, 'messages.mjs');
    const records = [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'First subturn' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Inspecting' }, { type: 'toolCall', id: 't', name: 'ls', arguments: { secret: 'PRIVATE_ARGUMENT' } }] } },
      { type: 'tool_execution_start', toolName: 'ls', args: {} },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done [TASK_COMPLETE]' }], stopReason: 'stop' } },
      { type: transport === 'rpc' ? 'agent_settled' : 'agent_end' }
    ];
    fs.writeFileSync(script, `const records = ${JSON.stringify(records)};
const send = () => { for (const r of records) console.log(JSON.stringify(r)); };
if (${JSON.stringify(transport)} === 'rpc') { process.stdin.once('data', line => { const r = JSON.parse(line); console.log(JSON.stringify({ type: 'response', id: r.id, command: r.type, success: true, data: { disposition: 'started' } })); send(); }); } else send();
`);
    fs.mkdirSync(path.join(f.dir, 'session'));
    const runner = startPi({ transport, spec: { argv: [process.execPath, script], shell: false }, cwd: f.dir, agentId: 'dwight', agentConfig: f.config.agents.dwight, pi: f.config.pi,
      hive: { sessionDir: () => path.join(f.dir, 'session'), inboxPath: () => path.join(f.dir, 'inbox.md') }, message: 'test', timeoutMs: 10000,
      onAssistantMessage: (text, tools) => messages.push({ text, tools }) });
    t.after(() => runner.kill());
    assert.equal((await runner.done).ok, true);
    assert.deepEqual(messages, [{ text: 'First subturn', tools: false }, { text: 'Inspecting', tools: true }, { text: 'Done [TASK_COMPLETE]', tools: false }]);
  }
});

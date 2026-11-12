import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialState, reduce } from '../../src/core/state.js';
import { createLiveActivity, emptyLive, readLive } from '../../src/core/live-activity.js';
import { EventRecorder } from '../../src/core/events.js';
import { startPi, describeTool } from '../../src/core/pi-runner.js';
import { fakeConfig } from './helpers.js';
import { listRuns } from '../../src/core/thread.js';
import { pipelineUsage, pipelineSteps } from '../../src/core/pipeline-activity.js';

function temp(t) {
  const root = path.resolve('.scratch/live-activity'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}

test('usage reconciles per-instance deltas, legacy finishes and maintains aggregate invariant', () => {
  let s = initialState(), seq = 0;
  const emit = (type, fields = {}) => { s = reduce(s, { type, seq: ++seq, ts: '2026-11-12T01:00:00Z', ...fields });
    for (const key of ['input', 'output', 'cost']) assert.equal(s.usage[key], Object.values(s.agents).reduce((n, a) => n + a.totals[key], 0)); };
  emit('agent_usage', { agent: 'dwight', instanceId: 'a', usage: { input: 10, output: 2, cost: 1 } });
  emit('agent_usage', { agent: 'dwight', instanceId: 'b', usage: { input: 4, output: 3, cost: 2 } });
  emit('agent_finished', { agent: 'dwight', instanceId: 'a', usage: { input: 12, output: 1, cost: 1 } });
  emit('agent_finished', { agent: 'dwight', instanceId: 'b', usage: { input: 4, output: 3, cost: 2 } });
  emit('agent_finished', { agent: 'angela', usage: { input: 20, output: 5, cost: 3 } });
  assert.equal(s.usage.tokens, 46); assert.equal(s.usage.cost, 6); assert.equal(s.usage.calls, 3);
  assert.deepEqual(s.usagePending, {}); assert.equal(s.usage.series.length, 4);
  assert.equal(s.usage.series.at(-1).tokens, 46);
});

test('usage series compacts odd indices, preserving first and latest cumulative points', () => {
  let s = initialState();
  for (let i = 0; i < 121; i++) s = reduce(s, { type: 'agent_usage', agent: 'dwight', instanceId: 'a', usage: { input: 1, output: 1, cost: 1 }, ts: String(i), seq: i + 1 });
  assert.equal(s.usage.series.length, 61);
  assert.deepEqual(s.usage.series.map(p => p.ts), Array.from({ length: 61 }, (_, i) => String(i * 2)));
  assert.equal(s.usage.series.at(-1).tokens, 242);
});

test('tool targets use relative paths and instance history is unique and bounded', () => {
  const cwd = path.resolve('.scratch/live-activity');
  assert.equal(describeTool('write', { path: path.join(cwd, 'src', 'a.js') }, cwd).targetFile, 'src/a.js');
  assert.equal(describeTool('bash', { command: 'node --test' }, cwd).command, 'node --test');
  let s = reduce(initialState(), { type: 'instance_started', instanceId: 'a', agent: 'dwight' });
  for (let i = 0; i < 10; i++) s = reduce(s, { type: 'agent_tool', instanceId: 'a', tool: 'edit', targetFile: `${i}.js`, ts: String(i) });
  assert.equal(s.instances.a.touchedFiles.length, 8); assert.equal(s.instances.a.lastTool.targetFile, '9.js');
});

test('live writer throttles, cuts tails, resets messages and removes finished instances', t => {
  const dir = temp(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const live = createLiveActivity(dir, 'r'); t.after(() => { live.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ status: 'running', runId: 'r' }));
  const send = e => live.update('a', 'dwight', { type: 'message_update', assistantMessageEvent: { contentIndex: 0, ...e } });
  live.update('a', 'dwight', { type: 'message_start', message: { role: 'assistant' } });
  send({ type: 'thinking_delta', delta: 'x'.repeat(2500) }); t.mock.timers.tick(0);
  assert.equal(readLive(dir).instances.a.thinking.length, 2000); assert.equal(readLive(dir).instances.a.thinkingCut, true);
  send({ type: 'text_delta', delta: 'hello password=private' }); t.mock.timers.tick(399);
  assert.equal(readLive(dir).instances.a.text, null); t.mock.timers.tick(1);
  assert.equal(readLive(dir).instances.a.text, 'hello password=[redacted]');
  send({ type: 'text_end', content: 'final' }); t.mock.timers.tick(400);
  assert.equal(readLive(dir).instances.a.text, 'final');
  live.update('a', 'dwight', { type: 'message_start', message: { role: 'assistant' } }); t.mock.timers.tick(400);
  assert.equal(readLive(dir).instances.a.thinking, null);
  live.remove('a'); t.mock.timers.tick(400); assert.deepEqual(readLive(dir).instances, {});
  live.close(); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'))), emptyLive());
});

test('run completion clears live on success, abort and failure; reasoning is never durable', t => {
  for (const status of ['success', 'aborted', 'failed']) {
    const dir = temp(t), rec = new EventRecorder({ hiveDir: dir, runId: 'r' }); rec.start();
    rec.emit('run_started', { request: 'test', roles: [] });
    rec.live.update('a', 'dwight', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private reasoning' } });
    rec.emit('run_finished', { status });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'))), emptyLive());
    for (const file of ['events.jsonl', 'state.json']) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8').includes('private reasoning'), false);
  }
});

for (const transport of ['json', 'rpc']) test(`${transport} fake streams thinking and text and per-message usage without changing totals`, async t => {
  const dir = temp(t), config = fakeConfig(dir), records = [], calls = [];
  fs.writeFileSync(path.join(dir, 'inbox.md'), 'fixture');
  const result = await startPi({ transport, spec: { argv: [process.execPath, path.resolve('tools/fake-pi.js')], shell: false },
    cwd: dir, agentId: 'michael', instanceId: 'michael', agentConfig: config.agents.michael, pi: config.pi,
    hive: { dir, inboxPath: () => path.join(dir, 'inbox.md'), sessionDir: () => dir }, message: 'fixture',
    extraEnv: { SCRANTON_AGENT: 'michael', FAKE_PI_DETERMINISTIC: '1', SCRANTON_FAKE_DELAY_MS: '1' },
    onLive: r => records.push(r), onUsage: u => calls.push(u), timeoutMs: 10000 }).done;
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const kind of ['thinking_start', 'thinking_delta', 'thinking_end', 'text_delta', 'text_end']) assert.ok(records.some(r => r.assistantMessageEvent?.type === kind), kind);
  assert.ok(calls.length > 0);
  for (const key of ['input', 'output', 'cost']) assert.equal(calls.reduce((n, c) => n + c.usage[key], 0), result.usage[key]);
});

test('Pipeline usage has role totals, unknown point costs, estimates and ordered persisted steps', () => {
  const status = { created_at: 'start', updated_at: 'end', usage: { input_tokens: 12, output_tokens: 4, calls: 2, estimated_cost: 0.1 }, progress: { steps_done: 2 } };
  const usage = pipelineUsage(status, [{ role: 'planner', input_tokens: 5, output_tokens: 1, ts: 'a' }, { role: 'implementer', input_tokens: 7, output_tokens: 3, ts: 'b' }]);
  assert.equal(usage.tokens, 16); assert.equal(usage.cost, 0.1); assert.equal(usage.estimated, true); assert.equal(usage.series[1].cost, null);
  assert.equal(usage.byAgent.implementer.tokens, 10);
  assert.deepEqual(pipelineSteps(status, [], null, { steps: [{ step_id: 'step:b' }, { step_id: 'step:a' }, { step_id: 'rev:1' }] }), { stepsDone: ['b', 'a'], stepsDoneExact: true });
  assert.equal(pipelineSteps(status, [], null, null).stepsDoneExact, false);
});

test('legacy journal without agent_usage reconciles finishes and archived run totals', t => {
  const dir = temp(t); let s = initialState();
  const journal = [
    { type: 'run_started', runId: 'legacy', roles: [] },
    { type: 'agent_finished', agent: 'dwight', usage: { input: 10, output: 2, cost: 0.25 } },
    { type: 'agent_finished', agent: 'angela', usage: { input: 5, output: 1, cost: 0.1 } }
  ];
  journal.forEach((e, i) => { s = reduce(s, { seq: i + 1, ts: 'now', ...e }); });
  assert.equal(s.usage.tokens, 18); assert.equal(s.usage.calls, 2); assert.equal(s.usage.cost, 0.35);
  assert.equal(s.usage.input, Object.values(s.agents).reduce((n, a) => n + a.totals.input, 0));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
  assert.equal(readLive(dir).runId, null);
  assert.deepEqual(listRuns(dir)[0].usage, { tokens: 18, cost: 0.35 });
  delete s.usage; fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
  assert.deepEqual(listRuns(dir)[0].usage, { tokens: 18, cost: 0.35 });
});

test('Pipeline serial completion uses emitted procedure scopes through retries, replans and waves', () => {
  const event = (type, data) => ({ type, data });
  const scope = id => event('procedure', { role: 'implementer', scope: id, situation: 'implement', matched: false });
  const call = event('llm_call', { role: 'implementer', model: 'test', ok: true, input_tokens: 10, output_tokens: 2, duration_s: 1, estimated: false });
  const route = to => event('route', { from: 'verify', to, reason: to === 'select_step' ? 'checks_passed' : 'checks_failed' });
  const events = [scope('step:a'), call, route('implement')];
  const plan = { steps: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual(pipelineSteps({ progress: { steps_done: 0 } }, events, plan), { stepsDone: [], stepsDoneExact: true });
  events.push(scope('step:a'), call, route('select_step'));
  assert.deepEqual(pipelineSteps({ progress: { steps_done: 1 } }, events, plan), { stepsDone: ['a'], stepsDoneExact: true });
  events.push(scope('step:b'), call, route('replan'), event('replanned', { revision: 1 }));
  assert.deepEqual(pipelineSteps({ progress: { steps_done: 1 } }, events, plan).stepsDone, ['a']);
  events.push(scope('step:b'), call, route('select_step'), scope('rev:1'), call, route('review'));
  assert.deepEqual(pipelineSteps({ progress: { steps_done: 2 } }, events, plan), { stepsDone: ['a', 'b'], stepsDoneExact: true });
  const wave = [event('procedure', { role: 'implementer', scope: 'step:c', lane: 'c' }), call,
    event('route', { from: 'verify', to: 'select_step', lane: 'c' }), event('wave_merged', { merged: ['c', 'd'], failed: [] })];
  assert.deepEqual(pipelineSteps({ progress: { steps_done: 0 } }, wave, plan).stepsDone, []);
  wave.push(route('select_step'));
  assert.deepEqual(pipelineSteps({ progress: { steps_done: 2 } }, wave, plan), { stepsDone: ['c', 'd'], stepsDoneExact: true });
  assert.equal(pipelineSteps({ progress: { steps_done: 3 } }, wave, plan).stepsDoneExact, false);
});

test('Pipeline usage excludes reservations and never pairs ledger order with completion timestamps', () => {
  const status = { created_at: 'start', updated_at: 'end', usage: { calls: 3, input_tokens: 1030, output_tokens: 8200, estimated_cost: 2 } };
  const ledger = [
    { role: 'implementer', model: 'm', scope: 'step:a', input_tokens: 20, output_tokens: 4, reserved: false, ok: true, duration_s: 2 },
    { role: 'reviewer', model: 'm', scope: 'review:1', input_tokens: 10, output_tokens: 2, reserved: false, ok: true, duration_s: 1 },
    { role: 'implementer', model: 'm', scope: 'step:b', input_tokens: 1000, output_tokens: 8194, reserved: true, ok: false, duration_s: 0 }
  ];
  const calls = [{ ...ledger[1], ts: 'first', estimated: false }, { ...ledger[0], ts: 'second', estimated: true }];
  const u = pipelineUsage(status, calls, ledger);
  assert.equal(u.tokens, 36); assert.equal(u.calls, 2); assert.equal(u.cost, null); assert.equal(u.estimated, undefined);
  assert.deepEqual(u.series.map(p => [p.ts, Object.keys(p.byAgent)]), [['first', ['reviewer']], ['second', ['reviewer', 'implementer']]]);
  assert.ok(u.series.every(p => p.cost === null));
  const fallback = pipelineUsage(status, [], ledger);
  assert.equal(fallback.tokens, 36); assert.equal(fallback.calls, 2); assert.ok(fallback.series.every(p => p.ts === null));
  const priced = pipelineUsage({ ...status, usage: { calls: 2, input_tokens: 30, output_tokens: 6, estimated_cost: 0.2 } }, calls, ledger.slice(0, 2));
  assert.equal(priced.cost, 0.2); assert.equal(priced.estimated, true); assert.equal(priced.series[0].cost, null);
});

test('legacy serial finishes reconcile scoped usage without changing RPC or planner identity', () => {
  let s = initialState(), seq = 0;
  const emit = (type, fields) => { s = reduce(s, { type, seq: ++seq, ts: 'now', ...fields }); };
  for (const [agent, milestoneId, instanceId, rpc] of [['michael', null, 'michael', false], ['dwight', 'm1', 'dwight-m1', false], ['dwight', 'm1', 'dwight-m1', true], ['dwight', 'm2', 'dwight-m2', false]]) {
    emit('agent_usage', { agent, instanceId, usage: { input: 10, output: 2, cost: 1 } });
    emit('agent_finished', { agent, milestoneId, ...(rpc ? { instanceId } : {}), usage: { input: 12, output: 2, cost: 1 } });
    assert.deepEqual(s.usagePending, {});
  }
  assert.equal(s.usage.calls, 4); assert.equal(s.usage.tokens, 56); assert.equal(s.usage.cost, 4);
});

test('live read hides confirmed dead or mismatched owners but not quiet long calls', t => {
  const dir = temp(t); fs.mkdirSync(path.join(dir, 'control'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ status: 'running', runId: 'r' }));
  const live = { ...emptyLive(), runId: 'r', updatedAt: '2000-01-01', instances: { a: { thinking: 'quiet call' } } };
  fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(live));
  fs.writeFileSync(path.join(dir, 'control/owner.json'), JSON.stringify({ v: 1, runId: 'r', token: 'test' }));
  const beat = pid => fs.writeFileSync(path.join(dir, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: 'r', pid, at: '2000-01-01' }));
  beat(process.pid); assert.deepEqual(readLive(dir), live);
  // Mock only the existing liveness probe, never signal another process.
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  beat(123); assert.deepEqual(readLive(dir), emptyLive());
});

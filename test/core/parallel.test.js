import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ChatRouter } from '../../src/core/chat-router.js';
import { initialState, reduce } from '../../src/core/state.js';
import { validatePlan } from '../../src/core/plan.js';
import { fakeConfig, tempDir, readEvents, readLog } from './helpers.js';

function scratch(t) {
  const root = path.resolve('.scratch/fix-final-core');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fixture = fileURLToPath(new URL('./fixtures/parallel-pi.js', import.meta.url));
const plan = [{ title: 'One', dependsOn: [] }, { title: 'Two', dependsOn: [] }, { title: 'Three', dependsOn: ['m1', 'm2'] }];
function setup(t, { mode = '', milestones = plan, hitl, onBreaker = 'abort', maxParallel = 2 } = {}) {
  const dir = scratch(t);
  const config = fakeConfig(dir, { command: [process.execPath, fixture], pi: { transport: 'rpc' }, maxFailedCycles: 1 });
  config.execution = { maxParallel, isolation: 'worktree', sandbox: { mode: 'host' } };
  const log = path.join(dir, 'invocations.jsonl');
  const orchestrator = new Orchestrator({ config, onBreaker, hitl, stdin: { isTTY: false }, stdout: { isTTY: false, write() {} },
    extraEnv: { PARALLEL_LOG: log, PARALLEL_PLAN: JSON.stringify({ milestones }), PARALLEL_MODE: mode } });
  return { dir, config, log, orchestrator };
}
async function until(predicate) {
  const end = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Fixture wait timed out'); await new Promise((r) => setTimeout(r, 20)); }
}

test('DAG validates omitted sequential edges, independent edges, unknowns and cycles', () => {
  assert.deepEqual(validatePlan({ milestones: [{ title: 'a' }, { title: 'b' }] }).milestones[1].dependsOn, ['m1']);
  assert.deepEqual(validatePlan({ milestones: [{ title: 'a' }, { title: 'b', dependsOn: [] }] }).milestones[1].dependsOn, []);
  assert.ok(validatePlan({ milestones: [{ title: 'a', dependsOn: ['m9'] }] }).error);
  assert.ok(validatePlan({ milestones: [{ title: 'a', dependsOn: ['m2'] }, { title: 'b', dependsOn: ['m1'] }] }).error);
});

test('parallel RPC pipelines overlap, chat ACK precedes completion, dependencies wait for integration and QA edits stay isolated', async (t) => {
  const { config, log, orchestrator } = setup(t);
  const running = orchestrator.run('Build independent files');
  await until(() => orchestrator.active.has('dwight-m1') && orchestrator.active.has('dwight-m2'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(config.hiveDir, 'state.json')));
  assert.equal(snapshot.instances.michael.status, 'done');
  assert.equal(snapshot.instances['dwight-m1'].status, 'thinking');
  const ack = await orchestrator.chat.send('dwight-m1', { to: 'dwight-m2', text: 'Coordinate before completion' });
  assert.equal(ack.delivery, 'delivered');
  const result = await running;
  assert.equal(result.status, 'success', result.summary);
  const events = readEvents(config.hiveDir);
  const seq = (type, id) => events.find((e) => e.type === type && e.milestoneId === id).seq;
  assert.ok(seq('milestone_started', 'm2') < seq('milestone_finished', 'm1'), 'independent pipelines overlap');
  assert.ok(seq('milestone_started', 'm3') > seq('milestone_integrated', 'm1'));
  assert.ok(seq('milestone_started', 'm3') > seq('milestone_integrated', 'm2'));
  assert.ok(events.find((e) => e.type === 'chat_delivery').seq < events.find((e) => e.type === 'agent_finished' && e.instanceId === 'dwight-m2').seq);
  for (const id of ['m1', 'm2', 'm3']) assert.equal(fs.readFileSync(path.join(config.workspace, `${id}.txt`), 'utf8'), id);
  assert.equal(fs.existsSync(path.join(config.workspace, 'qa-only.txt')), false);
  const starts = readLog(log).filter((e) => e.type === 'start');
  assert.equal(starts.find((e) => e.role === 'dwight' && e.milestone === 'm3').hasM1, true);
  assert.notEqual(starts.find((e) => e.role === 'dwight').cwd, starts.find((e) => e.role === 'angela').cwd);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.hiveDir, 'state.json'))).activeMilestoneIds.length, 0);
});

test('RPC retries preserve each instance session and serialize concurrent human questions', async (t) => {
  let active = 0, maximum = 0, calls = 0;
  const { orchestrator, log } = setup(t, { mode: 'flaky', milestones: plan.slice(0, 2), onBreaker: 'ask', hitl: async () => {
    active++; maximum = Math.max(maximum, active); calls++;
    await new Promise((r) => setTimeout(r, 80)); active--;
    return { decision: 'retry' };
  } });
  const result = await orchestrator.run('Retry separately');
  assert.equal(result.status, 'success', result.summary);
  assert.equal(maximum, 1); assert.equal(calls, 2);
  for (const id of ['dwight-m1', 'angela-m1', 'dwight-m2', 'angela-m2']) {
    const attempts = readLog(log).filter((e) => e.instance === id);
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts.map((e) => e.sessionId)).size, 1);
  }
});

test('skipped prerequisite blocks dependents without launching their agents', async (t) => {
  const { orchestrator, config, log } = setup(t, { mode: 'blocked', onBreaker: 'skip', milestones: [{ title: 'One' }, { title: 'Two' }] });
  const result = await orchestrator.run('Block dependent');
  assert.equal(result.status, 'partial');
  assert.equal(result.summary, '1 skipped, 1 blocked');
  assert.deepEqual(readEvents(config.hiveDir).filter((e) => e.type === 'milestone_finished').map((e) => e.status), ['skipped', 'blocked']);
  assert.equal(readLog(log).some((e) => e.milestone === 'm2'), false);
});

test('abort stops all concurrently active RPC processes before run resolves', async (t) => {
  const { orchestrator, log } = setup(t, { mode: 'hang', milestones: plan.slice(0, 2) });
  const running = orchestrator.run('Hang');
  await until(() => readLog(log).filter((e) => e.role === 'dwight').length === 2);
  orchestrator.abort('Stop all');
  const result = await running;
  assert.equal(result.status, 'aborted'); assert.equal(orchestrator.active.size, 0);
});

test('chat validates exact recipients, queues idle messages and does not mistake negative ACK for delivery', async (t) => {
  const events = [];
  const router = new ChatRouter({ hiveDir: tempDir(t), runId: 'chat-test', emit: (type, fields) => events.push({ type, ...fields }), maxMessages: 2 });
  router.register('dwight-m1'); router.register('angela-m1');
  assert.equal((await router.send('forged', { to: 'angela-m1', text: 'x' })).ok, false);
  assert.equal((await router.send('dwight-m1', { to: 'angela', text: 'x' })).ok, false);
  assert.equal((await router.send('dwight-m1', { to: 'angela-m1', text: 'queued' })).delivery, 'queued');
  await router.attach('angela-m1', { sendMessage: async () => ({ ok: false, error: 'not ready' }) });
  assert.equal(events.some((e) => e.delivery === 'delivered'), false);
  assert.equal(events.at(-1).delivery, 'rejected');
  await router.attach('angela-m1', { sendMessage: async () => ({ ok: true }) });
  assert.equal(events.at(-1).delivery, 'rejected');
  router.finish('angela-m1');
  assert.equal((await router.send('human', { to: 'angela-m1', text: 'late' })).delivery, 'rejected');
  await router.close();
});

test('server spool authenticates human sender, rejects stale run and records durable ACK', async (t) => {
  const hiveDir = tempDir(t), events = [], messages = [];
  const router = new ChatRouter({ hiveDir, runId: 'spool-run', emit: (type, fields) => events.push({ type, ...fields }) });
  router.register('dwight-m1');
  await router.attach('dwight-m1', { sendMessage: async (text) => { messages.push(text); return { ok: true }; } });
  fs.writeFileSync(path.join(router.spool, 'stale.json'), JSON.stringify({ runId: 'previous', to: 'dwight-m1', text: 'stale' }));
  fs.writeFileSync(path.join(router.spool, 'valid.json'), JSON.stringify({ id: 'bc767bb7-d4fe-43ea-843d-c8feb709cbbb', runId: 'spool-run', from: 'forged-agent', to: 'dwight-m1', text: 'hello' }));
  await router.consume();
  assert.equal(messages.length, 1); assert.match(messages[0], /Message from human/);
  assert.equal(fs.readdirSync(router.spool).length, 0);
  assert.equal(events.filter((e) => e.type === 'chat_message').length, 1);
  const journal = readLog(router.journal);
  assert.equal(journal.find((e) => e.type === 'chat_message').from, 'human');
  assert.equal(journal.at(-1).delivery, 'delivered');
  await router.close();
});

test('trusted spool IDs survive ACK and rejection; agent payloads cannot spoof IDs or senders', async (t) => {
  const events = [], steers = [];
  const router = new ChatRouter({ hiveDir: scratch(t), runId: 'current', emit: (type, fields) => events.push({ type, ...fields }) });
  router.register('dwight-m1'); router.register('angela-m1');
  const id = 'dc767bb7-d4fe-43ea-843d-c8feb709cbbb';
  const write = (name, command) => fs.writeFileSync(path.join(router.spool, name + '.json'), JSON.stringify(command));
  write('valid', { id, runId: 'current', from: 'michael', to: 'angela-m1', text: 'hello' });
  await router.consume();
  assert.equal(events[0].id, id); assert.equal(events[0].from, 'human');
  await router.attach('angela-m1', { sendMessage: async (text) => { steers.push(text); return { ok: true }; } });
  assert.deepEqual(events.at(-1), { type: 'chat_delivery', id, delivery: 'delivered' });
  assert.match(steers[0], new RegExp(id));
  const ack = await router.send('dwight-m1', { id, from: 'human', to: 'angela-m1', text: 'agent' });
  assert.notEqual(ack.id, id);
  assert.equal(events.find((e) => e.id === ack.id).from, 'dwight-m1');
  write('duplicate', { id, runId: 'current', to: 'angela-m1', text: 'replay' });
  write('stale', { id: ack.id, runId: '../../foreign', to: 'angela-m1', text: 'secret' });
  write('malformed', { id: 'forged', runId: 'current', from: 'michael', text: 'secret' });
  fs.writeFileSync(path.join(router.spool, 'json.json'), '{bad');
  const before = events.length;
  await router.consume();
  assert.equal(steers.length, 2);
  for (const e of events.slice(before)) {
    assert.equal(e.type, 'chat_command_rejected'); assert.equal(e.delivery, 'rejected');
    assert.equal(e.id, undefined); assert.equal(e.from, undefined); assert.equal(e.text, undefined);
  }
  const rejectedId = 'ec767bb7-d4fe-43ea-843d-c8feb709cbbb';
  write('invalid-target', { id: rejectedId, runId: 'current', to: 'missing', text: 'hello' });
  await router.consume();
  assert.equal(events.at(-1).id, rejectedId); assert.equal(events.at(-1).delivery, 'rejected');
  const state = readLog(router.journal).reduce((s, e, seq) => reduce(s, { ...e, seq, ts: 'now' }), initialState());
  assert.equal(state.chat.filter((m) => m.id === id).length, 1);
  assert.equal(state.chat.find((m) => m.id === id).delivery, 'delivered');
  assert.equal(state.chat.find((m) => m.id === id).ts, 'now');
  assert.equal(fs.readdirSync(router.spool).length, 0);
  await router.close();
});

test('shared RPC execution is host-only and does not publish a fictitious worktree', async (t) => {
  const { config, orchestrator } = setup(t, { maxParallel: 1, milestones: [{ title: 'One' }] });
  config.execution.isolation = 'shared';
  const result = await orchestrator.run('Shared trusted-host fixture');
  assert.equal(result.status, 'success', result.summary);
  const instances = readEvents(config.hiveDir).filter((e) => e.type === 'instance_started');
  assert.ok(instances.length > 0);
  for (const e of instances) { assert.equal(e.worktree, null); assert.equal(e.sandbox, 'host'); }
});

test('uncertain steer ACK is journaled once and never replayed on detach/attach/finish', async (t) => {
  const root = path.resolve('.scratch/fix-chat-integration');
  fs.mkdirSync(root, { recursive: true });
  const hiveDir = fs.mkdtempSync(path.join(root, 'chat-'));
  t.after(() => fs.rmSync(hiveDir, { recursive: true, force: true }));
  const events = [];
  const router = new ChatRouter({ hiveDir, runId: 'unknown-chat', emit: (type, fields) => events.push({ type, ...fields }) });
  router.register('dwight-m1');
  let sends = 0;
  await router.attach('dwight-m1', { sendMessage: async () => {
    sends++;
    return { ok: false, delivery: 'unknown', error: 'steer ACK timed out; delivery unknown' };
  } });
  const ack = await router.send('human', { to: 'dwight-m1', text: 'May already be accepted' });
  router.detach('dwight-m1');
  await router.attach('dwight-m1', { sendMessage: async () => { sends++; return { ok: true }; } });
  router.finish('dwight-m1');
  await router.close();
  assert.equal(sends, 1);
  assert.equal(ack.ok, false);
  assert.equal(ack.delivery, 'unknown');
  assert.match(ack.error, /timed out/);
  const transitions = events.filter((e) => e.type === 'chat_delivery' && e.id === ack.id);
  assert.deepEqual(transitions.map((e) => e.delivery), ['unknown']);
  assert.deepEqual(readLog(router.journal).filter((e) => e.type === 'chat_delivery').map((e) => e.delivery), ['unknown']);
});

test('finish during an in-flight steer preserves uncertainty and rejects only unsent messages', async (t) => {
  const root = path.resolve('.scratch/fix-chat-integration');
  fs.mkdirSync(root, { recursive: true });
  const hiveDir = fs.mkdtempSync(path.join(root, 'chat-'));
  t.after(() => fs.rmSync(hiveDir, { recursive: true, force: true }));
  const events = [];
  const router = new ChatRouter({ hiveDir, runId: 'finish-chat', emit: (type, fields) => events.push({ type, ...fields }) });
  router.register('dwight-m1');
  let resolveAck;
  await router.attach('dwight-m1', { sendMessage: () => new Promise((resolve) => { resolveAck = resolve; }) });
  const sending = router.send('human', { to: 'dwight-m1', text: 'In flight' });
  const waiting = router.send('human', { to: 'dwight-m1', text: 'Never sent' });
  router.finish('dwight-m1');
  resolveAck({ ok: true });
  const [uncertain, unsent] = await Promise.all([sending, waiting]);
  assert.equal(uncertain.ok, false); assert.equal(uncertain.delivery, 'unknown');
  assert.equal(unsent.ok, false); assert.equal(unsent.delivery, 'rejected');
  assert.deepEqual(events.filter((e) => e.type === 'chat_delivery').map((e) => e.delivery), ['unknown', 'rejected']);
  await router.close();
});


test('forward dependency chains and branches propagate skipped/failed outcomes to a fixed point', async () => {
  const { runDag } = await import('../../src/core/scheduler.js');
  for (const status of ['skipped', 'failed']) {
    const parsed = validatePlan({ milestones: [
      { title: 'Root', dependsOn: [] }, { title: 'Leaf', dependsOn: ['m3', 'm4'] },
      { title: 'Middle', dependsOn: ['m1'] }, { title: 'Branch', dependsOn: ['m3'] }
    ] });
    assert.equal(parsed.error, undefined);
    const launched = [], blocked = [];
    const outcomes = await runDag(parsed.milestones, { maxParallel: 2,
      run: async (m) => { launched.push(m.id); return status; },
      blocked: async (m) => blocked.push(m.id) });
    assert.deepEqual(launched, ['m1']);
    assert.deepEqual(blocked.sort(), ['m2', 'm3', 'm4']);
    assert.equal(outcomes.filter((s) => s === 'blocked').length, 3);
  }
  await assert.rejects(runDag([{ id: 'm1', dependsOn: ['m2'] }, { id: 'm2', dependsOn: ['m1'] }],
    { maxParallel: 2, run() { assert.fail('cycle launched'); }, blocked() {} }), /invalid dependency graph/);
});

test('reversed skipped prerequisite chain finishes partial, not invalid graph', async (t) => {
  const { orchestrator } = setup(t, { mode: 'blocked', onBreaker: 'skip', milestones: [
    { title: 'Root', dependsOn: [] }, { title: 'Leaf', dependsOn: ['m3'] }, { title: 'Middle', dependsOn: ['m1'] }
  ] });
  const result = await orchestrator.run('Skip reversed chain');
  assert.equal(result.status, 'partial', result.summary);
  assert.equal(result.summary, '1 skipped, 2 blocked');
});

test('snapshot and QA preparation failures stay milestone-local and support all human decisions', async (t) => {
  const { WorktreeManager } = await import('../../src/core/worktree.js');
  for (const method of ['snapshotWorktree', 'createQaWorktree']) {
    for (const decision of ['skip', 'retry', 'feedback', 'abort']) {
      await t.test(`${method}: ${decision}`, async (t) => {
        const original = WorktreeManager.prototype[method];
        let rejected = false;
        t.mock.method(WorktreeManager.prototype, method, async function (args) {
          if (args.milestoneId === 'm1' && !rejected) {
            rejected = true;
            throw new Error('Not an independent regular file: hardlink.txt');
          }
          return original.call(this, args);
        });
        let asked = 0;
        let integrated;
        const independentIntegrated = new Promise((resolve) => { integrated = resolve; });
        const { orchestrator, config, log } = setup(t, { milestones: plan.slice(0, 2), onBreaker: 'ask', hitl: async (ctx) => {
          asked++;
          assert.match(ctx.reason, /snapshot \/ QA preparation failed: Not an independent regular file/);
          assert.equal(ctx.milestoneId, 'm1');
          await independentIntegrated;
          assert.equal(readEvents(config.hiveDir).some((e) => e.type === 'milestone_integrated' && e.milestoneId === 'm1'), false);
          assert.equal(readLog(log).some((e) => e.role === 'angela' && e.milestone === 'm1'), false);
          return { decision, feedback: 'Remove the unsafe file and resubmit.' };
        } });
        orchestrator.rec.subscribe((event) => {
          if (event.type === 'milestone_integrated' && event.milestoneId === 'm2') integrated();
        });
        const result = await orchestrator.run('Reject unsafe snapshot without stopping siblings');
        assert.equal(asked, 1);
        assert.equal(result.status, decision === 'abort' ? 'aborted' : decision === 'skip' ? 'partial' : 'success', result.summary);
        assert.equal(fs.readFileSync(path.join(config.workspace, 'm2.txt'), 'utf8'), 'm2');
        if (decision === 'skip' || decision === 'abort') assert.equal(fs.existsSync(path.join(config.workspace, 'm1.txt')), false);
      });
    }
  }
});


test('chat attempt limit gives accepted spool IDs a bounded rejected transcript entry', async (t) => {
  const events = [], hiveDir = scratch(t);
  const router = new ChatRouter({ hiveDir, runId: 'attempt-limit', emit: (type, fields) => events.push({ type, ...fields }), maxMessages: 1, maxText: 8 });
  router.register('dwight-m1');
  await router.send('human', { to: 'dwight-m1', text: 'one' });
  await router.send('human', { to: 'dwight-m1', text: 'two' });
  const id = 'ac767bb7-d4fe-43ea-843d-c8feb709cbbb';
  fs.writeFileSync(path.join(router.spool, 'limit.json'), JSON.stringify({ id, runId: 'attempt-limit', from: 'forged', to: 'dwight-m1', text: '<b>long payload</b>' }));
  await router.consume();
  const rejected = events.filter((e) => e.id === id);
  assert.deepEqual(rejected, [{ type: 'chat_message', id, from: 'human', to: 'dwight-m1', text: '<b>long ', delivery: 'rejected', reason: 'Chat attempt limit reached' }]);
  const state = events.reduce((s, e) => reduce(s, e), initialState());
  assert.equal(state.chat.find((m) => m.id === id).delivery, 'rejected');
  assert.equal(readLog(router.journal).find((e) => e.id === id).type, 'chat_message');
  assert.equal(fs.readdirSync(router.spool).length, 0);
  assert.equal(router.instances.get('dwight-m1').queue.length, 1, 'rejected attempt is not sent');
  await router.close();
});

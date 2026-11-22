// The web views on what the real orchestrator emits in parallel RPC runs (scripted LLM, project scratch):
// role cards with role-only statuses, exact chat echo correlation, and a run whose process died.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  scratchDir, createRun, capture, until, spoolChat, readEvents,
} from './fixtures/real-orchestrator.js';
import {
  reduceAll, reduce, roleView, lanesOf, isLive, isBusy, interruptedView, dependencyState, createState,
} from '../../visualizer/public/js/state.js';
import { parseControl, runGone, runInterrupted, EXIT_SETTLE_MS, controlGates } from '../../visualizer/public/js/control.js';
import { chatRecipients, transcript, pruneOutbox, deliveryNews, composerBlock } from '../../visualizer/public/js/chat.js';
import { laneBadges } from '../../visualizer/public/js/lanes.js';
import { runElapsed } from '../../visualizer/public/js/format.js';

const runs = {};
const dirs = [];
const scratch = () => {
  const dir = scratchDir();
  dirs.push(dir);
  return dir;
};

after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

before(async () => {
  // A: Michael's agent fails twice; the human retries once, then skips planning
  {
    let calls = 0;
    const { orchestrator, hive } = createRun(scratch(), {
      env: { SCRANTON_FAKE_FAIL: 'exit1', SCRANTON_FAKE_FAIL_ROLE: 'michael' },
      hitl: async () => (++calls === 1 ? { decision: 'retry' } : { decision: 'skip' }),
    });
    runs.planner = { result: await orchestrator.run('Build a tiny todo CLI'), events: readEvents(hive) };
  }
  // B: two independent developer pipelines that never finish, human messages, then an abort
  {
    const { orchestrator, hive } = createRun(scratch(), { env: { SCRIPTED_MODE: 'hang' } });
    const running = orchestrator.run('Build a tiny todo CLI');
    await until(() => orchestrator.active.has('dwight-m1') && orchestrator.active.has('dwight-m2'));
    const runId = readEvents(hive)[0].runId;
    const before0 = capture(hive);
    const id1 = spoolChat(hive, runId, 'dwight-m1', 'Use todos.json in the working directory');
    await until(() => readEvents(hive).some((e) => e.type === 'chat_delivery' && e.id === id1));
    const afterFirst = capture(hive);
    // the same text again, echoed only later
    const id2 = spoolChat(hive, runId, 'dwight-m1', 'Use todos.json in the working directory');
    await until(() => readEvents(hive).some((e) => e.type === 'chat_delivery' && e.id === id2));
    const afterSecond = capture(hive);
    fs.writeFileSync(path.join(hive, 'control', 'chat', 'forged.json'), JSON.stringify({ id: 'forged', runId, to: 'dwight-m1', text: 'secret' }));
    await until(() => readEvents(hive).some((e) => e.type === 'chat_command_rejected'));
    const midRun = capture(hive);
    orchestrator.abort('test over');
    const result = await running;
    runs.parallel = { runId, id1, id2, before0, afterFirst, afterSecond, midRun, result, events: readEvents(hive) };
  }
  // C: a shared trusted-host run reports no worktree at all
  {
    const { orchestrator, hive, config } = createRun(scratch(), { maxParallel: 1 });
    config.execution.isolation = 'shared';
    runs.shared = { result: await orchestrator.run('Build a tiny todo CLI'), events: readEvents(hive), workspace: config.workspace };
  }
  // E: dwight-m1's agent crashes and the human skips m1 while dwight-m2 is still inside a tool, then an abort
  {
    const inTool = () => readEvents(hive).some((e) => e.type === 'agent_tool' && e.instanceId === 'dwight-m2' && e.tool === 'bash');
    // the skip waits for dwight-m2 to be inside its never-ending tool, so m2 is working when m1 ends
    const { orchestrator, hive } = createRun(scratch(), {
      env: { SCRIPTED_MODE: 'hang-tool', SCRIPTED_CRASH: 'dwight-m1' }, hitl: async () => { await until(inTool); return { decision: 'skip' }; },
    });
    const running = orchestrator.run('Build a tiny todo CLI');
    await until(() => readEvents(hive).some((e) => e.type === 'milestone_finished' && e.milestoneId === 'm1'));
    const skipped = capture(hive);
    orchestrator.abort('test over');
    runs.crash = { skipped, result: await running, events: readEvents(hive) };
  }
  // D: serial execution still publishes exact instance identities
  {
    const { orchestrator, hive } = createRun(scratch(), { maxParallel: 1 });
    runs.serial = { result: await orchestrator.run('Build a tiny todo CLI'), events: readEvents(hive) };
  }
});

const roleOnly = (e) => e.type === 'agent_status' && !e.instanceId;

test('every role-only status the orchestrator emits is what the role card shows, even over an error lane', () => {
  const { events, result } = runs.planner;
  assert.equal(result.status, 'success', result.summary);
  let checked = 0;
  for (let i = 0; i < events.length; i += 1) {
    if (!roleOnly(events[i])) continue;
    const s = reduceAll(events.slice(0, i + 1));
    const view = roleView(s, events[i].agent);
    assert.deepEqual([view.status, view.activity], [events[i].status, events[i].activity], `after seq ${events[i].seq}`);
    checked += 1;
  }
  assert.ok(checked >= 6, `${checked} role-only statuses`);
  // the planning failure itself: Michael's lane is in error, the role waits for a human
  const ask = events.findIndex((e) => e.type === 'hitl_request');
  const s = reduceAll(events.slice(0, ask + 1));
  assert.equal(s.instances.michael.status, 'error', 'the lane keeps its own error');
  assert.equal(roleView(s, 'michael').status, 'blocked');
  assert.equal(roleView(s, 'michael').activity, 'Needs a human!');
  assert.equal(roleView(s, 'michael').focus, null);
  // a newer lane event takes the card back
  const restart = events.findIndex((e, i) => i > ask && e.type === 'instance_started');
  const restarted = reduceAll(events.slice(0, restart + 1));
  assert.deepEqual([restarted.instances.michael.status, restarted.instances.michael.activity], ['thinking', 'Thinking...']);
  assert.equal(roleView(restarted, 'michael').status, 'thinking');
});

test('a just started lane is thinking, as state.json says, until its first callback', () => {
  const { events } = runs.planner;
  const first = events.findIndex((e) => e.type === 'instance_started');
  const s = reduceAll(events.slice(0, first + 1));
  assert.equal(events[first].instanceId, 'michael');
  assert.deepEqual([s.instances.michael.status, s.instances.michael.activity], ['thinking', 'Thinking...']);
  assert.deepEqual([roleView(s, 'michael').status, roleView(s, 'michael').focus], ['thinking', 'michael']);
});

test('a milestone skipped after its lane crashed ends that lane; the other pipeline still speaks for the role', () => {
  const { skipped, result, events } = runs.crash;
  const at = (pred) => skipped.events.findIndex(pred);
  const crash = at((e) => e.type === 'agent_status' && e.instanceId === 'dwight-m1' && e.status === 'error');
  const finished = at((e) => e.type === 'milestone_finished' && e.milestoneId === 'm1');
  assert.ok(crash > 0 && finished > crash, 'dwight-m1 crashed before m1 was skipped');
  assert.equal(skipped.events[finished].status, 'skipped');
  assert.ok(skipped.events.some((e) => e.type === 'hitl_response' && e.decision === 'skip'));
  // before the skip the crashed lane is the loudest
  const before = reduceAll(skipped.events.slice(0, finished));
  assert.equal(before.instances['dwight-m2'].status, 'working');
  assert.equal(roleView(before, 'dwight').focus, 'dwight-m1');

  const s = reduceAll(skipped.events);
  assert.equal(s.milestones.find((m) => m.id === 'm1').status, 'skipped');
  assert.equal(s.instances['dwight-m1'].status, skipped.state.instances['dwight-m1'].status, 'same as state.json');
  assert.equal(s.instances['dwight-m1'].status, 'done');
  assert.match(s.instances['dwight-m1'].activity, /^Failed: /, 'the lane keeps what went wrong');
  assert.equal(isLive(s.instances['dwight-m1']), false);
  assert.equal(isBusy(s.instances['dwight-m1']), false);
  const view = roleView(s, 'dwight');
  assert.deepEqual([view.status, view.focus, view.live, view.busy], ['working', 'dwight-m2', 1, 1]);
  assert.deepEqual(chatRecipients(s, null).map((r) => r.id), ['dwight-m2']);
  // a replayed (stale) crash status cannot bring the lane back
  assert.equal(reduce(s, skipped.events[crash]), s);
  assert.equal(reduceAll(skipped.events, s), s);

  // the abort ends m2 as well; nothing is left live
  assert.equal(result.status, 'aborted', result.summary);
  const end = reduceAll(events);
  assert.ok(events.some((e) => e.type === 'milestone_finished' && e.milestoneId === 'm2' && e.status === 'aborted'));
  assert.ok(lanesOf(end).every((i) => !isLive(i)), JSON.stringify(lanesOf(end).map((i) => [i.id, i.status])));
  assert.equal(roleView(end, 'dwight').busy, 0);
  // ...also when the stream is cut right after m2's milestone_finished, before run_finished
  const m2End = events.findIndex((e) => e.type === 'milestone_finished' && e.milestoneId === 'm2');
  const cut = reduceAll(events.slice(0, m2End + 1));
  assert.ok(lanesOf(cut).filter((i) => i.milestoneId).every((i) => i.status === 'done'));
  assert.deepEqual(chatRecipients(cut, null).filter((r) => r.agent === 'dwight'), []);
});

test('mid-run: Michael oversees while the planner lane is done or (older producers) idle', () => {
  const { midRun } = runs.parallel;
  const s = reduceAll(midRun.events);
  assert.equal(s.instances.michael.status, 'done');
  assert.deepEqual([roleView(s, 'michael').status, roleView(s, 'michael').activity], ['waiting', 'Overseeing m2: Command line interface']);
  assert.equal(roleView(s, 'dwight').busy, 2);
  // without the "Planning complete" lane update the planner lane stays idle; the role still oversees
  const older = reduceAll(midRun.events.filter((e) => !(e.type === 'agent_status' && e.instanceId === 'michael' && e.status === 'done')));
  assert.equal(older.instances.michael.status, 'idle');
  assert.deepEqual([roleView(older, 'michael').status, roleView(older, 'michael').activity], ['waiting', 'Overseeing m2: Command line interface']);
});

test('a finished planner is not messageable; live developer lanes are', () => {
  const { midRun, runId } = runs.parallel;
  const s = reduceAll(midRun.events);
  const control = parseControl({ v: 1, enabled: true, run: { pid: 1, mode: 'run', runId, startedAt: s.startedAt }, instances: midRun.state.instances });
  assert.deepEqual(chatRecipients(s, control).map((r) => r.id), ['dwight-m1', 'dwight-m2']);
});

test('identical human messages echoed one after the other each keep their own entry', () => {
  const { id1, id2, before0, afterFirst, afterSecond } = runs.parallel;
  const states = [before0, afterFirst, afterSecond].map((c) => reduceAll(c.events));
  assert.equal(states[1].chat.filter((c) => c.id === id1).length, 1, 'the orchestrator kept the POST id');
  // both POSTs answered before the first echo, as the panel builds its outbox
  const sent = (id) => ({ id, runId: states[0].runId, from: 'human', to: 'dwight-m1', text: 'Use todos.json in the working directory',
    truncated: false, milestoneId: null, delivery: 'queued', reason: null, ts: states[0].updatedAt, sentAt: 0 });
  let outbox = [sent(id1), sent(id2)];
  let deliveries = new Map([[id1, 'queued'], [id2, 'queued']]);
  const mine = new Set([id1, id2]);
  const said = [];
  const renders = (s) => {
    // the panel renders on every event and poll, so each state is rendered more than once
    for (let i = 0; i < 3; i += 1) {
      outbox = pruneOutbox(outbox, s);
      const entries = transcript(s, outbox);
      const next = new Map(entries.filter((m) => mine.has(m.id)).map((m) => [m.id, m.delivery]));
      const news = deliveryNews(deliveries, next, entries.filter((m) => mine.has(m.id)));
      if (news) said.push(news);
      deliveries = next;
    }
    return transcript(s, outbox).map((m) => [m.id, m.delivery, Boolean(m.local)]);
  };
  assert.deepEqual(renders(states[0]), [[id1, 'queued', true], [id2, 'queued', true]]);
  assert.deepEqual(renders(states[1]), [[id1, 'delivered', false], [id2, 'queued', true]], 'the second message does not take the first echo');
  assert.deepEqual(outbox.map((o) => o.id), [id2]);
  assert.deepEqual(renders(states[2]), [[id1, 'delivered', false], [id2, 'delivered', false]]);
  assert.deepEqual(outbox, []);
  assert.deepEqual(said, ['Message to dwight-m1 delivered', 'Message to dwight-m1 delivered'], 'each delivery announced once');
});

test('a refused spool command is logged, never put into the transcript', () => {
  const s = reduceAll(runs.parallel.midRun.events);
  const line = s.log.find((l) => l.type === 'chat_command_rejected');
  assert.equal(line.text, 'Chat command rejected: Invalid chat command');
  assert.equal(line.category, 'handoffs');
  assert.ok(s.chat.every((c) => c.from === 'human' && c.to === 'dwight-m1'));
  assert.equal(s.chat.length, 2);
});

test('a run whose process died shows as exited, without inventing a result or events', () => {
  const { midRun, runId, events: all } = runs.parallel;
  const s = reduceAll(midRun.events);
  const exitAt = new Date(Date.parse(s.updatedAt) + 4000).toISOString();
  const lastExit = { runId, mode: 'run', request: 'Build a tiny todo CLI', exitCode: 1, startedAt: s.startedAt, finishedAt: exitAt, outputTail: '' };
  const control = parseControl({ v: 1, enabled: true, run: null, lastExit });
  const at = Date.parse(exitAt);
  // the run's own run_finished may still be on its way over the stream
  assert.equal(runGone(control, s), true);
  assert.equal(runInterrupted(control, s, at + EXIT_SETTLE_MS - 1), false);
  assert.equal(runInterrupted(control, s, at + EXIT_SETTLE_MS), true);
  // ...and once it arrives, the run is simply over
  const finished = reduceAll(all);
  assert.equal(finished.result, 'aborted');
  assert.equal(runInterrupted(control, finished, at + 60_000), false);
  // an exit of another run, or of an older one, says nothing about the run on screen
  assert.equal(runInterrupted(parseControl({ v: 1, enabled: true, lastExit: { ...lastExit, runId: 'older-run' } }), s, at + 60_000), false);
  const newer = reduceAll(runs.planner.events.slice(0, 3));
  assert.equal(runInterrupted(control, newer, at + 60_000), false);
  // a new process of this server that has not published its run yet: the old run is still gone
  assert.equal(runInterrupted(parseControl({ v: 1, enabled: true, run: { pid: 2, mode: 'run', runId: null }, lastExit }), s, at + 60_000), true);

  const before = structuredClone(s);
  const v = interruptedView(s, { at: exitAt, exitCode: 1 });
  assert.deepEqual(s, before, 'the reducer state is untouched');
  assert.equal(v.status, 'exited');
  assert.equal(v.result, null);
  assert.equal(v.lastSeq, s.lastSeq);
  assert.equal(v.log.length, s.log.length, 'no event is forged');
  assert.deepEqual(v.exit, { at: exitAt, exitCode: 1 });
  assert.deepEqual(v.activeMilestoneIds, []);
  assert.deepEqual(v.milestones.map((m) => m.status), ['interrupted', 'interrupted', 'pending']);
  assert.equal(dependencyState(v, v.milestones[2]).kind, 'blocked');
  assert.ok(lanesOf(v).every((i) => !isLive(i) && !isBusy(i)), JSON.stringify(lanesOf(v).map((i) => [i.id, i.status])));
  assert.deepEqual(lanesOf(v).map((i) => [i.id, i.status]), [['michael', 'done'], ['dwight-m1', 'interrupted'], ['dwight-m2', 'interrupted']]);
  for (const id of ['michael', 'dwight']) assert.equal(roleView(v, id).status, 'interrupted', id);
  assert.equal(roleView(v, 'dwight').busy, 0);
  // the clock stops at the exit even while the page keeps ticking
  assert.equal(runElapsed(v, { ticking: true, now: at + 3_600_000 }), at - Date.parse(s.startedAt));
  // nobody can be messaged and New run is offered again
  assert.deepEqual(chatRecipients(v, control), []);
  assert.match(composerBlock({ enabled: true, mode: 'live', alive: false, sameRun: false, recipients: [], gone: true }), /exited/);
  assert.equal(controlGates({ control, mode: 'live' }).canStart, true);
  assert.equal(controlGates({ control, mode: 'live' }).canStop, false);
  // a finished run is shown as it is
  assert.equal(interruptedView(finished, { at: exitAt }), finished);
});

test('worktree badges only for reported worktrees, never for the shared workspace', () => {
  const p = reduceAll(runs.parallel.midRun.events);
  for (const i of lanesOf(p)) assert.equal(i.worktree?.mode, 'worktree', i.id);
  assert.ok(laneBadges(p.instances['dwight-m1']).some(([t]) => t === 'worktree'));
  const { events, result, workspace } = runs.shared;
  assert.equal(result.status, 'success', result.summary);
  const s = reduceAll(events);
  assert.ok(lanesOf(s).length >= 3);
  for (const i of lanesOf(s)) {
    assert.equal(i.worktree, null, i.id);
    assert.deepEqual(laneBadges(i).map(([t]) => t).filter((t) => t !== `session ${i.sessionId.slice(0, 8)}`), ['host'], i.id);
  }
  assert.ok(!s.log.some((l) => l.type === 'instance_started' && /worktree/.test(l.text)));
  // a producer that names the workspace itself as the directory does not get a worktree badge either
  const e = events.find((x) => x.type === 'instance_started');
  const named = reduce(reduceAll(events.slice(0, events.indexOf(e))), { ...e, worktree: `${workspace.toUpperCase()}\\` });
  assert.equal(named.instances[e.instanceId].worktree.mode, 'shared');
  assert.match(named.log.at(-1).text, /shared workspace/);
});

test('a serial own-runtime run publishes lanes consistently with tool instance identities', () => {
  const { events, result } = runs.serial;
  assert.equal(result.status, 'success', result.summary);
  assert.ok(events.some((e) => e.type === 'agent_tool' && e.instanceId), 'the producer names instances on tool events');
  let s = createState();
  for (const e of events) {
    s = reduce(s, e);
    assert.equal(s.lastSeq, e.seq, 'every own-runner event is consumed');
  }
  assert.deepEqual(lanesOf(s).map(i => i.id).sort(), ['angela-m1', 'angela-m2', 'angela-m3', 'dwight-m1', 'dwight-m2', 'dwight-m3', 'michael']);
  assert.ok(lanesOf(s).every((i) => !isLive(i)));
});

test('an unknown delivery is neither delivered nor rejected, and a late queued echo keeps it', () => {
  const { runId } = runs.parallel;
  let seq = 0;
  const e = (type, f) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString(), runId, type, ...f });
  let s = reduceAll([e('run_started', { request: 'x', workspace: 'C:\\w' }), e('chat_message', { id: 'c1', from: 'human', to: 'dwight-m1', text: 'hi', delivery: 'queued' })]);
  s = reduce(s, e('chat_delivery', { id: 'c1', delivery: 'unknown', reason: 'steer ACK timed out' }));
  assert.equal(s.chat[0].delivery, 'unknown');
  assert.match(s.log.at(-1).text, /delivery unknown - not resent automatically: steer ACK timed out/);
  s = reduce(s, e('chat_delivery', { id: 'c1', delivery: 'queued' }));
  s = reduce(s, e('chat_message', { id: 'c1', from: 'human', to: 'dwight-m1', text: 'hi', delivery: 'queued' }));
  assert.equal(s.chat[0].delivery, 'unknown');
  assert.equal(deliveryNews(new Map([['c1', 'queued']]), new Map([['c1', 'unknown']]), [{ id: 'c1', to: 'dwight-m1' }]),
    'Message to dwight-m1: delivery unknown, it is not resent automatically');
  assert.equal(createState().chat.length, 0);
});

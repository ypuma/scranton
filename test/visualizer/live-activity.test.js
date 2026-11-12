// Live activity (.enma/live-activity-contract.md): the reducer additions (tool target, touched files, the usage
// fold), and the engine-neutral run view: what every agent does now, the board and the usage, for a Team run and
// for a Pipeline run. No DOM here; the panels that draw it are in live-panels.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createState, reduce, reduceAll, totals, parseJsonl, interruptedView, TOUCHED_MAX, USAGE_POINTS_MAX, LOG_SIZE,
} from '../../visualizer/public/js/state.js';
import {
  toolLine, teamAgents, teamBoard, milestoneColumn, teamRunView, pipelineRunView, pipelineBoard, pipelineAgents, doneSteps, parseLive,
  liveTails, parseUsage, foldCalls, boardSummary, agentsSummary, railMode, parseRailChoice, liveLine, LIVE_STALE_MS, TAIL_MAX, NO_REASONING,
  BOARD_COLUMNS,
} from '../../visualizer/public/js/activity-model.js';
import { chartModel, niceStep, shortTime, usageFigures, BANDS_MAX, TABLE_ROWS_MAX } from '../../visualizer/public/js/usage-chart.js';
import { initialState as serverState, reduce as serverReduce } from '../../src/core/state.js';
import { CHAT_EVENT_TYPES } from '../../visualizer/public/js/chat-adapter-team.js';
import { parseRuns } from '../../visualizer/public/js/scope.js';
import { parseStatus, parsePlan, parseRunDoc, parseRunList } from '../../visualizer/public/js/pipeline-model.js';

const RUN = 'run-live';
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);

// events of one run: e(type, fields) numbers and stamps them one second apart
function journal() {
  let seq = 0;
  const e = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(T0 + seq * 1000).toISOString(), runId: RUN, type, ...fields });
  return e;
}

function started(extra = []) {
  const e = journal();
  const events = [
    e('run_started', { request: 'Build it', workspace: 'C:\\ws', maxFailedCycles: 3, execution: { workflow: { gates: [['oscar'], ['angela']] } } }),
    e('plan_ready', { milestones: [
      { id: 'm1', title: 'Storage', acceptanceCriteria: ['todos persist'] },
      { id: 'm2', title: 'CLI', dependsOn: ['m1'] },
      { id: 'm3', title: 'Docs', dependsOn: ['m2'] },
    ] }),
    ...extra.map(([type, fields]) => e(type, fields)),
  ];
  return { e, events, state: reduceAll(events) };
}
const add = (state, e, list) => list.reduce((s, [type, fields]) => reduce(s, e(type, fields)), state);
const lane = (agent, m) => ['instance_started', { instanceId: `${agent}-${m}`, agent, milestoneId: m }];
const status = (agent, m, st, activity = '') => ['agent_status', { agent, instanceId: `${agent}-${m}`, milestoneId: m, status: st, activity }];
const tool = (agent, m, name, fields) => ['agent_tool', { agent, instanceId: `${agent}-${m}`, tool: name, ...fields }];
const finished = (agent, m, usage, keyword = 'TASK_COMPLETE') => ['agent_finished', { agent, instanceId: `${agent}-${m}`, milestoneId: m, cycle: 1, keyword, exitCode: 0, durationMs: 1000, ...(usage ? { usage } : {}) }];
const usage = (agent, m, u) => ['agent_usage', { agent, instanceId: `${agent}-${m}`, model: 'gpt-x', usage: u }];

// ------------------------------------------------------------ reducer: tool target and touched files

test('agent_tool carries targetFile and command; an older event without them falls back to detail', () => {
  const { e, state } = started([['milestone_started', { milestoneId: 'm1', title: 'Storage', index: 0, total: 3 }], lane('dwight', 'm1')]);
  let s = add(state, e, [tool('dwight', 'm1', 'edit', { detail: 'edit src/cli.js', targetFile: 'src/cli.js', command: null })]);
  const d = s.instances['dwight-m1'];
  assert.deepEqual(d.tool, { tool: 'edit', detail: 'edit src/cli.js', targetFile: 'src/cli.js', command: null, startedAt: d.updatedAt });
  assert.deepEqual(d.lastTool, { tool: 'edit', detail: 'edit src/cli.js', targetFile: 'src/cli.js', command: null, ts: d.updatedAt });
  assert.deepEqual(s.agents.dwight.tool, d.tool, 'the role aggregate carries the same call');

  s = add(s, e, [tool('dwight', 'm1', 'bash', { detail: 'node --test', command: 'node --test "test/**"', targetFile: null })]);
  assert.deepEqual([s.instances['dwight-m1'].tool.command, s.instances['dwight-m1'].tool.targetFile], ['node --test "test/**"', null]);

  // a journal from before the fields: the file of read / write / edit and the command of a shell call are the detail
  s = add(s, e, [tool('dwight', 'm1', 'read', { detail: 'src/old.js' })]);
  assert.deepEqual([s.instances['dwight-m1'].tool.targetFile, s.instances['dwight-m1'].tool.command], ['src/old.js', null]);
  s = add(s, e, [tool('dwight', 'm1', 'bash', { detail: 'npm test' })]);
  assert.deepEqual([s.instances['dwight-m1'].tool.targetFile, s.instances['dwight-m1'].tool.command], [null, 'npm test']);
  s = add(s, e, [tool('dwight', 'm1', 'grep', { detail: 'TODO' })]);
  assert.deepEqual([s.instances['dwight-m1'].tool.targetFile, s.instances['dwight-m1'].tool.command], [null, null], 'a search targets no file');
});

test('touchedFiles: newest first, each path once, at most eight, with the kind of the call', () => {
  const { e, state } = started([['milestone_started', { milestoneId: 'm1', title: 'Storage', index: 0, total: 3 }], lane('dwight', 'm1')]);
  let s = add(state, e, [
    tool('dwight', 'm1', 'read', { detail: 'a.js', targetFile: 'a.js' }),
    tool('dwight', 'm1', 'bash', { detail: 'node a.js', command: 'node a.js' }),
    tool('dwight', 'm1', 'write', { detail: 'b.js', targetFile: 'b.js' }),
    tool('dwight', 'm1', 'edit', { detail: 'a.js', targetFile: 'a.js' }),
  ]);
  assert.deepEqual(s.instances['dwight-m1'].touchedFiles.map((f) => [f.path, f.kind]), [['a.js', 'edit'], ['b.js', 'write']], 'a.js moved to the front as an edit; the shell call touched nothing');
  assert.equal(s.instances['dwight-m1'].touchedFiles[0].ts, s.instances['dwight-m1'].updatedAt);
  s = add(s, e, Array.from({ length: 12 }, (_, i) => tool('dwight', 'm1', 'read', { detail: `f${i}.js`, targetFile: `f${i}.js` })));
  const files = s.instances['dwight-m1'].touchedFiles;
  assert.equal(files.length, TOUCHED_MAX);
  assert.deepEqual(files.map((f) => f.path), ['f11.js', 'f10.js', 'f9.js', 'f8.js', 'f7.js', 'f6.js', 'f5.js', 'f4.js']);
  assert.equal(TOUCHED_MAX, 8);
});

// ------------------------------------------------------------ reducer: the usage fold

test('agent_usage folds the delta of each call into totals, the agent and one cumulative point', () => {
  const { e, state } = started([lane('dwight', 'm1')]);
  let s = add(state, e, [usage('dwight', 'm1', { input: 100, output: 20, cost: 0.01 }), usage('dwight', 'm1', { input: 50, output: 5, cost: 0.004, cacheRead: 900 })]);
  assert.deepEqual({ ...s.usage, series: null }, {
    input: 150, output: 25, cost: 0.014, tokens: 175, calls: 2, startedAt: '2026-11-12T09:00:04.000Z',
    byAgent: { dwight: { input: 150, output: 25, cost: 0.014, tokens: 175, calls: 2 } }, series: null,
  });
  assert.deepEqual(s.usage.series.map((p) => [p.tokens, p.cost, p.byAgent.dwight.tokens]), [[120, 0.01, 120], [175, 0.014, 175]], 'cumulative run values, not deltas');
  assert.equal(s.usage.series[1].ts, s.updatedAt);

  // the launch ends: its agent_finished reports the same total, so nothing is counted twice
  s = add(s, e, [finished('dwight', 'm1', { input: 150, output: 25, cost: 0.014 })]);
  assert.deepEqual([s.usage.tokens, s.usage.calls, s.usage.series.length], [175, 2, 2]);
  assert.deepEqual(s.usagePending, {});
  // and what its calls did not report is one more delta
  s = add(s, e, [usage('dwight', 'm1', { input: 10, output: 0, cost: 0.001 }), finished('dwight', 'm1', { input: 40, output: 8, cost: 0.003 })]);
  assert.deepEqual([s.usage.input, s.usage.output, s.usage.calls, s.usage.series.length], [190, 33, 3, 4]);
  assert.ok(Math.abs(s.usage.cost - 0.017) < 1e-9);
});

test('a journal that only has agent_finished still adds up, and the usage equals the agents\' totals', () => {
  const { e, state } = started([lane('michael', 'plan'), lane('dwight', 'm1'), lane('angela', 'm1')]);
  const s = add(state, e, [
    ['agent_finished', { agent: 'michael', instanceId: 'michael', keyword: 'PLAN_READY', exitCode: 0, durationMs: 5, usage: { input: 1960, output: 280, cost: 0.01 } }],
    finished('dwight', 'm1', { input: 4000, output: 900, cost: 0.012 }),
    finished('angela', 'm1', null, 'TEST_PASSED'),
    finished('dwight', 'm1', { input: 1000, output: 100, cost: 0.003 }),
  ]);
  assert.deepEqual([s.usage.input, s.usage.output, s.usage.tokens, s.usage.calls], [6960, 1280, 8240, 3], 'one delta per launch that reported usage');
  assert.deepEqual(Object.keys(s.usage.byAgent), ['michael', 'dwight']);
  assert.deepEqual(s.usage.series.map((p) => p.tokens), [2240, 7140, 8240]);
  const t = totals(s);
  assert.deepEqual([s.usage.input, s.usage.output], [t.input, t.output], 'the invariant of contract section 2');
  assert.ok(Math.abs(s.usage.cost - t.cost) < 1e-9);
  for (const id of ['michael', 'dwight']) assert.equal(s.usage.byAgent[id].tokens, s.agents[id].totals.input + s.agents[id].totals.output, id);

  // the recorded demo (with agent_usage) and the serial fixture (without) both keep the invariant
  for (const file of ['../../visualizer/public/demo/sample-events.jsonl', './fixtures/serial-events.jsonl']) {
    const run = reduceAll(parseJsonl(readFileSync(new URL(file, import.meta.url), 'utf8')));
    const sum = totals(run);
    assert.ok(sum.tokens > 0, file);
    assert.deepEqual([run.usage.input, run.usage.output], [sum.input, sum.output], file);
    assert.ok(Math.abs(run.usage.cost - sum.cost) < 1e-6, `${file}: ${run.usage.cost} vs ${sum.cost}`);
    assert.deepEqual(run.usagePending, {}, `${file}: nothing left pending`);
  }
});

test('the series is bounded: past 120 points every odd one goes, the newest stays', () => {
  const { e, state } = started([lane('dwight', 'm1')]);
  let s = state;
  for (let i = 0; i < USAGE_POINTS_MAX; i += 1) s = reduce(s, e(...usage('dwight', 'm1', { input: 1, output: 0, cost: 0 })));
  assert.equal(s.usage.series.length, 120, 'at the bound nothing is dropped');
  s = reduce(s, e(...usage('dwight', 'm1', { input: 1, output: 0, cost: 0 })));
  assert.equal(s.usage.series.length, 61);
  assert.deepEqual(s.usage.series.slice(0, 3).map((p) => p.tokens), [1, 3, 5], 'the even indexes are kept');
  assert.equal(s.usage.series.at(-1).tokens, 121, 'and the newest point');
  for (let i = 0; i < 500; i += 1) s = reduce(s, e(...usage('dwight', 'm1', { input: 1, output: 0, cost: 0 })));
  assert.ok(s.usage.series.length <= USAGE_POINTS_MAX);
  assert.equal(s.usage.series.at(-1).tokens, 621);
  assert.equal(s.usage.tokens, 621, 'the totals never lose a call');
  assert.equal(s.usage.series[0].tokens, 1, 'the run still starts where it started');
});

test('agent_usage is no Activity-log row or conversation event; zero reports still count a call', () => {
  const { e, state } = started([lane('dwight', 'm1')]);
  const before = state.log.length;
  let s = add(state, e, [usage('dwight', 'm1', { input: 5, output: 5, cost: 0.001 })]);
  assert.equal(s.log.length, before, 'no row');
  assert.equal(s.applied, state.applied + 1, 'but a known event');
  assert.equal(CHAT_EVENT_TYPES.has('agent_usage'), false, 'the page does not buffer it, so it never counts against CHAT_EVENTS_MAX');
  const main = readFileSync(new URL('../../visualizer/public/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /if \(CHAT_EVENT_TYPES\.has\(event\.type\)\) \{\s*liveEvents\.push\(event\);/, 'only conversation events are kept');
  // a flood of them evicts nothing from the bounded log
  for (let i = 0; i < LOG_SIZE + 50; i += 1) s = reduce(s, e(...usage('dwight', 'm1', { input: 1, output: 1, cost: 0 })));
  assert.equal(s.log[0].seq, state.log[0].seq);

  for (const bad of [null, 'x', {}, { input: -5, output: 'many', cost: NaN }, { input: 0, output: 0, cost: 0 }]) {
    const next = reduce(s, e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: bad }));
    assert.deepEqual([next.usage.input, next.usage.output, next.usage.cost], [s.usage.input, s.usage.output, s.usage.cost], JSON.stringify(bad));
    assert.equal(next.usage.calls, s.usage.calls + 1, 'even a zero report is a call');
    assert.equal(next.usage.series.length, s.usage.series.length + 1, 'and a point');
  }
  // an agent named like an Object.prototype key is an own entry, never the prototype's
  const odd = reduce(s, e('agent_usage', { agent: 'constructor', instanceId: 'constructor-m1', usage: { input: 1, output: 1, cost: 0 } }));
  assert.deepEqual(odd.usage.byAgent.constructor, { input: 1, output: 1, cost: 0, tokens: 2, calls: 1 });
});

test('agent_finished never makes a lane: a serial JSON run names its instance there and has none', () => {
  const e = journal();
  const s = reduceAll([
    e('run_started', { request: 'x', workspace: 'C:\\ws' }),
    e('agent_status', { agent: 'dwight', status: 'working', activity: 'Working...' }),
    e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 10, output: 2, cost: 0.001 } }),
    e('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'write', detail: 'a.js', targetFile: 'a.js' }),
    e('agent_finished', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 1, usage: { input: 30, output: 5, cost: 0.002 } }),
  ]);
  assert.deepEqual(s.instances, {});
  assert.deepEqual([s.usage.tokens, s.usage.calls], [35, 1], 'the pending sum is found by the instance id both events carry');
  assert.deepEqual(s.agents.dwight.touchedFiles.map((f) => f.path), ['a.js'], 'the role keeps the files, so a serial run shows them');
  assert.deepEqual(teamAgents(s).map((a) => [a.id, a.name, a.role, a.files.length]), [['michael', 'Michael', 'Planner', 0], ['dwight', 'Dwight', 'Developer', 1], ['angela', 'Angela', 'QA', 0]]);
});

// ------------------------------------------------------------ what an agent is doing now

test('toolLine: one sentence per kind of call, with the detail when the newer fields are missing', () => {
  assert.equal(toolLine({ tool: 'edit', detail: 'x', targetFile: 'src/cli.js' }), 'Editing src/cli.js');
  assert.equal(toolLine({ tool: 'read', detail: 'README.md' }), 'Reading README.md', 'an old event: the file is the detail');
  assert.equal(toolLine({ tool: 'write', detail: '', targetFile: 'todo.js' }), 'Writing todo.js');
  assert.equal(toolLine({ tool: 'bash', detail: 'node --test', command: 'node --test "test/**/*.test.js"' }), 'Running node --test "test/**/*.test.js"');
  assert.equal(toolLine({ tool: 'powershell', detail: 'Get-ChildItem' }), 'Running Get-ChildItem');
  assert.equal(toolLine({ tool: 'grep', detail: 'parseArgs' }), 'Searching for parseArgs');
  assert.equal(toolLine({ tool: 'find', detail: '' }), 'Searching the workspace');
  assert.equal(toolLine({ tool: 'ls', detail: '' }), 'Listing .');
  assert.equal(toolLine({ tool: 'fetch', detail: 'https://example.org' }), 'Using fetch https://example.org');
  assert.equal(toolLine(null), '');
});

function working() {
  const r = started([
    lane('michael', 'plan'),
    ['agent_status', { agent: 'michael', instanceId: 'michael-plan', status: 'waiting', activity: 'Overseeing' }],
    ['milestone_started', { milestoneId: 'm1', title: 'Storage', index: 0, total: 3 }],
    lane('dwight', 'm1'),
    status('dwight', 'm1', 'working', 'Working...'),
    tool('dwight', 'm1', 'edit', { detail: 'src/cli.js', targetFile: 'src/cli.js' }),
    lane('angela', 'm1'),
  ]);
  return r;
}

test('teamAgents: name, role, status and one line for what each instance does now', () => {
  const { e, state } = working();
  const row = (s, id) => {
    const a = teamAgents(s).find((x) => x.id === id);
    return [a.name, a.role, a.status, a.line, a.live, a.busy];
  };
  assert.deepEqual(teamAgents(state).map((a) => a.id), ['michael-plan', 'dwight-m1', 'angela-m1'], 'reading order');
  assert.deepEqual(row(state, 'dwight-m1'), ['dwight-m1', 'Developer · m1', 'working', 'Editing src/cli.js', true, true]);
  assert.deepEqual(row(state, 'angela-m1'), ['angela-m1', 'QA · m1', 'thinking', 'Thinking', true, true], '"Thinking..." is the status word, said once');
  assert.deepEqual(row(state, 'michael-plan'), ['michael-plan', 'Planner', 'waiting', 'Overseeing', true, false]);
  assert.deepEqual(teamAgents(state).find((a) => a.id === 'dwight-m1').files, [{ path: 'src/cli.js', kind: 'edit', ts: state.instances['dwight-m1'].lastTool.ts }]);

  let s = add(state, e, [status('dwight', 'm1', 'thinking', 'Thinking...')]);
  assert.equal(row(s, 'dwight-m1')[3], 'Thinking', 'the tool ended');
  s = add(s, e, [status('dwight', 'm1', 'waiting', 'Waiting')]);
  assert.equal(row(s, 'dwight-m1')[3], 'Waiting');
  s = add(s, e, [status('dwight', 'm1', 'blocked', 'pi exited with code 1')]);
  assert.deepEqual(row(s, 'dwight-m1').slice(2, 4), ['blocked', 'Blocked: pi exited with code 1']);
  s = add(s, e, [status('dwight', 'm1', 'thinking', 'Writing the report...')]);
  assert.equal(row(s, 'dwight-m1')[3], 'Writing the report', 'what the engine says when it says more than the status');
  s = add(s, e, [finished('dwight', 'm1', { input: 1, output: 1, cost: 0 })]);
  assert.deepEqual(row(s, 'dwight-m1').slice(2), ['idle', 'Finished: TASK_COMPLETE', false, false]);
  // a settled gate lane says its verdict instead of its keyword
  s = add(s, e, [finished('angela', 'm1', null, 'TEST_FAILED'), ['gate_result', { agent: 'angela', instanceId: 'angela-m1', milestoneId: 'm1', cycle: 1, stage: 1, result: 'failed', keyword: 'TEST_FAILED' }]]);
  const angela = teamAgents(s).find((a) => a.id === 'angela-m1');
  assert.deepEqual([angela.line, angela.gate], ['Tests failed · cycle 1', 'failed']);
  assert.deepEqual(teamAgents(null), []);
  assert.deepEqual(teamAgents(createState()), []);
});

// ------------------------------------------------------------ the /live merge and its staleness rule

const LIVE = (over = {}) => ({
  v: 1, runId: RUN, updatedAt: new Date(T0).toISOString(),
  instances: {
    'dwight-m1': { agent: 'dwight', phase: 'thinking', thinking: 'The flag parser needs a second pass.', thinkingCut: false, text: null, textCut: false, updatedAt: 'x' },
    'angela-m1': { agent: 'angela', phase: 'text', thinking: null, thinkingCut: false, text: 'Running the suite now.', textCut: true, updatedAt: 'x' },
  },
  ...over,
});

test('parseLive: only the contract shape, tails cleaned and bounded from the end', () => {
  assert.equal(parseLive(null), null);
  assert.equal(parseLive({ v: 1 }), null);
  assert.deepEqual(parseLive({ v: 1, runId: null, updatedAt: null, instances: {} }), { runId: null, updatedAt: null, instances: {} });
  const long = `start ${'x'.repeat(TAIL_MAX)} END`;
  const doc = parseLive({ runId: RUN, instances: {
    a: { agent: 'dwight', phase: 'dancing', thinking: `a\u202Eb\u0007c\r\nd`, text: long },
    b: 'nope', c: { agent: 'angela', phase: 'tool', thinking: '   ', text: 42 },
  } });
  assert.deepEqual(Object.keys(doc.instances), ['a', 'c']);
  assert.equal(doc.instances.a.phase, 'idle', 'an unknown phase is idle');
  assert.deepEqual(doc.instances.a.thinking, { body: 'abc\nd', cut: false }, 'bidi and control characters go, line ends are unified');
  assert.equal(doc.instances.a.text.body.length, TAIL_MAX);
  assert.ok(doc.instances.a.text.body.endsWith(' END'), 'the newest text is kept');
  assert.equal(doc.instances.a.text.cut, true);
  assert.deepEqual([doc.instances.c.thinking, doc.instances.c.text], [null, null], 'blank and non-text are none');
});

test('a tail is shown only for the run on screen, while its instance is active, and while the answer is fresh', () => {
  const { e, state } = working();
  const now = T0 + 60_000;
  const live = { doc: parseLive(LIVE()), at: now - 1000 };
  const view = teamRunView({ state, live, now });
  const dwight = view.agents.find((a) => a.id === 'dwight-m1');
  assert.deepEqual(dwight.text, { kind: 'reasoning', label: 'Reasoning', body: 'The flag parser needs a second pass.', cut: false });
  assert.equal(dwight.note, '');
  assert.equal(dwight.line, 'Editing src/cli.js', 'the journal says what it does; the live text stands under it');
  const angela = view.agents.find((a) => a.id === 'angela-m1');
  assert.deepEqual(angela.text, { kind: 'answer', label: 'Answer', body: 'Running the suite now.', cut: true });
  assert.equal(angela.note, NO_REASONING, 'a model without reasoning is said once, as a note');
  assert.equal(angela.line, 'Writing', 'thinking, and the model is writing its answer');
  assert.equal(view.agents.find((a) => a.id === 'michael-plan').text, null, 'a waiting instance has no tail');

  // another run's answer
  assert.equal(liveTails({ doc: parseLive(LIVE({ runId: 'run-other' })), at: now }, RUN, now), null);
  assert.equal(teamRunView({ state, live: { doc: parseLive(LIVE({ runId: 'run-other' })), at: now }, now }).agents.find((a) => a.id === 'dwight-m1').text, null);
  // an answer the page got too long ago (the poll stopped answering)
  assert.ok(liveTails({ doc: live.doc, at: now - LIVE_STALE_MS }, RUN, now), 'still fresh at the bound');
  assert.equal(liveTails({ doc: live.doc, at: now - LIVE_STALE_MS - 1 }, RUN, now), null);
  assert.equal(teamRunView({ state, live: { doc: live.doc, at: now - 60_000 }, now }).agents.find((a) => a.id === 'dwight-m1').text, null);
  // no answer at all (a server without /live): the lines still come from the journal
  const plain = teamRunView({ state, live: null, now });
  assert.deepEqual(plain.agents.map((a) => [a.line, a.text, a.note]), [['Overseeing', null, ''], ['Editing src/cli.js', null, ''], ['Thinking', null, '']]);

  // the instance is no longer active in the reducer state: its tail is not shown although the file still has it
  const done = add(state, e, [finished('dwight', 'm1', { input: 1, output: 1, cost: 0 })]);
  assert.equal(teamRunView({ state: done, live, now }).agents.find((a) => a.id === 'dwight-m1').text, null);
  // a run that is over shows none, whatever the poll last said
  const over = add(done, e, [['run_finished', { status: 'success', summary: 'ok' }]]);
  const ended = teamRunView({ state: over, live, now });
  assert.equal(ended.live, false);
  assert.ok(ended.agents.every((a) => a.text === null && !a.live));
  assert.equal(teamRunView({ state: interruptedView(state, { at: null, exitCode: 1 }), live, now }).live, false, 'nor one whose process exited');

  // reasoning that gave way to the answer: the newest text wins, and nothing claims there was no reasoning
  const both = parseLive(LIVE({ instances: { 'dwight-m1': { agent: 'dwight', phase: 'text', thinking: 'Plan.', text: 'Done: the parser is fixed.' } } }));
  const d2 = teamRunView({ state, live: { doc: both, at: now }, now }).agents.find((a) => a.id === 'dwight-m1');
  assert.deepEqual([d2.text.kind, d2.text.body, d2.note], ['answer', 'Done: the parser is fixed.', '']);
});

// ------------------------------------------------------------ board: Team

const column = (s, id) => milestoneColumn(s, s.milestones.find((m) => m.id === id));

test('team board: every rule of contract section 5, first match wins', () => {
  const { e, state } = started();
  assert.deepEqual(BOARD_COLUMNS.map((c) => c.id), ['todo', 'in_progress', 'in_review', 'blocked', 'done']);
  // 5: pending -> todo, with the dependency noted
  assert.deepEqual(column(state, 'm1'), { column: 'todo', word: 'pending' });
  assert.deepEqual(column(state, 'm2'), { column: 'todo', word: 'waiting' });
  assert.equal(teamBoard(state).columns[0].cards.find((c) => c.id === 'm2').note, 'waiting on m1');

  // 4: active with the developer at work -> in progress
  let s = add(state, e, [['milestone_started', { milestoneId: 'm1', title: 'Storage', index: 0, total: 3 }], lane('dwight', 'm1'), status('dwight', 'm1', 'working', 'Working...')]);
  assert.deepEqual(column(s, 'm1'), { column: 'in_progress', word: 'in progress' });
  // 3: the developer finished the cycle and gate results are still out -> in review, before any gate started
  s = add(s, e, [finished('dwight', 'm1', { input: 1, output: 1, cost: 0 })]);
  assert.deepEqual(column(s, 'm1'), { column: 'in_review', word: 'in review' });
  // 3: a gate instance runs
  s = add(s, e, [lane('oscar', 'm1'), status('oscar', 'm1', 'working', 'Reviewing')]);
  assert.deepEqual(column(s, 'm1'), { column: 'in_review', word: 'in review' });
  let card = teamBoard(s).columns[2].cards[0];
  assert.deepEqual(card.agents.map((a) => [a.id, a.status, a.line]), [['dwight-m1', 'idle', 'Finished: TASK_COMPLETE'], ['oscar-m1', 'working', 'Reviewing']]);
  assert.deepEqual(card.gates, [{ id: 'oscar', name: 'Oscar', result: 'running' }, { id: 'angela', name: 'Angela', result: 'pending' }]);
  assert.deepEqual([card.attempt, card.failed], [1, 0]);

  // the cycle failed and the developer redoes the work: the card really moves back
  s = add(s, e, [
    finished('oscar', 'm1', null, 'CHANGES_REQUESTED'),
    ['gate_result', { agent: 'oscar', instanceId: 'oscar-m1', milestoneId: 'm1', cycle: 1, stage: 0, result: 'failed', keyword: 'CHANGES_REQUESTED' }],
    ['cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: 'Oscar requested changes' }],
  ]);
  assert.deepEqual(column(s, 'm1'), { column: 'in_progress', word: 'in progress' }, 'between the verdict and the retry it is the developer\'s again');
  card = teamBoard(s).columns[1].cards[0];
  assert.deepEqual([card.attempt, card.failed, card.reason], [1, 1, 'Oscar requested changes']);
  assert.deepEqual(card.gates[0], { id: 'oscar', name: 'Oscar', result: 'failed' });
  s = add(s, e, [status('dwight', 'm1', 'thinking', 'Thinking...')]);
  assert.deepEqual(column(s, 'm1'), { column: 'in_progress', word: 'in progress' });
  card = teamBoard(s).columns[1].cards[0];
  assert.deepEqual([card.attempt, card.failed], [2, 1]);
  assert.deepEqual(card.gates.map((g) => g.result), ['pending', 'pending'], 'the verdict of cycle 1 does not speak for cycle 2');

  // 2: one of its instances is blocked
  const blocked = add(s, e, [status('dwight', 'm1', 'blocked', 'no model')]);
  assert.deepEqual(column(blocked, 'm1'), { column: 'blocked', word: 'blocked' });
  // 2: the breaker tripped, and the question names the milestone
  const tripped = add(s, e, [['circuit_breaker', { state: 'tripped', failedCycles: 3, maxFailedCycles: 3 }]]);
  assert.deepEqual(column(tripped, 'm1'), { column: 'blocked', word: 'breaker tripped' });
  const asked = add(s, e, [['hitl_request', { milestoneId: 'm1', reason: 'Three cycles failed.\nSee the log.', options: ['retry'] }]]);
  assert.deepEqual(column(asked, 'm1'), { column: 'blocked', word: 'needs you' });
  assert.deepEqual(teamBoard(asked).notice, { text: 'Waiting for your answer: Three cycles failed.', loud: true });
  assert.equal(teamBoard(asked).columns[3].cards[0].loud, true);
  // a question about another milestone does not block this one
  const other = add(s, e, [['hitl_request', { milestoneId: 'm9', reason: 'x', options: [] }]]);
  assert.equal(column(other, 'm1').column, 'in_progress');

  // 1 and 2: the final states
  s = add(s, e, [['milestone_finished', { milestoneId: 'm1', status: 'passed' }]]);
  assert.deepEqual(column(s, 'm1'), { column: 'done', word: 'passed' });
  assert.deepEqual(column(s, 'm2'), { column: 'todo', word: 'queued' }, 'its prerequisite passed');
  // a milestone that is over has no gate "not run yet": only results it recorded for its last cycle are shown
  assert.deepEqual(teamBoard(s).columns[4].cards[0].gates, [], 'a journal without gate_result for the passing cycle says nothing');
  const judged = add(s, e, [['gate_result', { agent: 'angela', milestoneId: 'm1', cycle: 2, stage: 1, result: 'passed', keyword: 'TEST_PASSED' }]]);
  assert.deepEqual(teamBoard(judged).columns[4].cards[0].gates, [{ id: 'angela', name: 'Angela', result: 'passed' }]);
  for (const [st, col] of [['skipped', 'done'], ['failed', 'blocked'], ['aborted', 'blocked'], ['blocked', 'blocked']]) {
    const end = add(s, e, [['milestone_finished', { milestoneId: 'm2', status: st, reason: 'why' }]]);
    assert.deepEqual(column(end, 'm2'), { column: col, word: st }, st);
  }
  const skipped = teamBoard(add(s, e, [['milestone_finished', { milestoneId: 'm2', status: 'skipped', reason: 'human skipped it' }]]));
  assert.deepEqual([skipped.columns[4].cards.map((c) => [c.id, c.state]), skipped.counts], [[['m1', 'passed'], ['m2', 'skipped']], { todo: 1, in_progress: 0, in_review: 0, blocked: 0, done: 2 }]);
  assert.equal(skipped.columns[4].cards[1].reason, 'human skipped it');
  // a run whose process exited: its active milestone is not shown as going on
  const gone = interruptedView(add(state, e, [['milestone_started', { milestoneId: 'm1', title: 'Storage', index: 0, total: 3 }]]), { at: null, exitCode: 1 });
  assert.deepEqual(column(gone, 'm1'), { column: 'blocked', word: 'interrupted' });
  assert.equal(teamBoard(gone).notice.text, 'The run process exited before the run finished.');
});

test('team board: a serial run without lanes is read from its roles; empty states say why', () => {
  const e = journal();
  let s = reduceAll([
    e('run_started', { request: 'x', workspace: 'C:\\ws' }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One' }] }),
    e('milestone_started', { milestoneId: 'm1', title: 'One', index: 0, total: 1 }),
    e('agent_status', { agent: 'dwight', status: 'working', activity: 'Working...' }),
  ]);
  assert.equal(column(s, 'm1').column, 'in_progress');
  s = add(s, e, [['agent_finished', { agent: 'dwight', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 1, usage: { input: 1, output: 1, cost: 0 } }]]);
  assert.equal(column(s, 'm1').column, 'in_review', 'handed over, the tests are still out');
  s = add(s, e, [['agent_status', { agent: 'angela', status: 'working', activity: 'Testing' }]]);
  assert.equal(column(s, 'm1').column, 'in_review');
  assert.equal(teamBoard(s).total, 1);

  assert.deepEqual([teamBoard(null).total, teamBoard(null).empty], [0, 'No run yet']);
  const planning = reduceAll([journal()('run_started', { request: 'x' })]);
  assert.equal(teamBoard(planning).empty, 'Waiting for the plan...');
  const answered = reduce(planning, { v: 1, seq: 2, ts: 'x', runId: RUN, type: 'run_finished', status: 'success', summary: 'Answered by Michael' });
  assert.equal(teamBoard(answered).empty, 'This run had no milestones.');
  assert.equal(boardSummary(teamBoard(answered)), 'This run had no milestones.');
});

// ------------------------------------------------------------ board and agents: Pipeline

const PLAN = parsePlan({ summary: 'Fix it', steps: [
  { id: 's1', title: 'Parse flags', description: 'd', files: [{ path: 'a.py', action: 'modify' }], criteria: ['c1'] },
  { id: 's2', title: 'Handle empty input', files: [] },
  { id: 's3', title: 'Docs', files: [] },
] });
function pstatus(over = {}) {
  return parseStatus({
    schema: 1, run_id: 'abc123def456', status: 'running', phase: 'implement', node: 'verify', task: 'Fix the parser', source_dir: 'C:\\code\\app',
    progress: { step_index: 1, step_count: 3, step_title: 'Handle empty input', attempt: 2, review_round: 0, steps_done: 1 },
    pending: null, failure: null, usage: { calls: 4, input_tokens: 12400, output_tokens: 1800, estimated_cost: 0.031 },
    checks: [{ id: 'unit', kind: 'test', status: 'failed', required: true }], created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:05:00Z',
    ...over,
  });
}
const prun = (over = {}, more = {}) => ({ runId: 'abc123def456', status: pstatus(over), plan: PLAN, events: [], ...more });
const pcols = (run) => Object.fromEntries(pipelineBoard(run).columns.map((c) => [c.id, c.cards.map((x) => `${x.id}:${x.state}`)]));

test('pipeline board: every rule of contract section 5, from stepsDone', () => {
  // 2, 3, 4: implemented but not delivered, the current step, the rest
  const run = prun({}, { stepsDone: ['s1'] });
  assert.deepEqual(pcols(run), { todo: ['s3:to do'], in_progress: ['s2:in progress'], in_review: ['s1:implemented'], blocked: [], done: [] });
  const b = pipelineBoard(run);
  const current = b.columns[1].cards[0];
  assert.deepEqual(current.agents, [{ id: 'implementer', status: 'working', line: 'Running the checks for step 2/3: Handle empty input (attempt 2)' }]);
  assert.deepEqual([current.attempt, current.failed], [2, 1]);
  assert.deepEqual(current.gates, [{ id: 'unit', name: 'unit', result: 'failed' }], 'the checks of the step in flight');
  assert.equal(b.columns[2].cards[0].note, '1 file');
  assert.equal(b.note, '', 'ids from the server need no caveat');
  assert.equal(b.notice, null);
  assert.equal(boardSummary(b), '1 in progress · 1 in review · 0 of 3 done');

  // 3: the run stopped -> the step in flight is blocked, with the precise word
  assert.deepEqual(pcols(prun({ status: 'suspended' }, { stepsDone: ['s1'] })).blocked, ['s2:suspended']);
  const failed = pipelineBoard(prun({ status: 'failed', failure: { failure_class: 'checks', code: 'x', message: 'unit failed twice' } }, { stepsDone: ['s1'] }));
  assert.deepEqual(failed.columns[3].cards.map((c) => [c.id, c.state, c.reason, c.loud]), [['s2', 'failed', 'unit failed twice', true]]);

  // 1: delivered -> done; reviewed but not delivered stays in review
  assert.deepEqual(pcols(prun({ phase: 'review', node: 'review' }, { stepsDone: ['s1', 's2', 's3'] })).in_review, ['s1:implemented', 's2:implemented', 's3:implemented']);
  for (const phase of ['deliver', 'done']) {
    assert.deepEqual(pcols(prun({ phase, status: phase === 'done' ? 'succeeded' : 'running' }, { stepsDone: ['step:s1', 's2', 's3'] })).done, ['s1:done', 's2:done', 's3:done'], phase);
  }
  // a parallel wave: a step is in progress because it is in a lane
  const wave = prun({ progress: { step_index: 0, step_count: 3, lanes: [{ step_id: 's1', title: 'Parse flags', state: 'running', attempt: 1 }, { step_id: 's2', title: 'Handle empty input', state: 'failed', attempt: 2 }] } }, { stepsDone: [] });
  assert.deepEqual(pcols(wave), { todo: ['s3:to do'], in_progress: ['s1:in progress', 's2:lane failed'], in_review: [], blocked: [], done: [] });
  assert.equal(pipelineBoard(wave).columns[1].cards[1].loud, true);

  // waiting for approval is a notice on the board, not a column move
  const gate = pipelineBoard(prun({ status: 'awaiting_approval', phase: 'approve_plan', node: 'approve_plan', pending: { gate: 'plan', digest: 'abc', revision: 0 }, progress: { step_index: -1, step_count: 3 } }, { stepsDone: [] }));
  assert.deepEqual(gate.notice, { loud: true, text: 'The plan waits for your approval.' });
  assert.deepEqual(gate.counts, { todo: 3, in_progress: 0, in_review: 0, blocked: 0, done: 0 });
  assert.equal(pipelineBoard(prun({ status: 'awaiting_approval', phase: 'deliver', pending: { gate: 'delivery', digest: 'abc' } }, { stepsDone: ['s1', 's2', 's3'] })).notice.text, 'The changes wait for your decision.');

  assert.equal(pipelineBoard(null).empty, 'No run yet');
  assert.equal(pipelineBoard({ runId: 'x', status: pstatus({ phase: 'plan' }), plan: null, events: [] }).empty, 'Waiting for the plan...');
  assert.equal(pipelineBoard({ runId: 'x', status: pstatus({ status: 'succeeded', phase: 'done' }), plan: null, events: [] }).empty, 'This run had no steps.');
});

test('pipeline board: without stepsDone the done steps come from the events and the status, with one quiet note', () => {
  // an older server: the steps before the current one, in plan order
  const run = prun();
  assert.deepEqual(doneSteps(run), ['s1']);
  assert.deepEqual(pcols(run).in_review, ['s1:implemented']);
  assert.equal(pipelineBoard(run).note, 'Step states are approximate for this run.');
  // a wave: what its merge event and the lanes name
  const wave = prun({ progress: { step_index: 0, step_count: 3, lanes: [{ step_id: 's3', state: 'merged' }] } }, { events: [{ seq: 9, type: 'wave_merged', data: { wave: 1, merged: ['s1'], failed: ['s2'] } }] });
  assert.deepEqual(doneSteps(wave), ['s1', 's3']);
  // after the implementation every step is done
  assert.deepEqual(doneSteps(prun({ phase: 'review' })), ['s1', 's2', 's3']);
  const ended = prun({ status: 'succeeded', phase: 'done' });
  assert.deepEqual(pcols(ended).done, ['s1:done', 's2:done', 's3:done']);
  assert.equal(pipelineBoard(ended).note, '', 'a finished run is not a guess');

  // the server derived them itself while the run is going (contract 1.2): the same single note, no mark per card
  const derived = pipelineBoard(prun({}, { stepsDone: ['s1'], stepsDoneExact: false }));
  assert.equal(derived.note, 'Step states are approximate for this run.');
  assert.ok(derived.columns.flatMap((c) => c.cards).every((c) => !/approx/i.test(JSON.stringify(c))));
  assert.equal(pipelineBoard(prun({}, { stepsDone: ['s1'], stepsDoneExact: true })).note, '');
  // parseRunDoc reads both; absent means exact, and no list means "derive"
  const doc = (extra) => parseRunDoc({ status: { run_id: 'abc123def456', status: 'running' }, events: [], ...extra });
  assert.deepEqual([doc({}).stepsDone, doc({}).stepsDoneExact], [null, true]);
  assert.deepEqual([doc({ stepsDone: ['s1', 7, ''], stepsDoneExact: false }).stepsDone, doc({ stepsDone: [], stepsDoneExact: false }).stepsDoneExact], [['s1'], false]);
});

test('pipeline agents: the three roles, the current step, and the latest message where no live text is sent', () => {
  const events = [
    { seq: 3, ts: '2026-11-09T10:00:10Z', type: 'agent_message', lane: null, data: { role: 'planner', text: 'Plan: three steps.' } },
    { seq: 5, ts: '2026-11-09T10:01:00Z', type: 'edits_applied', lane: null, data: { files: ['a.py', 'b.py'] } },
    { seq: 6, ts: '2026-11-09T10:01:10Z', type: 'agent_message', lane: null, data: { role: 'implementer', text: 'Parsed the flags.' } },
    { seq: 8, ts: '2026-11-09T10:02:00Z', type: 'edits_applied', lane: null, data: { files: ['b.py', 'c.py'] } },
  ];
  const run = prun({}, { events, stepsDone: ['s1'] });
  const agents = pipelineAgents(run);
  assert.deepEqual(agents.map((a) => [a.id, a.name, a.role, a.status, a.line]), [
    ['planner', 'Planner', 'Planning', 'done', 'Done'],
    ['implementer', 'Implementer', 'Implementation', 'working', 'Running the checks for step 2/3: Handle empty input (attempt 2)'],
    ['reviewer', 'Reviewer', 'Review', 'idle', 'Not started'],
  ]);
  assert.deepEqual(agents[1].text, { kind: 'message', label: 'Latest message', body: 'Parsed the flags.', cut: false });
  assert.deepEqual(agents[1].files.map((f) => [f.path, f.kind]), [['b.py', 'edit'], ['c.py', 'edit'], ['a.py', 'edit']], 'newest first, each once');
  assert.deepEqual([agents[0].text.body, agents[0].files, agents[2].text], ['Plan: three steps.', [], null]);

  // liveText (contract section 4): the reasoning of the role at work, as for the team
  const liveText = parseLive({ runId: 'abc123def456', instances: { implementer: { agent: 'implementer', phase: 'thinking', thinking: 'Empty input must not raise.', text: null } } });
  const now = Date.now();
  const view = pipelineRunView({ run: { ...run, liveText, liveAt: now }, now });
  assert.deepEqual(view.agents[1].text, { kind: 'reasoning', label: 'Reasoning', body: 'Empty input must not raise.', cut: false });
  assert.equal(view.agents[0].text.kind, 'message', 'the planner is not at work: its latest message stays');
  assert.equal(pipelineRunView({ run: { ...run, liveText, liveAt: now - LIVE_STALE_MS - 1 }, now }).agents[1].text.kind, 'message', 'a stale tail gives way to the message');
  assert.equal(view.live, true);

  const at = (over) => pipelineAgents(prun(over, { events })).map((a) => `${a.id} ${a.status}: ${a.line}`);
  assert.equal(at({ phase: 'plan', node: 'plan_context', progress: { step_index: -1 } })[0], 'planner working: Reading the project for the plan');
  assert.equal(at({ phase: 'review', node: 'review', progress: { review_round: 2 } })[2], 'reviewer working: Reviewing the changes (round 2)');
  assert.equal(at({ status: 'awaiting_approval', phase: 'approve_plan', pending: { gate: 'plan', digest: 'd' } })[0], 'planner waiting: Waiting for your approval of the plan');
  assert.equal(at({ status: 'failed', failure: { message: 'unit failed twice' } })[1], 'implementer error: Failed: unit failed twice');
  assert.ok(pipelineAgents(prun({ status: 'succeeded', phase: 'done' }, { events })).every((a) => !a.live));
  // one implementer per lane of a wave, each with what it said in that lane
  const wave = pipelineAgents(prun({ progress: { step_index: 0, step_count: 3, lanes: [{ step_id: 's1', title: 'Parse flags', state: 'running', attempt: 1 }, { step_id: 's2', title: 'Handle empty input', state: 'passed' }] } }, {
    events: [...events, { seq: 20, ts: 'x', type: 'agent_message', lane: 's1', data: { role: 'implementer', text: 'Lane one.' } }],
  }));
  assert.deepEqual(wave.map((a) => [a.id, a.role, a.status, a.line]).slice(1, 3), [
    ['implementer:s1', 'Implementation · s1', 'working', 'Implementing Parse flags'], ['implementer:s2', 'Implementation · s2', 'done', 'passed, waiting for the merge'],
  ]);
  assert.deepEqual([wave[1].text.body, wave[2].text], ['Lane one.', null]);
  assert.deepEqual(pipelineAgents(null), []);
});

// ------------------------------------------------------------ usage

test('team usage: the run, the agents with their share, and the chat total from the run list', () => {
  const { e, state } = started([lane('dwight', 'm1'), lane('angela', 'm1')]);
  const s = add(state, e, [usage('dwight', 'm1', { input: 300, output: 100, cost: 0.03 }), usage('angela', 'm1', { input: 80, output: 20, cost: 0.01 })]);
  const runs = parseRuns({ runs: [
    { runId: 'r-old', goal: 'a', status: 'success', usage: { tokens: 1000, cost: 0.1 } },
    { runId: 'r-older', goal: 'b', status: 'success' },
    { runId: RUN, goal: 'c', status: 'running', current: true, usage: { tokens: 1, cost: 1 } },
  ] });
  assert.deepEqual(runs.map((r) => r.usage), [{ tokens: 1000, cost: 0.1 }, null, { tokens: 1, cost: 1 }]);
  const u = teamRunView({ state: s, runs }).usage;
  assert.deepEqual(u.run, { cost: 0.04, tokens: 500, input: 380, output: 120, calls: 2, estimated: false });
  assert.deepEqual(u.agents.map((a) => [a.id, a.name, a.calls, a.tokens, a.cost, Math.round(a.share * 100)]), [['dwight', 'Dwight', 1, 400, 0.03, 75], ['angela', 'Angela', 1, 100, 0.01, 25]]);
  assert.deepEqual(u.chat, { tokens: 1500, cost: 0.14, runs: 2, of: 3, estimated: false }, 'the run on screen counts as it stands now, not as the list last knew it');
  assert.deepEqual(u.series.map((p) => [p.at - T0, p.tokens, p.cost]), [[5000, 400, 0.03], [6000, 500, 0.04]]);
  assert.equal(u.startedAt, T0 + 5000);

  // a server from before the field: no chat total at all, rather than a wrong one
  assert.equal(teamRunView({ state: s, runs: parseRuns({ runs: [{ runId: 'r-old', goal: 'a' }, { runId: RUN, goal: 'c', current: true }] }) }).usage.chat, null);
  // one run in the chat: its total is the chat's
  assert.deepEqual(teamRunView({ state: s, runs: [] }).usage.chat, { tokens: 500, cost: 0.04, runs: 1, of: 1, estimated: false });
  assert.equal(usageFigures(teamRunView({ state: s, runs: [] }).usage).chat, null, 'which the figures do not say twice');
  // no cost at all: the share is by tokens
  const free = add(state, e, [usage('dwight', 'm1', { input: 30, output: 0, cost: 0 }), usage('angela', 'm1', { input: 10, output: 0, cost: 0 })]);
  assert.deepEqual(teamRunView({ state: free }).usage.agents.map((a) => a.share), [0.75, 0.25]);
  const none = teamRunView({ state: createState() }).usage;
  assert.deepEqual([none.run.tokens, none.agents, none.series, none.chat], [0, [], [], null]);
});

test('pipeline usage: the server\'s series when it sends one, else the calls folded here with the engine\'s own total', () => {
  // an older server: tokens from the llm_call events, the cost from status.usage, marked as an estimate
  let calls = foldCalls(null, [
    { seq: 1, ts: '2026-11-09T10:00:00Z', type: 'node_started', data: {} },
    { seq: 2, ts: '2026-11-09T10:00:05Z', type: 'llm_call', data: { role: 'planner', model: 'm', ok: true, input_tokens: 9000, output_tokens: 1000 } },
  ]);
  const first = calls;
  calls = foldCalls(calls, [{ seq: 3, ts: '2026-11-09T10:01:05Z', type: 'llm_call', data: { role: 'implementer', input_tokens: 3400, output_tokens: 800 } }]);
  assert.equal(first.calls, 1, 'folding again does not change what was folded');
  assert.equal(foldCalls(calls, [{ seq: 4, type: 'route', data: {} }]), calls, 'nothing to fold: the same object, so nothing is drawn again');
  const run = prun({}, { calls });
  const u = pipelineRunView({ run, list: parseRunList({ active: null, runs: [{ runId: 'aaaaaaaa', status: 'succeeded', usage: { tokens: 2000, cost: 0.02, estimated: true } }, { runId: 'abc123def456', status: 'running' }] }) }).usage;
  assert.deepEqual(u.run, { cost: 0.031, tokens: 14200, input: 12400, output: 1800, calls: 4, estimated: true });
  assert.deepEqual(u.agents.map((a) => [a.id, a.name, a.tokens, a.cost]), [['planner', 'Planner', 10000, null], ['implementer', 'Implementer', 4200, null]]);
  assert.equal(calls.cost, null, 'llm_call-only fallback has no run price of its own');
  assert.ok(calls.series.every((p) => p.cost === null && Object.values(p.byAgent).every((a) => a.cost === null)), 'unknown prices, not free calls');
  assert.deepEqual(u.series.map((p) => [p.tokens, p.cost]), [[10000, null], [14200, null]], 'no cost per call: the diagram has tokens only');
  assert.equal(u.costSeries, false);
  assert.deepEqual({ ...u.chat, cost: Math.round(u.chat.cost * 1e6) / 1e6 }, { tokens: 16200, cost: 0.051, runs: 2, of: 2, estimated: true });
  assert.deepEqual(usageFigures(u), {
    cost: '~$0.031', tokens: '14.2k tokens', estimated: true, sub: 'in 12.4k · out 1.8k · 4 model calls',
    chat: { cost: '~$0.051', tokens: '16.2k tokens', sub: '2 runs' },
  });
  // a list without usage (an older server): no chat total
  assert.equal(pipelineRunView({ run, list: parseRunList({ active: null, runs: [{ runId: 'aaaaaaaa', status: 'succeeded' }, { runId: 'abc123def456', status: 'running' }] }) }).usage.chat, null);
  assert.equal(usageFigures(pipelineRunView({ run: prun({ usage: { calls: 1, input_tokens: 5, output_tokens: 5, estimated_cost: null } }) }).usage).cost, 'not reported');

  // the server's usage (contract section 4): its series with cost per call, estimated as it says
  const reported = parseUsage({
    input: 12400, output: 1800, cost: 0.03, tokens: 14200, calls: 4, startedAt: '2026-11-09T10:00:00Z', estimated: true,
    byAgent: { planner: { input: 9000, output: 1000, cost: 0.02, tokens: 10000, calls: 1 }, implementer: { input: 3400, output: 800, cost: 0.01, tokens: 4200, calls: 3 }, __proto__: { x: 1 } },
    series: [{ ts: '2026-11-09T10:00:05Z', tokens: 10000, cost: 0.02, byAgent: { planner: { tokens: 10000, cost: 0.02 } } }, { ts: 'never', tokens: 14200, cost: 0.03, byAgent: { planner: { tokens: 10000, cost: 0.02 }, implementer: { tokens: 4200, cost: 0.01 } } }, 'junk'],
  });
  const exact = pipelineRunView({ run: prun({}, { usage: reported, calls: null }) }).usage;
  assert.deepEqual(exact.run, { cost: 0.03, tokens: 14200, input: 12400, output: 1800, calls: 4, estimated: true });
  assert.deepEqual([exact.costSeries, exact.series.length, exact.series[1].at], [true, 2, exact.series[0].at], 'a point without a usable time stands at the one before it');
  // where the points carry no cost the total is the engine's
  const noCost = parseUsage({ input: 1, output: 1, cost: null, tokens: 2, calls: 1, byAgent: {}, series: [{ ts: '2026-11-09T10:00:05Z', tokens: 2, cost: null, byAgent: {} }] });
  assert.equal(pipelineRunView({ run: prun({}, { usage: noCost }) }).usage.run.cost, 0.031);
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage('x'), null);
});

// ------------------------------------------------------------ the diagram's geometry

function chartUsage(n = 4, agents = ['dwight', 'angela']) {
  const { e, state } = started(agents.map((a) => lane(a, 'm1')));
  let s = state;
  for (let i = 0; i < n; i += 1) s = reduce(s, e(...usage(agents[i % agents.length], 'm1', { input: 900, output: 100, cost: 0.01 })));
  return teamRunView({ state: s }).usage;
}

test('chartModel: cumulative steps, stacked by agent, with a total, ticks, a readout per point and a table', () => {
  const u = chartUsage();
  const m = chartModel(u, { metric: 'cost', width: 320, height: 150 });
  assert.equal(m.empty, undefined);
  assert.deepEqual(m.bands.map((b) => [b.id, b.name, b.tone, b.label]), [['dwight', 'Dwight', 0, '$0.020'], ['angela', 'Angela', 1, '$0.020']]);
  assert.equal(m.total.label, '$0.040');
  assert.deepEqual(m.yTicks.map((t) => t.label), ['$0.00', '$0.020', '$0.040']);
  assert.equal(m.yTicks[0].y, m.plot.bottom, 'zero is the baseline');
  assert.equal(m.yTicks.at(-1).y, m.plot.top);
  // Like the server ledger, the time axis begins at the first model call, not run_started.
  assert.deepEqual(m.xTicks.map((t) => t.label), ['0s', '1s', '2s', '3s']);
  // a step line: it runs level to each call, then rises; nothing slopes
  const cmds = m.total.d.match(/[ML][\d. ]+/g).map((c) => c.slice(1).split(' ').map(Number));
  for (let i = 1; i < cmds.length; i += 1) assert.ok(cmds[i][0] === cmds[i - 1][0] || cmds[i][1] === cmds[i - 1][1], `segment ${i} is level or upright`);
  assert.deepEqual(cmds[0], [m.plot.left, m.plot.bottom], 'from zero at the start of the run');
  assert.equal(cmds.at(-1)[0], m.plot.right);
  for (const b of m.bands) assert.match(b.d, /^M[\d. ]+(L[\d. ]+)+Z$/, 'a closed area');
  assert.deepEqual(m.points.map((p) => p.text), [
    '0s · $0.010 total · Dwight $0.010', '1s · $0.020 total · Dwight $0.010 · Angela $0.010',
    '2s · $0.030 total · Dwight $0.020 · Angela $0.010', '3s · $0.040 total · Dwight $0.020 · Angela $0.020',
  ]);
  assert.ok(m.points.every((p, i) => !i || (p.x > m.points[i - 1].x && p.y < m.points[i - 1].y)), 'later and higher');
  assert.equal(m.summary, 'Cumulative cost over 3s: $0.040 (Dwight $0.020, Angela $0.020)');
  assert.equal(m.latest, '$0.040 after 3s');
  assert.deepEqual([m.columns, m.rows.at(-1)], [['Dwight', 'Angela'], { time: '3s', total: '$0.040', parts: ['$0.020', '$0.020'] }]);

  const tok = chartModel(u, { metric: 'tokens' });
  assert.deepEqual([tok.total.label, tok.yTicks.map((t) => t.label)], ['4.0k', ['0', '2.0k', '4.0k']]);
  // a run that is going: the axis reaches now, and the line runs level to it
  const live = chartModel(u, { metric: 'cost', end: u.series.at(-1).at + 57_000 });
  assert.equal(live.xTicks.at(-1).label, '1m');
  assert.ok(live.points.at(-1).x < live.plot.right);
});

test('chartModel: a real empty state, at most five bands, and a table that stays short', () => {
  assert.deepEqual(chartModel(teamRunView({ state: createState() }).usage, { metric: 'cost' }), { empty: true, metric: 'cost' });
  assert.deepEqual(chartModel(null), { empty: true, metric: 'cost' });
  // a pipeline run without cost per call has nothing to draw as cost, and tokens to draw
  const calls = foldCalls(null, [{ seq: 2, ts: '2026-11-09T10:00:05Z', type: 'llm_call', data: { role: 'planner', input_tokens: 9, output_tokens: 1 } }]);
  const p = pipelineRunView({ run: prun({}, { calls }) }).usage;
  assert.equal(chartModel(p, { metric: 'cost' }).empty, true);
  assert.equal(chartModel(p, { metric: 'tokens' }).total.label, '10');

  const { e, state } = started();
  let s = state;
  const ids = ['michael', 'dwight', 'oscar', 'hank', 'angela', 'seclint', 'docs2'];
  ids.forEach((id, i) => { s = reduce(s, e('agent_usage', { agent: id, instanceId: id, usage: { input: (i + 1) * 100, output: 0, cost: (i + 1) / 100 } })); });
  const many = chartModel(teamRunView({ state: s }).usage, { metric: 'cost' });
  assert.equal(many.bands.length, BANDS_MAX);
  assert.deepEqual(many.bands.map((b) => b.id), ['hank', 'angela', 'seclint', 'docs2', 'other'], 'the four largest keep their band; the rest share one');
  assert.equal(many.bands.at(-1).label, '$0.060');
  const sum = many.bands.reduce((n, b) => n + b.value, 0);
  assert.ok(Math.abs(sum - many.total.value) < 1e-9, 'the bands add up to the total');

  const long = chartModel(chartUsage(100), { metric: 'tokens' });
  assert.ok(long.rows.length <= TABLE_ROWS_MAX + 1, `${long.rows.length} rows`);
  assert.equal(long.rows.at(-1).total, '100.0k', 'the newest point is always in the table');
  assert.deepEqual([niceStep(0.04), niceStep(0.099), niceStep(4000), niceStep(0), niceStep(7)], [0.02, 0.05, 2000, 1, 5]);
  assert.deepEqual([0, 45_000, 120_000, 90_000, 3_900_000, 3_600_000].map(shortTime), ['0s', '45s', '2m', '1m 30s', '1h 5m', '1h']);
});

// ------------------------------------------------------------ the rail's visibility logic

test('railMode: beside the transcript on a wide window, a toggle on a narrow one, nowhere outside the Chat view', () => {
  const base = { view: 'chat', run: true, wide: true, collapsed: false, overlay: false };
  assert.equal(railMode(base), 'open');
  assert.equal(railMode({ ...base, collapsed: true }), 'closed', 'the human closed it');
  assert.equal(railMode({ ...base, wide: false }), 'closed', 'a narrow window starts with the toggle alone');
  assert.equal(railMode({ ...base, wide: false, overlay: true }), 'overlay');
  assert.equal(railMode({ ...base, wide: false, collapsed: true, overlay: true }), 'overlay', 'the choice of the wide layout does not lock the drawer');
  assert.equal(railMode({ ...base, overlay: true }), 'open', 'a window that grew wide shows it beside the transcript again');
  assert.equal(railMode({ ...base, view: 'dashboard' }), 'none', 'the dashboard has its own panels');
  assert.equal(railMode({ ...base, run: false }), 'none', 'nothing to show before the first run');
  assert.equal(railMode({ ...base, view: 'dashboard', wide: false, overlay: true }), 'none');
  // only a stored 'closed' closes it: the rail is there by default
  assert.deepEqual([parseRailChoice('closed'), parseRailChoice('open'), parseRailChoice(null), parseRailChoice('x')], [true, false, false, false]);
});

test('liveLine: one line while the rail is out of sight and the run is going, nothing otherwise', () => {
  const { e, state } = working();
  const view = teamRunView({ state });
  assert.equal(liveLine(view, 'closed'), 'dwight-m1 · Editing src/cli.js · +1 more');
  assert.equal(liveLine(view, 'open'), '', 'the rail says it');
  assert.equal(liveLine(view, 'overlay'), '');
  assert.equal(liveLine(view, 'none'), '');
  const one = teamRunView({ state: add(state, e, [finished('angela', 'm1', null, 'TEST_PASSED')]) });
  assert.equal(liveLine(one, 'closed'), 'dwight-m1 · Editing src/cli.js');
  // the one that runs a tool leads, whatever the reading order
  const later = teamRunView({ state: add(state, e, [status('dwight', 'm1', 'thinking', 'Thinking...'), tool('angela', 'm1', 'bash', { detail: 'node --test', command: 'node --test' }), status('angela', 'm1', 'working', 'Working...')]) });
  assert.equal(liveLine(later, 'closed'), 'angela-m1 · Running node --test · +1 more');
  const paused = teamRunView({ state: add(state, e, [finished('angela', 'm1', null), finished('dwight', 'm1', null), ['hitl_request', { milestoneId: 'm1', reason: 'Stuck.', options: [] }]]) });
  assert.equal(liveLine(paused, 'closed'), 'Waiting for your answer: Stuck.', 'nobody is busy: what the run waits for');
  const over = teamRunView({ state: add(state, e, [['run_finished', { status: 'success', summary: 'ok' }]]) });
  assert.equal(liveLine(over, 'closed'), '', 'a run that is over has no live line');
  assert.equal(liveLine(null, 'closed'), '');
  assert.equal(agentsSummary(view.agents), '3 active');
  assert.equal(agentsSummary(over.agents), '3 agents');
  assert.equal(agentsSummary(one.agents), '2 active · 1 finished');
  // a gate lane is already up beside the developer: rule 3 comes before rule 4
  assert.equal(boardSummary(view.board), '1 in review · 0 of 3 done');
});

// Review regressions: compare the actual producer fold, not a second hand-written interpretation.
test('usage parity with server: zero calls, legacy finishes, reconciliation and first-call timestamps', () => {
  const e = journal();
  const events = [
    e('run_started', { request: 'x', workspace: 'C:\\ws' }),
    e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 0, output: 0, cost: 0 } }),
    e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 10, output: 2, cost: 0.001 } }),
    // Legacy finish omits instanceId; its milestone-scoped pending sum must still be found.
    e('agent_finished', { agent: 'dwight', milestoneId: 'm1', usage: { input: 15, output: 3, cost: 0.002 } }),
    e('agent_finished', { agent: 'angela', usage: { input: 3, output: 1, cost: 0 } }),
    e('agent_finished', { agent: 'michael', usage: { input: 0, output: 0, cost: 0 } }),
    e('agent_usage', { agent: 'dwight', usage: { input: 2, output: 1, cost: 0 } }),
    e('agent_finished', { agent: 'dwight', usage: { input: 1, output: 5, cost: 0 } }),
    e('agent_finished', { agent: 'michael' }),
    e('run_finished', { status: 'success' }),
  ];
  let client = createState();
  let server = serverState();
  for (const event of events) {
    client = reduce(client, event);
    server = serverReduce(server, event);
    assert.deepEqual(client.usage, server.usage, `usage after ${event.seq}: ${event.type}`);
    assert.deepEqual(client.usagePending, server.usagePending, `pending after ${event.seq}`);
    for (const id of ['michael', 'dwight', 'angela']) {
      for (const key of ['input', 'output', 'cost']) assert.equal(client.agents[id].totals[key], server.agents[id].totals[key], `${id}.${key} after ${event.seq}`);
    }
  }
  assert.equal(client.usage.startedAt, '2026-11-12T09:00:02.000Z');
  assert.equal(client.usage.calls, 4, 'two Dwight reports, one legacy Angela finish, another Dwight report');
  assert.equal(client.usage.series.length, 6, 'two reconciliation points add no calls');
  for (const file of ['./fixtures/serial-events.jsonl', '../../visualizer/public/demo/sample-events.jsonl']) {
    const journalEvents = parseJsonl(readFileSync(new URL(file, import.meta.url), 'utf8'));
    assert.deepEqual(reduceAll(journalEvents).usage, journalEvents.reduce(serverReduce, serverState()).usage, file);
  }
});

test('priced Pipeline ledger with unavailable agent costs uses token shares without inventing costs', () => {
  // Real supervisor shape: estimated run cost, null ledger costs per role and per point.
  const doc = parseRunDoc({ status: {
    run_id: 'abc123def456', status: 'running', phase: 'implement',
    usage: { calls: 2, input_tokens: 320, output_tokens: 80, estimated_cost: 0.031 },
  }, usage: {
    input: 320, output: 80, tokens: 400, calls: 2, cost: 0.031, estimated: true, startedAt: '2026-11-12T09:00:02Z',
    byAgent: { planner: { input: 240, output: 60, tokens: 300, calls: 1, cost: null }, implementer: { input: 80, output: 20, tokens: 100, calls: 1, cost: null } },
    series: [{ ts: '2026-11-12T09:00:03Z', tokens: 400, cost: null, byAgent: { planner: { tokens: 300, cost: null }, implementer: { tokens: 100, cost: null } } }],
  }, events: [] });
  const u = pipelineRunView({ run: { ...doc, runId: 'abc123def456' } }).usage;
  assert.equal(u.shareMetric, 'tokens');
  assert.deepEqual(u.agents.map((a) => [a.share, a.cost]), [[0.75, null], [0.25, null]]);
  assert.equal(u.run.cost, 0.031);
  assert.equal(u.run.estimated, true);
  assert.equal(u.costSeries, false);
});

test('Pipeline cancellation after finalize stops only the implementation role, including retained parallel lanes', () => {
  for (const parallel of [false, true]) {
    const e = (type, node = null, data = {}) => ({ type, node, data });
    const run = prun({ status: 'cancelled', phase: 'done', node: 'finalize', progress: {
      step_index: 1, step_count: 3, attempt: 2,
      lanes: parallel ? [{ step_id: 's2', state: 'running', attempt: 2 }, { step_id: 's3', state: 'running', attempt: 1 }] : [],
    } }, { stepsDone: ['s1'], events: [
      e('agent_message', null, { role: 'planner', text: 'Plan accepted.' }),
      e('agent_message', null, { role: 'implementer', text: 'Checking the edit.' }),
      e('node_started', 'verify'), e('node_finished', 'verify', { duration_s: 0.1 }),
      e('route', null, { from: 'verify', to: 'finalize', reason: 'cancelled' }),
      e('node_started', 'finalize'), e('run_finished', null, { status: 'cancelled' }), e('node_finished', 'finalize', { duration_s: 0.1 }),
    ] });
    const agents = pipelineAgents(run);
    assert.deepEqual(agents.map((a) => [a.id, a.status, a.line, a.busy]), [
      ['planner', 'done', 'Done', false],
      ...(parallel ? ['implementer:s2', 'implementer:s3'] : ['implementer']).map((id) => [id, 'cancelled', 'Cancelled', false]),
      ['reviewer', 'idle', 'Not started', false],
    ]);
    assert.ok(agents.every((a) => !a.live));
    const b = pipelineBoard(run);
    assert.equal(b.columns[1].cards.length, 0);
    assert.equal(b.notice.text, 'The run is cancelled.');
    assert.deepEqual(b.columns[4].cards.map((c) => c.id), ['s1'], 'completed steps keep their existing done precedence');
    if (parallel) assert.deepEqual(b.columns[3].cards.map((c) => [c.id, c.state, c.agents]), [['s2', 'cancelled', []], ['s3', 'cancelled', []]]);
  }
});

for (const terminal of ['cancelled', 'rejected']) test(`Pipeline ${terminal} at plan approval survives final phase done`, () => {
  const e = (type, node = null, data = {}) => ({ type, node, data });
  const run = prun({ status: terminal, phase: 'done', node: 'finalize', pending: null, progress: { step_index: -1, step_count: 3, plan_revision: 1 } }, {
    stepsDone: ['s1'], events: [
      e('agent_message', null, { role: 'implementer', text: 'Earlier step completed.' }),
      e('node_finished', 'verify', { duration_s: 0.1 }), e('node_started', 'replan'), e('node_finished', 'replan', { duration_s: 0.1 }),
      e('node_started', 'plan'), e('agent_message', null, { role: 'planner', text: 'A revised plan.' }), e('node_finished', 'plan', { duration_s: 0.1 }),
      e('route', null, { from: 'plan', to: 'approve_plan', reason: 'plan_valid' }), e('node_started', 'approve_plan'),
      e('gate_waiting', null, { gate: 'plan', digest: 'abc' }), e('run_resumed'), e('node_started', 'approve_plan'),
      ...(terminal === 'rejected' ? [e('gate_decided', null, { gate: 'plan', decision: 'reject', by: 'human' })] : []),
      e('node_finished', 'approve_plan', { duration_s: 0.1 }), e('route', null, { from: 'approve_plan', to: 'finalize', reason: terminal }),
      e('node_started', 'finalize'), e('run_finished', null, { status: terminal }), e('node_finished', 'finalize', { duration_s: 0.1 }),
    ],
  });
  assert.deepEqual(pipelineAgents(run).map((a) => [a.agent, a.status, a.line]), [
    ['planner', terminal, terminal === 'cancelled' ? 'Cancelled' : 'Rejected'], ['implementer', 'done', 'Done'], ['reviewer', 'idle', 'Not started'],
  ], 'only the stopped approval role changes; the earlier completed implementer is not cancelled');
});

for (const terminal of ['failed', 'suspended', 'succeeded']) test(`Pipeline ${terminal} uses work history or failure node rather than finalize`, () => {
  const failure = terminal === 'failed' ? { failure_class: 'llm_output', code: 'output_invalid', message: 'Output repair budget exhausted', node: 'review' } : null;
  const run = prun({ status: terminal, phase: terminal === 'suspended' ? 'review' : 'done', node: terminal === 'suspended' ? 'review' : 'finalize', failure }, { events: [
    { type: 'agent_message', node: null, data: { role: 'planner', text: 'Plan.' } },
    { type: 'agent_message', node: null, data: { role: 'implementer', text: 'Edit.' } },
    { type: 'node_finished', node: 'verify', data: { duration_s: 0.1 } },
    { type: 'agent_message', node: null, data: { role: 'reviewer', text: 'Review.' } },
    ...(terminal === 'suspended' ? [
      { type: 'node_started', node: 'review', data: {} }, { type: 'warning', node: null, data: { code: 'suspended', message: 'Execution suspended (OSError)' } },
    ] : [
      { type: 'node_finished', node: 'review', data: { duration_s: 0.1 } },
      { type: 'route', node: null, data: { from: 'review', to: terminal === 'succeeded' ? 'ground' : 'finalize', reason: terminal === 'failed' ? 'failure' : 'review_approved' } },
      ...(terminal === 'succeeded' ? [{ type: 'node_finished', node: 'ground', data: { duration_s: 0.1 } }, { type: 'node_finished', node: 'package', data: { duration_s: 0.1 } }] : []),
      { type: 'node_started', node: 'finalize', data: {} }, { type: 'run_finished', node: null, data: { status: terminal } }, { type: 'node_finished', node: 'finalize', data: { duration_s: 0.1 } },
    ]),
  ] });
  const agents = pipelineAgents(run);
  assert.deepEqual(agents.slice(0, 2).map((a) => [a.status, a.line]), [['done', 'Done'], ['done', 'Done']]);
  assert.deepEqual([agents[2].status, agents[2].line, agents[2].busy], terminal === 'failed'
    ? ['error', 'Failed: Output repair budget exhausted', false] : terminal === 'suspended' ? ['blocked', 'Suspended', false] : ['done', 'Done', false]);
  if (failure) {
    run.events = run.events.slice(-3);
    assert.equal(pipelineAgents(run)[2].status, 'error', 'failure.node still locates the role when only finalize events remain');
  }
});

test('Team dependencies remain visible on in-progress, in-review and done cards', () => {
  const { e, state } = started([['milestone_finished', { milestoneId: 'm1', status: 'passed' }], ['milestone_started', { milestoneId: 'm2', title: 'CLI' }], lane('dwight', 'm2')]);
  const card = (s) => teamBoard(s).columns.flatMap((c) => c.cards).find((c) => c.id === 'm2');
  assert.equal(card(state).note, 'after m1');
  const review = add(state, e, [finished('dwight', 'm2', { input: 1, output: 1, cost: 0 })]);
  assert.equal(card(review).column, 'in_review');
  assert.equal(card(review).note, 'after m1');
  assert.equal(card(add(review, e, [['milestone_finished', { milestoneId: 'm2', status: 'passed' }]])).note, 'after m1');
});

test('serial JSON tails use only the exact active role/milestone identity without creating lanes', () => {
  const e = journal();
  let state = reduceAll([
    e('run_started', { request: 'Fix it', workspace: 'C:\\ws' }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One' }, { id: 'm2', title: 'Two' }] }),
    e('milestone_started', { milestoneId: 'm1', title: 'One', index: 0, total: 2 }),
    e('agent_status', { agent: 'dwight', status: 'thinking', activity: 'Thinking...' }),
    e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 10, output: 2, cost: 0.001 } }),
    e('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'edit', detail: 'src/a.js', targetFile: 'src/a.js' }),
    e('agent_status', { agent: 'dwight', status: 'working', activity: 'Working...' }),
  ]);
  const now = T0 + 60_000;
  const live = { doc: parseLive({ runId: RUN, instances: {
    'dwight-m1': { agent: 'dwight', phase: 'thinking', thinking: 'The current edit.' },
    'dwight-m2': { agent: 'dwight', phase: 'thinking', thinking: 'Other milestone.' },
    dwight: { agent: 'dwight', phase: 'thinking', thinking: 'Wrong bare role.' },
    'angela-m1': { agent: 'angela', phase: 'text', text: 'The current check.' },
    michael: { agent: 'michael', phase: 'text', text: 'The report.' },
  } }), at: now };
  const view = (s = state, l = live) => teamRunView({ state: s, live: l, now });
  const role = (s, id, l = live) => view(s, l).agents.find((a) => a.id === id);
  assert.deepEqual(state.instances, {}, 'agent_tool and agent_usage do not invent instance_started');
  assert.deepEqual([role(state, 'dwight').line, role(state, 'dwight').text.body, role(state, 'dwight').files[0].path], ['Editing src/a.js', 'The current edit.', 'src/a.js']);
  assert.equal(view().usage.run.tokens, 12);
  assert.equal(role(state, 'angela').text, null, 'an idle gate shows no tail');
  const missing = structuredClone(live);
  delete missing.doc.instances['dwight-m1'];
  assert.equal(role(state, 'dwight', missing).text, null, 'no fallback to a different milestone or the bare role');
  assert.equal(role(state, 'dwight', { ...live, at: now - LIVE_STALE_MS - 1 }).text, null, 'freshness still applies');
  assert.equal(role(state, 'dwight', { ...live, doc: { ...live.doc, runId: 'other' } }).text, null, 'run identity still applies');

  state = add(state, e, [
    ['agent_finished', { agent: 'dwight', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, usage: { input: 10, output: 2, cost: 0.001 } }],
    ['agent_status', { agent: 'dwight', status: 'idle', activity: 'Idle' }],
    ['agent_status', { agent: 'angela', status: 'thinking', activity: 'Thinking...' }],
  ]);
  assert.equal(role(state, 'dwight').text, null, 'a finished invocation cannot keep its tail');
  assert.equal(role(state, 'angela').text.body, 'The current check.');
  state = add(state, e, [
    ['agent_finished', { agent: 'angela', milestoneId: 'm1', keyword: 'TEST_PASSED', exitCode: 0 }],
    ['milestone_finished', { milestoneId: 'm1', status: 'passed' }],
    ['milestone_started', { milestoneId: 'm2', title: 'Two', index: 1, total: 2 }],
    ['agent_status', { agent: 'dwight', status: 'thinking', activity: 'Thinking...' }],
  ]);
  assert.equal(role(state, 'dwight').text.body, 'Other milestone.', 'identity advances only with the active milestone');
  assert.equal(role({ ...state, activeMilestoneIds: ['m1', 'm2'] }, 'dwight').text, null, 'ambiguous role-only state cannot pick a lane');
  state = add(state, e, [
    ['agent_finished', { agent: 'dwight', milestoneId: 'm2', keyword: 'TASK_COMPLETE', exitCode: 0 }],
    ['milestone_finished', { milestoneId: 'm2', status: 'passed' }],
    ['agent_status', { agent: 'michael', status: 'thinking', activity: 'Writing the report...' }],
  ]);
  assert.equal(role(state, 'michael').text.body, 'The report.', 'Michael keeps the unscoped identity');
  assert.deepEqual(state.instances, {});
});

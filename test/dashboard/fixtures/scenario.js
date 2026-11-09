// Builds contract v1 event sequences for the dashboard fixtures and the scratch simulator.
// state.json comes from the orchestrator's own reducer, so the fixtures have the shapes it writes.
import { AGENT_IDS, initialState, reduce } from '../../../src/core/state.js';

export { AGENT_IDS };

export const REQUEST = 'Build a small todo CLI in Node.js with add/list/done commands, JSON file storage and node:test tests';
export const WORKSPACE = 'C:\\work\\todo-cli';

const MILESTONES = [
  {
    id: 'm1', title: 'Project skeleton and CLI parsing',
    description: 'package.json, bin entry and argument parsing for add/list/done.',
    acceptanceCriteria: ['todo --help prints usage', 'unknown commands exit with code 1'],
  },
  {
    id: 'm2', title: 'JSON file storage',
    description: 'Persist todos in todos.json next to the working directory.',
    acceptanceCriteria: ['add appends a todo', 'list works when todos.json is missing', 'done marks a todo'],
  },
  {
    id: 'm3', title: 'Tests and README',
    description: 'node:test suite for the store and the CLI, short README.',
    acceptanceCriteria: ['npm test passes', 'README documents every command'],
  },
];

export function createRecorder({ runId, start }) {
  const events = [];
  let t = Date.parse(start);
  return {
    events,
    emit(type, fields = {}, afterSec = 1) {
      t += afterSec * 1000;
      const ev = { v: 1, seq: events.length + 1, ts: new Date(t).toISOString(), runId, type, ...fields };
      events.push(ev);
      return ev;
    },
  };
}

function plan(r) {
  r.emit('run_started', { request: REQUEST, workspace: WORKSPACE, maxFailedCycles: 3 }, 0);
  r.emit('agent_status', { agent: 'michael', status: 'thinking', activity: 'Planning milestones...' });
  r.emit('hive_write', { from: 'human', to: 'michael', file: 'michael/inbox.md', kind: 'plan_request', summary: `Plan: ${REQUEST}`.slice(0, 140) });
  r.emit('agent_tool', { agent: 'michael', tool: 'ls', detail: '.' }, 6);
  r.emit('agent_tool', { agent: 'michael', tool: 'write', detail: 'michael/plan.json' }, 20);
  r.emit('agent_finished', { agent: 'michael', milestoneId: null, cycle: null, keyword: 'PLAN_READY', exitCode: 0, durationMs: 41200, usage: { input: 18234, output: 2210, cost: 0.0412 } }, 14);
  r.emit('plan_ready', { milestones: MILESTONES });
  r.emit('agent_status', { agent: 'michael', status: 'waiting', activity: 'Waiting for Dwight' });
}

function startMilestone(r, index) {
  const m = MILESTONES[index];
  r.emit('milestone_started', { milestoneId: m.id, index, total: MILESTONES.length, title: m.title });
  r.emit('hive_write', { from: 'michael', to: 'dwight', file: 'dwight/inbox.md', kind: 'task', summary: `${m.id}: ${m.title}` });
}

function develop(r, m, cycle, tools, summary, usage) {
  r.emit('agent_status', { agent: 'dwight', status: 'thinking', activity: cycle > 1 ? 'Reading bug report...' : 'Reading the task...' });
  for (const [tool, detail] of tools) {
    r.emit('agent_status', { agent: 'dwight', status: 'working', activity: tool === 'bash' ? `Running ${detail}` : 'Writing code...' }, 8);
    r.emit('agent_tool', { agent: 'dwight', tool, detail }, 1);
  }
  r.emit('agent_finished', { agent: 'dwight', milestoneId: m, cycle, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 60000 + tools.length * 9000, usage }, 12);
  r.emit('agent_status', { agent: 'dwight', status: 'waiting', activity: 'Waiting for Angela' });
  r.emit('hive_write', { from: 'dwight', to: 'angela', file: 'angela/inbox.md', kind: 'handoff', summary });
}

function test(r, m, cycle, passed, reason, failedCycles, usage) {
  r.emit('agent_status', { agent: 'angela', status: 'thinking', activity: 'Reviewing handoff...' });
  r.emit('agent_tool', { agent: 'angela', tool: 'read', detail: 'angela/inbox.md' }, 3);
  r.emit('agent_status', { agent: 'angela', status: 'working', activity: 'Running npm test' }, 5);
  r.emit('agent_tool', { agent: 'angela', tool: 'bash', detail: 'npm test' }, 1);
  r.emit('agent_finished', { agent: 'angela', milestoneId: m, cycle, keyword: passed ? 'TEST_PASSED' : 'TEST_FAILED', exitCode: 0, durationMs: 48000, usage }, 20);
  r.emit('cycle_result', { milestoneId: m, cycle, result: passed ? 'passed' : 'failed', failedCycles, reason });
  if (passed) {
    r.emit('milestone_finished', { milestoneId: m, status: 'passed' });
    r.emit('agent_status', { agent: 'angela', status: 'idle', activity: 'Idle' });
  } else if (failedCycles < 3) {
    r.emit('hive_write', { from: 'angela', to: 'dwight', file: 'dwight/inbox.md', kind: 'bug_report', summary: reason });
    r.emit('agent_status', { agent: 'angela', status: 'waiting', activity: 'Waiting for Dwight' });
  }
}

const ENOENT = 'list crashes when todos.json is missing (ENOENT)';

function milestoneOne(r) {
  startMilestone(r, 0);
  develop(r, 'm1', 1, [['write', 'package.json'], ['write', 'src/cli.js'], ['bash', 'node src/cli.js --help']],
    'm1 ready: CLI skeleton with add/list/done stubs', { input: 40211, output: 6120, cost: 0.0934 });
  test(r, 'm1', 1, true, 'All acceptance criteria met', 0, { input: 22100, output: 1830, cost: 0.0388 });
}

export function buildScenario(name, { runId = '20250614-101502-k7f3', start = '2025-06-14T10:15:02.000Z' } = {}) {
  const r = createRecorder({ runId, start });
  plan(r);
  milestoneOne(r);
  startMilestone(r, 1);
  develop(r, 'm2', 1, [['write', 'src/store.js'], ['edit', 'src/cli.js']],
    'm2 ready: todos persisted to todos.json', { input: 35870, output: 5400, cost: 0.0811 });
  test(r, 'm2', 1, false, ENOENT, 1, { input: 20480, output: 1650, cost: 0.0352 });

  if (name === 'running') {
    r.emit('agent_status', { agent: 'dwight', status: 'thinking', activity: 'Reading bug report...' });
    r.emit('agent_tool', { agent: 'dwight', tool: 'read', detail: 'src/store.js' }, 4);
    r.emit('agent_status', { agent: 'dwight', status: 'working', activity: 'Writing code...' }, 7);
    r.emit('agent_tool', { agent: 'dwight', tool: 'edit', detail: 'src/store.js' }, 1);
    return r.events;
  }

  if (name === 'tripped' || name === 'aborted') {
    develop(r, 'm2', 2, [['edit', 'src/store.js']], 'm2 fix: create todos.json on first read', { input: 30110, output: 2900, cost: 0.0602 });
    test(r, 'm2', 2, false, 'list still throws ENOENT when the folder is read-only', 2, { input: 19300, output: 1400, cost: 0.0331 });
    develop(r, 'm2', 3, [['edit', 'src/store.js'], ['bash', 'node --test']], 'm2 fix: fall back to an in-memory list', { input: 31900, output: 3300, cost: 0.0655 });
    test(r, 'm2', 3, false, 'done no longer persists after the fallback change', 3, { input: 19950, output: 1500, cost: 0.0342 });
    r.emit('circuit_breaker', { milestoneId: 'm2', state: 'tripped', failedCycles: 3, maxFailedCycles: 3 });
    r.emit('agent_status', { agent: 'michael', status: 'blocked', activity: 'Needs a human!' }, 0);
    r.emit('agent_status', { agent: 'dwight', status: 'waiting', activity: 'Waiting for a human' }, 0);
    r.emit('hive_write', { from: 'michael', to: 'human', file: 'human/hitl.md', kind: 'hitl', summary: 'm2 JSON file storage needs a decision after 3 failed cycles' }, 0);
    r.emit('hitl_request', { milestoneId: 'm2', reason: 'Milestone m2 failed 3 test cycles in a row', options: ['feedback', 'retry', 'skip', 'abort'] }, 0);
    if (name === 'tripped') return r.events;
    r.emit('hitl_response', { milestoneId: 'm2', decision: 'abort' }, 25);
    r.emit('milestone_finished', { milestoneId: 'm2', status: 'aborted' }, 0);
    for (const agent of AGENT_IDS) r.emit('agent_status', { agent, status: 'idle', activity: 'Idle' }, 0);
    r.emit('run_finished', { status: 'aborted', summary: 'Aborted by the human at m2' }, 0);
    return r.events;
  }

  if (name === 'finished') {
    develop(r, 'm2', 2, [['edit', 'src/store.js']], 'm2 fix: treat a missing todos.json as an empty list', { input: 30110, output: 2900, cost: 0.0602 });
    test(r, 'm2', 2, true, 'All acceptance criteria met', 0, { input: 19300, output: 1400, cost: 0.0331 });
    startMilestone(r, 2);
    develop(r, 'm3', 1, [['write', 'test/store.test.js'], ['write', 'README.md'], ['bash', 'npm test']],
      'm3 ready: 9 tests, README with every command', { input: 42800, output: 7900, cost: 0.1033 });
    test(r, 'm3', 1, true, 'npm test: 9 passed, README complete', 0, { input: 23400, output: 1700, cost: 0.0401 });
    for (const agent of AGENT_IDS) r.emit('agent_status', { agent, status: 'done', activity: 'Done' }, 0);
    r.emit('log', { level: 'info', message: 'All milestones passed' }, 0);
    r.emit('run_finished', { status: 'success', summary: '3/3 milestones passed in 4 cycles' }, 0);
    return r.events;
  }

  throw new Error(`unknown scenario ${name}`);
}

/** The state.json the orchestrator writes after these events (src/core/state.js reduce). */
export function reduceState(events, state = initialState()) {
  return events.reduce(reduce, state);
}

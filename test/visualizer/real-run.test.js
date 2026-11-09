import { isolationTestEnv } from '../core/isolation-test-root.js';
// Replays what the orchestrator really emits (scranton demo with the fake pi) through the web reducer
// and compares the result with the hive/state.json the same run wrote.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduceAll, parseJsonl, humanNeeded, AGENT_IDS } from '../../visualizer/public/js/state.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'scranton.js');

const RUNS = [
  { scenario: 'happy', onBreaker: 'skip', exit: 0, result: 'success' },
  { scenario: 'flaky', onBreaker: 'skip', exit: 0, result: 'success' },
  { scenario: 'breaker', onBreaker: 'skip', exit: 1, result: 'partial' },
  { scenario: 'blocked', onBreaker: 'skip', exit: 1, result: 'partial' },
  { scenario: 'breaker', onBreaker: 'abort', exit: 1, result: 'aborted' },
];

let tmp;
const done = new Map();

function demo({ scenario, onBreaker }, dir) {
  const args = [CLI, 'demo', '--scenario', scenario, '--delay', '0', '--hive', path.join(dir, 'hive'), '--workspace', path.join(dir, 'ws'), '--on-breaker', onBreaker];
  return new Promise((resolve, reject) => {
    // cwd outside the repo so no scranton.config.json or .env changes the run
    const child = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: isolationTestEnv({ NO_COLOR: '1' }) });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'scranton-viz-real-'));
  await Promise.all(RUNS.map(async (run, i) => {
    const dir = await mkdtemp(path.join(tmp, `${i}-${run.scenario}-${run.onBreaker}-`));
    const { code, output } = await demo(run, dir);
    const hive = path.join(dir, 'hive');
    let events = [];
    let snapshot = null;
    try {
      events = parseJsonl(await readFile(path.join(hive, 'events.jsonl'), 'utf8'));
      snapshot = JSON.parse(await readFile(path.join(hive, 'state.json'), 'utf8'));
    } catch {
      // reported by the test below with the CLI output
    }
    done.set(run, { code, output, events, snapshot });
  }));
});

after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5 }));

for (const run of RUNS) {
  test(`demo ${run.scenario} --on-breaker ${run.onBreaker}: the web reducer agrees with state.json`, () => {
    const { code, output, events, snapshot } = done.get(run);
    assert.ok(snapshot && events.length, `no events/state written. CLI exit ${code}:\n${output.slice(-1500)}`);
    assert.equal(code, run.exit, `exit code. CLI output:\n${output.slice(-1500)}`);
    assert.equal(events.at(-1).type, 'run_finished');
    assert.equal(events.at(-1).status, run.result);

    const s = reduceAll(events);
    assert.equal(s.runId, snapshot.runId);
    assert.equal(s.lastSeq, snapshot.lastSeq);
    assert.equal(s.applied, events.length, 'every real event type is known to the reducer');
    assert.equal(s.status, snapshot.status, 'run status');
    assert.equal(s.result, run.result);
    assert.deepEqual(s.milestones.map((m) => [m.id, m.status]), snapshot.milestones.map((m) => [m.id, m.status]), 'milestone statuses');
    assert.equal(s.currentMilestoneId, snapshot.currentMilestoneId);
    assert.equal(s.breaker, snapshot.breaker, 'breaker closed/tripped');
    assert.equal(s.failedCycles, snapshot.failedCycles, 'failed cycles');
    for (const id of AGENT_IDS) {
      const mine = s.agents[id].totals;
      const theirs = snapshot.agents[id].totals;
      assert.equal(mine.runs, theirs.runs, `${id} totals.runs`);
      assert.equal(mine.input, theirs.input, `${id} totals.input`);
      assert.equal(mine.output, theirs.output, `${id} totals.output`);
      assert.ok(Math.abs(mine.cost - theirs.cost) < 1e-9, `${id} totals.cost`);
      assert.equal(s.agents[id].status, snapshot.agents[id].status, `${id} status`);
    }

    // nothing alarming survives the end of the run
    assert.equal(s.hitl, null);
    assert.equal(humanNeeded(s), false);
    assert.equal(s.breaker, 'closed');
    assert.equal(s.cycleOpen, false);
    for (const id of AGENT_IDS) assert.ok(!['thinking', 'working', 'blocked'].includes(s.agents[id].status), `${id} is ${s.agents[id].status}`);

    // a reconnect replay of the same file changes nothing
    assert.equal(reduceAll(events, s), s);
  });
}

test('the real runs cover the breaker, the human in the loop and skip/abort decisions', () => {
  const all = [...done.values()].flatMap((r) => r.events);
  const types = new Set(all.map((e) => e.type));
  for (const t of ['circuit_breaker', 'hitl_request', 'hitl_response', 'cycle_result', 'milestone_finished']) assert.ok(types.has(t), `no ${t} in any run`);
  const decisions = new Set(all.filter((e) => e.type === 'hitl_response').map((e) => e.decision));
  assert.ok(decisions.has('skip') && decisions.has('abort'), [...decisions].join(', '));
  assert.ok(all.some((e) => e.type === 'circuit_breaker' && e.state === 'tripped'));
});

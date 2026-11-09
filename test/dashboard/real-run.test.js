import { isolationTestEnv } from '../core/isolation-test-root.js';
// Renders hives written by real orchestrator runs (CLI demo with the fake pi), so the
// dashboard is checked against what the producer actually writes, not only fixtures.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDashboard } from '../../src/dashboard/index.js';
import { createHiveSource } from '../../src/dashboard/source.js';
import { stripAnsi, visibleWidth } from '../../src/dashboard/text.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'bin', 'scranton.js');

const RUNS = {
  happy: { scenario: 'happy', onBreaker: 'skip', status: 'finished', result: 'success', outcome: '3/3 milestones passed' },
  flaky: { scenario: 'flaky', onBreaker: 'skip', status: 'finished', result: 'success', outcome: '3/3 milestones passed' },
  // a skipped prerequisite never counts as passed, so its dependent m3 ends blocked
  breaker: { scenario: 'breaker', onBreaker: 'skip', status: 'finished', result: 'partial', outcome: '1/3 milestones passed · 1 skipped · 1 blocked' },
  blocked: { scenario: 'blocked', onBreaker: 'skip', status: 'finished', result: 'partial', outcome: '1/3 milestones passed · 1 skipped · 1 blocked' },
  abort: { scenario: 'breaker', onBreaker: 'abort', status: 'aborted', result: 'aborted', outcome: '1/3 milestones passed · 1 aborted · 1 not started' },
};

// Text that only the live alert lines print; none of it may survive the end of a run.
const STALE = /answer in the orchestrator terminal|Human needed:|PAUSED - a human|Breaker|Cycle \d|Milestone \d+\/\d+:/;

function demo(dir, { scenario, onBreaker }) {
  const args = [cli, 'demo', '--scenario', scenario, '--delay', '0', '--hive', path.join(dir, 'hive'),
    '--workspace', path.join(dir, 'ws'), '--on-breaker', onBreaker];
  return new Promise((resolve) => {
    // Runs that end partial or aborted exit 1 by design, so the exit code is not checked here.
    execFile(process.execPath, args, { cwd: dir, timeout: 60000, env: isolationTestEnv({ NO_COLOR: '1' }) },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, output: `${stdout}${stderr}${err && !stdout ? err.message : ''}` }));
  });
}

async function load(hive) {
  const source = createHiveSource(hive);
  await source.poll();
  return { state: source.state, events: source.events };
}

const hives = {};
let tmp;

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'scranton-dash-real-'));
  await Promise.all(Object.entries(RUNS).map(async ([name, run]) => {
    const dir = path.join(tmp, name);
    await mkdir(dir, { recursive: true });
    let attempt = await demo(dir, run);
    let hive = await load(path.join(dir, 'hive'));
    // The CLI may be mid-edit by another lane; one retry tells a flake from a real failure.
    if (!hive.events.some((e) => e.type === 'run_finished')) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      attempt = await demo(dir, run);
      hive = await load(path.join(dir, 'hive'));
    }
    hives[name] = { ...hive, dir, attempt };
  }));
});

after(() => rm(tmp, { recursive: true, force: true }));

function frame(hive, opts) {
  return renderDashboard(hive.state, hive.events, {
    height: 40, color: false, now: Date.parse(hive.state.updatedAt), hiveDir: path.join(hive.dir, 'hive'), ...opts,
  });
}

for (const [name, run] of Object.entries(RUNS)) {
  test(`real ${name} run (--on-breaker ${run.onBreaker}): outcome header, end banner, no stale alert`, () => {
    const hive = hives[name];
    assert.ok(hive.state, `no state.json:\n${hive.attempt.output}`);
    const finished = hive.events.find((e) => e.type === 'run_finished');
    assert.ok(finished, `no run_finished:\n${hive.attempt.output}`);
    assert.equal(finished.status, run.result);
    assert.equal(hive.state.status, run.status);
    assert.equal(hive.events[0].type, 'run_started');

    const banner = run.status === 'finished' ? `Run finished: ${run.result}` : `Run ${run.status}`;
    for (const width of [80, 100, 120]) {
      for (const color of [false, true]) {
        const out = stripAnsi(frame(hive, { width, color }));
        const badge = color ? ` ${run.status.toUpperCase()} ` : `[${run.status.toUpperCase()}]`;
        for (const text of [badge, run.outcome, banner]) {
          assert.ok(out.includes(text), `${width} color=${color}: missing ${JSON.stringify(text)}\n${out}`);
        }
        // An inverse result label carries a cell of padding on each side.
        assert.match(out, new RegExp(`run finished {2,3}${run.result}`), `${width} color=${color}`);
        assert.doesNotMatch(out, STALE, `${width} color=${color}`);
      }
    }

    for (const width of [40, 80, 100, 120]) {
      for (const color of [false, true]) {
        for (const ascii of [false, true]) {
          const raw = frame(hive, { width, color, ascii });
          const lines = raw.split('\n');
          assert.equal(lines.length, 40, `${width} color=${color} ascii=${ascii}`);
          for (const l of lines) assert.ok(visibleWidth(l) <= width, `${width}: ${visibleWidth(l)} > ${width}\n${stripAnsi(l)}`);
          if (ascii) assert.match(raw, /^[\x00-\x7f]*$/, `${width} color=${color}: non-ASCII in ascii mode`);
          assert.doesNotMatch(stripAnsi(raw), /answer in the orchestrator terminal|Human needed:|PAUSED - a human/, `${width} ascii=${ascii}`);
        }
      }
    }
  });
}

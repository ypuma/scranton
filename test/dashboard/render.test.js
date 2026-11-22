import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDashboard } from '../../src/dashboard/index.js';
import { formatCost, formatDuration, formatTokens } from '../../src/dashboard/render.js';
import { createHiveSource } from '../../src/dashboard/source.js';
import { sanitize, stripAnsi, textWidth, visibleWidth } from '../../src/dashboard/text.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const HIVE = 'C:\\Users\\pumas\\Documents\\Project_Scranton\\hive';

async function fixture(name) {
  const source = createHiveSource(path.join(fixtures, name));
  await source.poll();
  const state = source.state;
  return { state, events: source.events, now: state ? Date.parse(state.updatedAt) + 7000 : Date.parse('2025-06-14T12:00:00Z') };
}

function render(f, opts = {}) {
  return renderDashboard(f.state, f.events, { width: 120, height: 40, color: false, now: f.now, hiveDir: HIVE, ...opts });
}

test('idle fixture: no state.json shows the idle screen', async () => {
  const f = await fixture('idle');
  assert.equal(f.state, null);
  const out = render(f);
  assert.match(out, /^ SCRANTON   Agent Orchestration +\[IDLE\]$/m);
  assert.doesNotMatch(out, /Munder|Difflin|Paper|Branch|Agent Floor/);
  assert.match(out, /No run yet - start one with: scranton run "\.\.\."  or  scranton demo/);
  assert.match(out, /\[IDLE\]/);
  assert.match(out, /MICHAEL/);
  assert.match(out, /q quit/);
  assert.ok(out.includes(HIVE));
});

test('a state with status idle or no runId is the idle screen too', () => {
  for (const state of [{ v: 1, status: 'idle' }, { v: 1, runId: null, status: 'running' }, 'garbage', []]) {
    assert.match(renderDashboard(state, [], { width: 80, height: 24, color: false }), /No run yet/);
  }
});

test('running fixture: Dwight is working mid-cycle', async () => {
  const f = await fixture('running');
  assert.equal(f.state.agents.dwight.status, 'working');
  const out = render(f);
  for (const text of [
    '[RUNNING]', 'run 20250614-101502-k7f3', 'Request  Build a small todo CLI',
    'Milestone 2/3: JSON file storage', 'Cycle 2', 'Breaker ●○○ 1/3',
    'MICHAEL · Orchestrator', 'DWIGHT · Developer', 'ANGELA · QA',
    '● WORKING', '○ WAITING', 'Writing code...', 'Waiting for Dwight', 'edit  src/store.js',
    'last  TASK_COMPLETE', 'last  TEST_FAILED', 'last  PLAN_READY',
    '2 runs · 87.6k tok · $0.174', '1 run · 20.4k tok · $0.041',
    '✓ Project skeleton and CLI parsing', '● JSON file storage', '○ Tests and README',
    'Event log', 'dwight -> angela  handoff  m2 ready: todos persisted to todos.json',
    'angela   bash  npm test', 'cycle 1 FAILED  m2  1 failed in a row',
    'angela -> dwight  bug_report  list crashes when todos.json is missing (ENOENT)',
  ]) assert.ok(out.includes(text), `missing ${JSON.stringify(text)}\n${out}`);
  assert.match(out, /\b\d{2}:\d{2}:\d{2}   dwight   edit  src\/store\.js/);
  assert.doesNotMatch(out, /CIRCUIT BREAKER TRIPPED - answer/);
});

test('the spinner animates for a working agent', async () => {
  const f = await fixture('running');
  const frames = new Set([0, 120, 240, 360].map((dt) => render(f, { now: f.now + dt }).split('\n').find((l) => l.includes('WORKING'))));
  assert.ok(frames.size > 1, 'spinner frame did not change');
});

test('tripped fixture: loud breaker line, paused badge and full meter', async () => {
  const f = await fixture('tripped');
  assert.equal(f.state.breaker, 'tripped');
  assert.equal(f.state.status, 'paused');
  const out = render(f);
  for (const text of [
    '[PAUSED]', 'CIRCUIT BREAKER TRIPPED - answer in the orchestrator terminal', 'Breaker ●●● 3/3', '■ BLOCKED',
    'Human needed: Milestone m2 failed 3 test cycles in a row', 'BLOCKED', 'Needs a human!',
    'CIRCUIT BREAKER TRIPPED  m2  3/3 failed cycles', 'HUMAN NEEDED', 'michael -> human  hitl',
  ]) assert.ok(out.includes(text), `missing ${JSON.stringify(text)}\n${out}`);

  const colored = render(f, { color: true });
  const alert = colored.split('\n').find((l) => l.includes('CIRCUIT BREAKER TRIPPED - answer'));
  assert.ok(alert.includes('\x1b[1;7m'), 'breaker line is not bold inverse');
  assert.equal(visibleWidth(alert), 120 - 1, 'breaker bar spans the content width');
  assert.ok(colored.includes('\x1b[1;7m PAUSED \x1b[0m'), 'paused badge is inverse');
  assert.ok(render(f, { color: true, ascii: true }).includes('\x1b[1;7m'), 'ascii mode keeps the inverse bar');
});

test('normal badges are a quiet chip, only critical states invert', async () => {
  const running = render(await fixture('running'), { color: true });
  assert.ok(running.includes(' RUNNING '));
  assert.ok(!running.split('\n')[0].includes('\x1b[1;7m'), 'running badge must not be inverse');
  const f = await fixture('running');
  const failed = render({ ...f, state: { ...f.state, status: 'failed' } }, { color: true });
  assert.ok(failed.includes('\x1b[1;7m FAILED \x1b[0m'));
  assert.ok(failed.split('\n').some((l) => l.includes('Run failed') && visibleWidth(l) === 120 - 1), 'failed run is a full-width inverse bar');
});

// Attributes and resets only, plus 256-colour grays; anything else is a hue.
const GRAY_SAFE = new Set([0, 1, 2, 3, 4, 7, 22, 23, 24, 27, 39, 49]);
const GRAY_INDEX = (n) => (n >= 232 && n <= 255) || [0, 7, 8, 15].includes(n);

function hueViolations(out) {
  const bad = [];
  for (const [seq, body] of out.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const params = body === '' ? [0] : body.split(';').map(Number);
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 38 || p === 48) {
        if (params[i + 1] === 5 && GRAY_INDEX(params[i + 2])) i += 2;
        else if (params[i + 1] === 2 && params[i + 2] === params[i + 3] && params[i + 3] === params[i + 4]) i += 4;
        else { bad.push(JSON.stringify(seq)); break; }
      } else if (!GRAY_SAFE.has(p)) {
        bad.push(JSON.stringify(seq));
        break;
      }
    }
  }
  for (const m of out.matchAll(/\x1b(?!\[[0-9;]*m)./g)) bad.push(`non-SGR ${JSON.stringify(m[0])}`);
  return bad;
}

test('colour output is strictly grayscale for every fixture and state', async () => {
  const statuses = ['idle', 'thinking', 'working', 'waiting', 'blocked', 'error', 'done'];
  const variants = [];
  for (const name of ['idle', 'running', 'tripped', 'finished', 'aborted']) variants.push([name, await fixture(name)]);
  const f = await fixture('running');
  const agents = Object.fromEntries(['michael', 'dwight', 'angela'].map((id, i) => [id, { ...f.state.agents[id], status: statuses[i + 4] }]));
  const extra = [
    ...f.events,
    ...['info', 'warn', 'error'].map((level, i) => ({ v: 1, seq: 800 + i, ts: f.state.updatedAt, runId: f.state.runId, type: 'log', level, message: level })),
    ...statuses.map((status, i) => ({ v: 1, seq: 810 + i, ts: f.state.updatedAt, runId: f.state.runId, type: 'agent_status', agent: 'dwight', status, activity: status })),
    { v: 1, seq: 820, ts: f.state.updatedAt, runId: f.state.runId, type: 'run_finished', status: 'aborted', summary: 'stopped' },
  ];
  for (const status of ['planning', 'running', 'paused', 'finished', 'aborted', 'failed']) {
    variants.push([`${status}+states`, { ...f, state: { ...f.state, status, agents }, events: extra }]);
  }
  for (const [name, v] of variants) {
    for (const width of [40, 80, 100, 120]) {
      for (const ascii of [false, true]) {
        const out = render(v, { width, height: 40, color: true, ascii });
        assert.ok(out.includes('\x1b['), `${name}: expected styled output`);
        const bad = hueViolations(out);
        assert.deepEqual(bad, [], `${name} ${width} ascii=${ascii}: non-grayscale SGR ${[...new Set(bad)].join(' ')}`);
      }
    }
  }
});

test('status words are uppercase with one glyph each', async () => {
  const f = await fixture('running');
  const glyphs = { working: '●', thinking: '◐', waiting: '○', idle: '○', blocked: '■', error: '✕', done: '✓' };
  const ascii = { working: '*', thinking: '~', waiting: 'o', idle: 'o', blocked: '#', error: 'x', done: '+' };
  for (const [status, glyph] of Object.entries(glyphs)) {
    const state = { ...f.state, agents: { ...f.state.agents, dwight: { ...f.state.agents.dwight, status } } };
    const word = status.toUpperCase();
    assert.ok(render({ ...f, state }).includes(`${glyph} ${word}`), `${status}: expected "${glyph} ${word}"`);
    assert.ok(render({ ...f, state }, { ascii: true }).includes(`${ascii[status]} ${word}`), `${status}: expected ascii "${ascii[status]} ${word}"`);
  }
});

test('paused without a tripped breaker still asks for the human', async () => {
  const f = await fixture('running');
  const state = { ...f.state, status: 'paused' };
  assert.match(render({ ...f, state }), /PAUSED - a human is needed - answer in the orchestrator terminal/);
});

test('finished fixture: success banner and an outcome header instead of the last milestone', async () => {
  const f = await fixture('finished');
  // since parallel runs the producer clears the current milestone at run end; older hives kept the last one
  assert.equal(f.state.currentMilestoneId, null);
  assert.doesNotMatch(render({ ...f, state: { ...f.state, currentMilestoneId: 'm3' } }), /Milestone \d\/\d|Cycle \d|Breaker/);
  const out = render(f);
  for (const text of [
    '[FINISHED]', '✓ Run finished: success  3/3 milestones passed in 4 cycles', '3/3 milestones passed',
    '9 agent runs · 283.6k tok · $0.526',
    '✓ Project skeleton and CLI parsing   ✓ JSON file storage   ✓ Tests and README', '✓ DONE',
    'run finished  success', 'INFO  All milestones passed', '5m 23s',
  ]) assert.ok(out.includes(text), `missing ${JSON.stringify(text)}\n${out}`);
  assert.doesNotMatch(out, /Milestone \d\/\d|Cycle \d|Breaker/);
});

test('a run that ended at the breaker shows the end banner, never the breaker alert', async () => {
  const f = await fixture('aborted');
  // Whether or not the producer closes the breaker at run end, an ended run must read as over.
  for (const breaker of ['tripped', 'closed']) {
    const state = { ...f.state, breaker, failedCycles: 3, cycle: 3, currentMilestoneId: 'm2' };
    const out = render({ ...f, state });
    for (const text of [
      '[ABORTED]', 'Run aborted  Aborted by the human at m2', '1/3 milestones passed · 1 aborted · 1 not started',
      '✓ Project skeleton and CLI parsing   ✕ JSON file storage   ○ Tests and README',
    ]) assert.ok(out.includes(text), `${breaker}: missing ${JSON.stringify(text)}\n${out}`);
    assert.doesNotMatch(out, /answer in the orchestrator terminal|Human needed:|Breaker|Cycle \d|Run aborted: aborted/, breaker);
    const colored = render({ ...f, state }, { color: true }).split('\n').find((l) => l.includes('Run aborted'));
    assert.ok(colored.includes('\x1b[1;7m') && visibleWidth(colored) === 120 - 1, 'aborted run is a full-width inverse bar');
  }

  // A finished or failed state over a still-open hitl_request is over too.
  const tripped = await fixture('tripped');
  for (const status of ['finished', 'failed']) {
    const out = render({ ...tripped, state: { ...tripped.state, status } });
    assert.ok(out.includes(`Run ${status}`), `${status}: no end banner\n${out}`);
    assert.doesNotMatch(out, /answer in the orchestrator terminal|Human needed:/, status);
  }
});

test('number, cost, duration and clock formats match the web dashboard', async () => {
  for (const [n, text] of [[0, '0'], [999, '999'], [2300, '2.3k'], [56600, '56.6k'], [150000, '150.0k'], [999949, '999.9k'], [999950, '1.0M'], [1.2e6, '1.2M']]) {
    assert.equal(formatTokens(n), text, `tokens ${n}`);
  }
  for (const [n, text] of [[0, '$0.00'], [0.006, '$0.006'], [0.138, '$0.138'], [0.9996, '$1.00'], [1.25, '$1.25'], [12.5, '$12.50']]) {
    assert.equal(formatCost(n), text, `cost ${n}`);
  }
  for (const [ms, text] of [[0, '0s'], [12000, '12s'], [323000, '5m 23s'], [3720000, '1h 02m'], [50 * 3600e3, '50h 00m']]) {
    assert.equal(formatDuration(ms), text, `duration ${ms}`);
  }
  const f = await fixture('running');
  const d = new Date(f.state.updatedAt);
  const local = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  assert.ok(render(f).includes(`updated ${local}`), 'clock is local HH:MM:SS');
});

test('sanitize strips bidi controls, and they take no width', async () => {
  const bidi = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f';
  assert.equal(sanitize(`ab${bidi}cd`), 'abcd');
  assert.equal(sanitize('invoice\u202eexe.pdf'), 'invoiceexe.pdf');
  for (const ch of bidi) assert.equal(textWidth(ch), 0, `U+${ch.codePointAt(0).toString(16)}`);
  const f = await fixture('running');
  const out = render({ ...f, state: { ...f.state, request: `todo \u202e${'x'.repeat(200)}` } }, { color: true });
  assert.ok(!/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(out), 'bidi control reached the terminal');
});

test('panels sit side by side from 100 columns and stack below', async () => {
  const f = await fixture('running');
  const row = (out) => out.split('\n').find((l) => l.includes('MICHAEL'));
  assert.ok(row(render(f, { width: 100 })).includes('DWIGHT'));
  assert.ok(!row(render(f, { width: 99 })).includes('DWIGHT'));
  const small = render(f, { width: 80, height: 16 }).split('\n');
  assert.ok(small.some((l) => /MICHAEL\s+WAITING\s+Waiting for Dwight/.test(l)), 'expected compact one-liners');
});

test('no line exceeds the width, frames fill the height exactly', async () => {
  for (const name of ['idle', 'running', 'tripped', 'finished', 'aborted']) {
    const f = await fixture(name);
    for (const width of [20, 40, 60, 80, 100, 120, 160]) {
      for (const height of [3, 12, 24, 50]) {
        for (const color of [true, false]) {
          for (const ascii of [false, true]) {
            const lines = render(f, { width, height, color, ascii }).split('\n');
            assert.equal(lines.length, height, `${name} ${width}x${height}`);
            for (const line of lines) {
              assert.ok(visibleWidth(line) <= width, `${name} ${width}x${height} color=${color} ascii=${ascii}: ${visibleWidth(line)} > ${width}\n${stripAnsi(line)}`);
            }
          }
        }
      }
    }
  }
});

test('ascii mode output is pure ASCII', async () => {
  for (const name of ['idle', 'running', 'tripped', 'finished', 'aborted']) {
    const f = await fixture(name);
    for (const width of [40, 80, 120]) {
      for (const color of [false, true]) {
        const out = render(f, { width, ascii: true, color });
        assert.match(out, /^[\x00-\x7f]*$/, `${name} ${width} color=${color} has non-ASCII:\n${out}`);
      }
    }
    assert.match(render(f, { ascii: true }), /^ SCRANTON   Agent Orchestration /);
  }
});

test('color: false emits no escape sequences', async () => {
  const f = await fixture('tripped');
  assert.ok(!render(f).includes('\x1b'));
  assert.ok(render(f, { color: true }).includes('\x1b['));
});

test('unknown types, missing fields and hostile text do not crash or overflow', async () => {
  const f = await fixture('running');
  const runId = f.state.runId;
  const weird = [
    ...f.events,
    { v: 1, seq: 900, ts: 'not a date', runId, type: 'coffee_break', who: 'kevin' },
    { v: 1, seq: 901, ts: f.state.updatedAt, runId, type: 'hive_write' },
    { v: 1, seq: 902, ts: f.state.updatedAt, runId, type: 'agent_finished', agent: 'toby', usage: 'lots' },
    { v: 1, seq: 903, ts: f.state.updatedAt, runId, type: 'plan_ready', milestones: 'soon' },
    { v: 1, seq: 904, ts: f.state.updatedAt, runId, type: 'log', level: 'panic', message: 'line1\nline2\x1b[31m red \x07' },
    { v: 1, seq: 905, ts: f.state.updatedAt, runId, type: 'agent_tool', agent: 'dwight', tool: 'bash', detail: '会社のコピー機 '.repeat(20) },
    null, 42, 'text',
  ];
  const state = { ...f.state, request: '紙の会社\t\x1b[2Jdrop table', agents: { dwight: { status: 'exploding', totals: null } }, milestones: [null, { id: 'm9' }] };
  for (const width of [30, 80, 120]) {
    const out = renderDashboard(state, weird, { width, height: 30, color: true, now: f.now });
    assert.ok(!out.includes('\x1b[2J'), 'escape sequence from data leaked');
    assert.ok(!out.includes('\x07'));
    for (const line of out.split('\n')) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${stripAnsi(line)}`);
  }
  assert.doesNotThrow(() => renderDashboard(state, 'not an array', { width: 80, height: 24 }));
  assert.doesNotThrow(() => renderDashboard(undefined, undefined));
});

test('adaptive progress replaces the legacy meter and renders cause-specific titles', async () => {
  const f = await fixture('tripped');
  const progress = { milestoneId: 'm2', cycle: 5, verdict: 'stalled', source: 'rule', rule: 'repeat', reason: 'The full failure repeats', changed: true, stalledCycles: 2, maxStalledCycles: 2, tokens: 4500, tokenBudget: 500000 };
  const state = { ...f.state, maxFailedCycles: 12, maxStalledCycles: 2, milestoneTokenBudget: 500000,
    milestones: f.state.milestones.map(m => m.id === 'm2' ? { ...m, progress } : m) };
  for (const [cause, title] of [['stalled', 'No progress on m2: The full failure repeats'], ['budget', 'm2 used 4500 tokens without passing'], ['limit', 'm2 reached the cycle limit (12)']]) {
    const events = [...f.events, { ...progress, type: 'progress_check', runId: state.runId, seq: 500 }, { type: 'circuit_breaker', state: 'tripped', milestoneId: 'm2', cause, maxFailedCycles: 12, tokens: 4500, seq: 501 }];
    const out = render({ ...f, state, events });
    assert.match(out, /stalled 2\/2/); assert.match(out, /4\.5k\/500\.0k tok/);
    assert.match(out, /Cycle 5: stalled - The full failure repeats/);
    assert.ok(out.includes(title));
    assert.doesNotMatch(out, /Breaker .*3\/3/);
  }
});

test('adaptive current-milestone lookup tolerates malformed milestone collections', async () => {
  const f = await fixture('running');
  for (const milestones of [null, 'not an array', {}, [null]]) {
    assert.doesNotThrow(() => render({ ...f, state: { ...f.state, milestones, maxStalledCycles: 2 } }));
  }
});

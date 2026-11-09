import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderDashboard } from '../../src/dashboard/render.js';
import { createHiveSource, parseEventLines } from '../../src/dashboard/source.js';
import { stripAnsi, visibleWidth } from '../../src/dashboard/text.js';
import { roleFixture } from './fixtures/roles.js';

function render(f, options = {}) {
  return renderDashboard(f.state, f.events, { width: 140, height: 40, color: false, ascii: true, now: f.now, ...options });
}

const panelRows = (out) => out.split('\n').slice(0, out.split('\n').findIndex((l) => l.includes('Milestones  '))).join('\n');

test('workflow panels show ordered roles, parallel stage and both gate lanes', () => {
  const f = roleFixture();
  for (const width of [80, 100, 119, 120, 140]) {
    const out = render(f, { width, height: width < 120 ? 24 : 40 });
    for (const word of ['OSCAR', 'HANK', 'ANGELA', 'oscar || hank (parallel)', 'oscar-m1', 'hank-m1']) assert.ok(out.includes(word), `missing ${word} at ${width}\n${out}`);
    assert.match(panelRows(out), /gate  APPROVED/);
    assert.doesNotMatch(panelRows(out), /CHANGES/);
    const title = out.split('\n').find((l) => l.includes('MICHAEL'));
    assert.ok(title.includes('DWIGHT'));
    assert.equal(title.includes('OSCAR'), width >= 120, 'five columns start at 120; two-row grid below');
    const log = out.split('\n').findIndex((l) => l.includes('Event log'));
    assert.ok(log > 0 && out.split('\n').length - log - 2 >= 3, 'keep at least three event rows');
  }
  const unicode = render(f, { ascii: false });
  assert.ok(unicode.includes('oscar ∥ hank (parallel)'));
});

test('failed stage shows one current result per gate and readable gate log entries', () => {
  const out = render(roleFixture('failed'));
  const boxes = panelRows(out);
  assert.equal(boxes.match(/gate  CHANGES/g)?.length, 1);
  assert.equal(boxes.match(/gate  SECURITY ISSUES/g)?.length, 1);
  assert.match(out, /oscar gate failed CHANGES_REQUESTED/);
  assert.match(out, /hank gate failed SECURITY_ISSUES/);
  assert.doesNotMatch(boxes, /gate  TEST PASSED/);
  assert.match(panelRows(render(roleFixture('failed'), { width: 120 })), /SECURITY ISSUES/, 'full verdict fits a narrow column');
});

test('passed three-stage workflow keeps listed order and all final results', () => {
  const out = render(roleFixture('passed'));
  const titles = out.split('\n').find((l) => l.includes('MICHAEL'));
  assert.match(titles, /MICHAEL.*DWIGHT.*HANK.*OSCAR.*ANGELA/);
  assert.match(out, /Stage 1: hank -> Stage 2: oscar -> Stage 3: angela/);
  for (const label of ['SECURITY PASSED', 'APPROVED', 'TEST PASSED']) assert.equal(panelRows(out).split(label).length - 1, 1);
});

test('workflow comes from same-run start event or state; inactive roles stay omitted', () => {
  const f = roleFixture();
  delete f.state.execution;
  assert.match(render(f), /OSCAR.*HANK/);
  f.state.execution = { workflow: { gates: [['hank']] } };
  f.events = [];
  const out = render(f);
  assert.match(out, /HANK/);
  assert.doesNotMatch(out, /OSCAR|ANGELA/);
  f.state.execution = undefined;
  f.events = [{ ...roleFixture().events[0], runId: 'other-run' }];
  assert.doesNotMatch(render(f), /OSCAR|HANK/);
});

test('compact workflow uses one row per role below 24 rows', () => {
  const out = render(roleFixture('failed'), { width: 120, height: 23 });
  for (const id of ['MICHAEL', 'DWIGHT', 'OSCAR', 'HANK', 'ANGELA']) {
    assert.equal(out.split('\n').filter((l) => l.includes(id)).length, 1);
  }
  assert.match(out, /OSCAR.*CHANGES/);
  assert.match(out, /HANK.*SECURITY ISSUES/);
  assert.doesNotMatch(out, /\+-/);
});

test('gate results exclude previous cycles, other milestones and replays', () => {
  const f = roleFixture('failed');
  const gate = f.events.find((e) => e.type === 'gate_result');
  f.events.push({ ...gate, seq: 0, keyword: 'REVIEW_APPROVED' },
    { ...gate, seq: 90, cycle: 1, keyword: 'REVIEW_APPROVED' },
    { ...gate, seq: 91, milestoneId: 'm2', keyword: 'REVIEW_APPROVED' },
    { ...gate, seq: 92, runId: 'other', keyword: 'REVIEW_APPROVED' },
    ...['map', '__proto__', -1, 0.5, null].map((stage) => ({ ...gate, seq: 93, stage, keyword: 'REVIEW_APPROVED' })));
  assert.match(panelRows(render(f)), /gate  CHANGES/);
  assert.doesNotMatch(panelRows(render(f)), /APPROVED/);
  f.state.cycle = f.state.milestones[0].cycle = 3;
  assert.doesNotMatch(panelRows(render(f)), /CHANGES|SECURITY ISSUES/);
});

test('source accepts gate_result without changing its pinned shape', () => {
  const events = roleFixture('failed').events;
  assert.deepEqual(parseEventLines(events.map((e) => JSON.stringify(e) + '\n').join('')), events);
});

test('gate verdicts survive the bounded log tail, reconnect and run replacement', async (t) => {
  const root = path.resolve('.scratch/roles-dashboard');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = roleFixture('failed');
  const file = path.join(dir, 'events.jsonl');
  const line = (e) => JSON.stringify(e) + '\n';
  const padding = Array.from({ length: 100 }, (_, i) => ({ v: 1, seq: 10 + i, runId: f.state.runId, type: 'log',
    level: 'info', message: 'tool output '.repeat(30) })).map(line).join('');
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(f.state));
  await writeFile(file, f.events.map(line).join('') + padding);
  const source = createHiveSource(dir, { tailBytes: 2048, maxEvents: 12 });
  await source.poll();
  assert.equal(source.events.filter((e) => e.type === 'gate_result').length, 2);
  assert.ok(source.events.length <= 12);
  assert.match(panelRows(render({ ...f, events: source.events })), /SECURITY ISSUES/);
  const retry = { ...f.events[1], seq: 200, result: 'passed', keyword: 'REVIEW_APPROVED' };
  const text = line(retry);
  await appendFile(file, text.slice(0, -4));
  await source.poll();
  assert.equal(source.events.filter((e) => e.type === 'gate_result').length, 2, 'partial result is ignored');
  await appendFile(file, text.slice(-4) + padding);
  await source.poll();
  assert.match(panelRows(render({ ...f, events: source.events })), /APPROVED/);
  const reconnect = createHiveSource(dir, { tailBytes: 2048 });
  await reconnect.poll();
  assert.match(panelRows(render({ ...f, events: reconnect.events })), /APPROVED/);
  await appendFile(file, 'x'.repeat(300000));
  await source.poll();
  assert.match(panelRows(render({ ...f, events: source.events })), /APPROVED/, 'an oversized partial line cannot erase settled gates');
  await appendFile(file, '\n' + line({ ...retry, seq: 201, keyword: 'CHANGES_REQUESTED', result: 'failed' }));
  await source.poll();
  assert.match(panelRows(render({ ...f, events: source.events })), /CHANGES/, 'scanning resumes after an oversized line');
  await writeFile(file, '');
  await source.poll();
  assert.deepEqual(source.events, []);
  await writeFile(file, line({ ...f.events[0], runId: 'next' }));
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...f.state, runId: 'next' }));
  await source.poll();
  assert.deepEqual(source.events.map((e) => e.type), ['run_started']);
});

test('legacy role fixture is byte-identical to the old renderer', async () => {
  const hashes = JSON.parse(await readFile(new URL('./fixtures/roles-legacy-hashes.json', import.meta.url), 'utf8'));
  const f = roleFixture('legacy');
  for (const [size, expected] of Object.entries(hashes)) {
    const [dimensions, ascii] = size.split('/');
    const [width, height] = dimensions.split('x').map(Number);
    const out = render(f, { width, height, ascii: ascii === 'true' });
    assert.equal(createHash('sha256').update(out.replace(/\b\d{2}:\d{2}:\d{2}\b/g, '[TIME]')).digest('hex'), expected, size);
    assert.doesNotMatch(out, /OSCAR|HANK|Stage/);
  }
});

test('explicit default workflow is byte-identical to legacy at every invariant size', () => {
  const legacy = roleFixture('legacy');
  for (const source of ['state', 'event', 'both']) {
    const f = structuredClone(legacy);
    if (source !== 'event') f.state.execution = { workflow: { gates: [['angela']] } };
    if (source !== 'state') f.events[0].execution = { workflow: { gates: [['angela']] } };
    for (const width of [20, 24, 39, 40, 59, 60, 80, 100, 120, 160]) {
      for (const height of [3, 8, 12, 24, 40, 50]) {
        for (const color of [false, true]) {
          for (const ascii of [false, true]) {
            const options = { width, height, color, ascii };
            assert.equal(render(f, options), render(legacy, options), `default workflow differs: ${source} ${width}x${height} color=${color} ascii=${ascii}`);
          }
        }
      }
    }
  }
});

test('expanded workflow panels retain last tools and per-agent totals', () => {
  const f = roleFixture();
  for (const id of Object.keys(f.state.agents)) {
    f.state.agents[id].totals = { runs: 7, input: 100, output: 200, cost: 0.25 };
    f.events.push({ v: 1, seq: 100 + f.events.length, runId: f.state.runId, type: 'agent_tool', agent: id, tool: 'grep', detail: 'needle' });
  }
  for (const [width, height] of [[80, 24], [80, 40], [120, 24], [120, 40]]) {
    const boxes = panelRows(render(f, { width, height }));
    assert.equal(boxes.match(/grep/g)?.length, 5, `last tool rows missing at ${width}x${height}`);
    assert.equal(boxes.match(/7 runs/g)?.length, 5, `totals rows missing at ${width}x${height}`);
  }
});

test('breaker and pending human preserve three log rows in every layout mode', () => {
  const f = roleFixture();
  f.state.status = 'paused';
  f.state.breaker = 'tripped';
  f.state.failedCycles = 3;
  f.events.push({ v: 1, seq: 100, runId: f.state.runId, type: 'hitl_request', reason: 'Review needs help', options: ['retry', 'abort'] });
  for (const width of [20, 60, 80, 120]) {
    for (const height of [24, 40]) {
      for (const color of [false, true]) {
        for (const ascii of [false, true]) {
          const out = render(f, { width, height, color, ascii });
          const lines = stripAnsi(out).split('\n');
          const log = lines.findIndex((l) => l.includes('Event log'));
          assert.ok(log >= 0 && lines.length - log - 2 >= 3, `fewer than three log rows at ${width}x${height}`);
          assert.equal(lines.length, height);
          for (const line of lines) assert.ok(visibleWidth(line) <= width);
          if (width >= 80) assert.match(out, /Human needed:/);
          if (color) assertGrayscale(out);
          if (ascii) assert.match(out, /^[\x00-\x7f]*$/);
        }
      }
    }
  }
});

function assertGrayscale(raw) {
  for (const [, body] of raw.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const codes = body.split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 38 || codes[i] === 48) {
        assert.equal(codes[++i], 5);
        assert.ok(codes[++i] >= 232 && codes[i] <= 255, 'colour outside gray ramp');
      } else assert.ok([0, 1, 2, 3, 4, 7, 22, 23, 24, 27, 39, 49].includes(codes[i]), 'non-grayscale SGR');
    }
  }
  assert.doesNotMatch(raw.replace(/\x1b\[[0-9;]*m/g, ''), /\x1b/);
}

test('all role fixtures preserve size, ASCII, grayscale and hostile-text invariants at every existing size', () => {
  for (const kind of ['parallel', 'failed', 'passed', 'legacy']) {
    const f = roleFixture(kind);
    f.state.request += '\x1b[31m\x07\u202e unsafe\n会社';
    f.events.push({ v: 1, seq: 100, runId: f.state.runId, type: 'gate_result', ts: 'bad', agent: 'hank\x1b[31m',
      result: 'failed\n\u202e', keyword: '\x1b]0;evil\x07会社' });
    for (const width of [20, 24, 39, 40, 59, 60, 80, 100, 120, 160]) {
      for (const height of [3, 8, 12, 24, 40, 50]) {
        for (const color of [false, true]) {
          for (const ascii of [false, true]) {
            const out = render(f, { width, height, color, ascii });
            const context = `${kind} ${width}x${height} color=${color} ascii=${ascii}`;
            assert.equal(out.split('\n').length, height, context);
            for (const line of out.split('\n')) assert.ok(visibleWidth(line) <= width, `${context}: ${stripAnsi(line)}`);
            assert.doesNotMatch(out, /[\x07\u202e]/);
            if (ascii) assert.match(out, /^[\x00-\x7f]*$/, context);
            if (color) assertGrayscale(out);
            else assert.doesNotMatch(out, /\x1b/);
          }
        }
      }
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderDashboard } from '../../src/dashboard/render.js';
import { createHiveSource } from '../../src/dashboard/source.js';
import { stripAnsi, visibleWidth } from '../../src/dashboard/text.js';

const root = path.resolve('.scratch/ca-fix-dashboard');
const cli = path.resolve('bin/scranton.js');
const widths = [20, 24, 39, 40, 59, 60, 80, 100, 120, 140, 160];
const heights = [3, 8, 12, 24, 40, 50];
const cases = [
  ['default', [], ['michael', 'dwight', 'angela']],
  ['multi-stage', ['--gates', 'oscar+hank,angela'], ['michael', 'dwight', 'oscar', 'hank', 'angela']],
  ['no-plan', ['--no-plan'], ['michael', 'dwight', 'angela']],
  ['custom', ['--gates', 'seclint,angela'], ['michael', 'dwight', 'seclint', 'angela']],
];

for (const [name, flags, invoked] of cases) test(`real-engine ${name}: workflow owns panels and snapshot metadata is additive`, async (t) => {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hive = path.join(dir, 'hive');
  await mkdir(hive);
  if (name === 'custom') await writeFile(path.join(hive, 'agents.json'), JSON.stringify({ v: 1, agents: {
    seclint: { id: 'seclint', name: 'SecLint', title: 'Static security', instruction: 'Check static security.',
      passKeyword: 'SECLINT_CLEAN', failKeyword: 'SECLINT_DIRTY', tools: ['read'], model: null, thinking: null },
  } }));
  await new Promise((resolve, reject) => execFile(process.execPath,
    [cli, 'demo', '--scenario', 'happy', '--delay', '0', '--hive', hive, '--workspace', path.join(dir, 'ws'), ...flags],
    { cwd: dir, timeout: 60000, env: { ...process.env, NO_COLOR: '1', SCRANTON_DATA: '', SCRANTON_ISOLATION_ROOT: path.join(dir, 'isolation') } },
    (err, stdout, stderr) => err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve()));
  const source = createHiveSource(hive); await source.poll();
  const state = source.state;
  const events = (await readFile(path.join(hive, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'run_finished');
  assert.equal(events.at(-1).status, 'success');
  assert.deepEqual(events[0].roles.map((r) => r.id), invoked);
  const stripped = structuredClone(state); delete stripped.roles;
  const strippedEvents = events.map((e) => { const copy = { ...e }; delete copy.roles; return copy; });
  const now = Date.parse(state.updatedAt);
  for (const width of widths) for (const height of heights) for (const color of [false, true]) for (const ascii of [false, true]) {
    const options = { width, height, color, ascii, now };
    const frame = renderDashboard(state, events, options);
    const context = `${name} ${width}x${height} color=${color} ascii=${ascii}`;
    if (name !== 'custom') {
      assert.equal(frame, renderDashboard(stripped, strippedEvents, options), `roles metadata changed legacy rendering: ${context}`);
      const empty = { ...state, roles: [] };
      assert.equal(frame, renderDashboard(empty, events.map((e) => e.type === 'run_started' ? { ...e, roles: [] } : e), options), `empty roles changed rendering: ${context}`);
    }
    const lines = stripAnsi(frame).split('\n');
    assert.equal(lines.length, height, context);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, context);
    assert.doesNotMatch(stripAnsi(frame), /[\x00-\x09\x0b-\x1f\x7f\u202e]/, context);
    if (ascii) assert.match(frame, /^[\x00-\x7f]*$/, context);
    if (!color) assert.doesNotMatch(frame, /\x1b/, context);
    for (const [, codes] of frame.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const values = codes.split(';').map(Number);
      for (let i = 0; i < values.length; i++) {
        if ([38, 48].includes(values[i])) { assert.equal(values[++i], 5, context); assert.ok(values[++i] >= 232 && values[i] <= 255, context); }
        else assert.ok([0, 1, 2, 3, 4, 7, 22, 23, 24, 27, 39, 49].includes(values[i]), context);
      }
    }
    if (height >= 24 && width >= 40) {
      const log = lines.findIndex((line) => line.includes('Event log'));
      assert.ok(log >= 0 && height - log - 2 >= 3, context);
    }
  }
  const out = stripAnsi(renderDashboard(state, source.events, { width: 160, height: 50, color: false, ascii: true, now }));
  const displayed = ['michael', 'dwight', ...events[0].execution.workflow.gates.flat()];
  for (const id of ['michael', 'dwight', 'oscar', 'hank', 'angela', 'seclint']) {
    if (displayed.includes(id)) assert.match(out, new RegExp(id.toUpperCase()));
    else assert.doesNotMatch(out, new RegExp(id.toUpperCase()), `uninvoked role ${id}`);
  }
  if (name === 'custom') for (const text of ['SECLINT', 'Static security', 'PASSED']) assert.ok(out.includes(text), `missing custom metadata/verdict ${text}`);
});

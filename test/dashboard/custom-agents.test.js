import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderDashboard } from '../../src/dashboard/render.js';
import { createHiveSource } from '../../src/dashboard/source.js';
import { stripAnsi, visibleWidth } from '../../src/dashboard/text.js';
import { customFixture } from './fixtures/custom-agents.js';
import { roleFixture } from './fixtures/roles.js';

const WIDTHS = [20, 24, 39, 40, 59, 60, 80, 100, 120, 140, 160];
const HEIGHTS = [3, 8, 12, 24, 40, 50];
const render = (f, options = {}) => renderDashboard(f.state, f.events, { width: 140, height: 40, color: false, ascii: true, now: f.now, ...options });
const panels = (out) => out.split('\n').slice(0, out.split('\n').findIndex((line) => line.includes('Milestones  '))).join('\n');

function grayscale(out) {
  for (const [, body] of out.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const codes = body.split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 38 || codes[i] === 48) {
        assert.equal(codes[++i], 5);
        assert.ok(codes[++i] >= 232 && codes[i] <= 255);
      } else assert.ok([0, 1, 2, 3, 4, 7, 22, 23, 24, 27, 39, 49].includes(codes[i]));
    }
  }
  assert.doesNotMatch(out.replace(/\x1b\[[0-9;]*m/g, ''), /\x1b/);
}

test('six-role parallel run uses compact rows, custom verdicts and concurrent custom lanes', () => {
  for (const [width, height] of [[80, 24], [140, 40]]) {
    const out = render(customFixture(), { width, height });
    const rows = panels(out).split('\n');
    // compact rows lead with the Short name; 'QA' alone also appears in the stage line, so match the row start
    const names = ['PLANNER', 'DEVELOPER', 'REVIEWER', 'SECLINT', 'POLICY', 'QA'];
    const role = (line) => names.find((name) => new RegExp(`^ \\S ${name} `).test(line));
    for (const name of names) assert.equal(rows.filter((line) => role(line) === name).length, 1, `missing compact role ${name}`);
    assert.deepEqual(rows.filter(role).map(role), names);
    assert.doesNotMatch(out, /SECURITY|Security/);
    assert.match(panels(out), /SECLINT.*PASSED/);
    assert.match(out, /Stage 1:.*\(parallel\).*Stage 2: QA/);
    assert.match(out, /Policy - m1/);
    assert.doesNotMatch(out, /\+-/);
    assert.match(out, /SecLint gate passed SECLINT_CLEAN/);
  }
});

test('custom fail and BLOCKED use own keywords; built-in review wording stays intact', () => {
  const f = customFixture('failed');
  const out = render(f);
  assert.match(panels(out), /SECLINT.*FAILED/);
  assert.match(panels(out), /REVIEWER.*CHANGES/);
  assert.match(out, /SecLint gate failed SECLINT_DIRTY/);
  const ev = f.events.find((e) => e.agent === 'seclint');
  ev.keyword = 'BLOCKED'; ev.result = 'blocked';
  assert.match(panels(render(f)), /SECLINT.*BLOCKED/);
  ev.keyword = 'TEST_PASSED'; ev.result = 'passed';
  assert.match(panels(render(f)), /SECLINT.*FAILED/, 'foreign pass keyword must never pass a custom gate');
});

test('metadata comes from same-run start first, state second; state-only own verdicts render', () => {
  const f = customFixture();
  f.state.roles = structuredClone(f.state.roles);
  f.state.roles[3].name = 'State name';
  assert.match(render(f), /SECLINT/);
  f.events = [];
  f.state.agents.seclint.lastKeyword = 'SECLINT_CLEAN';
  assert.match(render(f), /STATE NAME.*PASSED/);
  f.events = [{ ...customFixture().events[0], runId: 'another-run' }];
  assert.match(render(f), /STATE NAME/);
  f.state.roles[3].name = '';
  f.state.roles[0].name = ''; f.state.roles[0].title = '';
  assert.match(render(f), /PLANNER/);
});

test('custom names and titles are safe and fitted even in a small five-role grid', () => {
  const f = customFixture('hostile');
  f.state.roles = f.state.roles.filter((r) => !['hank', 'angela'].includes(r.id));
  f.events[0].roles = f.state.roles;
  f.state.execution.workflow.gates = f.events[0].execution.workflow.gates = [['oscar', 'seclint', 'policy']];
  for (const width of [80, 120, 140]) for (const ascii of [false, true]) {
    const out = render(f, { width, ascii });
    assert.doesNotMatch(out, /[\x00-\x09\x0b-\x1f\x7f\u202e]/);
    for (const line of out.split('\n')) assert.ok(visibleWidth(line) <= width);
    if (ascii) assert.match(out, /^[\x00-\x7f]*$/);
    assert.match(out, /SEC/);
  }
});

test('a long custom name is cut on its own compact row and never starves the built-in rows', () => {
  const f = customFixture();
  const a11y = { ...f.state.roles[3], id: 'a11y', name: 'Accessibility Reviewer', title: 'Accessibility',
    passKeyword: 'A11Y_CLEAN', failKeyword: 'A11Y_DIRTY', keywords: ['A11Y_CLEAN', 'A11Y_DIRTY', 'BLOCKED'] };
  const roles = [f.state.roles[0], f.state.roles[1], a11y, f.state.roles[5]];
  const gates = [['a11y'], ['angela']];
  f.state.roles = roles;
  f.state.execution.workflow.gates = gates;
  f.events = [{ ...f.events[0], roles, execution: { workflow: { gates } } }];
  f.state.instances = {};
  f.state.agents.a11y = { status: 'done', activity: 'Contrast checked', lastKeyword: 'A11Y_CLEAN', totals: {} };
  f.state.agents.dwight = { ...f.state.agents.dwight, status: 'blocked', lastKeyword: 'BLOCKED' };
  f.state.agents.angela = { ...f.state.agents.angela, status: 'done', activity: 'Two tests fail', lastKeyword: 'TEST_FAILED' };
  const verdict = (agent, keyword, result, stage) => ({ v: 1, seq: f.events.length + 1, ts: f.state.updatedAt, runId: f.state.runId,
    type: 'gate_result', agent, keyword, result, stage, milestoneId: 'm1', cycle: 2, instanceId: `${agent}-m1` });
  f.events.push(verdict('a11y', 'A11Y_CLEAN', 'passed', 0));
  f.events.push(verdict('angela', 'TEST_FAILED', 'failed', 1));
  const builtins = [['PLANNER', 'DONE', 'PLAN_READY', 'Plan ready'], ['DEVELOPER', 'BLOCKED', 'BLOCKED', 'Snapshot ready'],
    ['QA', 'DONE', 'TEST FAILED', 'Two tests fail']];
  for (const width of [40, 39]) for (const ascii of [false, true]) {
    const ell = ascii ? '...' : '…';
    const lines = render(f, { width, height: 20, ascii }).split('\n');
    const context = `${width} ascii=${ascii}`;
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${context}: ${line}`);
    const row = (name) => lines.find((line) => new RegExp(`^ ?\\S ${name}\\s`).test(line));
    for (const [name, word, keyword, activity] of builtins) {
      const line = row(name);
      assert.ok(line, `${context}: missing ${name} row`);
      const rest = line.replace(new RegExp(`^ ?\\S ${name}\\s+`), '');
      assert.ok(rest.startsWith(`${word} `), `${context}: ${name} lost its status word: ${line}`);
      assert.ok(rest.endsWith(` ${keyword}`), `${context}: ${name} lost its keyword: ${line}`);
      // ASCII cuts cost three cells, so only the one-cell ellipsis is held to a visible activity at 40 columns.
      const shown = rest.slice(word.length, -keyword.length).trim().replace(ell, '');
      if (!ascii) assert.ok(shown.length && activity.startsWith(shown), `${context}: ${name} lost its activity: ${line}`);
    }
    assert.ok(lines.some((line) => line.includes(`ACCESS${ascii ? '' : 'IB'}${ell} DONE`)), `${context}: custom name not cut`);
  }
});

test('new fixtures keep size, fill, ASCII, grayscale and log budget with alerts at every invariant size', () => {
  for (const kind of ['mid-stage', 'failed', 'hostile']) for (const alert of [false, true]) {
    const f = customFixture(kind);
    if (alert) {
      f.state.status = 'paused'; f.state.breaker = 'tripped'; f.state.failedCycles = 3;
      f.events.push({ type: 'hitl_request', reason: 'Custom gate needs help', options: ['retry', 'abort'] });
    }
    for (const width of WIDTHS) for (const height of HEIGHTS) for (const color of [false, true]) for (const ascii of [false, true]) {
      const out = render(f, { width, height, color, ascii });
      const lines = stripAnsi(out).split('\n');
      const context = `${kind} ${width}x${height} ${color}/${ascii} alert=${alert}`;
      assert.equal(lines.length, height, context);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, context);
      assert.doesNotMatch(stripAnsi(out), /[\x00-\x09\x0b-\x1f\x7f\u202e]/);
      if (ascii) assert.match(out, /^[\x00-\x7f]*$/);
      if (color) grayscale(out); else assert.doesNotMatch(out, /\x1b/);
      if (height >= 24) {
        const log = lines.findIndex((line) => line.includes('Event log'));
        assert.ok(log >= 0 && lines.length - log - 2 >= 3, context);
        if (alert && width >= 80) assert.match(out, /Human needed:/);
      }
    }
  }
});

test('17-role capacity keeps three log rows and alerts at height 24', () => {
  const f = customFixture();
  f.state.execution.workflow.gates[0].push('hank');
  f.state.roles.push({ id: 'hank', name: 'Hank', title: 'Security Auditor', kind: 'gate', builtin: true });
  for (let i = 0; i < 10; i++) {
    const role = { ...f.state.roles[3], id: `gate${i}`, name: `Gate ${i}` };
    f.state.roles.push(role); f.state.agents[role.id] = {};
    f.state.execution.workflow.gates[0].push(role.id);
  }
  f.state.status = 'paused';
  for (const width of [80, 140]) {
    const out = render(f, { width, height: 24 });
    assert.match(out, /more roles/);
    assert.match(out, /PAUSED/);
    const lines = out.split('\n');
    assert.ok(lines.length - lines.findIndex((line) => line.includes('Event log')) - 2 >= 3);
  }
});

test('custom verdicts survive tool traffic, reconnect and bounded source retention', async (t) => {
  const root = path.resolve('.scratch/ca-fix-dashboard');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = customFixture('failed');
  const line = (e) => JSON.stringify(e) + '\n';
  const padding = Array.from({ length: 100 }, (_, i) => ({ type: 'log', level: 'info', seq: 1000 + i, runId: f.state.runId, message: 'tool '.repeat(100) }));
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(f.state));
  await writeFile(path.join(dir, 'events.jsonl'), [...f.events, ...padding].map(line).join(''));
  for (let i = 0; i < 2; i++) {
    const source = createHiveSource(dir, { tailBytes: 2048, maxEvents: 12 });
    await source.poll();
    assert.ok(source.events.some((e) => e.type === 'gate_result' && e.agent === 'seclint'), 'custom verdict must survive log tail');
    assert.ok(source.events.length <= 12);
    assert.match(panels(render({ ...f, events: source.events })), /SECLINT.*FAILED/);
  }
  const many = Array.from({ length: 1000 }, (_, i) => ({ ...f.events[1], seq: i + 2, milestoneId: `m${i}` }));
  await writeFile(path.join(dir, 'events.jsonl'), [f.events[0], ...many, ...padding.map((e) => ({ ...e, seq: e.seq + 2000 }))].map(line).join(''));
  const source = createHiveSource(dir, { tailBytes: 2048 }); await source.poll();
  assert.equal(source.events.filter((e) => e.type === 'gate_result').length, 119, 'retention is bounded to 17 roles times seven milestones');
  assert.ok(source.events.length <= 500);
});

test('all existing fixtures with at most five roles remain byte-identical in every mode', async () => {
  const hashes = JSON.parse(await readFile(new URL('./fixtures/custom-agents-legacy-hashes.json', import.meta.url), 'utf8'));
  const fixtures = {};
  for (const name of ['idle', 'running', 'tripped', 'finished', 'aborted', 'parallel']) {
    const source = createHiveSource(path.resolve('test/dashboard/fixtures', name)); await source.poll();
    fixtures[name] = { state: source.state, events: source.events, now: source.state ? Date.parse(source.state.updatedAt) + 7000 : Date.parse('2025-06-14T12:00:00Z') };
  }
  for (const kind of ['parallel', 'failed', 'passed', 'legacy']) fixtures[`roles-${kind}`] = roleFixture(kind);
  for (const [key, expected] of Object.entries(hashes)) {
    const [name, dimensions, color, ascii] = key.split('/');
    const [width, height] = dimensions.split('x').map(Number);
    const out = render(fixtures[name], { width, height, color: color === 'true', ascii: ascii === 'true' });
    assert.equal(createHash('sha256').update(out.replace(/\b\d{2}:\d{2}:\d{2}\b/g, '[TIME]')).digest('hex'), expected, key);
  }
});

test('single-role snapshots do not override workflow role selection', () => {
  for (const id of ['michael', 'dwight', 'seclint']) for (const width of [80, 140]) {
    const f = customFixture();
    f.state.roles = f.state.roles.filter((role) => role.id === id);
    delete f.state.execution;
    f.events = [];
    const out = render(f, { width });
    for (const name of ['PLANNER', 'DEVELOPER', 'QA TESTER']) assert.match(out, new RegExp(name));
    assert.doesNotMatch(out, /SECLINT|CODE REVIEWER|SECURITY AUDITOR|Stage/);
    assert.equal(out.split('\n').length, 40);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderDashboard } from '../../src/dashboard/render.js';
import { createHiveSource, parseEventLines } from '../../src/dashboard/source.js';
import { stripAnsi, visibleWidth } from '../../src/dashboard/text.js';

const root = path.resolve('.scratch/chat-terminal');
const widths = [20, 24, 39, 40, 59, 60, 80, 100, 120, 140, 160];
const heights = [3, 8, 12, 24, 40, 50];
const ts = '2025-06-14T12:00:00Z';
const now = Date.parse(ts);
const hostile = [
  'Visible\x00\x07\x08\t\r\ncontrol\x7f\x9b text',
  '\x1b[2J\x1b[31mVisible\x1b[0m \x1b]0;hostile title\x07safe',
  'Visible invoice\u202eexe.pdf\u2066 text\u2069',
  'Visible 😀 漢字 fullwidth Ｗ',
  'Visible ' + 'x'.repeat(15992),
  'Visible\n' + '\nline\n'.repeat(2000),
];

function fixture(kind = 'report', text = 'Implemented storage and verified the tests.') {
  const reply = { from: kind === 'summary' ? 'system' : 'michael', kind, text };
  const state = { v: 1, runId: 'conversation', status: kind === 'summary' ? 'aborted' : 'finished',
    request: 'Inspect the workspace', workspace: '/workspace', updatedAt: ts, lastSeq: 5,
    execution: { conversation: true }, agents: {}, milestones: kind === 'answer' ? [] : [
      { id: 'm1', title: 'Storage', status: kind === 'summary' ? 'aborted' : 'passed' },
    ], reply };
  const events = [
    { type: 'run_started', request: state.request, execution: state.execution },
    { type: 'agent_message', agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, final: false, text: 'INTERMEDIATE_SECRET' },
    { type: 'agent_message', agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, final: true, text: 'FINAL_SECRET' },
    { type: 'run_reply', ...reply },
    { type: 'run_finished', status: kind === 'summary' ? 'aborted' : 'success', summary: 'Run outcome' },
  ].map((e, i) => ({ v: 1, runId: state.runId, seq: i + 1, ts, ...e }));
  return { state, events };
}

function frame(f, options = {}) {
  return renderDashboard(f.state, f.events, { width: 80, height: 24, ascii: true, color: false, now, ...options });
}

function invariants(out, width, height, color, ascii) {
  const plain = stripAnsi(out);
  assert.equal(plain.split('\n').length, height);
  for (const line of plain.split('\n')) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  assert.doesNotMatch(plain, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  if (ascii) assert.match(out, /^[\x00-\x7f]*$/);
  if (!color) assert.doesNotMatch(out, /\x1b/);
  for (const [, body] of out.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const codes = body.split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      if ([38, 48].includes(codes[i])) { assert.equal(codes[++i], 5); assert.ok(codes[++i] >= 232 && codes[i] <= 255); }
      else assert.ok([0, 1, 2, 3, 4, 7, 22, 23, 24, 27, 39, 49].includes(codes[i]));
    }
  }
}

for (const kind of ['answer', 'report', 'summary']) test(`conversation ${kind}: one reply log row, finished summary, no assistant log rows`, () => {
  const f = fixture(kind);
  const parsed = parseEventLines(f.events.map((e) => JSON.stringify(e) + '\n').join(''));
  assert.equal(parsed.filter((e) => e.type === 'agent_message').length, 2, 'source accepts intermediate and final assistant messages');
  assert.equal(parsed.filter((e) => e.type === 'run_reply').length, 1, 'source accepts the reply');
  const out = frame({ ...f, events: parsed });
  assert.ok(out.includes(`-- Reply (${kind}) --`), 'finished summary contains reply header');
  assert.ok(out.includes(f.state.reply.text), 'finished summary contains reply text');
  assert.equal(out.split('\n').filter((l) => l.includes(`reply [${kind}]`)).length, 1);
  assert.doesNotMatch(out, /INTERMEDIATE_SECRET|FINAL_SECRET/);
  assert.equal(frame(f), frame({ ...f, events: f.events.filter((e) => e.type !== 'agent_message') }), 'messages do not consume log rows');
  for (const width of widths) for (const height of heights) for (const color of [false, true]) for (const ascii of [false, true]) {
    const options = { width, height, color, ascii };
    const rendered = frame(f, options);
    invariants(rendered, width, height, color, ascii);
    assert.equal(rendered, frame({ state: { ...f.state, reply: null }, events: f.events }, options), 'event and snapshot reply render identically');
    if (height >= 24 && width >= 40) {
      const lines = stripAnsi(rendered).split('\n');
      const log = lines.findIndex((l) => l.includes('Event log'));
      assert.ok(log >= 0 && height - log - 2 >= 3, 'keep minimum event log rows');
      assert.ok(rendered.includes(`Reply (${kind})`));
    }
  }
});

test('conversation hostile replies remain safe and fitted at every invariant size', () => {
  for (const text of hostile) {
    const f = fixture('report', text);
    for (const width of widths) for (const height of heights) for (const color of [false, true]) for (const ascii of [false, true]) {
      invariants(frame(f, { width, height, color, ascii }), width, height, color, ascii);
    }
    const out = frame(f, { width: 160, height: 50 });
    assert.match(out, /Visible/, 'safe reply excerpt survives');
    assert.doesNotMatch(out, /hostile title/);
    const log = out.split('\n').find((l) => l.includes('reply [report]'));
    assert.ok(visibleWidth(log.slice(log.indexOf('reply [report]') + 'reply [report] '.length)) <= 80, 'reply log excerpt capped at 80 cells');
  }
});

test('snapshot reply works without a reply event and ignores a foreign run reply', () => {
  const f = fixture();
  const missingReply = { ...f.state }; delete missingReply.reply;
  assert.equal(frame({ state: missingReply, events: f.events }), frame(f), 'missing snapshot reply is null until the event arrives');
  const events = f.events.filter((e) => e.type !== 'run_reply');
  assert.match(frame({ ...f, events }), /-- Reply \(report\) --/);
  const out = frame({ state: { ...f.state, reply: null }, events: [...events, { ...f.events[3], runId: 'other' }] });
  assert.doesNotMatch(out.split('Event log')[0], /Reply \(report\)/);
});

test('real-engine conversation demo: journal and state render the same reply', async (t) => {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hive = path.join(dir, 'hive');
  await new Promise((resolve, reject) => execFile(process.execPath,
    [path.resolve('bin/scranton.js'), 'demo', '--conversation', '--scenario', 'happy', '--delay', '0', '--hive', hive, '--workspace', path.join(dir, 'ws')],
    { cwd: dir, timeout: 60000, env: { ...process.env, NO_COLOR: '1', SCRANTON_DATA: '', SCRANTON_ISOLATION_ROOT: path.join(dir, 'isolation') } },
    (err, stdout, stderr) => err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve()));
  const source = createHiveSource(hive); await source.poll();
  const state = JSON.parse(await readFile(path.join(hive, 'state.json'), 'utf8'));
  const events = parseEventLines(await readFile(path.join(hive, 'events.jsonl'), 'utf8'));
  assert.ok(events.some((e) => e.type === 'agent_message' && !e.final));
  assert.ok(events.some((e) => e.type === 'agent_message' && e.final));
  assert.equal(events.filter((e) => e.type === 'run_reply').length, 1);
  assert.equal(events.at(-2).type, 'run_reply');
  assert.equal(events.at(-1).type, 'run_finished');
  assert.equal(state.reply.kind, 'report');
  const options = { width: 80, height: 24, ascii: true, color: false, now: Date.parse(state.updatedAt) };
  const out = renderDashboard(state, source.events, options);
  assert.match(out, /-- Reply \(report\) --/);
  assert.match(out, /reply \[report\]/);
  assert.equal(out, renderDashboard({ ...state, reply: null }, source.events, options));
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  const snapshot = createHiveSource(dir); await snapshot.poll();
  assert.ok(renderDashboard(snapshot.state, [], options).includes('-- Reply (report) --'));
});

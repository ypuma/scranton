import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createContext } from '../../src/core/context/index.js';
import { createContextStore } from '../../src/core/context/store.js';
import { buildTeamPack, buildPipelineContext, condensedTurn } from '../../src/core/context/pack.js';
import { clip, readTurns } from '../../src/core/context/turns.js';
import { listRuns, listContextRuns } from '../../src/core/thread.js';
import { buildPipelineHistory } from '../../src/core/pipeline-history.js';
import { replaceDuringRead } from './fixtures/replace-during-read.js';

function fixture(t) {
  const base = path.resolve('.scratch/context-system/lane-a2'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'review-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const chats = [], projectId = 'project';
  const chat = (id, engine = 'team') => { const c = { id, projectId, engine, title: id, updatedAt: '2026-02-01T00:00:00Z', hiveDir: path.join(dataDir, 'projects', projectId, 'chats', id, 'hive') }; chats.push(c); return c; };
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const team = (c, id, request = id, extra = []) => write(path.join(c.hiveDir, 'runs', id, 'events.jsonl'), [{ type: 'run_started', runId: id, request, ts: '2026-01-01T00:00:00Z' }, ...extra.map((e) => ({ runId: id, ...e })), { type: 'run_finished', runId: id, status: 'success', summary: 'Done', ts: '2026-01-02T00:00:00Z' }].map(JSON.stringify).join('\n') + '\n');
  const pipelineRoot = (c) => path.join(dataDir, 'projects', projectId, 'chats', c.id, 'pipeline');
  const pipeline = (c, id) => { const root = path.join(pipelineRoot(c), 'runs', id); write(path.join(root, 'status.json'), { status: 'succeeded', created_at: '2026-01-01T00:00:00Z', task: id }); write(path.join(root, 'run.json'), { task: id }); return root; };
  const registry = { getProject: () => ({ id: projectId }), getChat: (p, id) => chats.find((c) => c.id === id), listChats: () => chats };
  const context = createContext({ dataDir, registry });
  return { dataDir, projectId, chats, chat, write, team, pipeline, pipelineRoot, registry, context };
}
const turn = (bad = '') => ({ id: 'run1', index: 1, status: 'success', request: 'request' + bad, outcome: 'outcome' + bad, plan: [{ title: 'plan' + bad, status: 'passed' }], files: ['src/file' + bad + '.js'], reply: { kind: 'report', text: 'reply' + bad } });
function wellFormed(value) {
  if (typeof value === 'string') assert.equal(value.isWellFormed(), true, JSON.stringify(value));
  else if (value && typeof value === 'object') for (const v of Object.values(value)) wellFormed(v);
}

test('R1 all emitted strings repair lone high and low surrogates before and after clipping', async (t) => {
  const f = fixture(t), c = f.chat('pipe', 'pipeline'), root = f.pipeline(c, 'run1');
  for (const bad of ['\ud83d', '\ude00']) {
    const row = turn(bad), title = 'a'.repeat(59) + bad;
    wellFormed(clip(bad + '😀', 2));
    wellFormed(buildTeamPack({ turns: [row], notes: 'notes' + bad, otherChats: [{ title, engine: 'team', turns: [row] }] }));
    const raw = buildPipelineContext({ turns: [row], notes: 'notes' + bad, otherChats: [{ title, engine: 'team', turns: [row] }] });
    wellFormed(raw);
    f.write(path.join(root, 'run.json'), { task: row.request });
    f.write(path.join(root, 'delivery/reply.json'), row.reply);
    f.write(path.join(root, 'artifacts/plan.json'), { summary: row.outcome, steps: [{ title: title, files: [{ path: row.files[0] }] }] });
    const wire = buildPipelineHistory({ dataDir: f.dataDir, projectId: f.projectId, chatId: c.id, context: raw });
    wellFormed(wire); wellFormed(JSON.parse(wire.runs[0].plan)); wellFormed(JSON.parse(wire.runs[0].outcome));
    const store = createContextStore(f.dataDir, f.projectId); store.setNotes(bad); wellFormed(store.notes());
  }
});

test('R2 sibling pack exhaustion cannot erase legacy Pipeline runs or double-read own artifacts', async (t) => {
  const f = fixture(t), c = f.chat('pipe', 'pipeline'); f.pipeline(c, 'run1');
  const ownRoot = path.join(f.pipelineRoot(c), 'runs/run1');
  const ownBytes = ['status.json', 'run.json'].reduce((n, file) => n + fs.statSync(path.join(ownRoot, file)).size, 0);
  for (let i = 0; i < 4; i++) {
    const sibling = f.chat('sibling' + i);
    for (let j = 0; j < 4; j++) {
      const file = f.team(sibling, 'run' + j), size = 4 * 1024 * 1024 - (i === 3 && j === 0 ? ownBytes : 0);
      fs.appendFileSync(file, ' '.repeat(size - fs.statSync(file).size)); fs.utimesSync(path.dirname(file), j + 1, j + 1);
    }
  }
  f.team(f.chat('sibling4'), 'overflow');
  const opened = new Map(), open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (typeof file === 'string' && file.includes(`${path.sep}pipe${path.sep}pipeline${path.sep}runs${path.sep}`)) opened.set(file, (opened.get(file) ?? 0) + 1); return open(file, ...args); });
  const wire = f.context.forPipeline(f.projectId, c.id);
  assert.deepEqual(wire.runs.map((r) => r.run_id), ['run1']);
  assert.equal(wire.truncated, true);
  assert.ok([...opened.values()].every((n) => n === 1), 'each existing own artifact is opened once');
});

test('R2 legacy plan anchor outside the new 500-run scan remains eligible', async (t) => {
  const f = fixture(t), c = f.chat('pipe', 'pipeline');
  const root = f.pipeline(c, 'anchor'); f.write(path.join(root, 'artifacts/plan.json'), { summary: 'anchor', steps: [{ title: 'Keep anchor' }] }); fs.utimesSync(root, 1, 1);
  for (let i = 0; i < 501; i++) { const dir = path.join(f.pipelineRoot(c), 'runs', 'busy' + i); f.write(path.join(dir, 'status.json'), { status: 'running' }); fs.utimesSync(dir, i + 2, i + 2); }
  assert.deepEqual(f.context.forPipeline(f.projectId, c.id)?.runs.map((r) => r.run_id), ['anchor']);
});

test('R3 null agents do not discard good turns, notes or sibling context', async (t) => {
  const f = fixture(t), c = f.chat('own'), sibling = f.chat('sibling'); f.team(c, 'good', 'GOOD'); f.team(sibling, 'other', 'SIBLING');
  f.write(path.join(c.hiveDir, 'state.json'), { runId: 'corrupt', agents: { x: null } });
  (await f.context.setNotes(f.projectId, 'NOTES'));
  assert.doesNotThrow(() => listRuns(c.hiveDir));
  const pack = f.context.forTeam(f.projectId, c.id);
  for (const text of ['GOOD', 'SIBLING', 'NOTES']) assert.ok(pack.text.includes(text), text);
});

test('R3 an unexpected per-run projection error only degrades that run', async (t) => {
  const f = fixture(t), c = f.chat('own'); f.team(c, 'good', 'GOOD');
  f.write(path.join(c.hiveDir, 'runs/bad/state.json'), { runId: 'bad', agents: { explode: true } });
  const values = Object.values;
  t.mock.method(Object, 'values', (obj) => { if (obj?.explode === true) throw Error('broken run projection'); return values(obj); });
  const pack = f.context.forTeam(f.projectId, c.id);
  assert.match(pack.text, /GOOD/); assert.equal(pack.meta.degraded, true); assert.equal(pack.meta.truncated, true);
});

test('R4 project status/configure/setNotes never open journals and use cheap counts and chat activity', async (t) => {
  const f = fixture(t), c = f.chat('own'), p = f.chat('pipe', 'pipeline'); f.team(c, 'archived');
  f.write(path.join(c.hiveDir, 'state.json'), { runId: 'root' }); f.team(c, 'empty'); fs.rmSync(path.join(c.hiveDir, 'runs/empty/events.jsonl'));
  f.pipeline(p, 'done'); f.write(path.join(f.pipelineRoot(p), 'runs/busy/status.json'), { status: 'running' });
  createContextStore(f.dataDir, f.projectId, c.id).setReset('2026-01-31');
  const open = fs.openSync; let journals = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (String(file).endsWith('events.jsonl')) { journals++; throw Error('journal reads forbidden'); } return open(file, ...args); });
  for (const doc of [(await f.context.status(f.projectId)), (await f.context.configure(f.projectId, { crossChat: false })), (await f.context.setNotes(f.projectId, 'notes'))]) {
    const own = doc.chats.find((r) => r.id === c.id), pipe = doc.chats.find((r) => r.id === p.id);
    assert.equal(own.turns, 3); assert.equal(pipe.turns, 1); assert.equal(own.lastActiveAt, c.updatedAt); assert.equal(own.reset, true);
  }
  assert.equal(journals, 0);
});

for (const engine of ['team', 'pipeline']) test(`R5 ${engine} budget stops before older runs and reset retains explicit omissions`, async (t) => {
  const f = fixture(t), c = f.chat('own', engine);
  if (engine === 'team') {
    const old = f.team(c, 'old'), newer = f.team(c, 'new', 'N'.repeat(2000));
    fs.utimesSync(path.dirname(old), 1, 1); fs.utimesSync(path.dirname(newer), 2, 2);
  } else {
    const old = f.pipeline(c, 'old'), newer = f.pipeline(c, 'new'); f.write(path.join(newer, 'status.json'), { status: 'succeeded', task: 'N'.repeat(2000), created_at: '2026-01-02' });
    fs.utimesSync(old, 1, 1); fs.utimesSync(newer, 2, 2);
  }
  const result = readTurns({ dataDir: f.dataDir, projectId: f.projectId, chat: c, budget: { bytes: 500 }, since: '2025-01-01' });
  assert.deepEqual(result.turns, []); assert.equal(result.unread, 2); assert.equal(result.total, 2); assert.equal(result.truncated, true);
  const pack = buildTeamPack(result); assert.match(pack.text, /2 earlier turns omitted/);
});

test('R6 whitespace-only notes stay empty and condensed empty outcomes have no dangling separator', () => {
  const pack = buildTeamPack({ notes: ' \n\t ' }); assert.equal(pack.text, ''); assert.equal(pack.developer, '');
  const line = condensedTurn({ ...turn(), outcome: ' \n ' }); assert.equal(line, line.trim()); assert.doesNotMatch(line, /->/);
});

test('R7 redact credentials before any request/reply/file or Pipeline line cut', async (t) => {
  const f = fixture(t), c = f.chat('own');
  const key = 'sk-ABCDEF0123456789abcdefghijklmnop', row = { ...turn(), request: 'R'.repeat(145) + ' ' + key };
  assert.doesNotMatch(buildPipelineContext({ turns: [row] }).lines[0].line, /sk-ABC/);
  f.team(c, 'run1', 'R'.repeat(3989) + ' ' + key, [{ type: 'run_reply', kind: 'report', text: 'R'.repeat(15989) + ' ' + key }, { type: 'agent_tool', agent: 'dwight', tool: 'edit', targetFile: 'src/' + key }]);
  const turns = readTurns({ dataDir: f.dataDir, projectId: f.projectId, chat: c }).turns;
  assert.doesNotMatch(JSON.stringify(turns), /sk-ABC/);
});

for (const phase of ['open', 'read']) for (const reuseIndex of [false, true]) test(`R8 hardened Team reader rejects same-size path replacement at ${phase} (${reuseIndex ? 'reused' : 'native'} index)`, async (t) => {
  const f = fixture(t), c = f.chat('own'), file = f.team(c, 'run1', 'ORIGINAL'); f.team(c, 'good', 'HEALTHY');
  const replaced = replaceDuringRead(t, file, phase, reuseIndex);
  const result = listContextRuns(c.hiveDir); assert.equal(replaced(), true); assert.doesNotMatch(JSON.stringify(result.runs), /ORIGINAL/);
  assert.equal(result.degraded, true); assert.equal(result.runs.find((r) => r.id === 'good').request, 'HEALTHY');
});

test('R8 context storage reports context paths, not dreaming paths', async (t) => {
  const f = fixture(t), victim = path.join(f.dataDir, 'victim'); fs.mkdirSync(victim);
  fs.mkdirSync(path.join(f.dataDir, 'projects')); fs.symlinkSync(victim, path.join(f.dataDir, 'projects/project'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createContextStore(f.dataDir, f.projectId).setNotes('notes'), (e) => /context path/i.test(e.message) && !/dreaming/i.test(e.message));
});

const delimiterVariants = (tag) => ['', ' ', '\t', '\n', '\r\n', '\u00a0'].flatMap((before) => ['', '/'].flatMap((slash) => ['', ' ', '\t', '\n'].map((after) => `<${before}${slash}${after}${tag.toUpperCase()} \t>`)));

test('A3 packs neutralise whitespace delimiter variants before either consumer sees them', () => {
  const hostile = ['earlier-runs', 'conversation-context'].flatMap(delimiterVariants).join(' ');
  const row = { ...turn(), request: hostile, outcome: hostile, plan: [{ title: hostile, status: 'passed' }], reply: { kind: 'report', text: hostile } };
  const pack = buildTeamPack({ turns: [row], notes: hostile, memory: hostile, otherChats: [{ title: hostile, engine: 'team', turns: [row] }] });
  for (const text of [pack.text, pack.developer]) {
    assert.doesNotMatch(text, /<\s*\/?\s*(?:earlier-runs|conversation-context)\s*>/i);
    assert.equal(text.replace(/<\s*\/?\s*earlier-runs\s*>/gi, '[earlier-runs]'), text, 'planner sanitisation is a no-op');
    assert.equal(text.replace(/<\s*\/?\s*conversation-context\s*>/gi, '[conversation-context]'), text, 'developer sanitisation is a no-op');
  }
});

for (const mode of ['legacy', 'context']) test(`A3 ${mode} Pipeline history rejects hard-linked artifacts independently`, async (t) => {
  const base = path.resolve('.scratch/context-system/lane-a3'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'hardlink-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const scope = { dataDir, projectId: 'project', chatId: 'chat' };
  const root = path.join(dataDir, 'projects/project/chats/chat/pipeline/runs');
  const write = (id, file, value) => { const name = path.join(root, id, file); fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, JSON.stringify(value)); return name; };
  for (const id of ['good1', 'linked-status', 'linked-plan', 'good2']) {
    write(id, 'status.json', { status: 'succeeded', created_at: '2026-01-01', task: id });
    write(id, 'run.json', { task: id });
  }
  const status = path.join(root, 'linked-status/status.json');
  const plan = write('linked-plan', 'artifacts/plan.json', { summary: 'LINKED-PLAN', steps: [{ title: 'Do not forward' }] });
  try { fs.linkSync(status, path.join(dataDir, 'status-link')); fs.linkSync(plan, path.join(dataDir, 'plan-link')); }
  catch (error) { t.skip(`Filesystem refuses hard links: ${error.code}`); return; }
  assert.equal(fs.statSync(status).nlink, 2); assert.equal(fs.statSync(plan).nlink, 2);
  const options = mode === 'legacy' ? scope : { ...scope, context: { notes: 'Keep notes' } };
  const wire = buildPipelineHistory(options);
  assert.deepEqual(wire.runs.map((r) => r.run_id), ['good1', 'good2', 'linked-plan']);
  assert.equal(wire.runs.find((r) => r.run_id === 'linked-plan').plan, '');
  assert.doesNotMatch(JSON.stringify(wire), /LINKED-PLAN|Do not forward/);
  if (mode === 'context') assert.equal(wire.context.notes, 'Keep notes');
});

test('A3 Events documents the context-system v2 file and legacy CLI acceptance', () => {
  const paragraph = fs.readFileSync('docs/EVENTS.md', 'utf8').split(/\r?\n/).find((line) => line.startsWith('Vor einem vom Server gestarteten Registry-Team-Run'));
  assert.match(paragraph, /\{ "v": 3, "text": string <= 800000 chars, "developer": string <= 8000 chars \}/);
  assert.match(paragraph, /8388608 bytes/); assert.match(paragraph, /262144 bytes/);
  assert.match(paragraph, /context system/);
  assert.match(paragraph, /\{ "v": 1, "text": string <= 8000 chars \}/);
  assert.match(paragraph, /\[CONTROL\.md\]\(CONTROL\.md\), section 12/);
});

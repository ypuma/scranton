import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createContext } from '../../src/core/context/index.js';
import { createContextStore } from '../../src/core/context/store.js';
import { readTurns } from '../../src/core/context/turns.js';
import { buildTeamPack, pipelineSections } from '../../src/core/context/pack.js';
import { listContextRuns, listRuns, countContextRuns } from '../../src/core/thread.js';
import { runCli } from '../../src/core/cli.js';
import { createProjectRegistry } from '../../src/core/projects.js';

function fixture(t) {
  const base = path.resolve('.scratch/context-system/lane-c1'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'review-')), dataDir = path.join(dir, 'real/data'); fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chats = [], projectId = 'project';
  const chat = (id, engine = 'team') => { const c = { id, projectId, engine, title: id, updatedAt: '2026-02-01', hiveDir: path.join(dataDir, 'projects', projectId, 'chats', id, 'hive') }; chats.push(c); return c; };
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return file; };
  const team = (c, id, day = 1) => write(path.join(c.hiveDir, 'runs', id, 'events.jsonl'), [{ type: 'run_started', runId: id, request: 'Task ' + id, ts: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z` }, { type: 'run_finished', runId: id, status: 'success', summary: 'Done' }].map(JSON.stringify).join('\n') + '\n');
  const pipeline = (c, id) => { const root = path.join(dataDir, 'projects', projectId, 'chats', c.id, 'pipeline/runs', id); write(path.join(root, 'status.json'), { status: 'succeeded', created_at: '2026-01-01', task: id }); write(path.join(root, 'run.json'), { task: id }); return root; };
  const registry = { getProject: () => ({ id: projectId }), getChat: (p, id) => chats.find((c) => c.id === id), listChats: () => chats };
  return { dir, dataDir, projectId, chat, write, team, pipeline, registry, context: createContext({ dataDir, registry }) };
}
function link(t, target, file) {
  try { fs.symlinkSync(target, file, 'junction'); return true; }
  catch (error) { t.skip(`Filesystem refuses directory links: ${error.code}`); return false; }
}

test('C1.1 Team pack accepts linked ancestors above the hive', async (t) => {
  const f = fixture(t), c = f.chat('own'); f.team(c, 'old');
  if (!link(t, path.join(f.dir, 'real'), path.join(f.dir, 'alias'))) return;
  const expected = f.context.forTeam(f.projectId, c.id);
  c.hiveDir = c.hiveDir.replace(path.join(f.dir, 'real'), path.join(f.dir, 'alias'));
  assert.deepEqual(f.context.forTeam(f.projectId, c.id), expected);
  assert.equal(countContextRuns(c.hiveDir), 1);
});

test('C1.1 store canonicalises dataDir but rejects links below it', async (t) => {
  const f = fixture(t), c = f.chat('own'), store = createContextStore(f.dataDir, f.projectId);
  store.setNotes('Preferences'); store.configure({ crossChat: false });
  createContextStore(f.dataDir, f.projectId, c.id).setReset('2026-02-01');
  if (!link(t, path.join(f.dir, 'real'), path.join(f.dir, 'alias'))) return;
  const data = path.join(f.dir, 'alias/data'), other = createContextStore(data, f.projectId);
  assert.deepEqual(other.notes(), store.notes()); assert.deepEqual(other.settings(), store.settings());
  assert.deepEqual(createContextStore(data, f.projectId, c.id).state(), createContextStore(f.dataDir, f.projectId, c.id).state());
  other.setNotes('Updated'); assert.equal(store.notes().text, 'Updated'); other.configure({ crossChat: true }); assert.equal(store.settings().crossChat, true);
  createContextStore(data, f.projectId, c.id).setReset(null); assert.equal(createContextStore(f.dataDir, f.projectId, c.id).state().resetAt, null);
  const context = path.join(f.dataDir, 'projects/project/context'); fs.renameSync(context, context + '-real');
  if (!link(t, context + '-real', context)) return;
  assert.equal(other.notes().text, ''); assert.throws(() => other.setNotes('unsafe'), /context path/i);
});

test('C1.1 linked hive/run/plan directories and non-ENOENT errors are degraded', async (t) => {
  const f = fixture(t), c = f.chat('own'); f.team(c, 'good');
  const target = path.join(c.hiveDir, 'runs/good'), linked = path.join(c.hiveDir, 'runs/linked');
  if (!link(t, target, linked)) return;
  let result = listContextRuns(c.hiveDir); assert.equal(result.degraded, true); assert.deepEqual(result.runs.map((r) => r.id), ['good']);
  fs.unlinkSync(linked); fs.renameSync(c.hiveDir, c.hiveDir + '-real');
  if (!link(t, c.hiveDir + '-real', c.hiveDir)) return;
  result = listContextRuns(c.hiveDir); assert.equal(result.degraded, true); assert.deepEqual(result.runs, []);
  fs.unlinkSync(c.hiveDir); fs.renameSync(c.hiveDir + '-real', c.hiveDir);
  fs.mkdirSync(path.join(target, 'plan-real')); if (!link(t, path.join(target, 'plan-real'), path.join(target, 'michael'))) return;
  assert.equal(listContextRuns(c.hiveDir).degraded, true);
  const read = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (file, ...args) => { if (file === path.join(c.hiveDir, 'runs')) throw Object.assign(Error('denied'), { code: 'EACCES' }); return read(file, ...args); });
  assert.equal(listContextRuns(c.hiveDir).degraded, true);
});

for (const engine of ['team', 'pipeline']) test(`C1.2 ${engine} reset hides unread older runs without renumbering or changing total`, async (t) => {
  const f = fixture(t), c = f.chat('own', engine);
  for (let i = 1; i <= 3; i++) { const file = engine === 'team' ? path.dirname(f.team(c, 'run' + i, i)) : f.pipeline(c, 'run' + i); fs.utimesSync(file, i, i); }
  const source = readTurns({ dataDir: f.dataDir, projectId: f.projectId, chat: c, maxRuns: 2, since: '2026-02-01' });
  assert.equal(source.total, 3); assert.equal(source.unread, 0); assert.deepEqual(source.turns, []);
  assert.equal(buildTeamPack(source).text, ''); assert.equal(buildTeamPack(source).meta.turns.visible, 0);
});

for (const mode of ['invalid', 'BOM']) test(`C1.3 CLI notes ${mode} UTF-8`, async (t) => {
  const f = fixture(t), registry = createProjectRegistry({ dataDir: f.dataDir, projectsRoot: path.join(f.dir, 'workspaces') }), p = registry.addProject({ name: 'CLI', create: true });
  const file = f.write(path.join(f.dir, 'input.md'), mode === 'invalid' ? Buffer.from([0xc3, 0x28]) : '\ufeffHello');
  let errors = '';
  const code = await runCli(['context', 'notes', '--data', f.dataDir, '--project', p.id, '--file', file], { cwd: f.dir, env: {}, stdout: { write() {} }, stderr: { write(s) { errors += s; } } });
  assert.equal(code, mode === 'invalid' ? 2 : 0, errors);
  if (mode === 'BOM') assert.equal(fs.readFileSync(path.join(f.dataDir, 'projects', p.id, 'context/notes.md'), 'utf8'), 'Hello');
  const notes = (await createContext({ dataDir: f.dataDir, registry }).status(p.id)).notes.text;
  assert.equal(notes, mode === 'invalid' ? '' : 'Hello');
});

test('C1.4 nonregular Team and store artifacts are rejected before open', async (t) => {
  const f = fixture(t), c = f.chat('own'), file = path.join(c.hiveDir, 'state.json'); fs.mkdirSync(file, { recursive: true });
  const notes = path.join(f.dataDir, 'projects/project/context/notes.md'); fs.mkdirSync(notes, { recursive: true });
  const open = fs.openSync, opened = [];
  t.mock.method(fs, 'openSync', (name, ...args) => { if ([file, notes].includes(name)) opened.push(name); return open(name, ...args); });
  countContextRuns(c.hiveDir); createContextStore(f.dataDir, f.projectId).notes();
  assert.deepEqual(opened, []);
});

test('C1.4 FIFO state and notes do not block context reads', { skip: process.platform === 'win32' ? 'mkfifo requires POSIX' : false }, async (t) => {
  const f = fixture(t), c = f.chat('own'), state = path.join(c.hiveDir, 'state.json'), notes = path.join(f.dataDir, 'projects/project/context/notes.md');
  for (const file of [state, notes]) { fs.mkdirSync(path.dirname(file), { recursive: true }); const result = spawnSync('mkfifo', [file]); assert.equal(result.status, 0, result.stderr?.toString()); }
  const script = f.write(path.join(f.dir, 'fifo-probe.mjs'), `import { countContextRuns, listContextRuns } from ${JSON.stringify(new URL('../../src/core/thread.js', import.meta.url).href)};\nimport { createContextStore } from ${JSON.stringify(new URL('../../src/core/context/store.js', import.meta.url).href)};\ncountContextRuns(${JSON.stringify(c.hiveDir)}); if (!listContextRuns(${JSON.stringify(c.hiveDir)}).degraded) process.exit(1); createContextStore(${JSON.stringify(f.dataDir)}, 'project').notes();`);
  const result = spawnSync(process.execPath, [script], { timeout: 2000, encoding: 'utf8' }); assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test('C1.6 one full context scan survives sibling and legacy cache pressure', async (t) => {
  const f = fixture(t), own = f.chat('own'), others = [];
  for (let i = 0; i < 500; i++) f.team(own, 'run' + i);
  for (let i = 0; i < 12; i++) { const c = f.chat('sibling' + i); others.push(c); for (let j = 0; j < 4; j++) f.team(c, 'run' + j); }
  const scan = () => { listContextRuns(own.hiveDir); for (const c of others) listContextRuns(c.hiveDir, { maxRuns: 4 }); };
  scan(); listRuns(own.hiveDir);
  const open = fs.openSync; let journals = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (String(file).endsWith('events.jsonl')) journals++; return open(file, ...args); });
  scan(); assert.equal(journals, 0);
});

test('C1.7 Pipeline inspection propagates unreadable-artifact degradation', async (t) => {
  const f = fixture(t), c = f.chat('pipe', 'pipeline'), root = f.pipeline(c, 'run1'); f.write(path.join(root, 'artifacts/plan.json'), '{broken');
  const doc = (await f.context.inspect(f.projectId, c.id)); assert.equal(doc.degraded, true); assert.equal(doc.turns.visible, 1);
});

test('C1.7 Pipeline inspection propagates sibling degradation and fallback', async (t) => {
  const f = fixture(t), c = f.chat('pipe', 'pipeline'), sibling = f.chat('other'); f.pipeline(c, 'run1');
  f.write(path.join(sibling.hiveDir, 'runs/bad/state.json'), { runId: 'bad', agents: { explode: true } });
  const values = Object.values;
  t.mock.method(Object, 'values', (obj) => { if (obj?.explode) throw Error('broken'); return values(obj); });
  assert.equal((await f.context.inspect(f.projectId, c.id)).degraded, true);
  t.mock.method(f.registry, 'listChats', () => { throw Error('registry unavailable'); });
  assert.equal((await f.context.inspect(f.projectId, c.id)).degraded, true);
});

test('C1.8 Pipeline recent projection is readable and leaves the wire untouched', () => {
  const wire = { runs: [{ run_id: 'run1', status: 'failed', task: 'Fix tests', plan: JSON.stringify({ summary: 'Repair behavior', steps: [{ title: 'Add guard' }, { title: 'Verify' }] }), outcome: JSON.stringify({ failure: { code: 'checks_failed', message: 'Unit failed' }, verified_step_count: 1, delivery_applied: false, final_checks: [{ id: 'unit', status: 'failed' }], assistant_reply: 'Needs another pass' }) }] };
  const before = JSON.stringify(wire), section = pipelineSections(wire).find((s) => s.id === 'recent');
  for (const expected of ['Run run1 [failed]', 'Task: Fix tests', 'Plan: Repair behavior', '- Add guard', '- Verify', 'Outcome:', 'checks_failed: Unit failed', 'Verified steps: 1', 'Delivery applied: false', 'unit: failed', 'Needs another pass']) assert.ok(section.text.includes(expected), expected);
  assert.doesNotMatch(section.text, /\{"/); assert.equal(section.exact, false); assert.equal(JSON.stringify(wire), before);
});

test('C1.8 malformed Pipeline projections are clipped defensively', () => {
  const section = pipelineSections({ runs: [{ run_id: 'run1', status: 'failed', task: 'Task', plan: 'not-json ' + 'X'.repeat(10000), outcome: 'not-json ' + 'Y'.repeat(10000) }] })[0];
  assert.match(section.text, /Plan: not-json/); assert.match(section.text, /Outcome: not-json/); assert.ok(section.text.length < 5000);
  for (const raw of ['null', '[]', '42', '"text"']) assert.doesNotThrow(() => pipelineSections({ runs: [{ run_id: 'r', plan: raw, outcome: raw }] }));
});

test('C1.9 shared helpers preserve both historical masking dialects and relative path rules', async () => {
  const { maskHistoricalText, isRelativeFile, PIPELINE_TERMINAL } = await import('../../src/core/context/shared.js');
  const prior = (value, pipeline) => value.replace(pipeline ? /\b[A-Za-z]:[\\/][^\s"<>]+|\\\\[^\s"<>]+|\/(?:Users|home|tmp|private|var|mnt)\/[^\s"<>]+/g : /\b[A-Za-z]:[\\/][^\s"<>]+|\\\\[^\s"<>]+/g, '[private path]').replace(/(^|[\s"'(=])\/[^\s"<>]+/g, '$1[private path]').replace(/\b[a-f0-9]{64}\b|\b[EKH]-[a-f0-9]{10}\b/gi, '[historical reference]');
  const samples = ['C:\\secret\\file', '\\\\host\\file', '/home/me/file', 'prefix/tmp/hidden', '/other/root', 'src/file.js', 'E-0123456789', 'A'.repeat(64), '< /not/a/tag >', '\ud83d'];
  for (const value of samples) for (const prefix of ['', 'prefix', ' ', '(=', '"']) for (const pipeline of [true, false]) assert.equal(maskHistoricalText(prefix + value, pipeline), prior(prefix + value, pipeline));
  for (const value of [...samples, '', null, 'a..b', '..\\escape', '\\root', 'src\\file.js', 'ok\u0001bad']) assert.equal(isRelativeFile(value), Boolean(typeof value === 'string' && value && !/^(?:[A-Za-z]:|\/|\\)|\.\.|[\x00-\x1f\x7f]/.test(value)));
  assert.deepEqual(PIPELINE_TERMINAL, ['succeeded', 'failed', 'rejected', 'cancelled']); assert.ok(Object.isFrozen(PIPELINE_TERMINAL));
});

test('C1.1 unreadable context storage is flagged in the pack and inspection', async (t) => {
  const f = fixture(t), c = f.chat('own'); f.team(c, 'good');
  const directory = path.join(f.dataDir, 'projects/project/context'), target = path.join(f.dir, 'external-context'); fs.mkdirSync(target);
  f.write(path.join(target, 'notes.md'), 'DO-NOT-READ');
  if (!link(t, target, directory)) return;
  const pack = f.context.forTeam(f.projectId, c.id); assert.equal(pack.meta.degraded, true); assert.doesNotMatch(pack.text, /DO-NOT-READ/);
  assert.equal((await f.context.inspect(f.projectId, c.id)).degraded, true);
});

test('C1.4 CLI notes rejects nonregular input before reading', async (t) => {
  const f = fixture(t), registry = createProjectRegistry({ dataDir: f.dataDir, projectsRoot: path.join(f.dir, 'workspaces') }), p = registry.addProject({ name: 'CLI', create: true });
  const read = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (file === f.dir) reads++; return read(file, ...args); });
  // Built-in named exports must see the same instrumentation as the default fs object.
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const code = await runCli(['context', 'notes', '--data', f.dataDir, '--project', p.id, '--file', f.dir], { cwd: f.dir, env: {}, stdout: { write() {} }, stderr: { write() {} } });
  assert.equal(code, 2); assert.equal(reads, 0);
});

test('C1.1 corrupt Team artifacts degrade without losing readable turns', async (t) => {
  const f = fixture(t), c = f.chat('own'), file = f.team(c, 'good'); fs.appendFileSync(file, '{corrupt}\n');
  const result = listContextRuns(c.hiveDir); assert.equal(result.degraded, true); assert.equal(result.runs[0].request, 'Task good');
});

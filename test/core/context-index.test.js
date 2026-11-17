import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createContext } from '../../src/core/context/index.js';
import { listRuns, formatThreadContext } from '../../src/core/thread.js';
import { teamDreamingContext } from '../../src/core/dreaming-sources.js';
import { buildPipelineHistory } from '../../src/core/pipeline-history.js';

function fixture(t) {
  const base = path.resolve('.scratch/context-system/lane-a'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'index-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), registry = createProjectRegistry({ dataDir, projectsRoot: path.join(root, 'workspaces') });
  const p = registry.addProject({ name: 'Project', create: true }), foreign = registry.addProject({ name: 'Foreign', create: true });
  const team = registry.createChat(p.id, { title: 'Team' }), pipe = registry.createChat(p.id, { title: 'Pipeline', engine: 'pipeline' }), empty = registry.createChat(p.id), other = registry.createChat(foreign.id);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const teamRun = (chat, id, request, date = '2026-01-01T00:00:00Z') => write(path.join(chat.hiveDir, `runs/${id}/events.jsonl`), [{ type: 'run_started', runId: id, request, ts: date }, { type: 'run_finished', runId: id, status: 'success', summary: 'Delivered', ts: date }].map(JSON.stringify).join('\n') + '\n');
  const pipelineRun = (chat, id, task, date = '2026-01-01T00:00:00Z') => { const dir = path.join(dataDir, 'projects', chat.projectId, 'chats', chat.id, 'pipeline/runs', id); write(path.join(dir, 'status.json'), { status: 'succeeded', task, created_at: date, updated_at: date }); write(path.join(dir, 'run.json'), { task }); };
  const context = createContext({ dataDir, registry, now: () => '2026-01-02T00:00:00.000Z' });
  return { dataDir, registry, p, foreign, team, pipe, empty, other, write, teamRun, pipelineRun, context };
}
// Anchors: gather scopes listChats(p), per-chat since filters and crossChat branch; inspect projections;
// forTeam/forPipeline catch with legacy helpers; shared injected now; sibling scan bounds.
test('reset/restore hides both engines from own and sibling packs without hiding project notes or memory', (t) => {
  const f = fixture(t), { context: c, p, team, pipe, empty } = f;
  f.teamRun(team, 'team1', 'TEAM-OLD'); f.pipelineRun(pipe, 'pipe0001', 'PIPE-OLD'); c.setNotes(p.id, 'STANDING-NOTES');
  assert.match(c.forTeam(p.id, empty.id).text, /TEAM-OLD/); assert.match(JSON.stringify(c.forPipeline(p.id, pipe.id)), /TEAM-OLD/);
  const resetTeam = c.reset(p.id, team.id); assert.ok(Number.isFinite(Date.parse(resetTeam.reset.at))); c.reset(p.id, pipe.id);
  const teamPack = c.forTeam(p.id, team.id, { memory: 'PROJECT-MEMORY' }); assert.doesNotMatch(teamPack.text, /TEAM-OLD|PIPE-OLD/); assert.match(teamPack.text, /STANDING-NOTES|PROJECT-MEMORY/);
  assert.doesNotMatch(c.forTeam(p.id, empty.id).text, /TEAM-OLD|PIPE-OLD/);
  const pipeline = c.forPipeline(p.id, pipe.id); assert.deepEqual(pipeline.runs, []); assert.equal(pipeline.context.notes, 'STANDING-NOTES');
  f.teamRun(team, 'team2', 'TEAM-NEW', '2026-01-03T00:00:00Z');
  assert.match(c.forTeam(p.id, team.id).text, /#2 \[success\]/); assert.doesNotMatch(c.forTeam(p.id, team.id).text, /TEAM-OLD/);
  c.restore(p.id, team.id); c.restore(p.id, pipe.id);
  assert.match(c.forTeam(p.id, empty.id).text, /TEAM-OLD/); assert.match(JSON.stringify(c.forPipeline(p.id, pipe.id)), /PIPE-OLD/);
});
test('crossChat off prevents receiving/providing siblings; other projects and removed chats never appear', (t) => {
  const f = fixture(t), c = f.context; f.teamRun(f.team, 'run1', 'SAME-PROJECT'); f.teamRun(f.other, 'run2', 'FOREIGN-PROJECT');
  assert.match(c.forTeam(f.p.id, f.empty.id).text, /SAME-PROJECT/); assert.doesNotMatch(c.forTeam(f.p.id, f.empty.id).text, /FOREIGN-PROJECT/);
  c.configure(f.p.id, { crossChat: false }); assert.equal(c.forTeam(f.p.id, f.empty.id).text, ''); assert.equal(c.forTeam(f.p.id, f.team.id).meta.otherChats.chats, 0);
  c.configure(f.p.id, { crossChat: true }); f.registry.removeChat(f.p.id, f.team.id); assert.equal(c.forTeam(f.p.id, f.empty.id).text, '');
});
test('inspect is the exact Team injection, readable Pipeline projection and valid empty/developer/reset API shape', (t) => {
  const f = fixture(t), c = f.context;
  let doc = c.inspect(f.p.id, f.empty.id); assert.deepEqual(doc.developer, { chars: 0, text: '' }); assert.deepEqual(doc.sections, []);
  f.teamRun(f.team, 'run1', 'Original task'); f.pipelineRun(f.pipe, 'pipe0001', 'Pipeline task'); c.setNotes(f.p.id, 'notes');
  doc = c.inspect(f.p.id, f.team.id, { memory: 'memory' }); const pack = c.forTeam(f.p.id, f.team.id, { memory: 'memory' });
  assert.equal(doc.sections.map((s) => s.text).join('\n\n'), pack.text); assert.equal(doc.developer.text, pack.developer); assert.ok(doc.sections.every((s) => s.exact));
  const pipeline = c.inspect(f.p.id, f.pipe.id); assert.equal(pipeline.developer, null); assert.ok(pipeline.sections.every((s) => s.exact === false));
  assert.equal(c.inspect(f.p.id, f.pipe.id, { activeRunId: 'pipe0001' }).sections.some((s) => s.id === 'recent'), false);
  assert.equal(pipeline.budget.limit, 32768); assert.ok(pipeline.sections.find((s) => s.id === 'recent').text.includes('Pipeline task'));
  for (const d of [doc, pipeline]) { assert.equal(new Set(d.sections.map((s) => s.id)).size, d.sections.length); for (const s of d.sections) { assert.match(s.id, /^[a-z][a-z0-9-]*$/); assert.ok(s.text); assert.equal(s.chars, s.text.length); } }
  assert.equal(c.status(f.p.id).chats.length, 3); assert.deepEqual(c.status(f.p.id).settings, { crossChat: true });
  assert.throws(() => c.status('missing'), { status: 404 }); assert.throws(() => c.inspect(f.p.id, 'missing'), { status: 404 });
});
test('injected internal errors never prevent startup: exact Team legacy fallback and closed Pipeline fallback', (t) => {
  const f = fixture(t); f.teamRun(f.team, 'run1', 'Historical request'); f.pipelineRun(f.pipe, 'pipe0001', 'Pipeline request');
  const registry = { ...f.registry, listChats(p) { if (p === f.p.id) throw Error('injected internal failure'); return f.registry.listChats(p); }, getChat: f.registry.getChat };
  const c = createContext({ dataDir: f.dataDir, registry });
  const team = c.forTeam(f.p.id, f.team.id, { memory: 'memory' });
  assert.equal(team.text, teamDreamingContext(formatThreadContext(listRuns(f.team.hiveDir), { maxChars: 8000 }), 'memory')); assert.equal(team.developer, ''); assert.equal(team.meta.degraded, true);
  assert.deepEqual(c.forPipeline(f.p.id, f.pipe.id), buildPipelineHistory({ dataDir: f.dataDir, projectId: f.p.id, chatId: f.pipe.id })); assert.equal(c.inspect(f.p.id, f.pipe.id).degraded, true);
  const bad = createContext({ dataDir: f.dataDir, registry: f.registry, redact() { throw Error('bad scrubber'); } }); assert.doesNotThrow(() => bad.forTeam(f.p.id, f.team.id)); assert.equal(bad.forPipeline(f.p.id, f.pipe.id), null);
});
test('sibling scan reads newest four runs of twelve newest chats only, and repeated packs are deterministic', (t) => {
  const f = fixture(t); f.context.configure(f.p.id, { crossChat: true });
  for (const chat of [f.team, f.pipe]) f.write(path.join(f.dataDir, 'projects', f.p.id, 'chats', chat.id, 'chat.json'), { ...chat, updatedAt: '2025-01-01' });
  for (let i = 0; i < 14; i++) {
    const chat = f.registry.createChat(f.p.id, { title: 'sibling' + i });
    for (let j = 1; j <= 5; j++) { f.teamRun(chat, `run${j}`, `sibling${i}-turn${j}`); const dir = path.join(chat.hiveDir, 'runs', `run${j}`); fs.utimesSync(dir, j, j); }
    f.write(path.join(f.dataDir, 'projects', f.p.id, 'chats', chat.id, 'chat.json'), { ...chat, updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}` });
  }
  const opened = new Set(), open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (typeof file === 'string' && file.endsWith('events.jsonl')) opened.add(file); return open(file, ...args); });
  const a = f.context.forTeam(f.p.id, f.empty.id), b = f.context.forTeam(f.p.id, f.empty.id); assert.deepEqual(a, b);
  assert.equal(opened.size, 12 * 4, 'scan exactly twelve chats and four runs, not just the rendered subset');
  assert.equal(new Set([...opened].map((file) => path.dirname(path.dirname(path.dirname(file))))).size, 12);
  for (const file of opened) assert.match(file, /runs[\\/]run[2-5][\\/]events\.jsonl$/);
  assert.doesNotMatch(a.text, /sibling0-|sibling1-|turn1/); assert.ok(a.meta.otherChats.chats <= 6); assert.equal(a.meta.truncated, true);
});

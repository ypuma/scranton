import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createDreamingReflectionSources } from '../../src/core/dreaming-reflection-sources.js';

export function fixture(t) {
  const base = path.resolve('.scratch/claude-dream-integration/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'reflection-')), dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Reflection', workspace });
  const chat = registry.createChat(project.id), pipeline = registry.createChat(project.id, { engine: 'pipeline' }), closers = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const at = '2026-11-15T12:00:00.000Z';
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const events = (file, rows, runId, engine = 'team', date = at) => write(file, rows.map((e, i) => JSON.stringify({ ...(engine === 'team' ? { v: 1, runId } : { run_id: runId }), seq: i + 1, ts: date, ...e })).join('\n') + '\n');
  function team(runId = 'earlier', extra = [], date = at) {
    return events(path.join(chat.hiveDir, 'runs', runId, 'events.jsonl'), [
      { type: 'run_started', request: 'Use concise release notes.', maxFailedCycles: 3 },
      { type: 'hitl_response', decision: 'feedback', feedback: 'Correction: ask before changing the release schedule.' }, ...extra,
      { type: 'run_reply', text: 'I believe the schedule is correct.' },
      { type: 'agent_finished', agent: 'angela', exitCode: 0 }, { type: 'run_finished', status: 'success' }
    ], runId, 'team', date);
  }
  function pipe(runId = 'abc12345', extra = {}) {
    const root = path.join(dataDir, 'projects', project.id, 'chats', pipeline.id, 'pipeline/runs', runId);
    write(path.join(root, 'run.json'), { run_id: runId, task: 'Keep releases manual.', created_at: at, ...extra });
    write(path.join(root, 'status.json'), { schema: 1, run_id: runId, status: 'succeeded', updated_at: at, checks: [{ status: 'passed', output_tail: 'RAW TOOL BODY MUST NOT SEND' }] });
    write(path.join(root, 'delivery/reply.json'), { text: 'I report a release preference.' });
    events(path.join(root, 'events.jsonl'), [{ type: 'run_started' }, { type: 'run_finished', data: { status: 'succeeded' } }], runId, 'pipeline');
    return root;
  }
  const source = createDreamingReflectionSources({ dataDir, projectId: project.id, env: { TEST_SECRET: 'known-secret-value' } });
  const auth = { listAccounts: () => [{ id: 'fixture', status: 'signed_in' }], listModels: () => ({ providers: [{ id: 'fixture', models: [{ id: 'scripted' }] }] }), close() {} };
  const completion = () => {
    const s = source.collectReflection().signals.find((s) => s.role === 'user' && s.text.startsWith('Correction:'));
    return { text: JSON.stringify({ summary: 'Store an explicit preference.', operations: [{ action: 'add', targetIds: [], type: 'feedback', title: 'Release approval', text: 'Ask before schedule changes.', reason: 'Explicit user correction.', evidence: [{ signalId: s.id, quote: s.text }] }] }), usage: { inputTokens: 100, outputTokens: 80 } };
  };
  return { dir, dataDir, workspace, registry, project, chat, pipeline, at, write, events, team, pipe, source, auth, completion, onClose: (fn) => closers.push(fn) };
}

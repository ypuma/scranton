import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './dreaming-reflection-fixtures.js';
import { runCli } from '../../src/core/cli.js';
import { buildPipelineHistory } from '../../src/core/pipeline-history.js';
import { resolveReflectionModel } from '../../src/core/dreaming-reflection-sources.js';

test('registry wires real reflection adapter, review, source revalidation and rollback into bounded advisory context', async (t) => {
  const f = fixture(t), sourceFile = f.team(); let calls = 0;
  const dream = f.registry.dreaming(f.project.id, { completeReflection: async (r) => { calls++; assert.ok(r.system.length + r.user.length <= 12000); return f.completion(); } }); f.onClose(() => dream.close());
  assert.equal(dream.status().reflectionEnabled, false); assert.equal(dream.status().reflectionModel, null);
  assert.equal(dream.status().reflectionMaxOutputTokens, 2048); assert.equal(dream.status().reflectionTimeoutSeconds, 60);
  dream.preview(); dream.sweep(); assert.equal(calls, 0);
  const job = dream.propose({ model: 'fixture/scripted' }); assert.equal(dream.status().reflection.state, 'running');
  const ready = await job; assert.equal(ready.reflection.state, 'ready'); assert.equal(calls, 1);
  const p = ready.reflection.proposal; assert.ok(p); assert.deepEqual(dream.structuredContext(), []);
  assert.throws(() => dream.applyProposal('wrong'), { status: 409 });
  const applied = dream.applyProposal(p.id); assert.equal(applied.reflection.memory.length, 1);
  const memory = dream.structuredContext(); assert.ok(memory.length); assert.ok(JSON.stringify(memory).length <= 2000);
  const history = buildPipelineHistory({ dataDir: f.dataDir, projectId: f.project.id, chatId: f.pipeline.id, projectMemory: memory });
  assert.deepEqual(history.runs, []); assert.ok(Buffer.byteLength(JSON.stringify(history)) <= 32768);
  fs.appendFileSync(sourceFile, '\n'); assert.deepEqual(dream.structuredContext(), []);
  assert.equal(dream.rollback().reflection.memory.length, 0);
});

test('CLI propose awaits scripted completion and apply/reject require the exact proposal ID without model calls', async (t) => {
  const f = fixture(t); f.team(); let calls = 0, output = '', errors = '';
  const io = { cwd: f.dir, env: {}, auth: f.auth, completeReflection: async () => { calls++; return f.completion(); }, stdout: { write: (s) => output += s }, stderr: { write: (s) => errors += s } };
  const args = ['--data', f.dataDir, '--project', f.project.id, '--json'];
  assert.equal(await runCli(['dreaming', 'propose', ...args, '--provider', 'fixture', '--model', 'scripted'], io), 0, errors);
  let status = JSON.parse(output), id = status.reflection.proposal.id; assert.equal(status.reflection.state, 'ready'); assert.equal(calls, 1);
  assert.equal(await runCli(['dreaming', 'apply', ...args], io), 2);
  output = ''; assert.equal(await runCli(['dreaming', 'reject', ...args, '--proposal', id], io), 0, errors); assert.equal(JSON.parse(output).reflection.proposal, null); assert.equal(calls, 1);
  f.team('new-input'); output = '';
  assert.equal(await runCli(['dreaming', 'propose', ...args, '--model', 'fixture/scripted'], io), 0, errors);
  id = JSON.parse(output).reflection.proposal.id; output = '';
  assert.equal(await runCli(['dreaming', 'apply', ...args, '--proposal', id], io), 0, errors); assert.equal(JSON.parse(output).reflection.memory.length, 1);
  output = ''; assert.equal(await runCli(['dreaming', 'cancel', ...args], io), 0, errors);
  assert.equal(calls, 2);
});

test('catalog selection must be explicit, authenticated and available; catalog failures are safe', async () => {
  const auth = { listModels: () => ({ providers: [{ id: 'p', models: [{ id: 'm/n' }] }] }), listAccounts: () => [{ id: 'p', status: 'signed_in' }] };
  assert.equal(await resolveReflectionModel(auth, 'p/m/n'), 'p/m/n');
  for (const model of [null, {}, 'p', 'p/unknown', 'p/m n', 'other/m']) await assert.rejects(resolveReflectionModel(auth, model), { status: 400 });
  await assert.rejects(resolveReflectionModel({ ...auth, listAccounts: () => [] }, 'p/m/n'), { status: 400 });
  await assert.rejects(resolveReflectionModel({ listModels() { throw Error('SECRET'); } }, 'p/m'), (e) => e.status === 409 && !e.message.includes('SECRET'));
});

test('live Team evidence survives two recorder archives without changing identities or charging relocation again', async (t) => {
  const { EventRecorder } = await import('../../src/core/events.js');
  const { collectInput } = await import('../../src/core/dreaming/reflection.js');
  const { createStorage } = await import('../../src/core/dreaming/storage.js');
  const f = fixture(t);
  const first = new EventRecorder({ hiveDir: f.chat.hiveDir, runId: 'original' }); first.start();
  first.emit('run_started', { request: 'Use concise release notes.', maxFailedCycles: 3 });
  first.emit('hitl_response', { decision: 'feedback', feedback: 'Correction: ask before changing the release schedule.' });
  first.emit('run_finished', { status: 'success' });
  const before = f.source.collectReflection(), storage = createStorage(f.dataDir, f.project.id);
  const fingerprint = () => collectInput(f.source.collectReflection(), storage.verification()).fingerprint;
  const originalFingerprint = fingerprint();
  let calls = 0;
  const dream = f.registry.dreaming(f.project.id, { completeReflection: async () => { calls++; return f.completion(); } });
  f.onClose(() => dream.close());
  let ready = await dream.propose({ model: 'fixture/scripted' });
  dream.rejectProposal(ready.reflection.proposal.id);
  const second = new EventRecorder({ hiveDir: f.chat.hiveDir, runId: 'second' }); second.start();
  assert.deepEqual(f.source.collectReflection().signals, before.signals, 'archive relocation preserves run and signal IDs');
  assert.equal(fingerprint(), originalFingerprint);
  assert.throws(() => dream.propose({ model: 'fixture/scripted' }), /already attempted/);
  assert.equal(calls, 1, 'no repeated billed attempt solely from archival');
  // Use a fresh service authority to accept the original live evidence in a separate project chat lifecycle.
  const g = fixture(t);
  const live = new EventRecorder({ hiveDir: g.chat.hiveDir, runId: 'accepted' }); live.start();
  live.emit('run_started', { request: 'Keep releases manual.', maxFailedCycles: 3 });
  live.emit('hitl_response', { decision: 'feedback', feedback: 'Correction: ask before changing the release schedule.' });
  live.emit('run_finished', { status: 'success' });
  const accepted = g.registry.dreaming(g.project.id, { completeReflection: async () => g.completion() });
  g.onClose(() => accepted.close());
  ready = await accepted.propose({ model: 'fixture/scripted' });
  accepted.applyProposal(ready.reflection.proposal.id);
  const memory = accepted.structuredContext(); assert.equal(memory.length, 1);
  for (const runId of ['next', 'latest']) {
    const recorder = new EventRecorder({ hiveDir: g.chat.hiveDir, runId }); recorder.start();
    recorder.emit('run_started', { request: 'A later task', maxFailedCycles: 3 });
    recorder.emit('run_finished', { status: 'success' });
  }
  assert.deepEqual(accepted.structuredContext(), memory, 'accepted live evidence remains injectable after two subsequent runs');
  const archive = path.join(g.chat.hiveDir, 'runs/accepted/events.jsonl');
  fs.appendFileSync(archive, '\n');
  assert.deepEqual(accepted.structuredContext(), [], 'changed archive bytes invalidate the note');
});

test('non-JSON reflection CLI reports state and exact proposal ID; usage lists reflection commands', async (t) => {
  const f = fixture(t); f.team(); let output = '', errors = '';
  const io = { cwd: f.dir, env: {}, auth: f.auth, completeReflection: async () => f.completion(), stdout: { write: (s) => output += s }, stderr: { write: (s) => errors += s } };
  const args = ['--data', f.dataDir, '--project', f.project.id];
  assert.equal(await runCli(['dreaming', 'propose', ...args, '--model', 'fixture/scripted'], io), 0, errors);
  assert.match(output, /Reflection: ready; proposalId: [a-z0-9-]+\./);
  assert.equal(await runCli(['dreaming', 'unknown', ...args], io), 2);
  assert.match(errors, /propose\|apply\|reject\|cancel/);
});

test('historical-heavy valid runs and boundary display output succeed through service apply', async (t) => {
  const { redact } = await import('../../src/core/dreaming/reflection.js');
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.team('bounded' + i, Array.from({ length: 3 }, () => ({ type: 'hitl_response', decision: 'feedback', feedback: 'E1 H2 '.repeat(170) })));
  let calls = 0;
  const field = (max) => 'H2 E1 ' + 'x'.repeat(max - 6);
  const dream = f.registry.dreaming(f.project.id, { completeReflection: async (r) => {
    calls++;
    assert.ok(r.system.length + r.user.length <= 12000);
    const { signals } = JSON.parse(r.user);
    assert.ok(signals.every((s) => redact(s.text) === s.text));
    const s = signals.find((s) => s.role === 'user');
    const text = JSON.stringify({ summary: field(400), operations: [{ text: field(400), evidence: [{ quote: s.text, signalId: s.id }], reason: field(400), title: field(80), type: 'feedback', targetIds: [], action: 'add' }] });
    assert.ok(text.length <= 4096);
    return { text, usage: null };
  } });
  f.onClose(() => dream.close());
  const ready = await dream.propose({ model: 'fixture/scripted' });
  assert.equal(calls, 1);
  assert.equal(ready.reflection.state, 'ready');
  const p = ready.reflection.proposal;
  assert.equal(p.summary.length, 400);
  assert.equal(p.operations[0].title.length, 80);
  assert.equal(p.operations[0].text.length, 400);
  assert.equal(p.operations[0].reason.length, 400);
  assert.equal(dream.applyProposal(p.id).reflection.memory.length, 1);
});

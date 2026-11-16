import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createDreaming } from '../../../src/core/dreaming/index.js';
import { digest } from '../../../src/core/dreaming/storage.js';
import { collectInput, reduceOutput, applyOperations, emptyReflection, validateReflection, boundedRedact, redact } from '../../../src/core/dreaming/reflection.js';

const at = '2026-11-15T12:00:00.000Z';
const signal = () => ({ id: digest('signal'), runId: digest('run'), role: 'user', text: 'Use offline tests for this project.', at, sources: [{ path: 'projects/project/chats/chat/hive/run.json', sha256: digest('source') }] });
const add = (patch = {}) => ({ action: 'add', targetIds: [], type: 'feedback', title: 'Offline testing', text: 'The user prefers offline tests.', reason: 'Explicit preference.', evidence: [{ signalId: signal().id, quote: 'Use offline tests' }], ...patch });
const output = (operations = [add()]) => JSON.stringify({ summary: 'A sourced preference.', operations });
const input = () => collectInput({ signals: [signal()], limitations: [] }, () => true);
const reduce = (text, memory = [], supplied = input()) => reduceOutput(text, memory, supplied, { model: 'fake/model', at, usage: null, base: digest('base') });
function fixture(t, completion = async () => ({ text: output(), usage: { inputTokens: 100, outputTokens: 30 } })) {
  const dataDir = path.resolve('.scratch/claude-dream-core', randomUUID()), s = signal();
  const file = path.join(dataDir, s.sources[0].path);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'source');
  let busy = false, signals = [s];
  const options = { dataDir, projectId: 'project', collect: () => ({ episodes: [], limitations: [] }), collectReflection: () => ({ signals, limitations: [] }), completeReflection: completion, isBusy: () => busy, now: () => Date.parse(at) };
  const api = createDreaming(options), dir = path.join(dataDir, 'projects/project/dreaming');
  t.after(async () => { await api.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { api, options, dir, file, busy: (v) => { busy = v; }, signals: (v) => { signals = v; } };
}
const statusCode = (n) => (e) => e.status === n;

test('close is idempotent with corrupt idle authority and never repairs it', async (t) => {
  const f = fixture(t);
  f.api.configure({ reflectionModel: 'fake/model' });
  const file = path.join(f.dir, 'state.json'), corrupt = '{bad';
  fs.writeFileSync(file, corrupt);
  assert.throws(() => f.api.status(), statusCode(409));
  await f.api.close();
  await f.api.close();
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  assert.equal(fs.existsSync(path.join(f.dir, '.owner-lock')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.reflection-job')), false);
});

test('close drains owned child and lease despite corrupt active authority', { timeout: 5000 }, async (t) => {
  let child, aborted = false, cleaned = false, releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  const f = fixture(t, async ({ signal }) => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    signal.addEventListener('abort', () => { aborted = true; child.kill(); }, { once: true });
    await exited;
    await cleanup;
    cleaned = true;
    throw Error('cancelled');
  });
  t.after(() => { releaseCleanup(); child?.kill(); });
  const pending = f.api.propose({ model: 'fake/model' });
  const rejected = assert.rejects(pending, statusCode(409));
  await Promise.resolve();
  await once(child, 'spawn');
  const file = path.join(f.dir, 'state.json'), corrupt = '{bad';
  fs.writeFileSync(file, corrupt);
  let closed = false;
  const closing = f.api.close();
  assert.equal(f.api.close(), closing);
  const drained = closing.then(() => { closed = true; });
  assert.equal(aborted, true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(fs.existsSync(path.join(f.dir, '.reflection-job')), true);
  releaseCleanup();
  await drained; await rejected;
  assert.equal(cleaned, true);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
  assert.equal(fs.existsSync(path.join(f.dir, '.reflection-job')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.owner-lock')), false);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  await f.api.close();
});

test('strict reducer grounds typed notes and normalized add/merge/remove preimages', () => {
  const p = reduce(output());
  assert.equal(p.operations[0].after.type, 'feedback');
  assert.equal(p.operations[0].evidence[0].role, 'user');
  const memory = applyOperations([], p);
  const replacement = reduce(output([add({ action: 'replace', targetIds: [memory[0].id], text: 'Offline tests are preferred for project changes.' })]), memory);
  assert.deepEqual(replacement.operations[0].before, memory);
  const next = applyOperations(memory, replacement);
  const remove = reduce(output([add({ action: 'remove', targetIds: [next[0].id], type: null, title: null, text: null, evidence: [] })]), next);
  assert.deepEqual(applyOperations(next, remove), []);
  assert.throws(() => applyOperations([], replacement));
});

test('unknown quotes cannot ground accepted notes (negative control guard)', () => {
  assert.throws(() => reduce(output([add({ evidence: [{ signalId: signal().id, quote: 'Fabricated preference' }] })])));
});

test('schema/type/target/role/output/capacity safety guards fail closed', () => {
  for (const patch of [
    { type: 'system' }, { title: 'x'.repeat(81) }, { text: 'x'.repeat(401) }, { evidence: [] },
    { evidence: [{ signalId: 'unknown', quote: 'Use offline tests' }] },
    { targetIds: ['deterministic'] }, { surprise: true },
    { evidence: Array(4).fill(add().evidence[0]) },
    { action: 'remove', targetIds: ['unknown'], type: null, title: null, text: null, evidence: [] }
  ]) assert.throws(() => reduce(output([add(patch)])));
  assert.throws(() => reduce('x'.repeat(4097)));
  assert.throws(() => reduce('{"summary":"x","operations":[],"extra":1}'));
  assert.throws(() => reduce(output(Array(13).fill(add()))));
  const assistant = signal(); assistant.role = 'assistant';
  assert.throws(() => reduce(output(), [], collectInput({ signals: [assistant], limitations: [] }, () => true)));
  assert.equal(reduce(output([])), null);
  assert.throws(() => collectInput({ signals: [signal()], limitations: [] }, () => false));
  assert.throws(() => collectInput({ signals: Array.from({ length: 5 }, (_, i) => ({ ...signal(), id: digest(String(i)), runId: digest('run' + i) })), limitations: [] }, () => true));
  assert.throws(() => collectInput({ signals: [{ ...signal(), text: 'x'.repeat(600) }, { ...signal(), id: digest('s2'), text: 'x'.repeat(401) }], limitations: [] }, () => true));
  const r = emptyReflection(); r.memory = [{ instruction: 'bad' }]; assert.throws(() => validateReflection(r));
});

test('propose preflight is synchronous, running visible, no owner lock across await', async (t) => {
  let resolve, request;
  const f = fixture(t, (r) => { request = r; return new Promise((done) => { resolve = done; }); });
  assert.throws(() => f.api.propose(), statusCode(400));
  assert.equal(fs.existsSync(f.dir), false);
  const pending = f.api.propose({ model: 'fake/model' });
  assert.ok(pending instanceof Promise);
  assert.equal(f.api.status().reflection.state, 'running');
  assert.equal(f.api.preview().preview, true);
  f.busy(true); assert.throws(() => f.api.preview(), statusCode(409)); f.busy(false);
  assert.equal(fs.existsSync(path.join(f.dir, '.owner-lock')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.reflection-job')), true);
  const other = createDreaming(f.options);
  assert.throws(() => other.propose({ model: 'fake/model' }), statusCode(409));
  assert.throws(() => f.api.configure({ enabled: true }), statusCode(409));
  await Promise.resolve();
  assert.ok(request.system.length + request.user.length <= 12000);
  assert.equal(request.timeoutMs, 60000); assert.equal(request.maxOutputTokens, 2048);
  resolve({ text: output(), usage: null });
  const ready = await pending;
  assert.equal(ready.reflection.state, 'ready');
  assert.equal(fs.existsSync(path.join(f.dir, '.reflection-job')), false);
  assert.equal(ready.reflection.memory.length, 0);
  assert.ok(fs.existsSync(path.join(f.dir, 'proposal.json')));
  assert.throws(() => f.api.propose({ model: 'fake/model' }), statusCode(409));
});

test('explicit apply persists notes, restart, bounded context, exact rollback and fingerprint accounting', async (t) => {
  const f = fixture(t);
  f.api.configure({ reflectionModel: 'fake/model' });
  const before = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json')));
  const ready = await f.api.propose();
  assert.equal(ready.reflection.usage.inputTokens, 100);
  assert.throws(() => f.api.applyProposal('wrong'), statusCode(409));
  const accepted = f.api.applyProposal(ready.reflection.proposal.id);
  assert.equal(accepted.reflection.memory.length, 1);
  assert.equal(fs.existsSync(path.join(f.dir, 'proposal.json')), false);
  assert.match(fs.readFileSync(path.join(f.dir, 'MEMORY.md'), 'utf8'), /NOTES.md#/);
  assert.match(fs.readFileSync(path.join(f.dir, 'NOTES.md'), 'utf8'), /user prefers offline/);
  const restarted = createDreaming(f.options);
  assert.deepEqual(restarted.status().reflection.memory, accepted.reflection.memory);
  assert.equal(restarted.structuredContext().length, 1);
  assert.ok(JSON.stringify(restarted.structuredContext()).length <= 2000);
  assert.match(restarted.context(), /^Advisory/);
  const restored = f.api.rollback();
  assert.deepEqual(restored.reflection.memory, []);
  const after = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json')));
  assert.deepEqual(after.settings, before.settings); assert.deepEqual(after.current, before.current);
  assert.throws(() => f.api.propose(), statusCode(409));
});

test('legacy v1 settings remain exact across reflection acceptance/rollback', async (t) => {
  const f = fixture(t); f.api.configure({ enabled: true });
  const file = path.join(f.dir, 'state.json'), record = JSON.parse(fs.readFileSync(file));
  record.settings = { enabled: false, intervalMinutes: 360, applyPolicy: false };
  fs.writeFileSync(file, JSON.stringify(record));
  const ready = await f.api.propose({ model: 'fake/model' });
  f.api.applyProposal(ready.reflection.proposal.id); f.api.rollback();
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).settings, record.settings);
  assert.equal(f.api.status().reflectionTimeoutSeconds, 60);
});

test('stale sources fail at apply and disappear at injection', async (t) => {
  const f = fixture(t), ready = await f.api.propose({ model: 'fake/model' });
  fs.appendFileSync(f.file, 'changed');
  assert.throws(() => f.api.applyProposal(ready.reflection.proposal.id));
  assert.equal(f.api.status().reflection.memory.length, 0);
  fs.writeFileSync(f.file, 'source'); f.api.applyProposal(ready.reflection.proposal.id);
  fs.appendFileSync(f.file, 'changed again');
  assert.deepEqual(f.api.structuredContext(), []); assert.equal(f.api.context(), '');
});

test('failure/noop/rejection/cancellation never promote or repeat charges', async (t) => {
  for (const kind of ['failure', 'noop', 'reject', 'cancel']) {
    let resolve, calls = 0;
    const f = fixture(t, async () => { calls++; if (kind === 'failure') throw Error('password=private'); if (kind === 'cancel') return new Promise((done) => { resolve = done; }); return { text: kind === 'noop' ? output([]) : output(), usage: null }; });
    const p = f.api.propose({ model: 'fake/model' }); await Promise.resolve();
    if (kind === 'cancel') {
      assert.equal(f.api.cancelReflection().reflection.state, 'cancelled');
      resolve({ text: output(), usage: null });
    }
    const result = await p;
    if (kind === 'reject') f.api.rejectProposal(result.reflection.proposal.id);
    if (kind === 'cancel') { resolve({ text: output(), usage: null }); await Promise.resolve(); }
    assert.equal(f.api.status().reflection.memory.length, 0);
    assert.equal(f.api.status().reflection.proposal, null);
    assert.ok(!JSON.stringify(f.api.status()).includes('private'));
    assert.throws(() => f.api.propose({ model: 'fake/model' }), statusCode(409));
    assert.equal(calls, 1);
  }
});

test('busy fallback aborts and close resolves without accepting late output', async (t) => {
  const f = fixture(t, ({ signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); }));
  const pending = f.api.propose({ model: 'fake/model' }); f.busy(true);
  await pending;
  assert.equal(f.api.status().reflection.state, 'cancelled');
  f.busy(false); await f.api.close();
});

test('malformed state/proposal and settings are refused without repair', async (t) => {
  const f = fixture(t);
  for (const patch of [{ reflectionTimeoutSeconds: 61 }, { reflectionMaxOutputTokens: 255 }, { reflectionEnabled: 1 }, { reflectionModel: 'default' }]) assert.throws(() => f.api.configure(patch), statusCode(400));
  const ready = await f.api.propose({ model: 'fake/model' });
  const proposalPath = path.join(f.dir, 'proposal.json');
  fs.writeFileSync(proposalPath, '{bad');
  assert.throws(() => f.api.status(), statusCode(409));
  fs.writeFileSync(proposalPath, JSON.stringify(ready.reflection.proposal));
  const statePath = path.join(f.dir, 'state.json'), record = JSON.parse(fs.readFileSync(statePath));
  record.reflection.memory = [{ text: 'malformed' }]; fs.writeFileSync(statePath, JSON.stringify(record));
  assert.throws(() => f.api.status(), statusCode(409));
  // Restore only the deliberately corrupted test state for fixture shutdown.
  record.reflection.memory = []; fs.writeFileSync(statePath, JSON.stringify(record));
});

test('accepted capacity and expanded evidence capacity reject without silent pruning', () => {
  const note = reduce(output()).operations[0].after;
  const memory = Array.from({ length: 16 }, (_, i) => ({ ...note, id: digest('note' + i).slice(0, 24) }));
  assert.throws(() => reduce(output([add({ text: 'Another note.' })]), memory));
  const oversized = memory.map((n) => ({ ...n, text: 'x'.repeat(400), evidence: [{ ...n.evidence[0], quote: 'x'.repeat(1000) }] }));
  assert.throws(() => reduce(output(), oversized));
  const s = signal(); s.sources = Array.from({ length: 3 }, (_, i) => ({ path: `projects/project/chats/chat/hive/run-${i}.json`, sha256: digest(String(i)) }));
  const supplied = collectInput({ signals: [s], limitations: [] }, () => true);
  assert.equal(reduce(output(), [], supplied).operations[0].evidence.length, 3);
  assert.throws(() => reduce(output([add({ evidence: [add().evidence[0], add().evidence[0]] })]), [], supplied));
});

test('output redaction and unredacted quotes do not leak secrets', () => {
  const p = reduce(output([add({ text: 'password=do-not-retain', reason: 'Bearer do-not-retain' })]));
  assert.ok(!JSON.stringify(p).includes('do-not-retain'));
  const s = signal(); s.text = 'password=do-not-retain';
  const supplied = collectInput({ signals: [s], limitations: ['private diagnostic'] }, () => true);
  assert.ok(!JSON.stringify(supplied).includes('do-not-retain'));
  assert.throws(() => reduce(output([add({ evidence: [{ signalId: s.id, quote: s.text }] })]), [], supplied));
});

test('pending proposal survives restart; changed configuration refuses stale apply', async (t) => {
  const f = fixture(t), ready = await f.api.propose({ model: 'fake/model' });
  const other = createDreaming(f.options);
  assert.equal(other.status().reflection.proposal.id, ready.reflection.proposal.id);
  other.configure({ reflectionMaxOutputTokens: 256 });
  assert.throws(() => f.api.applyProposal(ready.reflection.proposal.id), statusCode(409));
  assert.equal(f.api.status().reflection.memory.length, 0);
  assert.equal(other.rejectProposal(ready.reflection.proposal.id).reflection.proposal, null);
});

test('close waits for owned transport cleanup without accepting an aborted completion', async (t) => {
  let resolve;
  const f = fixture(t, () => new Promise((done) => { resolve = done; }));
  const pending = f.api.propose({ model: 'fake/model' }); await Promise.resolve();
  let closed = false;
  const closing = f.api.close().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(fs.existsSync(path.join(f.dir, '.reflection-job')), true);
  resolve({ text: output(), usage: null });
  await closing; await pending;
  assert.equal(fs.existsSync(path.join(f.dir, '.reflection-job')), false);
  const record = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json')));
  assert.deepEqual(record.reflection.memory, []); assert.equal(record.reflection.state, 'cancelled');
});

test('duplicate refs are rejected before staging; unique multi-source proposals all apply', async (t) => {
  for (const sources of [1, 2, 3]) {
    for (const duplicate of [false, true]) {
      const f = fixture(t, async () => ({ text: output([add({ evidence: duplicate ? [add().evidence[0], add().evidence[0]] : add().evidence })]), usage: null }));
      const s = signal();
      s.sources = Array.from({ length: sources }, (_, i) => ({ path: `projects/project/chats/chat/hive/source-${i}.json`, sha256: digest('source') }));
      for (const source of s.sources) { const file = path.join(f.options.dataDir, source.path); fs.writeFileSync(file, 'source'); }
      f.signals([s]);
      const ready = await f.api.propose({ model: 'fake/model' });
      assert.equal(ready.reflection.state, duplicate ? 'failed' : 'ready');
      if (duplicate) assert.equal(ready.reflection.proposal, null);
      else assert.equal(f.api.applyProposal(ready.reflection.proposal.id).reflection.memory[0].evidence.length, sources);
    }
  }
});

test('maximum accepted memory remains visible, bounded and repeatedly pruneable', async (t) => {
  let request, targets;
  const f = fixture(t, async (r) => {
    request = r;
    const supplied = JSON.parse(r.user);
    assert.deepEqual(supplied.memory.map((n) => n.id), targets);
    assert.ok(supplied.memory.every((n) => n.text.length > 0));
    assert.ok(r.system.length + r.user.length <= 12000);
    assert.ok(supplied.signals.every((s) => !Object.hasOwn(s, 'sources')));
    return { text: output([add({ action: 'remove', targetIds: targets, type: null, title: null, text: null, evidence: [] })]), usage: null };
  });
  f.api.configure({ reflectionModel: 'fake/model' });
  const file = path.join(f.dir, 'state.json');
  const note = reduce(output()).operations[0].after;
  const memory = Array.from({ length: 16 }, (_, i) => ({ ...note, id: digest('capacity' + i).slice(0, 24), text: 'Note text. '.repeat(36), evidence: [{ ...note.evidence[0], quote: 'q'.repeat(80) }] }));
  assert.ok(Buffer.byteLength(JSON.stringify(memory)) <= 16384);
  for (let round = 0; round < 2; round++) {
    const record = JSON.parse(fs.readFileSync(file));
    record.reflection ??= emptyReflection(); record.reflection.memory = memory;
    fs.writeFileSync(file, JSON.stringify(record));
    targets = memory.map((n) => n.id);
    f.signals(Array.from({ length: 4 }, (_, i) => ({ ...signal(), id: digest(`round-${round}-${i}`), runId: digest('run' + i), text: 'Available source excerpt. '.repeat(38) })));
    const ready = await f.api.propose();
    assert.equal(ready.reflection.state, 'ready');
    assert.equal(f.api.applyProposal(ready.reflection.proposal.id).reflection.memory.length, 0);
    assert.ok(request);
  }
});

test('unchanged sweeps preserve pending authority but real memory drift rejects apply', async (t) => {
  const f = fixture(t), file = path.join(f.dir, 'state.json');
  f.api.configure({ reflectionModel: 'fake/model' });
  const record = JSON.parse(fs.readFileSync(file)); record.current.at = at;
  fs.writeFileSync(file, JSON.stringify(record));
  const ready = await f.api.propose();
  f.options.now = () => Date.parse(at) + 1000;
  const other = createDreaming(f.options);
  other.sweep();
  assert.notEqual(other.status().lastSweepAt, at);
  const changed = JSON.parse(fs.readFileSync(file));
  changed.reflection.memory = [reduce(output()).operations[0].after];
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => other.applyProposal(ready.reflection.proposal.id), statusCode(409));
  changed.reflection.memory = []; fs.writeFileSync(file, JSON.stringify(changed));
  assert.equal(other.applyProposal(ready.reflection.proposal.id).reflection.memory.length, 1);
});

test('hard deadline is failed, immediate busy completion is cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('abort')), { once: true })));
  f.api.configure({ reflectionTimeoutSeconds: 10 });
  const pending = f.api.propose({ model: 'fake/model' });
  await Promise.resolve(); t.mock.timers.tick(10000);
  assert.equal((await pending).reflection.state, 'failed');
  const busy = fixture(t, async () => { busy.busy(true); return { text: output(), usage: null }; });
  assert.equal((await busy.api.propose({ model: 'fake/model' })).reflection.state, 'cancelled');
});

test('reordered add replace remove model keys stage canonically and apply exactly', async (t) => {
  let operation = add();
  const f = fixture(t, async () => ({ text: output([Object.fromEntries(Object.entries(operation).reverse())]), usage: null }));
  let memory = [];
  for (const action of ['add', 'replace', 'remove']) {
    const s = { ...signal(), id: digest(action), text: `Use offline tests for this project. ${action}` };
    f.signals([s]);
    operation = add({ action, targetIds: memory.map((n) => n.id), evidence: [{ signalId: s.id, quote: 'Use offline tests' }], ...(action === 'remove' ? { type: null, title: null, text: null } : { text: `Offline tests: ${action}.` }) });
    const ready = await f.api.propose({ model: 'fake/model' });
    assert.equal(ready.reflection.state, 'ready');
    memory = f.api.applyProposal(ready.reflection.proposal.id).reflection.memory;
    assert.deepEqual(Object.keys(ready.reflection.proposal.operations[0]), ['action', 'targetIds', 'type', 'title', 'text', 'reason', 'evidence', 'before', 'after']);
    assert.equal(memory.length, action === 'remove' ? 0 : 1);
  }
});

test('boundary display fields redact then bound without relaxing raw limits or quotes', () => {
  const prefix = 'H2 E1 password=private-value ';
  const field = (max) => prefix + 'x'.repeat(max - prefix.length);
  for (const max of [80, 400]) {
    const value = 'x'.repeat(max - 12) + ' password=private-value';
    const bounded = boundedRedact(value, max);
    assert.ok(bounded.length <= max);
    assert.equal(redact(bounded), bounded);
    assert.equal(boundedRedact(bounded, max), bounded);
    assert.doesNotMatch(bounded, /private-value/);
  }
  const fields = { title: field(80), text: field(400), reason: field(400) };
  const summary = field(400);
  const proposal = reduce(JSON.stringify({ summary, operations: [add(fields)] }));
  assert.ok(proposal);
  for (const [key, max] of [['title', 80], ['text', 400], ['reason', 400]]) {
    assert.ok(proposal.operations[0][key].length <= max);
    assert.doesNotMatch(proposal.operations[0][key], /private-value|\b[EH]2?1?\b/);
  }
  assert.ok(proposal.summary.length <= 400);
  for (const [key, max] of [['title', 80], ['text', 400], ['reason', 400]]) assert.throws(() => reduce(output([add({ [key]: 'H2 ' + 'x'.repeat(max - 2) })])));
  assert.throws(() => reduce(JSON.stringify({ summary: 'x'.repeat(401), operations: [add()] })));
  const s = { ...signal(), text: 'H2 E1 Use offline tests' };
  assert.throws(() => reduce(output([add({ evidence: [{ signalId: s.id, quote: 'H2 E1' }] })]), [], collectInput({ signals: [s], limitations: [] }, () => true)));
});

test('six expanded operations apply without reusing the model wire cap; tampering still fails closed', async (t) => {
  const wire = output(Array.from({ length: 6 }, (_, i) => add({
    title: `Observation ${i + 1}: ` + 'E1 H2 '.repeat(5),
    text: `Observation ${i + 1}: ` + 'E1 H2 '.repeat(15),
    reason: 'Historical grounding: ' + 'E1 H2 '.repeat(15)
  })));
  assert.ok(wire.length <= 4096);
  const f = fixture(t, async () => ({ text: wire, usage: null }));
  const ready = await f.api.propose({ model: 'fake/model' });
  assert.equal(ready.reflection.state, 'ready');
  const proposal = ready.reflection.proposal;
  const raw = { summary: proposal.summary, operations: proposal.operations.map(({ action, targetIds, type, title, text, reason, evidence }) => ({ action, targetIds, type, title, text, reason, evidence: evidence.map(({ signalId, quote }) => ({ signalId, quote })) })) };
  assert.ok(JSON.stringify(raw).length > 4096);
  const candidate = applyOperations([], proposal);
  assert.equal(candidate.length, 6);
  assert.ok(Buffer.byteLength(JSON.stringify(candidate)) < 16384);
  const statePath = path.join(f.dir, 'state.json'), proposalPath = path.join(f.dir, 'proposal.json');
  const stateBytes = fs.readFileSync(statePath), proposalBytes = fs.readFileSync(proposalPath);
  for (const tamper of [
    (p) => { p.operations[0].text = p.operations[0].after.text = 'Forged note.'; },
    (p) => { p.operations[0].surprise = true; },
    (p) => { p.operations[0].evidence[0].quote = p.operations[0].after.evidence[0].quote = 'Fabricated preference'; }
  ]) {
    const record = JSON.parse(stateBytes), changed = record.reflection.proposal;
    tamper(changed);
    fs.writeFileSync(statePath, JSON.stringify(record));
    fs.writeFileSync(proposalPath, JSON.stringify(changed));
    try { assert.throws(() => f.api.applyProposal(proposal.id), statusCode(409)); }
    finally { fs.writeFileSync(statePath, stateBytes); fs.writeFileSync(proposalPath, proposalBytes); }
  }
  const accepted = f.api.applyProposal(proposal.id);
  assert.deepEqual(accepted.reflection.memory, candidate);
  assert.equal(accepted.reflection.proposal, null);
  const oversized = wire.padEnd(4097, ' ');
  assert.throws(() => reduce(oversized), statusCode(409));
  const rejected = fixture(t, async () => ({ text: oversized, usage: null }));
  assert.equal((await rejected.api.propose({ model: 'fake/model' })).reflection.state, 'failed');
  assert.deepEqual(rejected.api.status().reflection.memory, []);
});

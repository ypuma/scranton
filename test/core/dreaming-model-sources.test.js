import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from './dreaming-reflection-fixtures.js';
import { createDreamingSources } from '../../src/core/dreaming-sources.js';

const hash = (b) => createHash('sha256').update(b).digest('hex');
test('reflection collects real Team corrections separately from assistant claims and exits without changing replay gates', (t) => {
  const f = fixture(t), file = f.team();
  const input = f.source.collectReflection();
  assert.deepEqual(f.source.collectReflection(), input);
  assert.equal(input.signals[0].role, 'user'); assert.match(input.signals[0].text, /^Correction:/);
  assert.ok(input.signals.some((s) => s.role === 'assistant' && s.text.includes('believe')));
  assert.ok(input.signals.some((s) => s.role === 'outcome' && s.text.includes('does not prove task correctness')));
  for (const s of input.signals) {
    assert.match(s.runId, /^[a-f0-9]{64}$/); assert.equal(s.sources[0].sha256, hash(fs.readFileSync(file)));
    assert.equal(path.isAbsolute(s.sources[0].path), false);
  }
  const replay = createDreamingSources({ dataDir: f.dataDir, projectId: f.project.id }).collect();
  assert.ok(replay.episodes.every((e) => e.intervened || !e.attempts.length));
});

test('Pipeline uses original task, reply and check metadata with at most three original hashes per signal', (t) => {
  const f = fixture(t); f.pipe();
  const input = f.source.collectReflection(); assert.ok(input.signals.length >= 4);
  assert.ok(input.signals.some((s) => s.role === 'assistant'));
  assert.ok(input.signals.some((s) => s.role === 'outcome' && s.text.includes('check status: passed')));
  assert.doesNotMatch(JSON.stringify(input), /RAW TOOL BODY/);
  for (const s of input.signals) {
    assert.ok(s.sources.length <= 3);
    assert.ok(s.sources.some((r) => r.path.endsWith('/run.json')), 'demo provenance retained');
    for (const r of s.sources) assert.equal(r.sha256, hash(fs.readFileSync(path.join(f.dataDir, r.path))));
  }
});

test('reflection redacts known credentials, bearer tokens, private paths, URLs and terminal controls before truncation', (t) => {
  const f = fixture(t);
  f.team('private', [{ type: 'hitl_response', decision: 'feedback', feedback: 'known-secret-value Bearer bearer-private sk-1234567890abcdef token=private-token C:\\Users\\Alice\\file /etc/private \\u001b[31m https://user:pass@example.test/?key=private-url'.replace('\\u001b', '\u001b') }, { type: 'agent_tool', detail: 'RAW TOOL BODY' }]);
  const text = JSON.stringify(f.source.collectReflection());
  assert.doesNotMatch(text, /known-secret-value|bearer-private|1234567890abcdef|private-token|Alice|etc\/private|private-url|RAW TOOL BODY|\\u001b|\[31m/);
  assert.match(text, /redacted/);
});

test('four most recent completed runs and eight signals per run stay within the core input capacities', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) f.team('r' + i, Array.from({ length: 50 }, () => ({ type: 'hitl_response', decision: 'feedback', feedback: 'x'.repeat(400) })), `2026-11-${10 + i}T12:00:00.000Z`);
  const input = f.source.collectReflection(), groups = new Map();
  for (const s of input.signals) groups.set(s.runId, (groups.get(s.runId) ?? 0) + s.text.length);
  assert.equal(groups.size, 4); assert.ok(input.signals.length <= 32); assert.ok([...groups.values()].every((n) => n <= 1000));
  assert.ok(input.signals.every((s) => Date.parse(s.at) >= Date.parse('2026-11-12')));
  assert.ok(input.signals.some((s) => s.role === 'assistant')); assert.ok(input.signals.some((s) => s.role === 'outcome'));
});

test('demo/internal, redirected, missing, malformed, oversized and incomplete artifacts fail safely', (t) => {
  const f = fixture(t); f.pipe('demo0000', { demo: true }); f.pipe('internal', { internal: true });
  const bad = f.team('bad'); fs.appendFileSync(bad, '{');
  const big = f.team('big'); fs.writeFileSync(big, 'x'.repeat(2097153));
  const target = path.join(f.dir, 'external'); fs.mkdirSync(target); f.registry.createChat(f.project.id, { hiveDir: target });
  const link = f.team('linked'); fs.rmSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, path.dirname(link), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.source.collectReflection(); assert.deepEqual(result.signals, []); assert.ok(result.limitations.length);
  assert.doesNotMatch(JSON.stringify(result), /external|PRIVATE/);
  f.team('valid'); assert.ok(f.source.collectReflection().signals.length);
});

test('healthy Team and Pipeline without optional reply report no coverage loss', (t) => {
  const f = fixture(t); f.team(); const root = f.pipe();
  fs.unlinkSync(path.join(root, 'delivery/reply.json'));
  assert.deepEqual(f.source.collectReflection().limitations, []);
  f.write(path.join(root, 'delivery/reply.json'), '{broken');
  assert.ok(f.source.collectReflection().limitations.length);
});

test('canonical Team provenance rejects wrong identity, tampering, copies at other paths and redirected archives', async (t) => {
  const { createStorage } = await import('../../src/core/dreaming/storage.js');
  const f = fixture(t), archive = f.team('original');
  const storage = createStorage(f.dataDir, f.project.id), source = f.source.collectReflection().signals[0].sources[0];
  const bytes = fs.readFileSync(archive);
  assert.equal(storage.verify(source), true);
  const live = path.join(f.chat.hiveDir, 'events.jsonl');
  fs.copyFileSync(archive, live); fs.unlinkSync(archive);
  assert.equal(storage.verify(source), true, 'matching live original can resolve canonical archive locator');
  fs.writeFileSync(live, bytes.toString().replaceAll('original', 'different'));
  assert.equal(storage.verify(source), false, 'live fallback cannot name another run');
  fs.writeFileSync(live, bytes);
  const copy = f.team('copy'); fs.writeFileSync(copy, bytes);
  fs.unlinkSync(live);
  assert.equal(storage.verify(source), false, 'does not search copies by digest');
  assert.ok(!f.source.collectReflection().signals.some((s) => s.sources.some((r) => r.path === source.path)), 'archive directory must match journal identity');
  fs.writeFileSync(live, bytes);
  f.write(archive, bytes.toString() + '\n');
  assert.equal(storage.verify(source), false, 'an existing changed archive never falls back to matching live bytes');
  fs.rmSync(path.dirname(archive), { recursive: true });
  const outside = path.join(f.dir, 'elsewhere'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'events.jsonl'), bytes);
  fs.symlinkSync(outside, path.dirname(archive), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(storage.verify(source), false, 'unsafe canonical archive cannot fall back to live');
  for (const unsafe of [source.path.replace('/runs/original/', '/runs/../'), source.path.replace(f.project.id, 'other-project'), source.path.replace('/runs/original/', '/runs/original\\\\escape/')]) assert.equal(storage.verify({ ...source, path: unsafe }), false);
  assert.ok(f.source.collectReflection().limitations.length);
});

test('historical references are fully redacted before per-run excerpt budgeting', async (t) => {
  const { collectInput, redact } = await import('../../src/core/dreaming/reflection.js');
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.team('historical' + i, Array.from({ length: 3 }, () => ({ type: 'hitl_response', decision: 'feedback', feedback: 'E1 H2 '.repeat(170) })), `2026-11-${10 + i}T12:00:00.000Z`);
  const supplied = f.source.collectReflection(), groups = new Map();
  for (const s of supplied.signals) {
    assert.equal(redact(s.text), s.text);
    assert.doesNotMatch(s.text, /\b[EH]\d+\b/);
    groups.set(s.runId, (groups.get(s.runId) ?? 0) + s.text.length);
    for (const source of s.sources) assert.equal(source.sha256, hash(fs.readFileSync(path.join(f.dataDir, source.path))));
  }
  assert.equal(groups.size, 4);
  assert.ok([...groups.values()].every((n) => n <= 1000));
  assert.deepEqual(collectInput(supplied, () => true).signals, supplied.signals);
});

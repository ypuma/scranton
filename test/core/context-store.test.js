import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createContextStore, normalizeNotes } from '../../src/core/context/store.js';
import { replaceDuringRead } from './fixtures/replace-during-read.js';

function fixture(t) { const base = path.resolve('.scratch/context-system/lane-a'); fs.mkdirSync(base, { recursive: true }); const data = fs.mkdtempSync(path.join(base, 'store-')); t.after(() => fs.rmSync(data, { recursive: true, force: true })); return data; }
// Anchors: normalizeNotes length/control handling, read's size/nlink checks and defaults,
// checkPath before mkdir/open, atomic O_EXCL + fsync + rename and cleanup.
test('notes normalise CRLF and controls, count JS characters, reject excess, and clear with empty text', (t) => {
  const data = fixture(t), s = createContextStore(data, 'project');
  assert.equal(normalizeNotes('A\r\nB\x00\x1b\tC\rD'), 'A\nB\tCD'); s.setNotes('😀'.repeat(8000)); assert.equal(s.notes().chars, 16000);
  assert.throws(() => s.setNotes('😀'.repeat(8001)), /limit/); assert.equal(s.notes().chars, 16000);
  s.setNotes(''); assert.equal(s.notes().text, ''); assert.throws(() => s.setNotes(null));
});
test('missing/corrupt/oversized files default independently; atomic writes leave no temporary files and use private mode', (t) => {
  const data = fixture(t), s = createContextStore(data, 'project'), c = createContextStore(data, 'project', 'chat');
  assert.deepEqual(s.settings(), { crossChat: true, budget: { mode: 'percent', value: 10 }, models: {} }); assert.equal(s.notes().updatedAt, null); assert.deepEqual(c.state(), { resetAt: null });
  s.configure({ crossChat: false }); s.setNotes('text'); c.setReset('2026-01-01T00:00:00Z');
  assert.deepEqual(s.settings(), { crossChat: false, budget: { mode: 'percent', value: 10 }, models: {} }); assert.equal(c.state().resetAt, '2026-01-01T00:00:00.000Z');
  const root = path.join(data, 'projects/project/context'); assert.deepEqual(fs.readdirSync(root).sort(), ['notes.md', 'settings.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'notes.md')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(root, 'notes.md'), 'x'.repeat(65537)); assert.equal(s.notes().text, '');
  fs.writeFileSync(path.join(root, 'settings.json'), '{broken'); assert.deepEqual(s.settings(), { crossChat: true, budget: { mode: 'percent', value: 10 }, models: {} });
  fs.writeFileSync(path.join(root, 'settings.json'), ' '.repeat(65537)); assert.deepEqual(s.settings(), { crossChat: true, budget: { mode: 'percent', value: 10 }, models: {} });
  fs.writeFileSync(path.join(data, 'projects/project/chats/chat/context/state.json'), '{broken'); assert.equal(c.state().resetAt, null);
  assert.throws(() => s.configure({ crossChat: true, other: true })); assert.throws(() => createContextStore(data, '../escape'));
});
for (const phase of ['open', 'read']) for (const reuseIndex of [false, true]) test(`store rejects same-size replacement at ${phase} (${reuseIndex ? 'reused' : 'native'} index) independently`, (t) => {
  const data = fixture(t), store = createContextStore(data, 'project');
  store.setNotes('ORIGINAL'); store.configure({ crossChat: false });
  const file = path.join(data, 'projects/project/context/notes.md'), replaced = replaceDuringRead(t, file, phase, reuseIndex);
  assert.equal(store.notes().text, ''); assert.equal(replaced(), true); assert.equal(store.degraded, true);
  assert.deepEqual(store.settings(), { crossChat: false, budget: { mode: 'percent', value: 10 }, models: {} });
});

test('linked ancestor and hardlinked artifacts are refused without modifying their targets', (t) => {
  const data = fixture(t), victim = path.join(data, 'victim'); fs.mkdirSync(victim);
  const project = path.join(data, 'projects/project'); fs.mkdirSync(path.dirname(project), { recursive: true }); fs.symlinkSync(victim, project, process.platform === 'win32' ? 'junction' : 'dir');
  const s = createContextStore(data, 'project'); assert.equal(s.notes().text, ''); assert.throws(() => s.setNotes('attack'), /path/i); assert.deepEqual(fs.readdirSync(victim), []);
  fs.rmSync(project); fs.mkdirSync(path.join(project, 'context'), { recursive: true });
  const source = path.join(victim, 'notes.md'); fs.writeFileSync(source, 'PRIVATE'); fs.linkSync(source, path.join(project, 'context/notes.md'));
  assert.equal(s.notes().text, ''); assert.throws(() => s.setNotes('attack'), /artifact/); assert.equal(fs.readFileSync(source, 'utf8'), 'PRIVATE');
});

// Revert settings' v2 branch, configure merge, models/modelKey guards or settingsBytes to fail these tests.
test('settings v1 and optional v2 fields read as resolved defaults; invalid documents degrade', (t) => {
  const data = fixture(t), s = createContextStore(data, 'project'); s.configure({ crossChat: true });
  const file = path.join(data, 'projects/project/context/settings.json');
  const defaults = { crossChat: true, budget: { mode: 'percent', value: 10 }, models: {} };
  for (const value of [{ v: 1, crossChat: false }, { v: 2, crossChat: false }, { v: 2, crossChat: false, models: {} }]) {
    fs.writeFileSync(file, JSON.stringify(value)); assert.deepEqual(s.settings(), { ...defaults, crossChat: false });
  }
  for (const value of [{ v: 1, crossChat: true, budget: defaults.budget }, { v: 2, crossChat: true, budget: null }, { v: 2, crossChat: true, models: [] }, { v: 2, crossChat: true, extra: 1 }, { v: 2 }, { v: 3, crossChat: true }]) {
    fs.writeFileSync(file, JSON.stringify(value)); const store = createContextStore(data, 'project'); assert.deepEqual(store.settings(), defaults); assert.equal(store.degraded, true);
  }
  const large = { v: 2, crossChat: true, models: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['provider/' + String(i).repeat(300), { mode: 'tokens', value: 1000 }])) };
  fs.writeFileSync(file, JSON.stringify(large)); assert.ok(fs.statSync(file).size > 1024); assert.equal(Object.keys(s.settings().models).length, 8);
  fs.writeFileSync(file, JSON.stringify(large) + ' '.repeat(65536)); assert.deepEqual(s.settings(), defaults);
});
test('settings merge patches preserve unrelated values and reset rules or delete overrides', (t) => {
  const data = fixture(t), s = createContextStore(data, 'project');
  s.configure({ budget: { mode: 'tokens', value: 24000 }, models: { 'provider/model': { mode: 'percent', value: 20 } } });
  s.configure({ crossChat: false }); s.configure({ models: { other: { mode: 'tokens', value: 1000 } } });
  assert.equal(s.settings().budget.value, 24000); assert.equal(s.settings().crossChat, false); assert.equal(Object.keys(s.settings().models).length, 2);
  s.configure({ budget: null, models: { 'provider/model': null } }); assert.deepEqual(s.settings(), { crossChat: false, budget: { mode: 'percent', value: 10 }, models: { other: { mode: 'tokens', value: 1000 } } });
  const stored = JSON.parse(fs.readFileSync(path.join(data, 'projects/project/context/settings.json'))); assert.equal(stored.v, 2);
  const before = s.settings();
  for (const patch of [{}, null, [], { extra: true }, { crossChat: 1 }, { budget: { mode: 'tokens', value: true } }, { budget: { mode: 'tokens', value: 999 } }, { budget: { mode: 'tokens', value: 200001 } }, { budget: { mode: 'percent', value: 0 } }, { budget: { mode: 'percent', value: 51 } }, { budget: { mode: 'percent', value: 1.1 } }, { budget: { mode: 'percent', value: 10, extra: 1 } }, { budget: { value: 10 } }, { models: null }, { models: [] }]) { assert.throws(() => s.configure(patch), { status: 400 }); assert.deepEqual(s.settings(), before); }
  for (const rule of [{ mode: 'percent', value: 1 }, { mode: 'percent', value: 50 }, { mode: 'tokens', value: 1000 }, { mode: 'tokens', value: 200000 }]) { s.configure({ budget: rule }); assert.deepEqual(s.settings().budget, rule); }
});
test('override limit is checked after merge and hostile model keys cannot touch prototypes', (t) => {
  const data = fixture(t), s = createContextStore(data, 'project'), rule = { mode: 'tokens', value: 1000 };
  const map = Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['model' + i, rule]));
  s.configure({ models: map }); assert.equal(Object.keys(s.settings().models).length, 32);
  assert.throws(() => s.configure({ models: { extra: rule } }), /limit/);
  s.configure({ models: { model0: null, extra: rule } }); assert.equal(Object.keys(s.settings().models).length, 32);
  for (const key of ['__proto__', 'constructor', 'prototype', '', 'a b', 'x\u0000', 'x\u007f', ...Array.from({ length: 32 }, (_, i) => 'x' + String.fromCharCode(0x80 + i)), 'a'.repeat(514)]) {
    assert.throws(() => s.configure({ models: JSON.parse(JSON.stringify({ [key]: rule })) }), { status: 400 });
    const file = path.join(data, 'projects/project/context/settings.json'); fs.writeFileSync(file, JSON.stringify({ v: 2, crossChat: false, models: { [key]: rule } }));
    const store = createContextStore(data, 'project'); assert.equal(store.settings().crossChat, true); assert.equal(store.degraded, true);
  }
  assert.equal({}.mode, undefined);
  const file = path.join(data, 'projects/project/context/settings.json'); fs.writeFileSync(file, JSON.stringify({ v: 2, crossChat: false, models: { ...map, extra: rule } }));
  assert.equal(createContextStore(data, 'project').settings().crossChat, true);
  const safe = 'p/' + 'x'.repeat(511); s.configure({ models: { [safe]: rule } }); assert.deepEqual(s.settings().models[safe], rule);
});

// Revert LIMITS.settingsBytes to 16384 (ASCII) or 32768 (non-ASCII) to fail the round trip.
for (const [name, id] of [['ASCII', (i) => 'p/' + String(i).padStart(3, '0') + 'm'.repeat(508)],
  ['non-ASCII', (i) => '\u754c'.repeat(256) + '/' + String.fromCharCode(0x4e00 + i) + '\u754c'.repeat(255)]]) test(`largest valid ${name} settings round trip with 32 maximum-length model ids`, (t) => {
  const data = fixture(t), s = createContextStore(data, 'project');
  const models = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [id(i), { mode: 'tokens', value: 200000 }]));
  const patch = { crossChat: false, budget: { mode: 'tokens', value: 200000 }, models };
  assert.ok(Object.keys(models).every((id) => id.length === 513));
  s.configure(patch);
  const file = path.join(data, 'projects/project/context/settings.json');
  assert.ok(fs.statSync(file).size > (name === 'ASCII' ? 16384 : 32768)); assert.ok(fs.statSync(file).size <= 65536);
  const fresh = createContextStore(data, 'project'); assert.deepEqual(fresh.settings(), patch); assert.equal(fresh.degraded, false);
  fresh.configure({ models: { [Object.keys(models)[0]]: null } }); assert.equal(Object.keys(fresh.settings().models).length, 31);
});

// Revert modelKey's isWellFormed check to admit lone surrogates on writes or reads.
test('settings refuse lone-surrogate override ids instead of consuming JSON escape capacity', (t) => {
  const data = fixture(t), s = createContextStore(data, 'project'), rule = { mode: 'tokens', value: 1000 };
  s.configure({ crossChat: false });
  for (const key of ['p/bad\ud800', 'bad\udc00/m']) {
    assert.throws(() => s.configure({ models: { [key]: rule } }), { status: 400 });
    const file = path.join(data, 'projects/project/context/settings.json'); fs.writeFileSync(file, JSON.stringify({ v: 2, crossChat: false, models: { [key]: rule } }));
    const read = createContextStore(data, 'project'); assert.equal(read.settings().crossChat, true); assert.equal(read.degraded, true);
  }
});

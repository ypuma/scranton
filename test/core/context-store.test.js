import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createContextStore, normalizeNotes } from '../../src/core/context/store.js';

function fixture(t) { const base = path.resolve('.scratch/context-system/lane-a'); fs.mkdirSync(base, { recursive: true }); const data = fs.mkdtempSync(path.join(base, 'store-')); t.after(() => fs.rmSync(data, { recursive: true, force: true })); return data; }
// Anchors: normalizeNotes length/control handling, read's size/nlink checks and defaults,
// checkPath before mkdir/open, atomic O_EXCL + fsync + rename and cleanup.
test('notes normalise CRLF and controls, count JS characters, reject excess, and clear with empty text', (t) => {
  const data = fixture(t), s = createContextStore(data, 'project');
  assert.equal(normalizeNotes('A\r\nB\x00\x1b\tC\rD'), 'A\nB\tCD'); s.setNotes('😀'.repeat(2000)); assert.equal(s.notes().chars, 4000);
  assert.throws(() => s.setNotes('😀'.repeat(2001)), /limit/); assert.equal(s.notes().chars, 4000);
  s.setNotes(''); assert.equal(s.notes().text, ''); assert.throws(() => s.setNotes(null));
});
test('missing/corrupt/oversized files default independently; atomic writes leave no temporary files and use private mode', (t) => {
  const data = fixture(t), s = createContextStore(data, 'project'), c = createContextStore(data, 'project', 'chat');
  assert.deepEqual(s.settings(), { crossChat: true }); assert.equal(s.notes().updatedAt, null); assert.deepEqual(c.state(), { resetAt: null });
  s.configure({ crossChat: false }); s.setNotes('text'); c.setReset('2026-01-01T00:00:00Z');
  assert.deepEqual(s.settings(), { crossChat: false }); assert.equal(c.state().resetAt, '2026-01-01T00:00:00.000Z');
  const root = path.join(data, 'projects/project/context'); assert.deepEqual(fs.readdirSync(root).sort(), ['notes.md', 'settings.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'notes.md')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(root, 'notes.md'), 'x'.repeat(16385)); assert.equal(s.notes().text, '');
  fs.writeFileSync(path.join(root, 'settings.json'), '{broken'); assert.deepEqual(s.settings(), { crossChat: true });
  fs.writeFileSync(path.join(root, 'settings.json'), ' '.repeat(1025)); assert.deepEqual(s.settings(), { crossChat: true });
  fs.writeFileSync(path.join(data, 'projects/project/chats/chat/context/state.json'), '{broken'); assert.equal(c.state().resetAt, null);
  assert.throws(() => s.configure({ crossChat: true, other: true })); assert.throws(() => createContextStore(data, '../escape'));
});
test('linked ancestor and hardlinked artifacts are refused without modifying their targets', (t) => {
  const data = fixture(t), victim = path.join(data, 'victim'); fs.mkdirSync(victim);
  const project = path.join(data, 'projects/project'); fs.mkdirSync(path.dirname(project), { recursive: true }); fs.symlinkSync(victim, project, process.platform === 'win32' ? 'junction' : 'dir');
  const s = createContextStore(data, 'project'); assert.equal(s.notes().text, ''); assert.throws(() => s.setNotes('attack'), /path/i); assert.deepEqual(fs.readdirSync(victim), []);
  fs.rmSync(project); fs.mkdirSync(path.join(project, 'context'), { recursive: true });
  const source = path.join(victim, 'notes.md'); fs.writeFileSync(source, 'PRIVATE'); fs.linkSync(source, path.join(project, 'context/notes.md'));
  assert.equal(s.notes().text, ''); assert.throws(() => s.setNotes('attack'), /artifact/); assert.equal(fs.readFileSync(source, 'utf8'), 'PRIVATE');
});

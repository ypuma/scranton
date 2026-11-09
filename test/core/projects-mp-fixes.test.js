import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry } from '../../src/core/projects.js';
function fixture(t) {
  const base = path.resolve('.scratch/mp-fix-backend'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'registry-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'); const r = createProjectRegistry({ dataDir: data });
  return { dir, data, r };
}
test('registry recovers stale empty locks and retries a disappearing or initializing lock', (t) => {
  const { data, r } = fixture(t), lock = path.join(data, '.registry-lock');
  fs.writeFileSync(lock, ''); fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal(r.locked(() => 'recovered'), 'recovered');
  for (const contents of ['', JSON.stringify({ pid: process.pid })]) {
    fs.writeFileSync(lock, contents);
    const original = fs.readFileSync;
    let first = true;
    const mock = t.mock.method(fs, 'readFileSync', function (file, ...args) {
      if (file === lock && first) { first = false; fs.rmSync(lock); }
      return original.call(this, file, ...args);
    });
    assert.equal(r.locked(() => 'retried'), 'retried'); mock.mock.restore();
  }
});

test('corrupt chat is listed as an error without hiding healthy siblings', (t) => {
  const { dir, data, r } = fixture(t); const ws = path.join(dir, 'ws'); fs.mkdirSync(ws);
  const p = r.addProject({ name: 'One', workspace: ws }), good = r.createChat(p.id), bad = r.createChat(p.id);
  fs.writeFileSync(path.join(data, 'projects', p.id, 'chats', bad.id, 'chat.json'), 'null');
  assert.equal(r.listChats(p.id).find((c) => c.id === bad.id).error, 'Corrupt chat metadata');
  assert.equal(r.getChat(p.id, good.id).id, good.id);
  assert.throws(() => r.getChat(p.id, bad.id), /Corrupt/);
});

test('workspace refuses registry ancestors and nested registered workspaces', (t) => {
  const { dir, r } = fixture(t);
  assert.throws(() => r.addProject({ name: 'Ancestor', workspace: dir }), /Forbidden/);
  const ws = path.join(dir, 'ws'); fs.mkdirSync(ws);
  r.addProject({ name: 'Parent', workspace: ws });
  assert.throws(() => r.addProject({ name: 'Nested', workspace: path.join(ws, 'child'), create: true }), /nested/);
});

test('fresh empty locks retry rather than being treated as corrupt; dead PID locks recover', (t) => {
  const { data, r } = fixture(t), lock = path.join(data, '.registry-lock');
  fs.writeFileSync(lock, '');
  const original = fs.readFileSync; let reads = 0;
  const mock = t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === lock && ++reads === 2) fs.rmSync(lock);
    return original.call(this, file, ...args);
  });
  assert.equal(r.locked(() => 'retried'), 'retried'); assert.ok(reads >= 2); mock.mock.restore();
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999 }));
  const kill = process.kill;
  t.mock.method(process, 'kill', function (pid, signal) { if (pid === 999999) throw Object.assign(Error('dead'), { code: 'ESRCH' }); return kill(pid, signal); });
  assert.equal(r.locked(() => 'recovered'), 'recovered');
});

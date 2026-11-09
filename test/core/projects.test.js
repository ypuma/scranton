import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectRegistry, validateId } from '../../src/core/projects.js';
import { acquireRunLease } from '../../src/core/run-lease.js';

export function fixture(t) {
  const root = path.resolve('.scratch/multiproject-backend'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function setup(t) {
  const dir = fixture(t), dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  return { dir, dataDir, workspace, registry: createProjectRegistry({ dataDir, projectsRoot: path.join(dir, 'new') }) };
}
test('registry validates names, IDs, forbidden paths and duplicate real workspaces', (t) => {
  const { registry: r, workspace, dataDir } = setup(t);
  const p = r.addProject({ name: 'One', workspace });
  assert.equal(p.workspace, fs.realpathSync(workspace));
  assert.throws(() => r.addProject({ name: 'Duplicate', workspace }), /already registered/);
  for (const workspace of [dataDir, path.join(dataDir, 'nested'), path.parse(dataDir).root, os.homedir(), 'relative']) assert.throws(() => r.addProject({ name: 'Bad', workspace, create: true }));
  for (const id of ['../escape', 'A', '', 'x'.repeat(41), 'con']) assert.throws(() => validateId(id));
  for (const name of ['', ' ', '\ninvalid', 'x'.repeat(121)]) assert.throws(() => r.addProject({ name, workspace }));
  assert.equal(r.addProject({ name: 'Created' }).name, 'Created');
});
test('corrupt projects and chat metadata are never overwritten', (t) => {
  const { registry: r, workspace, dataDir } = setup(t);
  const file = path.join(dataDir, 'projects.json');
  for (const text of ['{bad', 'null', '{"v":2,"projects":[]}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => r.addProject({ name: 'No', workspace }));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  fs.rmSync(file);
  const p = r.addProject({ name: 'One', workspace }), c = r.createChat(p.id);
  const chatFile = path.join(dataDir, 'projects', p.id, 'chats', c.id, 'chat.json');
  fs.writeFileSync(chatFile, 'null');
  // A malformed file is not equivalent to an absent chat.
  assert.throws(() => r.updateChat(p.id, c.id, { title: 'Changed' }));
  assert.equal(fs.readFileSync(chatFile, 'utf8'), 'null');
});
test('chat/project removal refuses ownership and never removes workspace or external hive', (t) => {
  const { registry: r, workspace, dir } = setup(t);
  fs.writeFileSync(path.join(workspace, 'keep'), 'yes');
  const p = r.addProject({ name: 'One', workspace }), c = r.createChat(p.id);
  acquireRunLease(c.hiveDir, { runId: 'live' });
  assert.throws(() => r.removeChat(p.id, c.id), /running/);
  assert.throws(() => r.removeProject(p.id), /running/);
  fs.rmSync(path.join(c.hiveDir, 'control', 'owner.json'));
  const external = path.join(dir, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'keep'), 'yes');
  r.createChat(p.id, { hiveDir: external });
  r.removeProject(p.id, { deleteHistory: true });
  assert.equal(fs.readFileSync(path.join(workspace, 'keep'), 'utf8'), 'yes');
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'yes');
});
test('legacy import is idempotent and references the original hive without moving it', (t) => {
  const { registry: r, workspace, dataDir } = setup(t);
  const hive = path.join(dataDir, 'hive'); fs.mkdirSync(hive); fs.writeFileSync(path.join(hive, 'events.jsonl'), 'legacy');
  r.importLegacy(workspace); r.importLegacy(workspace);
  const p = r.listProjects()[0]; assert.equal(p.name, 'Scranton');
  assert.equal(r.listChats(p.id)[0].hiveDir, hive);
  r.removeProject(p.id, { deleteHistory: true });
  assert.equal(fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8'), 'legacy');
});

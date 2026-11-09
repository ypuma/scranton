import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createRegistryRouter } from '../../src/server/registry-router.js';

test('unscoped aliases skip corrupt chats and return 404 when none are readable', async (t) => {
  const root = path.resolve('.scratch/mp-fix-backend2');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'), ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  const registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Test', workspace: ws });
  const bad = registry.createChat(project.id), good = registry.createChat(project.id);
  const metadata = (chat) => path.join(data, 'projects', project.id, 'chats', chat.id, 'chat.json');
  fs.writeFileSync(metadata(bad), '{broken');
  const selected = [];
  const router = createRegistryRouter({ dataDir: data, maxConcurrentRuns: 4, control: { auth: { close() {} } },
    contextFactory({ hive }) {
      selected.push(hive);
      return { handleState(req, res) { res.end('{}'); }, close() {} };
    } });
  t.after(() => router.close());
  const req = { method: 'GET', headers: { host: '127.0.0.1:1771', 'x-scranton-client': '1' }, socket: { remoteAddress: '127.0.0.1', localPort: 1771 } };
  const res = { end() {} };
  assert.equal(await router.handle(req, res, '/api/state'), true);
  assert.deepEqual(selected, [good.hiveDir]);
  fs.writeFileSync(metadata(good), '{broken');
  await assert.rejects(router.handle(req, res, '/api/state'), { status: 404, message: 'No active chat' });
});

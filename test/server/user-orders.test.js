import '../core/isolation-test-root.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fixture, until } from './agent-fixture.js';
import { createAccess } from '../../src/core/access.js';
import { createControl } from '../../src/server/control.js';

for (const scoped of [false, true]) test(`access approval API ${scoped ? 'scoped' : 'single'} narrows and rejects escalation`, async t => {
  const f = await fixture(t, scoped), home = path.join(f.dir, 'fake-home'), outside = path.join(home, 'Documents');
  fs.mkdirSync(outside, { recursive: true });
  const access = createAccess({ home, hiveDir: f.hive, env: { SCRANTON_CREDENTIALS_DIR: path.join(home, 'own-store') } });
  const runner = f.start([{ toolCalls: [{ id: 'access', name: 'request_access', arguments: { path: outside, mode: 'write', reason: 'Create result' } }] }, { text: '[TASK_COMPLETE]' }], { access, approvals: { tools: [], timeoutSeconds: 60 } });
  const route = f.prefix + '/approvals';
  const item = (await until(async () => (await f.request(route)).json(), value => value.approvals.length)).approvals[0];
  assert.equal(item.tool, 'request_access'); assert.deepEqual(item.args, { path: outside, mode: 'write', reason: 'Create result' });
  assert.equal(item.protected, null); assert.match(item.warning, /not covered by undo/);
  const body = { workflowId: runner.workflowId, callId: item.callId, approved: true };
  assert.equal((await f.request(route, { ...body, grant: 'admin' })).status, 400);
  assert.equal((await f.request(route, { ...body, approved: false, grant: 'read' })).status, 400);
  assert.equal((await f.request(route, { ...body, grant: 'read' })).status, 202);
  assert.equal((await runner.done).ok, true); assert.equal(access.roots()[0].mode, 'read');
  const reader = f.start([{ toolCalls: [{ id: 'read-access', name: 'request_access', arguments: { path: outside, mode: 'read', reason: 'Inspect' } }] }, { text: '[TASK_COMPLETE]' }], { access });
  await until(async () => (await f.request(route)).json(), value => value.approvals.length);
  const readBody = { workflowId: reader.workflowId, callId: 'read-access', approved: true };
  assert.equal((await f.request(route, { ...readBody, grant: 'write' })).status, 400);
  assert.equal((await f.request(route, { ...readBody, grant: 'read' })).status, 202);
  assert.equal((await reader.done).ok, true);
});

test('run start API validates permissions and forwards it separately from sandbox', async t => {
  const base = path.resolve('.scratch/user-orders-runtime'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'api-')), children = [], calls = [];
  const control = createControl({ hive: path.join(dir, 'hive'), workspace: path.join(dir, 'work'), auth: { close() {} }, acquire: () => ({ token: 'test-lease' }), runner(file, args, options) {
    calls.push({ args, options });
    const child = Object.assign(new EventEmitter(), { pid: 123, stdin: { on() {}, write() {} } }); children.push(child); return child;
  } });
  t.after(async () => { for (const child of children) child.emit('close', 0); await control.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const start = async body => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json', 'x-scranton-client': '1', host: 'localhost' }, socket: { localPort: 80, remoteAddress: '127.0.0.1' } });
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await control.handle(req, res, '/api/runs'); return res.status;
  };
  for (const permissions of ['wrong', true, 1, {}, []]) assert.equal(await start({ request: 'test', permissions }), 400);
  for (const permissions of ['ask', 'auto', 'bypass']) {
    assert.equal(await start({ request: 'test', permissions, trustedHost: true }), 202);
    const args = calls.at(-1).args;
    assert.equal(args[args.indexOf('--permissions') + 1], permissions); assert.ok(args.includes('--trusted-host'));
    children.at(-1).emit('close', 0);
  }
});

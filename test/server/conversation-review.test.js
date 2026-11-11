import '../core/isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { releaseRunLease } from '../../src/core/run-lease.js';

async function fixture(t) {
  const root = path.resolve('.scratch/chat-backend-fix/server'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'review-')), hive = path.join(dir, 'hive');
  let child, env;
  const server = await startVisualizerServer({ hiveDir: hive, publicDir: dir, port: 0, control: { workspace: path.join(dir, 'ws'), auth: { close() {} }, runner(_exe, _argv, options) {
    env = options.env; child = Object.assign(new EventEmitter(), { pid: 123 }); return child;
  } } });
  t.after(async () => { if (child) { releaseRunLease(hive, env.SCRANTON_RUN_LEASE); child.emit('close', 0); } await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return async (route, body) => {
    const res = await fetch(server.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(res.status, body === undefined ? 200 : 202); return res.json();
  };
}

test('control discovery omits disabled conversation and exposes true only when enabled', async (t) => {
  const prior = process.env.SCRANTON_CONVERSATION;
  t.after(() => { if (prior === undefined) delete process.env.SCRANTON_CONVERSATION; else process.env.SCRANTON_CONVERSATION = prior; });
  const req = await fixture(t);
  for (const setting of ['0', '1']) {
    process.env.SCRANTON_CONVERSATION = setting;
    for (const route of ['/api/control', '/api/projects/default/chats/default/control']) {
      const { defaults } = await req(route);
      assert.equal(Object.hasOwn(defaults.execution, 'conversation'), setting === '1', 'off-mode response has no conversation key');
      if (setting === '1') assert.equal(defaults.execution.conversation, true);
    }
  }
});

test('question demo control metadata describes the same question as the CLI', async (t) => {
  const req = await fixture(t);
  await req('/api/runs', { demo: { scenario: 'question', delayMs: 0 }, conversation: true });
  assert.equal((await req('/api/control')).run.request, 'How does the Team orchestrator handle a request?', 'question metadata is not a todo build request');
});

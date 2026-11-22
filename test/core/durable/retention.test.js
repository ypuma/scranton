import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createDurableRuntime, createDurableClient } from '../../../src/core/durable/index.js';

const root = resolve('.scratch/durable-tests');
mkdirSync(root, { recursive: true });
async function fixture(t) {
  const directory = mkdtempSync(join(root, 'retention-'));
  const config = { hiveDir: directory, markerDir: join(directory, 'markers'), env: {} };
  const runtime = await createDurableRuntime(config);
  t.after(async () => { await runtime.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, config };
}

test('at-most-once markers are removed after success and error checkpoints, while workflow remains pending', async t => {
  const { runtime, config } = await fixture(t);
  runtime.registerWorkflow('markers', async wf => {
    await wf.runStep(async () => 1, { name: 'ok', atMostOnce: true });
    try { await wf.runStep(async () => { throw new Error('expected'); }, { name: 'fail', atMostOnce: true }); } catch {}
    await wf.setEvent('ready', true);
    await wf.recv('finish');
  });
  await runtime.launch();
  const handle = await runtime.startWorkflow('markers', { workflowId: 'markers' });
  await runtime.getEvent('markers', 'ready');
  try { assert.deepEqual(readdirSync(config.markerDir), []); }
  finally { await runtime.send('markers', true, 'finish'); await handle.getResult(); }
});

test('prune removes all terminal rows, respects age and keep count, and never removes pending workflows', async t => {
  const { runtime, config } = await fixture(t);
  runtime.registerWorkflow('data', async (wf, mode) => {
    await wf.runStep(async () => 1, { name: 'step', atMostOnce: true });
    await wf.setEvent('ready', true);
    await wf.writeStream('out', 'chunk');
    if (mode === 'pending') await wf.recv('finish');
    if (mode === 'error') throw new Error('expected');
  });
  await runtime.launch();
  for (const id of ['old', 'error', 'new']) {
    const h = await runtime.startWorkflow('data', { workflowId: id }, id);
    await h.getResult().catch(() => {});
    await runtime.send(id, 'unused');
  }
  const pending = await runtime.startWorkflow('data', { workflowId: 'pending' }, 'pending');
  await runtime.getEvent('pending', 'ready');
  const client = await createDurableClient(config);
  try {
    assert.deepEqual(await client.prune({ olderThanMs: 100000, keepLastWorkflows: 0 }), { deletedWorkflows: 0 });
    runtime.db.prepare('UPDATE workflows SET completed_at=? WHERE id=?').run(1, 'old');
    runtime.db.prepare('UPDATE workflows SET completed_at=? WHERE id=?').run(2, 'error');
    runtime.db.prepare('UPDATE workflows SET completed_at=? WHERE id=?').run(3, 'new');
    assert.deepEqual(await client.prune({ olderThanMs: 0, keepLastWorkflows: 1 }), { deletedWorkflows: 2 });
    assert.deepEqual((await client.listWorkflows()).map(row => row.workflowId).sort(), ['new', 'pending']);
    for (const table of ['operations', 'events', 'messages', 'streams']) {
      assert.equal(client.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workflow IN ('old','error')`).get().n, 0);
      assert.ok(client.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workflow='new'`).get().n > 0);
    }
    assert.ok(client.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE workflow='pending'").get().n > 0);
    for (const options of [{}, { olderThanMs: -1 }, { olderThanMs: Infinity }, { olderThanMs: 0, keepLastWorkflows: -1 }]) await assert.rejects(client.prune(options), /Invalid/);
  } finally { await client.shutdown(); await runtime.send('pending', true, 'finish'); await pending.getResult(); }
});

test('checkpoint failure retains an at-most-once marker for safe recovery', async t => {
  const { runtime, config } = await fixture(t);
  runtime.registerWorkflow('guarded', async wf => {
    const run = runtime.db.prepare.bind(runtime.db);
    runtime.db.prepare = sql => {
      if (sql.startsWith('INSERT INTO operations')) throw new Error('checkpoint unavailable');
      return run(sql);
    };
    try {
      await assert.rejects(wf.runStep(async () => 1, { name: 'once', atMostOnce: true }), /checkpoint unavailable/);
      assert.equal(readdirSync(config.markerDir).length, 1);
    } finally { runtime.db.prepare = run; }
  });
  await runtime.launch();
  await (await runtime.startWorkflow('guarded', { workflowId: 'checkpoint-failure' })).getResult();
  assert.deepEqual(readdirSync(config.markerDir), []);
});

test('terminal markers left by a crash are removed on launch, but pending markers survive', async t => {
  const { runtime, config } = await fixture(t);
  const { guardedStep } = await import('../../../src/core/durable/shared.js');
  const { encode } = await import('../../../src/core/durable/shared.js');
  for (const [id, status] of [['done', 'SUCCESS'], ['pending', 'PENDING']]) {
    runtime.db.prepare('INSERT INTO workflows(id,name,args,executor,version,status,output) VALUES(?,?,?,?,?,?,?)')
      .run(id, 'unused', encode([]), 'other-executor', '1', status, encode(true));
    await guardedStep(config.markerDir, id, 0, 'once', async () => true);
  }
  assert.equal(readdirSync(config.markerDir).length, 2);
  await runtime.launch();
  assert.equal(readdirSync(config.markerDir).length, 1);
  assert.equal((await runtime.retrieveWorkflow('pending').getStatus()).status, 'PENDING');
});

test('SQLite upgrades existing workflow schema conservatively for retention', async t => {
  const { runtime, config } = await fixture(t);
  runtime.db.exec('ALTER TABLE workflows DROP COLUMN completed_at');
  const { encode } = await import('../../../src/core/durable/shared.js');
  runtime.db.prepare('INSERT INTO workflows(id,name,args,executor,version,status,output) VALUES(?,?,?,?,?,?,?)')
    .run('legacy', 'legacy', encode([]), 'local', '1', 'SUCCESS', encode(true));
  const client = await createDurableClient(config);
  try {
    assert.deepEqual(await client.prune({ olderThanMs: 100000 }), { deletedWorkflows: 0 });
    assert.deepEqual(await client.prune({ olderThanMs: 0 }), { deletedWorkflows: 1 });
  } finally { await client.shutdown(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DBOSClientAdapter } from '../../../src/core/durable/dbos.js';

test('DBOS retention uses SDK deletion without children, and excludes all nonterminal statuses', async t => {
  t.mock.method(Date, 'now', () => 10000);
  const rows = [
    { workflowID: 'old', status: 'SUCCESS', completedAt: 1 },
    { workflowID: 'error', status: 'ERROR', completedAt: 2 },
    { workflowID: 'cancel', status: 'CANCELLED', updatedAt: 3 },
    { workflowID: 'new', status: 'SUCCESS', completedAt: 4 },
    ...['PENDING', 'ENQUEUED', 'DELAYED', 'SUSPENDED'].map(status => ({ workflowID: status, status, completedAt: 0 })),
  ];
  const deleted = [];
  const target = {
    listWorkflows: async options => { assert.equal(options.applicationName, 'test-app'); return rows; },
    retrieveWorkflow: id => ({ getStatus: async () => rows.find(row => row.workflowID === id) }),
    deleteWorkflow: async (...args) => deleted.push(args),
  };
  const client = new DBOSClientAdapter(target, { name: 'test-app' });
  assert.deepEqual(await client.prune({ olderThanMs: 0, keepLastWorkflows: 1 }), { deletedWorkflows: 3 });
  assert.deepEqual(deleted, [['cancel', false], ['error', false], ['old', false]]);
  deleted.length = 0;
  assert.deepEqual(await client.prune({ olderThanMs: Date.now(), keepLastWorkflows: 0 }), { deletedWorkflows: 0 });
  assert.deepEqual(deleted, []);
  assert.deepEqual(await client.prune({ olderThanMs: 9999 }), { deletedWorkflows: 1 });
  assert.deepEqual(deleted, [['old', false]]);
  await assert.rejects(client.prune({ olderThanMs: -1 }), /Invalid/);
});

test('DBOS retention rechecks terminal status before deletion', async () => {
  let deleted = false;
  const client = new DBOSClientAdapter({
    listWorkflows: async () => [{ workflowID: 'resumed', status: 'CANCELLED', completedAt: 1 }],
    retrieveWorkflow: () => ({ getStatus: async () => ({ status: 'PENDING' }) }),
    deleteWorkflow: async () => { deleted = true; },
  }, {});
  assert.deepEqual(await client.prune({ olderThanMs: 0 }), { deletedWorkflows: 0 });
  assert.equal(deleted, false);
});

test('DBOS guarded outcomes clean markers only after checkpoint success', async t => {
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  const { createDBOS } = await import('../../../src/core/durable/dbos.js');
  const { mkdirSync, mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const root = resolve('.scratch/durable-tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'dbos-guard-'));
  const originals = new Map();
  const replace = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(DBOS, key));
    Object.defineProperty(DBOS, key, { configurable: true, value });
  };
  let registered, position = 0, failCheckpoint = false, replay;
  replace('setConfig', () => {});
  replace('registerWorkflow', fn => { registered = fn; return fn; });
  replace('workflowID', 'guarded');
  replace('stepID', 0);
  replace('shutdown', async () => {});
  replace('reserveStep', () => ({ stepID: position++, run: (body, settings) => DBOS.runStep(body, settings) }));
  replace('runStep', async body => {
    if (replay) return replay;
    const result = await body();
    if (failCheckpoint) throw new Error('checkpoint unavailable');
    return result;
  });
  let runtime;
  t.after(async () => {
    try { if (runtime) await runtime.shutdown(); }
    finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(DBOS, key, descriptor); else delete DBOS[key];
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  runtime = await createDBOS({ markerDir: directory }, false);
  runtime.registerWorkflow('guarded', async wf => {
    const opts = { name: 'once', atMostOnce: true };
    assert.equal(await wf.runStep(async () => 42, opts), 42);
    assert.deepEqual(readdirSync(directory), []);
    await assert.rejects(wf.runStep(async () => { throw new Error('body failed'); }, opts), /body failed/);
    assert.deepEqual(readdirSync(directory), []);
    failCheckpoint = true;
    await assert.rejects(wf.runStep(async () => 3, opts), /checkpoint unavailable/);
    assert.equal(readdirSync(directory).length, 1);
    // Replaying the same interrupted checkpoint must read the marker, not rerun the side effect.
    position--;
    failCheckpoint = false;
    assert.equal(await wf.runStep(async () => assert.fail('reran side effect'), opts), 3);
    assert.deepEqual(readdirSync(directory), []);
    failCheckpoint = true;
    await assert.rejects(wf.runStep(async () => 4, opts), /checkpoint unavailable/);
    assert.equal(readdirSync(directory).length, 1);
    position--;
    replay = { scrantonGuardedOutcome: true, value: 4 };
    assert.equal(await wf.runStep(async () => assert.fail('ran a checkpointed body'), opts), 4);
    assert.deepEqual(readdirSync(directory), []);
  });
  await registered();
});

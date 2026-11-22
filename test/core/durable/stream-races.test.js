import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDurableRuntime, createDurableClient } from '../../../src/core/durable/index.js';

const root = resolve('.scratch/durable-tests');
mkdirSync(root, { recursive: true });
async function fixture(t) {
  const directory = mkdtempSync(join(root, 'stream-race-'));
  const config = { hiveDir: directory, env: {} };
  const runtime = await createDurableRuntime(config);
  const client = await createDurableClient(config);
  t.after(async () => { await client.shutdown(); await runtime.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, runtime, client };
}

test('stream drains writes made while the consumer is paused at a yield', { timeout: 10000 }, async t => {
  const { runtime, client } = await fixture(t);
  runtime.registerWorkflow('stream', async wf => {
    await wf.writeStream('output', 'first');
    await wf.writeStream('output', 'second');
    await wf.recv('continue', { timeoutSeconds: 2 });
    await wf.writeStream('output', 'third');
    await wf.writeStream('output', 'last');
  });
  await runtime.launch();
  const handle = await runtime.startWorkflow('stream', { workflowId: 'paused' });
  // Wait for both initial rows so the iterator holds a batch across the pause.
  while (client.db.prepare('SELECT COUNT(*) AS count FROM streams').get().count < 2) await client.wait();
  const iterator = client.readStream('paused', 'output');
  const first = await iterator.next();
  assert.deepEqual(first, { value: { offset: 0, value: 'first' }, done: false });
  await client.send('paused', true, 'continue');
  await handle.getResult();
  const values = [first.value];
  for await (const value of iterator) values.push(value);
  assert.deepEqual(values, [
    { offset: 0, value: 'first' }, { offset: 1, value: 'second' },
    { offset: 2, value: 'third' }, { offset: 3, value: 'last' },
  ]);
  assert.deepEqual(await Array.fromAsync(client.readStream('paused', 'output', { fromOffset: 2 })), values.slice(2));
});

test('stream rereads when another process writes and closes between read and terminal check', { timeout: 10000 }, async t => {
  const { directory, client } = await fixture(t);
  const row = client.row.bind(client);
  let checks = 0;
  client.row = id => {
    if (checks++ === 0) {
      // Force the writer to finish after the empty SELECT, before the status read.
      const result = spawnSync(process.execPath, ['test/core/durable/stream-writer.js', directory], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
    }
    return row(id);
  };
  const values = await Array.fromAsync(client.readStream('process-stream', 'output'));
  assert.equal(checks > 0, true);
  assert.equal(row('process-stream').status, 'SUCCESS');
  assert.equal(client.db.prepare('SELECT COUNT(*) AS count FROM streams WHERE closed=1').get().count, 1);
  assert.deepEqual(values, [{ offset: 0, value: 'first' }, { offset: 1, value: 'last' }]);
});

for (const readerName of ['runtime', 'client']) {
  for (const pageSize of [undefined, 7]) {
    test(`${readerName} drains ordered stream pages with pageSize ${pageSize ?? 'default'}`, async t => {
      const fixtureValue = await fixture(t);
      const { runtime } = fixtureValue;
      const reader = fixtureValue[readerName];
      const count = 785;
      runtime.registerWorkflow('pages', async wf => {
        for (let i = 0; i < count; i++) await wf.writeStream('output', i);
        if (pageSize !== undefined) await wf.closeStream('output');
      });
      await runtime.launch();
      await (await runtime.startWorkflow('pages', { workflowId: 'pages' })).getResult();
      const prepare = reader.db.prepare.bind(reader.db);
      const queries = [];
      t.mock.method(reader.db, 'prepare', sql => {
        const statement = prepare(sql);
        if (!sql.startsWith('SELECT * FROM streams')) return statement;
        assert.match(sql, /ORDER BY offset LIMIT \?$/);
        return { all: (...args) => {
          assert.equal(args[3], pageSize ?? 256);
          const rows = statement.all(...args);
          assert.ok(rows.length <= args[3]);
          queries.push({ offset: args[2], count: rows.length });
          return rows;
        } };
      });
      const values = await Array.fromAsync(reader.readStream('pages', 'output', { fromOffset: 3, pageSize }));
      assert.deepEqual(values, Array.from({ length: count - 3 }, (_, i) => ({ offset: i + 3, value: i + 3 })));
      assert.ok(queries.length > 3);
      assert.equal(queries[0].offset, 3);
      for (let i = 1; i < queries.length; i++) {
        assert.equal(queries[i].offset, queries[i - 1].offset + queries[i - 1].count);
      }
      assert.deepEqual(await Array.fromAsync(reader.readStream('pages', 'output', { fromOffset: count, pageSize })), []);
    });
  }
}

test('paged reader does not prefetch while paused and drains a growing terminal stream', { timeout: 10000 }, async t => {
  const { runtime, client } = await fixture(t);
  runtime.registerWorkflow('growing', async wf => {
    for (let i = 0; i < 9; i++) await wf.writeStream('output', i);
    await wf.recv('continue', { timeoutSeconds: 2 });
    for (let i = 9; i < 35; i++) await wf.writeStream('output', i);
  });
  await runtime.launch();
  const handle = await runtime.startWorkflow('growing', { workflowId: 'growing' });
  while (client.db.prepare('SELECT COUNT(*) AS count FROM streams').get().count < 9) await client.wait();
  const prepare = client.db.prepare.bind(client.db);
  let queries = 0;
  t.mock.method(client.db, 'prepare', sql => {
    if (sql.startsWith('SELECT * FROM streams')) queries++;
    return prepare(sql);
  });
  const iterator = client.readStream('growing', 'output', { pageSize: 4 });
  const first = await iterator.next();
  assert.deepEqual(first.value, { offset: 0, value: 0 });
  assert.equal(queries, 1);
  await client.send('growing', true, 'continue');
  await handle.getResult();
  assert.equal(queries, 1);
  const second = await iterator.next();
  assert.deepEqual(second.value, { offset: 1, value: 1 });
  assert.equal(queries, 1);
  const values = [first.value, second.value];
  for await (const value of iterator) values.push(value);
  assert.deepEqual(values, Array.from({ length: 35 }, (_, i) => ({ offset: i, value: i })));
  assert.ok(queries > 8);
});

test('SQLite stream page size must be a positive safe integer', async t => {
  const { client } = await fixture(t);
  for (const pageSize of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4']) {
    await assert.rejects(client.readStream('unused', 'output', { pageSize }).next(), /Invalid pageSize/);
  }
});

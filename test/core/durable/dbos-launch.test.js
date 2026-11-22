import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDBOS } from '../../../src/core/durable/dbos.js';

const { DBOS } = await import('@dbos-inc/dbos-sdk');
const { Client } = createRequire(import.meta.resolve('@dbos-inc/dbos-sdk'))('pg');

for (const mode of ['success', 'contention', 'admin unavailable', 'admin forbidden', 'both unavailable', 'target missing', 'lock forbidden', 'query failure', 'launch failure', 'connection lost', 'timeout', 'stalled query']) {
  test(`DBOS launch lock: ${mode}`, async t => {
    const calls = [], connections = [], queries = [], timeouts = [];
    let polls = 0;
    const secret = 'postgresql://user:secret@localhost/disposable?connect_timeout=3';
    t.mock.method(DBOS, 'setConfig', () => {});
    t.mock.method(DBOS, 'listWorkflows', async () => []);
    t.mock.method(DBOS, 'shutdown', async () => { calls.push('shutdown'); });
    t.mock.method(DBOS, 'launch', async () => {
      calls.push('launch');
      if (mode === 'launch failure') throw new Error(`launch failed ${secret}`);
    });
    t.mock.method(Client.prototype, 'connect', async function () {
      const database = this.connectionParameters.database;
      connections.push(database);
      timeouts.push(this._connectionTimeoutMillis);
      calls.push('connect');
      if (mode === 'both unavailable' || mode === 'target missing' || database === 'postgres' && ['admin unavailable', 'admin forbidden'].includes(mode)) {
        throw Object.assign(new Error(`connect failed ${secret}`), { code: mode === 'target missing' ? '3D000' : mode === 'admin forbidden' ? '42501' : 'ECONNREFUSED' });
      }
    });
    t.mock.method(Client.prototype, 'query', async function (query) {
      calls.push('poll'); queries.push(query);
      assert.equal(query.text, 'SELECT pg_try_advisory_lock(1396920910, hashtext($1)) AS acquired');
      assert.deepEqual(query.values, ['disposable']);
      assert.ok(query.query_timeout > 0 && query.query_timeout <= 120000);
      if (mode === 'lock forbidden') throw Object.assign(new Error('permission denied'), { code: '42501' });
      if (mode === 'query failure') throw new Error(`query failed ${secret}`);
      if (mode === 'connection lost') this.emit('error', new Error(`connection lost ${secret}`));
      if (mode === 'stalled query') {
        return new Promise((resolve, reject) => setTimeout(() => reject(new Error('Query read timeout')), query.query_timeout));
      }
      return { rows: [{ acquired: mode !== 'timeout' && (mode !== 'contention' || polls++ > 0) }] };
    });
    t.mock.method(Client.prototype, 'end', async () => { calls.push('end'); });
    if (mode === 'timeout') {
      let now = 0;
      t.mock.method(Date, 'now', () => now += 60001);
    }
    if (mode === 'stalled query') t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const runtime = await createDBOS({ systemDatabaseUrl: secret }, false);
    try {
      const failed = ['query failure', 'launch failure', 'connection lost', 'timeout', 'stalled query'].includes(mode);
      const launching = runtime.launch();
      if (failed) {
        const rejected = assert.rejects(launching, error => {
          assert.equal(error.message.includes('secret'), false);
          assert.match(error.message, mode === 'stalled query' ? /^Query read timeout$/ : mode === 'timeout' ? /^Timed out waiting for DBOS launch lock$/ : /failed|lost/);
          return true;
        });
        if (mode === 'stalled query') {
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(queries.length, 1);
          t.mock.timers.tick(120000);
        }
        await rejected;
        assert.equal(calls.filter(call => call === 'launch').length, mode === 'launch failure' ? 1 : 0);
        assert.deepEqual(calls.slice(-2), ['end', 'shutdown']);
      } else {
        await launching;
        assert.equal(calls.filter(call => call === 'launch').length, 1);
        const fallback = ['admin unavailable', 'admin forbidden', 'both unavailable', 'target missing', 'lock forbidden'].includes(mode);
        assert.deepEqual(connections, fallback ? ['postgres', 'disposable'] : ['postgres']);
        assert.equal(calls.filter(call => call === 'end').length, connections.length);
        if (['both unavailable', 'target missing'].includes(mode)) assert.equal(queries.length, 0);
      }
      assert.deepEqual(timeouts, connections.map(() => 3000));
    } finally { await runtime.shutdown(); }
  });
}

for (const [suffix, expected] of [['', 10000], ['?connect_timeout=7', 7000], ['?connect_timeout=0', 10000], ['?connect_timeout=invalid', 10000]]) {
  test(`DBOS lock matches SDK connect timeout: ${suffix || 'default'}`, async t => {
    t.mock.method(DBOS, 'setConfig', () => {});
    t.mock.method(DBOS, 'listWorkflows', async () => []);
    t.mock.method(DBOS, 'shutdown', async () => {});
    t.mock.method(DBOS, 'launch', async () => {});
    const timeouts = [];
    t.mock.method(Client.prototype, 'connect', async function () { timeouts.push(this._connectionTimeoutMillis); });
    t.mock.method(Client.prototype, 'query', async (query) => {
      assert.deepEqual(query.values, ['space name']);
      return { rows: [{ acquired: true }] };
    });
    t.mock.method(Client.prototype, 'end', async () => {});
    const runtime = await createDBOS({ systemDatabaseUrl: `postgresql://localhost/space%20name${suffix}` }, false);
    try {
      await runtime.launch();
      assert.deepEqual(timeouts, [expected]);
    } finally { await runtime.shutdown(); }
  });
}

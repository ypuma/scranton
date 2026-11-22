import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { redact } from '../../../src/core/durable/shared.js';

const url = process.env.SCRANTON_TEST_DBOS_URL;
for (const mode of ['fresh', 'missing single', 'missing concurrent']) test(`DBOS first launches: ${mode}`, {
  skip: !url && 'SCRANTON_TEST_DBOS_URL not set; PostgreSQL with CREATE DATABASE required',
  timeout: 180000,
}, async t => {
  const requireSDK = createRequire(import.meta.resolve('@dbos-inc/dbos-sdk'));
  const { Client } = requireSDK('pg');
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  await admin.connect();
  const database = `scranton_dbos_race_${randomUUID().replaceAll('-', '')}`;
  const children = [];
  let created = false;
  const root = resolve('.scratch/durable-tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'cold-'));
  try {
    try { await admin.query(`CREATE DATABASE ${database}`); created = true; }
    catch (error) {
      if (error.code === '42501') return t.skip('URL user requires CREATE DATABASE privilege');
      throw new Error(redact(error.message));
    }
    const target = new URL(url);
    target.pathname = `/${database}`;
    if (mode !== 'fresh') await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    const count = mode === 'missing single' ? 1 : 4;
    const workers = Array.from({ length: count }, (_, index) => {
      const child = spawn(process.execPath, ['test/core/durable/dbos-cold-child.js'], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, SCRANTON_TEST_DBOS_URL: target.href,
          SCRANTON_CREDENTIALS_DIR: join(directory, String(index), 'credentials'),
          PI_CODING_AGENT_DIR: join(directory, String(index), 'pi') },
      });
      children.push(child);
      let output = '';
      child.stdout.on('data', value => { output += value; });
      child.stderr.on('data', value => { output += value; });
      const ready = new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Child exited before barrier: ${code}: ${redact(output)}`)));
      });
      const done = new Promise(resolve => child.once('close', code => resolve({ code, output: redact(output) })));
      return { child, ready, done };
    });
    const timer = setTimeout(() => children.forEach(child => child.kill()), 150000);
    try {
      await Promise.all(workers.map(worker => worker.ready));
      for (const { child } of workers) child.send('launch');
      const results = await Promise.all(workers.map(worker => worker.done));
      assert.deepEqual(results.map(result => result.code), Array(count).fill(0), results.map(result => result.output).join('\n'));
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      assert.equal(exists.rowCount, 1, 'SDK created the target database');
    } finally { clearTimeout(timer); }
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', resolve); child.kill();
    })));
    try { if (created) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
    finally { await admin.end(); rmSync(directory, { recursive: true, force: true }); }
  }
});

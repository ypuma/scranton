import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { child } from './helpers.js';

const root = resolve('.scratch/durable-tests');
mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = mkdtempSync(join(root, 'crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function crash(directory, kind = 'normal') {
  const result = await child(['crash', directory, kind]);
  assert.equal(result.code, 71, result.stderr);
  assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), '1');
}
async function recover(directory, kind = 'normal') {
  const result = await child(['recover', directory, kind]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('hard exit after step checkpoint replays without executing step 1', { timeout: 20000 }, async t => {
  const directory = fixture(t);
  await crash(directory);
  const result = await recover(directory);
  assert.deepEqual(result.result, { one: 1, two: 2 });
  assert.equal(result.status.status, 'SUCCESS');
  assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), '1');
});

test('hard exit within an at-most-once step returns interrupted and never reruns its body', { timeout: 20000 }, async t => {
  const directory = fixture(t);
  await crash(directory, 'at-most-once');
  const result = await recover(directory, 'at-most-once');
  assert.deepEqual(readdirSync(join(directory, 'markers')), []);
  assert.deepEqual(result.result, { one: { status: 'interrupted' }, two: 2 });
  assert.equal(result.status.status, 'SUCCESS');
  assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), '1');
});

test('changed step name at a recorded position is a hard non-determinism error', { timeout: 20000 }, async t => {
  const directory = fixture(t);
  await crash(directory);
  const result = await recover(directory, 'changed');
  assert.match(result.error, /Non-determinism.*one.*different/);
  assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), '1');
});

test('launch does not recover a different appVersion or executorId', { timeout: 20000 }, async t => {
  const directory = fixture(t);
  await crash(directory);
  for (const [version, executor] of [['v2', 'run:test'], ['v1', 'run:other']]) {
    const result = await child(['inspect', directory, 'normal', version, executor]);
    assert.equal(result.code, 0, result.stderr);
    const rows = JSON.parse(result.stdout);
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'PENDING');
  }
  assert.equal((await recover(directory)).status.status, 'SUCCESS');
});

test('recovery replays helpers, events, recv, sleep and stream operations in call order', { timeout: 20000 }, async t => {
  const directory = fixture(t);
  await crash(directory, 'operations');
  const result = await recover(directory, 'operations');
  assert.equal(result.status.status, 'SUCCESS');
  assert.equal(result.result.one, 1); assert.equal(result.result.two, 2);
  assert.deepEqual(result.result.helpers, result.helpers);
  assert.deepEqual(result.stream, [{ offset: 0, value: 'before' }, { offset: 1, value: 'after' }]);
  assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), '1');
});

test('hard exit after at-most-once checkpoint replays from the database with no marker', { timeout: 20000 }, async t => {
  const directory = fixture(t);
  await crash(directory, 'at-most-once-checkpoint');
  assert.deepEqual(readdirSync(join(directory, 'markers')), []);
  const result = await recover(directory, 'at-most-once-checkpoint');
  assert.deepEqual(result.result, { one: 1, two: 2 });
  assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), '1');
});

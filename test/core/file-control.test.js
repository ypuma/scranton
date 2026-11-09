import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.js';
import { waitForResponse } from '../../src/core/file-control.js';

for (const failure of ['EBUSY', 'EPERM', 'partial']) {
  test(`human answer retries ${failure} instead of rejecting valid input`, async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'human', 'response.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const answer = { v: 1, runId: 'run', requestSeq: 2, decision: 'retry', ts: new Date().toISOString() };
    fs.writeFileSync(file, failure === 'partial' ? '{' : JSON.stringify(answer));
    const original = fs.readFileSync;
    let attempted = false;
    if (failure !== 'partial') t.mock.method(fs, 'readFileSync', function (target, ...args) {
      if (target === file && !attempted) { attempted = true; throw Object.assign(Error('locked'), { code: failure }); }
      return original.call(this, target, ...args);
    });
    const timer = failure === 'partial' ? setTimeout(() => fs.writeFileSync(file, JSON.stringify(answer)), 100) : null;
    t.after(() => clearTimeout(timer));
    const warnings = [];
    const value = await waitForResponse(dir, { runId: 'run', seq: 2, options: ['retry'] }, { signal: AbortSignal.timeout(1600), log: (...args) => warnings.push(args) });
    assert.equal(value.decision, 'retry');
    assert.deepEqual(warnings, []);
    assert.ok(fs.existsSync(path.join(dir, 'human', 'archive', 'response-run-2.json')));
  });
}

test('old malformed human answer is rejected', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'human', 'response.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{');
  fs.utimesSync(file, new Date(0), new Date(0));
  const warnings = [];
  await waitForResponse(dir, { runId: 'run', seq: 2, options: ['retry'] }, { signal: AbortSignal.timeout(400), log: (...args) => warnings.push(args) });
  assert.equal(warnings.length, 1);
  assert.equal(fs.existsSync(file), false);
});

for (const accepted of [true, false]) {
  test(`${accepted ? 'accepted' : 'rejected'} answer archive retries transient Windows locks`, async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'human', 'response.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, runId: accepted ? 'run' : 'stale', requestSeq: 2, decision: 'retry', ts: new Date().toISOString() }));
    const rename = fs.renameSync;
    let attempts = 0;
    t.mock.method(fs, 'renameSync', function (from, ...args) {
      if (from === file && ++attempts < 3) throw Object.assign(Error('locked'), { code: 'EPERM' });
      return rename.call(this, from, ...args);
    });
    const result = await waitForResponse(dir, { runId: 'run', seq: 2, options: ['retry'] }, { signal: AbortSignal.timeout(400), log() {} });
    assert.equal(result.decision, accepted ? 'retry' : 'abort');
    assert.equal(attempts, 3);
    assert.equal(fs.existsSync(file), false);
  });
}

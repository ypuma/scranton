import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup } from './fixture-cleanup.js';

test('fixture cleanup closes resources before files and continues after errors and deadlines', async () => {
  let after;
  const t = { after(fn) { assert.equal(after, undefined); after = fn; } };
  const calls = [];
  const failure = new Error('close failed');
  cleanup(t, () => calls.push('files'));
  cleanup(t, () => { calls.push('server'); throw failure; });
  cleanup(t, () => { calls.push('stalled resource'); return new Promise(() => {}); }, { timeoutMs: 20 });
  cleanup(t, () => calls.push('client'));
  await assert.rejects(after, err => {
    assert.ok(err instanceof AggregateError);
    assert.equal(err.errors[0].message, 'Fixture cleanup timed out');
    assert.equal(err.errors[1], failure);
    return true;
  });
  assert.deepEqual(calls, ['client', 'stalled resource', 'server', 'files']);
});

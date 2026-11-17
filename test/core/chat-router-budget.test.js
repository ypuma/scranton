import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatRouter } from '../../src/core/chat-router.js';

// Revert maxText=16000 or the 131072-byte command cap in ChatRouter to fail.
test('budget chat router accepts 16000 characters by send and escaped UTF-8 command, rejects 16001', async (t) => {
  const base = path.resolve('.scratch/context-budget/lane-s'); fs.mkdirSync(base, { recursive: true });
  const hiveDir = fs.mkdtempSync(path.join(base, 'router-')), rows = [];
  const router = new ChatRouter({ hiveDir, runId: 'budget-run', emit: (type, value) => rows.push({ type, ...value }) });
  t.after(async () => { await router.close(); fs.rmSync(hiveDir, { recursive: true, force: true }); });
  router.register('dwight-m1');
  const text = '\u6771'.repeat(16000);
  assert.equal((await router.send('human', { to: 'dwight-m1', text })).ok, true);
  assert.equal((await router.send('human', { to: 'dwight-m1', text: text + 'x' })).delivery, 'rejected');
  for (const text of ['\u6771'.repeat(16000), '\u0001'.repeat(15999) + 'x']) {
    const id = randomUUID(), file = path.join(router.spool, id + '.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1, id, runId: 'budget-run', to: 'dwight-m1', text }));
    assert.ok(fs.statSync(file).size > 16384);
    await router.consume(); assert.equal(rows.find((r) => r.id === id).text, text); assert.equal(rows.find((r) => r.id === id).delivery, 'queued');
    assert.equal(fs.existsSync(file), false);
  }
  const oversized = path.join(router.spool, randomUUID() + '.json'); fs.writeFileSync(oversized, ' '.repeat(131073));
  await router.consume(); assert.equal(rows.at(-1).type, 'chat_command_rejected'); assert.equal(fs.existsSync(oversized), false);
});

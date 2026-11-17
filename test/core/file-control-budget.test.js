import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validDecision, waitForResponse } from '../../src/core/file-control.js';

// Revert validDecision's feedback.length <=16000 to fail boundary acceptance and the archive.
test('budget file control accepts and archives 16000-character feedback, rejects 16001', async (t) => {
  const base = path.resolve('.scratch/context-budget/lane-s'); fs.mkdirSync(base, { recursive: true });
  const hive = fs.mkdtempSync(path.join(base, 'feedback-')), feedback = '\u6771'.repeat(16000);
  t.after(() => fs.rmSync(hive, { recursive: true, force: true }));
  assert.equal(validDecision({ decision: 'feedback', feedback }, ['feedback']), true);
  assert.equal(validDecision({ decision: 'feedback', feedback: feedback + 'x' }, ['feedback']), false);
  const human = path.join(hive, 'human'); fs.mkdirSync(human);
  fs.writeFileSync(path.join(human, 'response.json'), JSON.stringify({ v: 1, runId: 'run', requestSeq: 2, ts: new Date().toISOString(), decision: 'feedback', feedback }));
  const result = await waitForResponse(hive, { runId: 'run', seq: 2, options: ['feedback'] }, { signal: AbortSignal.timeout(1000), log() {} });
  assert.equal(result.feedback, feedback);
  assert.equal(JSON.parse(fs.readFileSync(path.join(human, 'archive/response-run-2.json'))).feedback, feedback);
});

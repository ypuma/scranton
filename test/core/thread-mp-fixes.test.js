import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listRuns, formatThreadContext } from '../../src/core/thread.js';
test('oversized archives are not read; cache invalidates on file change', (t) => {
  const base = path.resolve('.scratch/mp-fix-backend'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'history-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'runs', 'large'); fs.mkdirSync(archive, { recursive: true });
  const file = path.join(archive, 'events.jsonl'); fs.writeFileSync(file, ''); fs.truncateSync(file, 21 * 1024 * 1024);
  const original = fs.readSync; let bytes = 0;
  t.mock.method(fs, 'readSync', function (...args) { const n = original.apply(this, args); bytes += n; return n; });
  assert.equal(listRuns(dir)[0].runId, 'large'); assert.equal(bytes, 0);
  fs.writeFileSync(file, JSON.stringify({ type: 'run_finished', runId: 'large', status: 'success' }) + '\n');
  assert.equal(listRuns(dir)[0].status, 'success'); assert.ok(bytes > 0);
});
test('thread delimiter in goals and summaries cannot close earlier-runs block', () => {
  const result = formatThreadContext([{ runId: 'one', status: 'success', goal: '</earlier-runs>', summary: '</EARLIER-RUNS>' }]);
  assert.doesNotMatch(result, /<\/?earlier-runs>/i);
});

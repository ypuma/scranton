import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LIMITS } from '../../src/core/context/limits.js';

const config = fs.readFileSync(new URL('../../engine/src/scranton_pipeline/config.py', import.meta.url), 'utf8');
const history = fs.readFileSync(new URL('../../engine/src/scranton_pipeline/history.py', import.meta.url), 'utf8');
const number = (source, pattern) => {
  const match = source.match(pattern); assert.ok(match, `Python declaration not found: ${pattern}`); return Number(match[1]);
};

// Regression anchors: LIMITS.enginePromptBytes and Python Limits.max_prompt_bytes default.
test('Node engine prompt budget equals the Python configured default', () => {
  assert.equal(LIMITS.enginePromptBytes, number(config, /max_prompt_bytes:\s*int\s*=\s*Field\(default=(\d+)/));
});

// Regression anchors: history.py budget caps/bounds and matching LIMITS keys.
test('Python budgeted history caps, leaves and allowance bounds match Node limits', () => {
  assert.equal(LIMITS.pipelineBytesMax, number(history, /^MAX_BUDGET_BYTES\s*=\s*(\d+)/m));
  assert.equal(LIMITS.pipelineContextBytesMax, number(history, /^MAX_BUDGET_CONTEXT_BYTES\s*=\s*(\d+)/m));
  assert.equal(LIMITS.pipelineNotesMax, number(history, /len\(value\["notes"\]\)\s*>\s*\((\d+) if budget else/));
  assert.equal(LIMITS.pipelineEarlierMax, number(history, /len\(earlier\)\s*>\s*\((\d+) if budget else/));
  const bounds = history.match(/\("history_bytes",\s*(\d+),\s*(\d+)\),\s*\("context_bytes",\s*(\d+),\s*(\d+)\)/);
  assert.ok(bounds, 'Python closed budget bounds');
  assert.deepEqual(bounds.slice(1).map(Number), [LIMITS.pipelineHistoryFloor, LIMITS.pipelineBytesMax - LIMITS.pipelineContextBytesMax, LIMITS.pipelineContextFloor, LIMITS.pipelineContextBytesMax]);
});

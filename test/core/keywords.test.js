import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEYWORDS, extractKeyword } from '../../src/core/keywords.js';

test('finds a plain keyword', () => {
  assert.equal(extractKeyword('All good.\n[TEST_PASSED]', KEYWORDS.angela), 'TEST_PASSED');
});

test('tolerates markdown around the keyword', () => {
  assert.equal(extractKeyword('**[TEST_PASSED]**', KEYWORDS.angela), 'TEST_PASSED');
  assert.equal(extractKeyword('Done.\n\n`[TASK_COMPLETE]`', KEYWORDS.dwight), 'TASK_COMPLETE');
  assert.equal(extractKeyword('> _[TEST_FAILED]_  ', KEYWORDS.angela), 'TEST_FAILED');
});

test('the LAST known keyword wins', () => {
  const text = 'I expected [TEST_PASSED] but the second criterion fails.\n[TEST_FAILED]';
  assert.equal(extractKeyword(text, KEYWORDS.angela), 'TEST_FAILED');
  assert.equal(extractKeyword('[BLOCKED] no wait\n[TASK_COMPLETE]', KEYWORDS.dwight), 'TASK_COMPLETE');
});

test('unknown or foreign keywords are ignored', () => {
  assert.equal(extractKeyword('[TEST_PASSED] [SOMETHING_ELSE]', KEYWORDS.angela), 'TEST_PASSED');
  assert.equal(extractKeyword('[TEST_PASSED]', KEYWORDS.dwight), null);
  assert.equal(extractKeyword('[test_passed] TEST_PASSED (TEST_PASSED)', KEYWORDS.angela), null);
});

test('no keyword, empty and missing text give null', () => {
  assert.equal(extractKeyword('just a report', KEYWORDS.angela), null);
  assert.equal(extractKeyword('', KEYWORDS.angela), null);
  assert.equal(extractKeyword(undefined, KEYWORDS.angela), null);
});

test('each agent only knows its own keywords', () => {
  assert.deepEqual(KEYWORDS.michael, ['PLAN_READY', 'PROGRESS', 'STALLED']);
  assert.deepEqual(KEYWORDS.dwight, ['TASK_COMPLETE', 'BLOCKED']);
  assert.deepEqual(KEYWORDS.angela, ['TEST_PASSED', 'TEST_FAILED', 'BLOCKED']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { quotePathArgument } from '../../src/core/run-summary.js';

test('path argument quoting escapes control characters without changing ordinary paths', () => {
  for (const platform of ['win32', 'linux']) {
    const value = 'path\r\n\t\x00\x1b[2J\x7f\x9b\u2028\u202e';
    const quoted = quotePathArgument(value, platform);
    assert.doesNotMatch(quoted, /[\x00-\x1f\x7f-\x9f\u2028\u202e]/);
    assert.match(quoted, /path\\u000d\\u000a\\u0009\\u0000\\u001b/);
  }
  assert.equal(quotePathArgument('C:\\project folder\\hive', 'win32'), '"C:\\project folder\\hive"');
  assert.equal(quotePathArgument("project's hive", 'linux'), "'project'\\''s hive'");
});

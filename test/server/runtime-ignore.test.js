import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ROOT } from '../core/helpers.js';

test('control runtime files are ignored but Hive placeholders remain visible', () => {
  const ignored = ['hive/human/response.json', 'hive/human/archive/rejected-test.json', 'hive/control/stop.json', 'hive/state.json.123.tmp'];
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: ROOT, input: ignored.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ignored);
  const kept = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: ROOT, input: 'hive/README.md\nhive/human/.gitkeep\n', encoding: 'utf8' });
  assert.equal(kept.status, 1, kept.stderr);
  assert.equal(kept.stdout, '');
});

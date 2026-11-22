import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve('.scratch/durable-tests');
function child(action, directory, kind) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['test/core/durable/dbos-child.js', action, directory, kind], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...globalThis.process.env, SCRANTON_CREDENTIALS_DIR: join(directory, 'credentials'), PI_CODING_AGENT_DIR: join(directory, 'pi') },
    });
    let output = '';
    process.stdout.on('data', value => { output += value; });
    process.stderr.on('data', value => { output += value; });
    const timer = setTimeout(() => process.kill(), 180000);
    process.on('error', reject);
    process.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('DBOS cross-process recovery, live stream client and retention', {
  skip: !process.env.SCRANTON_TEST_DBOS_URL && 'SCRANTON_TEST_DBOS_URL not set; disposable PostgreSQL required',
  timeout: 600000,
}, async t => {
  mkdirSync(root, { recursive: true });
  for (const kind of ['normal', 'guarded']) {
    await t.test(`crash and relaunch with the same executor: ${kind}`, async t => {
      const directory = mkdtempSync(join(root, 'dbos-recovery-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const crash = await child('crash', directory, kind);
      assert.equal(crash.code, 71, crash.output);
      const recovered = await child('recover', directory, kind);
      assert.equal(recovered.code, 0, recovered.output);
    });
  }
  for (const action of ['live', 'prune']) {
    await t.test(action, async t => {
      const directory = mkdtempSync(join(root, `dbos-${action}-`));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const result = await child(action, directory, 'normal');
      assert.equal(result.code, 0, result.output);
    });
  }
});

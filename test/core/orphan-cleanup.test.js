import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { readRunLease, readRunHeartbeat, runOwnerStatus } from '../../src/core/run-lease.js';
import { createControl } from '../../src/server/control.js';

function fixture(t) {
  const root = path.resolve('.scratch/orphan-fix'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, hive: path.join(dir, 'hive'), workspace: path.join(dir, 'ws') };
}
const output = { write() {} };
function cli(f) {
  return runCli(['run', 'test', '--trusted-host', '--hive', f.hive, '--workspace', f.workspace], { cwd: f.dir, env: {}, stdout: output, stderr: output });
}

test('failed first heartbeat write releases newly acquired CLI lease', async (t) => {
  const f = fixture(t), original = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(f.hive, 'control', 'heartbeat.json')) throw Object.assign(Error('heartbeat write failed'), { code: 'EIO' });
    return original(from, to);
  });
  await assert.rejects(cli(f), /heartbeat write failed/);
  assert.equal(readRunLease(f.hive), null, 'failed first heartbeat must release its newly acquired lease');
});

test('unclean CLI finish pins cleanup unresolved and never automatically releases', async (t) => {
  const f = fixture(t), reason = 'Container removal failed';
  t.mock.method(Orchestrator.prototype, 'run', async function () {
    this.cleanupComplete = false; this.cleanupReason = reason;
    return { status: 'aborted', cleanupComplete: false, summary: 'Interrupted' };
  });
  assert.equal(await cli(f), 1);
  assert.equal(readRunHeartbeat(f.hive).cleanup, 'unresolved', 'unclean finish must persist unresolved cleanup');
  const beat = readRunHeartbeat(f.hive);
  fs.writeFileSync(path.join(f.hive, 'control', 'heartbeat.json'), JSON.stringify({ ...beat, pid: 2147483647 }));
  assert.equal(runOwnerStatus(f.hive), 'unknown', 'unresolved cleanup outranks a dead PID');
  const controller = createControl({ hive: f.hive, workspace: f.workspace, auth: { close() {} } });
  t.after(() => controller.close());
  await controller.recoverGone();
  assert.equal(controller.snapshot().orphan.recoveryError, `Cleanup of this run could not be verified: ${reason}`);
  assert.ok(readRunLease(f.hive), 'unclean finish stays locked');
});

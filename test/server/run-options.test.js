import '../core/isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { readRunLease, releaseRunLease } from '../../src/core/run-lease.js';
import { PACKAGE_ROOT, loadConfig } from '../../src/core/config.js';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';

for (const route of ['/api/runs', '/api/projects/default/chats/default/runs']) test(`own runtime options map unchanged for ${route}`, async t => {
  const base = path.resolve('.scratch/server-switch'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'options-')), hive = path.join(dir, 'hive');
  let invocation, child, cliConfig;
  t.mock.method(Orchestrator.prototype, 'run', async function () { cliConfig = this.config; return { status: 'success' }; });
  const server = await startVisualizerServer({ hiveDir: hive, publicDir: dir, port: 0, control: { workspace: path.join(dir, 'ws'), auth: { close() {} }, runner(exe, args, opts) { invocation = { exe, args, opts }; child = Object.assign(new EventEmitter(), { pid: 123 }); return child; } } });
  const finish = () => { const lease = readRunLease(hive); if (lease) releaseRunLease(hive, lease.token); child?.emit('close', 0); child = null; };
  t.after(async () => { finish(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = body => fetch(server.url + route, { method: 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json' }, body: JSON.stringify({ request: 'Task', ...body }) });
  for (const body of [{ sandbox: 'host' }, { sandbox: 'scranton', trustedHost: true }, { sandbox: 'scranton', sandboxImage: 'image:1' }, { sandboxNetwork: 'invalid' }, { approvals: {} }, { approvals: { tools: ['unknown'] } }, { approvals: { tools: ['write', 'write'] } }, { approvals: { tools: ['write'], timeoutSeconds: 0 } }, { approvals: { tools: [], extra: 1 } }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  for (const timeoutSeconds of [0.5, 1.5, 86401, 1e100, 0, -1, '600', null, true]) {
    invocation = undefined;
    const response = await post({ approvals: { tools: ['write'], timeoutSeconds } });
    assert.equal(response.status, 400, JSON.stringify({ timeoutSeconds }));
    assert.match((await response.json()).error, /approvals.timeoutSeconds must be an integer from 1 to 86400/);
    assert.equal(invocation, undefined);
    assert.equal(readRunLease(hive), null);
  }
  for (const timeoutSeconds of [1, 86400]) {
    const response = await post({ approvals: { tools: [], timeoutSeconds } });
    assert.equal(response.status, 202, await response.text());
    assert.equal(invocation.args[invocation.args.indexOf('--approval-timeout') + 1], String(timeoutSeconds));
    finish();
  }
  for (const sandbox of ['scranton', 'docker', 'host']) {
    const response = await post({ sandbox, ...(sandbox === 'host' ? { trustedHost: true } : {}), sandboxNetwork: 'allow', ...(sandbox === 'docker' ? { sandboxImage: 'local/tool:1' } : {}), approvals: { tools: ['write', 'edit'], timeoutSeconds: 90 } });
    assert.equal(response.status, 202, await response.text());
    const args = invocation.args;
    assert.equal(args[args.indexOf('--sandbox') + 1], sandbox); assert.equal(args.includes('--trusted-host'), sandbox === 'host');
    assert.equal(args[args.indexOf('--sandbox-network') + 1], 'allow');
    assert.equal(args[args.indexOf('--approve') + 1], 'write,edit'); assert.equal(args[args.indexOf('--approval-timeout') + 1], '90');
    assert.deepEqual(args.slice(-2), ['--', 'Task']);
    const flags = { approve: args[args.indexOf('--approve') + 1], approvalTimeout: args[args.indexOf('--approval-timeout') + 1] };
    const expected = loadConfig({ cwd: dir, env: {}, fileConfig: {}, flags }).approvals;
    assert.deepEqual(expected, { tools: ['write', 'edit'], timeoutSeconds: 90 });
    let err = '';
    assert.equal(await runCli(['run', 'Task', '--approve', flags.approve, '--approval-timeout', flags.approvalTimeout, '--hive', path.join(dir, 'cli-hive')], {
      cwd: dir, env: { SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'), PI_CODING_AGENT_DIR: path.join(dir, 'legacy') },
      stdout: { write() {} }, stderr: { write(s) { err += s; } }
    }), 0, err);
    assert.deepEqual(cliConfig.approvals, expected);
    finish();
  }
  assert.equal((await post({ sandboxNetwork: 'bridge', approvals: { tools: [] } })).status, 202);
  assert.equal(invocation.args[invocation.args.indexOf('--sandbox-network') + 1], 'allow');
  assert.equal(invocation.args[invocation.args.indexOf('--approve') + 1], ''); finish();
  assert.equal((await post({ demo: { scenario: 'happy', delayMs: 0 } })).status, 202);
  assert.equal(invocation.opts.env.SCRANTON_FAKE_MODE, '1'); assert.equal(invocation.opts.env.SCRANTON_FAKE_SCENARIO, 'happy');
});

for (const route of ['/api/runs', '/api/projects/default/chats/default/runs']) test(`launch config rejects incompatible execution before spawning for ${route}`, async t => {
  const base = path.resolve('.scratch/server-switch'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'validation-')), hive = path.join(dir, 'hive');
  let explicitPowerShell = true, child, starts = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(PACKAGE_ROOT, 'scranton.config.json')) return JSON.stringify(explicitPowerShell ? { agents: { dwight: { tools: ['read', 'powershell'] } } } : {});
    return read.call(this, file, ...args);
  });
  const server = await startVisualizerServer({ hiveDir: hive, publicDir: dir, port: 0, control: {
    workspace: path.join(dir, 'ws'), auth: { close() {} },
    runner() { starts++; child = Object.assign(new EventEmitter(), { pid: 123 }); return child; }
  } });
  const finish = () => { const lease = readRunLease(hive); if (lease) releaseRunLease(hive, lease.token); child?.emit('close', 0); child = null; };
  t.after(async () => { finish(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = body => fetch(server.url + route, { method: 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json' }, body: JSON.stringify({ request: 'Task', ...body }) });
  const docker = await post({ sandbox: 'docker' });
  assert.equal(docker.status, 400);
  assert.equal((await docker.json()).error, 'agents.dwight.tools: powershell is unavailable in the Linux Docker tool image; use bash');
  assert.equal(starts, 0);
  assert.equal(readRunLease(hive), null);
  explicitPowerShell = false;
  await t.test('Windows native network denial is rejected before launch', { skip: process.platform !== 'win32' }, async () => {
    const response = await post({ sandbox: 'scranton', sandboxNetwork: 'none' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Windows Scranton sandbox cannot block network; use --sandbox docker with --sandbox-network none');
    assert.equal(starts, 0);
    assert.equal(readRunLease(hive), null);
  });
  for (const body of [{ sandbox: 'docker', sandboxNetwork: 'none' }, { sandbox: 'scranton', sandboxNetwork: 'allow' }, { sandbox: 'host', trustedHost: true, sandboxNetwork: 'none' }]) {
    const response = await post(body);
    assert.equal(response.status, 202, await response.text());
    finish();
  }
  assert.equal(starts, 3);
});

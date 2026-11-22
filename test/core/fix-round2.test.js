import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAuthService } from '../../src/core/auth.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { runCli } from '../../src/core/cli.js';
import { runDoctor } from '../../src/core/doctor.js';
import { loadConfig, PACKAGE_ROOT } from '../../src/core/config.js';

const secret = 'FAKE_ROUND2_SECRET';
function fixture(t) {
  const base = path.resolve('.scratch/fix-round2'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const credential = { type: 'oauth', access: secret, refresh: secret, expires: 1 };
function authFixture(t, extra = {}, credentials = { openai: credential, anthropic: credential }) {
  const dir = fixture(t), file = path.join(dir, 'store.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, credentials, providers: {}, renewals: {}, deviceId: '00000000-0000-4000-8000-000000000000', import: { at: 'fixture' } }));
  const auth = createAuthService({ env: { SCRANTON_CREDENTIALS_DIR: dir, PI_CODING_AGENT_DIR: path.join(dir, 'pi') }, ...extra });
  t.after(() => auth.close());
  return { dir, file, auth };
}

test('own OAuth adapters classify rejected versus temporary refresh without disclosing secrets', async (t) => {
  for (const code of ['SCRANTON_OAUTH_REJECTED', 'SCRANTON_OAUTH_TEMPORARY']) {
    const { auth } = authFixture(t, { oauth: { openai: { refresh: async () => { throw Object.assign(Error(secret), { code, provider: 'openai' }); } } } });
    await assert.rejects(auth.mintAccessToken('openai', { minExpiryMs: 1800000 }), error => {
      assert.equal(error.code, code); assert.ok(!error.message.includes(secret)); return true;
    });
    const accounts = auth.listAccounts();
    assert.equal(accounts.find(a => a.id === 'openai').status, code === 'SCRANTON_OAUTH_REJECTED' ? 'expired' : 'signed_in');
    assert.ok(!JSON.stringify(accounts).includes(secret));
  }
});

test('proactive renewal stays nonblocking and does not overlap pending own-provider requests', async (t) => {
  const calls = [], finish = []; let blocking = true;
  const adapter = { refresh: c => { calls.push(c); return blocking ? new Promise(resolve => finish.push(() => resolve({ ...c, expires: Date.now() + 3600000 }))) : Promise.resolve({ ...c, expires: Date.now() + 3600000 }); } };
  const { auth } = authFixture(t, { oauth: { openai: adapter, anthropic: adapter } });
  const accounts = auth.listAccounts(); assert.equal(calls.length, 0);
  auth.checkRenewals(accounts); await sleep(20); assert.equal(calls.length, 1);
  auth.checkRenewals(accounts); await sleep(20); assert.equal(calls.length, 1);
  blocking = false; for (const complete of finish) complete(); await auth.close();
  assert.equal(auth.listAccounts().find(a => a.id === 'openai').renewsOnUse, false);
});

test('proactive renewal deadline bounds a stalled own OAuth adapter without marking rejection', async (t) => {
  const { auth } = authFixture(t, { renewalTimeoutMs: 10, oauth: { openai: { refresh: async (_c, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } } }, { openai: credential });
  auth.checkRenewals(auth.listAccounts()); await auth.close();
  assert.equal(auth.listAccounts().find(a => a.id === 'openai').status, 'signed_in');
});

test('failure activities in durable events and state are capped at 300; diagnostic log stays full', (t) => {
  const dir = fixture(t);
  const orchestrator = new Orchestrator({ config: { hiveDir: path.join(dir, 'hive') } });
  orchestrator.rec.start();
  orchestrator.emit('instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1', sessionId: 'fake', worktree: null, sandbox: 'host' });
  const line = 'x'.repeat(1000), text = `${line}\nsecond line`;
  for (const status of ['error', 'blocked']) {
    orchestrator.setStatus('dwight', status, text, 'dwight-m1');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'hive', 'state.json')));
    assert.equal(state.agents.dwight.activity, `${'x'.repeat(297)}...`);
    assert.equal(state.instances['dwight-m1'].activity, `${'x'.repeat(297)}...`);
  }
  orchestrator.log('error', text);
  const events = fs.readFileSync(path.join(dir, 'hive', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).message, text);
  assert.ok(events.filter((e) => e.type === 'agent_status').every((e) => e.activity.length === 300));
});

test('unknown standalone agent is a usage error before Docker model selection', async (t) => {
  const dir = fixture(t); let output = ''; const stream = { write: (s) => output += s };
  assert.equal(await runCli(['agent', 'bob', 'x'], { cwd: dir, env: {}, stdout: stream, stderr: stream }), 2);
  assert.match(output, /agent must be one of: michael, dwight, oscar, hank, angela/); assert.doesNotMatch(output, /explicit provider and model/);
  assert.equal(fs.existsSync(path.join(dir, 'hive')), false);
});

test('doctor checks Docker availability rather than obsolete explicit-model constraints', async (t) => {
  const dir = fixture(t); let output = '';
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: { execution: { sandbox: { mode: 'docker' } },
    agents: { dwight: { provider: 'anthropic', model: 'fake-catalog' }, angela: { provider: 'google', model: 'fake-catalog' } } } });
  await runDoctor({ config, env: { PATH: '' }, auth: { listAccounts: () => [] }, stdout: { write: (s) => output += s } });
  // run refuses this configuration (validateDockerModels), so doctor reports it as a failure, not a warning
  assert.match(output, /Docker/);
  assert.doesNotMatch(output, /requires an explicit provider and model/);
  assert.doesNotMatch(output, /choose a ChatGPT model|for michael, dwight/);
});

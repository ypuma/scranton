import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ModelsError } from '@earendil-works/pi-ai';
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
const wrapped = (provider, cause) => new ModelsError('oauth', `OAuth refresh failed for ${provider}`, { cause: cause instanceof Error ? cause : new Error(cause) });
const rejection = (provider, status) => wrapped(provider, provider === 'openai'
  ? `OpenAI OAuth token request failed (${status}): invalid_grant ${secret}`
  : `Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=${status}; url=https://platform.claude.com/v1/oauth/token; body=invalid_grant ${secret}`);

test('pi refresh endpoint 400/401 and permanent grant errors mark sign-in failed; all errors are sanitized', async (t) => {
  for (const provider of ['openai', 'anthropic']) {
    for (const [error, rejected] of [[rejection(provider, 400), true], [rejection(provider, 401), true], [rejection(provider, 500), false],
      ...(provider === 'openai' ? [
        [wrapped(provider, 'Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT'), true],
        [wrapped(provider, 'OpenAI OAuth grant did not include chatgpt.tokens.use.direct'), true]
      ] : []),
      [wrapped(provider, new TypeError(`fetch failed ${secret}`)), false],
      [wrapped(provider, new DOMException(`The operation was aborted due to timeout ${secret}`, 'TimeoutError')), false],
      [new ModelsError('oauth', `OAuth refresh returned a token that expires too soon for ${provider}`), false],
      [new ModelsError('auth', `Credential store modify failed for ${provider}`, { cause: rejection(provider, 400) }), false],
      [new Error(`invalid_grant ${secret}`), false]]) {
      const dir = fixture(t), authPath = path.join(dir, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({ [provider]: credential }));
      const auth = createAuthService({ authPath, env: {}, now: () => 5000, runtimeFactory: async () => ({ getAuth: async () => { throw error; } }) });
      await assert.rejects(auth.resolveDockerCredential(provider, { minExpiryMs: 1800000 }), (err) => {
        assert.doesNotMatch(err.message, /FAKE_ROUND2_SECRET|invalid_grant|fetch failed/);
        assert.equal(err.code, rejected ? 'SCRANTON_OAUTH_REJECTED' : 'SCRANTON_OAUTH_TEMPORARY', `${provider}: ${error.message}`);
        assert.match(err.message, rejected ? /rejected; sign in again/ : /right now; check the connection/);
        return true;
      });
      const accounts = auth.listAccounts();
      assert.ok(Array.isArray(accounts), 'listAccounts is synchronous');
      const account = accounts.find((a) => a.id === provider);
      assert.equal(account.status, rejected ? 'expired' : 'signed_in');
      assert.equal(account.renewsOnUse, !rejected);
      assert.equal(Boolean(account.renewFailedAt), rejected);
      assert.doesNotMatch(JSON.stringify(accounts), /FAKE_ROUND2_SECRET/);
      const marker = path.join(dir, `scranton-renewal-${provider}.json`);
      assert.equal(fs.existsSync(marker), rejected);
      if (rejected) assert.deepEqual(JSON.parse(fs.readFileSync(marker)), { expires: 1, failedAt: new Date(5000).toISOString() });
      await auth.close();
    }
  }
});

test('proactive renewal is per-provider, nonblocking, one pending request and five-minute cooldown', async (t) => {
  const dir = fixture(t), authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ openai: credential, anthropic: credential }));
  let clock = 10000; const calls = [], finish = [];
  const auth = createAuthService({ authPath, env: {}, now: () => clock, runtimeFactory: async () => ({
    getAuth: (provider, options) => {
      calls.push(provider); assert.equal(options.minOAuthValidityMs, 0); assert.ok(options.signal);
      return new Promise((resolve, reject) => finish.push(() => reject(wrapped(provider, `fetch failed ${secret}`))));
    }
  }) });
  assert.equal(calls.length, 0);
  const accounts = auth.listAccounts(); assert.equal(calls.length, 0, 'listing never makes network calls');
  assert.equal(auth.checkRenewals(accounts), undefined);
  await sleep(0); assert.deepEqual(calls, ['anthropic', 'openai']);
  clock += 600000; auth.checkRenewals(accounts); await sleep(0);
  assert.equal(calls.length, 2, 'pending requests cannot overlap even after cooldown');
  for (const complete of finish.splice(0)) complete(); await sleep(0);
  auth.checkRenewals(auth.listAccounts()); await sleep(0); assert.equal(calls.length, 4);
  for (const complete of finish.splice(0)) complete(); await sleep(0);
  clock += 299999; auth.checkRenewals(auth.listAccounts()); await sleep(0); assert.equal(calls.length, 4);
  clock++; auth.checkRenewals(auth.listAccounts()); await sleep(0); assert.equal(calls.length, 6);
  for (const complete of finish.splice(0)) complete(); await auth.close();
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('scranton-renewal-')), false);
});

test('proactive success is visible on the next listing; actual rejection is persisted, without notifications', async (t) => {
  const dir = fixture(t), authPath = path.join(dir, 'auth.json'), notices = [];
  fs.writeFileSync(authPath, JSON.stringify({ openai: credential, anthropic: credential }));
  const auth = createAuthService({ authPath, env: {}, onChange: (value) => notices.push(value), runtimeFactory: async () => ({ getAuth: async (provider) => {
    if (provider === 'anthropic') throw rejection(provider, 401);
    const data = JSON.parse(fs.readFileSync(authPath)); data.openai.expires = Date.now() + 3600000;
    fs.writeFileSync(authPath, JSON.stringify(data)); return { source: 'OAuth', auth: { apiKey: secret } };
  } }) });
  auth.checkRenewals(auth.listAccounts()); await auth.close();
  const accounts = auth.listAccounts();
  assert.equal(accounts.find((a) => a.id === 'openai').renewsOnUse, false);
  assert.equal(accounts.find((a) => a.id === 'anthropic').status, 'expired');
  assert.deepEqual(notices, []); assert.doesNotMatch(JSON.stringify(accounts), /FAKE_ROUND2_SECRET/);
});

test('proactive renewal deadline bounds a stalled runtime and never marks it rejected', async (t) => {
  const dir = fixture(t), authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ openai: credential }));
  const auth = createAuthService({ authPath, env: {}, renewalTimeoutMs: 10, runtimeFactory: async () => ({ getAuth: async () => new Promise(() => {}) }) });
  auth.checkRenewals(auth.listAccounts()); await auth.close();
  assert.equal(auth.listAccounts().find((a) => a.id === 'openai').status, 'signed_in');
  assert.equal(fs.readdirSync(dir).length, 1);
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

test('doctor fails for any partial Docker model configuration and names missing roles neutrally', async (t) => {
  const dir = fixture(t); let output = '';
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: { execution: { sandbox: { mode: 'docker' } }, pi: { command: [process.execPath, path.join(PACKAGE_ROOT, 'tools/fake-pi.js')] },
    agents: { dwight: { provider: 'anthropic', model: 'fake-catalog' }, angela: { provider: 'google', model: 'fake-catalog' } } } });
  await runDoctor({ config, env: { PATH: '' }, auth: { listAccounts: () => [] }, stdout: { write: (s) => output += s } });
  // run refuses this configuration (validateDockerModels), so doctor reports it as a failure, not a warning
  assert.match(output, /\[FAIL\] Docker requires an explicit provider and model for michael;/);
  assert.doesNotMatch(output, /choose a ChatGPT model|for michael, dwight/);
});

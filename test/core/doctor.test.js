import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runDoctor, satisfiesMin } from '../../src/core/doctor.js';
import { loadConfig } from '../../src/core/config.js';
import { createAuthService } from '../../src/core/auth.js';

async function doctor(t, { credentials = {}, agents = {}, sandbox = { available: true, backend: 'fake-native' }, mode = 'host', docker = { available: true, image: 'scranton-tools:24-r2' }, platform = process.platform, gitBash = false } = {}) {
  const root = path.resolve('.scratch/auth-port/doctor'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-')), file = path.join(dir, 'store.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, credentials, providers: {}, renewals: {}, deviceId: 'fixture', import: { at: 'fixture' } }));
  const before = fs.readFileSync(file), env = { SCRANTON_CREDENTIALS_DIR: dir, PATH: '' };
  if (gitBash) { fs.mkdirSync(path.join(dir, 'Git/bin'), {recursive: true}); fs.writeFileSync(path.join(dir, 'Git/bin/bash.exe'), 'fixture'); env.ProgramFiles = dir; }
  const auth = createAuthService({ env });
  t.after(async () => { await auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: { execution: { sandbox: { mode: 'host' } }, agents } });
  config.execution.sandbox.mode = mode;
  let output = '', probes = 0;
  const code = await runDoctor({ config, env, auth, platform, stdout: { write: (s) => output += s }, sandboxAvailable: async () => { probes++; return sandbox; }, dockerAvailable: async () => docker });
  assert.equal(probes, 1); assert.deepEqual(fs.readFileSync(file), before);
  assert.doesNotMatch(output, /FAKE_ACCESS|FAKE_REFRESH|FAKE_KEY|pi --version|pi auth check|pi default/);
  return { code, output };
}
const oauth = { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: Date.now() + 3600000 };
test('doctor reports credential metadata without refreshing or printing secrets', async (t) => {
  const { code, output } = await doctor(t, { credentials: { anthropic: oauth, openai: { type: 'api_key', key: 'FAKE_KEY' } } });
  assert.equal(code, 0); assert.match(output, /Claude \(Pro\/Max\): signed_in \(oauth\)/); assert.match(output, /ChatGPT: signed_in \(api_key\)/);
  assert.match(output, /Automatic model: anthropic\/claude-opus-5-5/);
});
test('doctor reports Automatic unavailable and fails active roles without accounts', async (t) => {
  const { code, output } = await doctor(t);
  assert.equal(code, 1); assert.match(output, /Automatic model: unavailable; sign in to Claude, ChatGPT, Gemini, Google Antigravity or Vertex/);
  for (const id of ['michael', 'dwight', 'angela']) assert.match(output, new RegExp(id + ': model Automatic \\(unavailable\\)'));
  assert.doesNotMatch(output, /oscar:|hank:/);
});
test('doctor uses the runner Automatic priority rather than catalogue ordering', async (t) => {
  const { code, output } = await doctor(t, { credentials: { openai: oauth, google: { type: 'api_key', key: 'FAKE_KEY' } } });
  assert.equal(code, 0); assert.match(output, /Automatic model: openai\/gpt-6.2-sol/);
});
test('doctor verifies explicit models against own catalogue and available accounts', async (t) => {
  const { code, output } = await doctor(t, { credentials: { openai: oauth }, agents: { dwight: { provider: 'openai', model: 'unknown-model' } } });
  assert.equal(code, 1); assert.match(output, /dwight: model openai\/unknown-model; credentials unavailable or model unknown/);
  assert.match(output, /michael: model openai\/gpt-6.2-sol/);
});
test('search and shell checks are offline and native fallback is explained', async (t) => {
  const { output } = await doctor(t, { credentials: { google: { type: 'api_key', key: 'FAKE_KEY' } } });
  for (const command of ['rg', 'fd']) assert.match(output, new RegExp(command + ' not on PATH; tools use native search fallback'));
  assert.match(output, /Git Bash:/); assert.match(output, /PowerShell:/); assert.match(output, /Node \d/);
});
test('missing native helper fails native mode but warns in explicitly trusted host', async (t) => {
  const options = { credentials: { openai: oauth }, sandbox: { available: false, reason: 'missing helper; no automatic fallback' } };
  assert.equal((await doctor(t, { ...options, mode: 'scranton' })).code, 1);
  const { code, output } = await doctor(t, options); assert.equal(code, 0); assert.match(output, /Native sandbox unavailable/); assert.match(output, /Trusted host execution is not OS isolation/);
});
test('doctor warning count matches summary without claiming all good', async (t) => {
  const { code, output } = await doctor(t, { credentials: { openai: oauth } });
  assert.equal(code, 0); const count = output.split('\n').filter((line) => line.startsWith('[warn]')).length;
  assert.match(output, new RegExp(count + ' warning' + (count === 1 ? '' : 's') + ' found; the run can start'));
  assert.doesNotMatch(output, /All good/);
});
test('Node minimum check compares full versions', () => {
  assert.equal(satisfiesMin('24.22.1', '>=22.19.0'), true); assert.equal(satisfiesMin('22.18.9', '>=22.19.0'), false);
  assert.equal(satisfiesMin('22.19.0', '>=22.19.0'), true);
});

test('credential inspection failure does not suppress independent workspace diagnostics', async (t) => {
  const root = path.resolve('.scratch/auth-port/doctor'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'broken-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: { execution: { sandbox: { mode: 'host' } } } });
  fs.writeFileSync(config.workspace, 'not a directory');
  let output = '';
  const code = await runDoctor({ config, env: { PATH: '' }, stdout: { write: (s) => output += s },
    auth: { listModels: async () => { throw Error('FAKE_SECRET'); } }, sandboxAvailable: async () => ({ available: true, backend: 'fake' }) });
  assert.equal(code, 1); assert.match(output, /michael: model Automatic/); assert.match(output, /dwight: tools/); assert.match(output, /angela: tools/); assert.match(output, /workspace not writable/); assert.match(output, /check the credential store/); assert.doesNotMatch(output, /FAKE_SECRET/);
});

test('Docker doctor checks tool executor readiness without explicit-model rules', async t => {
  const { code, output } = await doctor(t, { mode: 'docker', credentials: { openai: oauth } });
  assert.equal(code, 0); assert.match(output, /Docker tool executor ready: scranton-tools:24-r2/);
  assert.match(output, /Only tools run inside Docker/); assert.match(output, /credentials stay on the host/);
  const failed = await doctor(t, { mode: 'docker', credentials: { openai: oauth }, docker: { available: false, reason: 'daemon unreachable' } });
  assert.equal(failed.code, 1); assert.match(failed.output, /daemon unreachable/); assert.match(failed.output, /angela: tools/);
});

test('doctor reports native Windows bash unavailable even when Git Bash is installed', async t => {
  const reason = 'MSYS2 object namespace is Medium integrity; use powershell';
  const {output} = await doctor(t, {credentials: {openai: oauth}, platform: 'win32', mode: 'scranton', gitBash: true,
    sandbox: {available: true, backend: 'restricted-token', tools: {bash: {available: false, reason}}}});
  assert.ok(output.includes('Git Bash: unavailable in the Windows Scranton sandbox: ' + reason));
  assert.doesNotMatch(output, /Git Bash: available/);
  const host = await doctor(t, {credentials: {openai: oauth}, platform: 'win32', mode: 'host', gitBash: true});
  assert.match(host.output, /Git Bash: available/);
});

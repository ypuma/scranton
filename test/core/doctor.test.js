import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runDoctor } from '../../src/core/doctor.js';
import { loadConfig } from '../../src/core/config.js';
import { createAuthService } from '../../src/core/auth.js';

test('doctor reports account metadata, uses no-refresh checks, and never prints credential diagnostics', async (t) => {
  const root = path.resolve('.scratch/usability/fix3/doctor'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'doctor-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile'); fs.mkdirSync(profile);
  const authPath = path.join(profile, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: Date.now() + 3600000 }, openai: { type: 'api_key', key: 'FAKE_KEY' } }));
  const before = fs.readFileSync(authPath);
  const script = path.join(dir, 'fake-doctor-pi.mjs');
  fs.writeFileSync(script, `if (process.argv.includes('--version')) console.log('fake-pi'); else {
    if (!process.argv.includes('--no-refresh')) process.exit(3);
    console.log(JSON.stringify({status:'not_ready', secret:'FAKE_ACCESS FAKE_REFRESH FAKE_KEY'}));
  }`);
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: {
    pi: { command: [process.execPath, script] }, execution: { sandbox: { mode: 'host' } }, agents: { dwight: { provider: 'anthropic', model: 'fake-catalog' } }
  } });
  let output = '';
  const code = await runDoctor({ config, env: { ...process.env, PI_CODING_AGENT_DIR: profile }, auth: createAuthService({ authPath, env: {} }), stdout: { write: (s) => output += s } });
  assert.equal(code, 1);
  assert.match(output, /1 problem found\./);
  assert.doesNotMatch(output, /All good\.|run can start/i);
  assert.match(output, /Claude \(Pro\/Max\): signed_in \(oauth\)/);
  assert.match(output, /ChatGPT: signed_in \(api_key\)/);
  assert.match(output, /credentials for fake-catalog are not_ready/);
  assert.doesNotMatch(output, /FAKE_ACCESS|FAKE_REFRESH|FAKE_KEY/);
  assert.deepEqual(fs.readFileSync(authPath), before);
});

test('doctor directs missing Docker models to active agent defaults in Agents', async (t) => {
  const root = path.resolve('.scratch/usability/fix3/doctor'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = Object.fromEntries(['PATH', 'Path'].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = '';
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const script = path.join(dir, 'fake-pi.mjs');
  fs.writeFileSync(script, "console.log('fake-pi');\n");
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: {
    pi: { command: [process.execPath, script] }, workflow: { gates: [['hank']] }, execution: { sandbox: { mode: 'docker' } }
  } });
  let output = '';
  await runDoctor({ config, env: { PI_CODING_AGENT_DIR: path.join(dir, 'profile'), SCRANTON_PIPELINE_COMMAND: JSON.stringify([path.join(dir, 'missing-engine')]) }, auth: { async listAccounts() { return []; } }, stdout: { write: (s) => output += s } });
  assert.match(output, /Docker requires an explicit provider and model for michael, dwight, hank; set the agent default for each role in Agents/);
  assert.doesNotMatch(output, /Options → Models/);
  assert.match(output, /SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL/);
});

async function defaultDoctor(t, agents = {}) {
  const root = path.resolve('.scratch/usability/fix3/doctor'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'defaults-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile'); fs.mkdirSync(profile);
  const authPath = path.join(profile, 'auth.json');
  const oauth = { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: Date.now() + 3600000 };
  fs.writeFileSync(authPath, JSON.stringify({ openai: oauth, 'google-antigravity': oauth, 'google-vertex': { type: 'api_key', key: 'FAKE_KEY' } }));
  const before = fs.readFileSync(authPath);
  const script = path.join(dir, 'fake-pi.mjs');
  fs.writeFileSync(script, `if (process.argv.includes('--version')) console.log('fake-pi');
    else if (process.argv.includes('--no-refresh')) console.log('{"status":"ready"}');
    else process.exit(3);`);
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: {
    pi: { command: [process.execPath, script] }, execution: { sandbox: { mode: 'host' } }, agents
  } });
  let output = '';
  const code = await runDoctor({ config, platform: 'linux', env: { PI_CODING_AGENT_DIR: profile,
    SCRANTON_PIPELINE_COMMAND: JSON.stringify([path.join(dir, 'missing-engine')]) },
    auth: createAuthService({ authPath, env: {} }), stdout: { write: (s) => output += s } });
  assert.deepEqual(fs.readFileSync(authPath), before);
  assert.doesNotMatch(output, /FAKE_ACCESS|FAKE_REFRESH|FAKE_KEY/);
  return { code, output };
}

test('doctor counts warnings without blocking a run or claiming all good', async (t) => {
  const { code, output } = await defaultDoctor(t);
  assert.equal(code, 0);
  const count = output.split('\n').filter((line) => line.startsWith('[warn]')).length;
  assert.equal(count, 3);
  assert.match(output, new RegExp(`\\n${count} warnings found; the run can start\\.\\n$`));
  assert.doesNotMatch(output, /All good\./);
});

test('doctor reports the unsupported offline default lookup and real model selection routes', async (t) => {
  const { output } = await defaultDoctor(t);
  for (const id of ['michael', 'dwight', 'oscar', 'hank', 'angela']) {
    assert.match(output, new RegExp(`${id}: model \\(pi's default; provider/model undetermined offline\\)`));
  }
  assert.match(output, /pi 1\.5\.2 does not export findInitialModel through its public API/);
  assert.match(output, /All agents without an explicit model choice share one pi default model/);
  assert.match(output, /Credentials for pi default were not verified/);
  assert.match(output, /scranton agents/);
  assert.match(output, /scranton agent set-model <id> --provider P --model M \[--thinking T\]/);
  assert.match(output, /Agents view/);
  assert.match(output, /scranton\.config\.json \(agents\.<id>\.provider\/model\)/);
  assert.match(output, /SCRANTON_<AGENT>_PROVIDER and SCRANTON_<AGENT>_MODEL/);
});

test('doctor also warns about unconfigured agents when another agent has a model', async (t) => {
  const { code, output } = await defaultDoctor(t, { dwight: { provider: 'openai', model: 'chosen-model' } });
  assert.equal(code, 0);
  assert.match(output, /dwight: model openai\/chosen-model/);
  assert.match(output, /No model configured for michael, angela/);
  assert.doesNotMatch(output, /No model configured for [^\n]*dwight/);
  assert.match(output, /scranton agent set-model/);
});

test('fix2: README model setup avoids inactive gate warnings and suggestions include the inspected hive', async (t) => {
  const chosen = { provider: 'openai', model: 'chosen-model' };
  const { output } = await defaultDoctor(t, { michael: chosen, dwight: chosen, angela: chosen });
  assert.doesNotMatch(output, /No model configured for/);
  const missing = await defaultDoctor(t);
  assert.match(missing.output, /No model configured for michael, dwight, angela\./);
  assert.match(missing.output, /scranton agent set-model <id> --provider P --model M \[--thinking T\] --hive "[^"]+hive"/);
});

test('fix3 item5: missing Docker models are failures even with a ready sandbox', async (t) => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = path.resolve('.scratch/usability/fix3/doctor'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'docker-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker'); fs.writeFileSync(executable, '', { mode: 0o755 });
  const key = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH'), old = process.env[key]; process.env[key] = dir;
  t.after(() => { process.env[key] = old; });
  const original = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (exe, args, options, callback) => exe.toLowerCase() === executable.toLowerCase() ? (callback(null, 'linux', ''), {}) : original(exe, args, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const script = path.join(dir, 'fake.mjs'); fs.writeFileSync(script, "console.log('fake-pi');\n");
  const config = loadConfig({ cwd: dir, env: {}, fileConfig: { pi: { command: [process.execPath, script] }, execution: { sandbox: { mode: 'docker' } }, workflow: { gates: [['hank']] } } });
  let output = '';
  const code = await runDoctor({ config, platform: 'linux', env: { PI_CODING_AGENT_DIR: path.join(dir, 'pi'), SCRANTON_PIPELINE_COMMAND: JSON.stringify([path.join(dir, 'missing-engine')]) }, auth: { async listAccounts() { return []; } }, stdout: { write(s) { output += s; } } });
  assert.match(output, /\[ ok \] Sandbox image ready/);
  assert.equal(code, 1);
  assert.match(output, /\[FAIL\] Docker requires an explicit provider and model for michael, dwight, hank/);
  assert.doesNotMatch(output, /the run can start|All good/);
});

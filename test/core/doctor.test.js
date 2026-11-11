import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runDoctor } from '../../src/core/doctor.js';
import { loadConfig } from '../../src/core/config.js';
import { createAuthService } from '../../src/core/auth.js';

test('doctor reports account metadata, uses no-refresh checks, and never prints credential diagnostics', async (t) => {
  const root = path.resolve('.scratch/auth-backend'); fs.mkdirSync(root, { recursive: true });
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
  assert.match(output, /Claude \(Pro\/Max\): signed_in \(oauth\)/);
  assert.match(output, /ChatGPT: signed_in \(api_key\)/);
  assert.match(output, /credentials for fake-catalog are not_ready/);
  assert.doesNotMatch(output, /FAKE_ACCESS|FAKE_REFRESH|FAKE_KEY/);
  assert.deepEqual(fs.readFileSync(authPath), before);
});

test('doctor directs missing Docker models to active agent defaults in Agents', async (t) => {
  const root = path.resolve('.scratch/docker-agent-defaults'); fs.mkdirSync(root, { recursive: true });
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
  await runDoctor({ config, env: { SCRANTON_PIPELINE_COMMAND: JSON.stringify([path.join(dir, 'missing-engine')]) }, auth: { async listAccounts() { return []; } }, stdout: { write: (s) => output += s } });
  assert.match(output, /Docker requires an explicit provider and model for michael, dwight, hank; set the agent default for each role in Agents/);
  assert.doesNotMatch(output, /Options → Models/);
  assert.match(output, /SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL/);
});

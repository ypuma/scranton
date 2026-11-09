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

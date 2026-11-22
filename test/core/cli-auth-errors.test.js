import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createAuthService } from '../../src/core/auth.js';
import { runCli } from '../../src/core/cli.js';

const key = 'fake-cli-key-never-print-me';
const add = ['provider', 'add', 'custom-test', '--base-url', 'https://example.test/v1', '--api', 'openai-completions', '--models', 'model'];

function fixture(t) {
  const root = path.resolve('.scratch/cli-msg');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ version: 1, credentials: {}, providers: {}, renewals: {}, deviceId: '00000000-0000-4000-8000-000000000000', import: { at: 'fixture' } }));
  const auth = createAuthService({ env: { SCRANTON_CREDENTIALS_DIR: dir, PI_CODING_AGENT_DIR: path.join(dir, 'pi') } });
  t.after(() => auth.close());
  return { dir, auth };
}

async function invoke(args, dir, auth) {
  let stdout = '', stderr = '';
  const code = await runCli(args, {
    cwd: dir, env: {}, auth, stdin: Readable.from([`${key}\n`]),
    stdout: { isTTY: false, write: (text) => { stdout += text; } },
    stderr: { isTTY: false, write: (text) => { stderr += text; } }
  });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.ok(!(stdout + stderr).includes(key));
  return stderr;
}

test('CLI reports own credential conflicts without printing the input key', async (t) => {
  const { dir, auth } = fixture(t);
  await auth.setApiKey('google', key);
  await auth.addProvider({ id: 'custom-test', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'model' }], key });
  assert.equal(await invoke(add, dir, auth), 'Provider already exists\n');
});

test('CLI reports own credential locking without printing the input key', async (t) => {
  const { dir } = fixture(t);
  const fail = async () => { throw Object.assign(Error('Credential store is locked; verify the writer has stopped'), { status: 409 }); };
  assert.equal(await invoke(add, dir, { addProvider: fail }), 'Credential store is locked; verify the writer has stopped\n');
});

test('CLI keeps unexpected provider, key and logout errors generic like HTTP control', async (t) => {
  const { dir } = fixture(t);
  const fail = async () => { throw Error(`raw upstream ${key}`); };
  for (const args of [add, ['provider', 'remove', 'custom-test'], ['login', 'gemini'], ['logout', 'google']]) {
    const stderr = await invoke(args, dir, { addProvider: fail, removeProvider: fail, setApiKey: fail, logout: fail });
    assert.equal(stderr, 'Control operation failed\n');
  }
});

test('CLI reports classified API key and logout conflicts like HTTP control', async (t) => {
  const { dir } = fixture(t);
  const fail = async () => { throw Object.assign(Error('A credential operation is running'), { status: 409 }); };
  for (const args of [['login', 'gemini'], ['logout', 'google']]) {
    assert.equal(await invoke(args, dir, { setApiKey: fail, logout: fail }), 'A credential operation is running\n');
  }
});

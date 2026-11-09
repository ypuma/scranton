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
  const auth = createAuthService({ env: {}, authPath: path.join(dir, 'auth.json'), runtimeFactory: async () => { throw Error(`upstream diagnostic ${key}`); } });
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

test('CLI reports provider lock recovery instructions without printing the input key', async (t) => {
  const { dir, auth } = fixture(t);
  const lock = path.join(dir, 'models.json.scranton-lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '2147483647');
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, 2147483647);
    assert.equal(signal, 0);
    throw Object.assign(Error('dead fixture writer'), { code: 'ESRCH' });
  });
  assert.equal(await invoke(add, dir, auth), 'Provider configuration is locked; after verifying no Scranton writer is running, remove models.json.scranton-lock from the Pi agent directory\n');
});

test('CLI reports comments and unmanaged credential conflicts without printing the input key', async (t) => {
  const { dir, auth } = fixture(t);
  fs.writeFileSync(path.join(dir, 'models.json'), '{// keep this comment\n"providers":{}}');
  assert.equal(await invoke(add, dir, auth), 'Provider configuration contains comments; refusing to rewrite or drop comments\n');
  fs.unlinkSync(path.join(dir, 'models.json'));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'custom-test': { type: 'api_key', key } }));
  assert.equal(await invoke(add, dir, auth), 'Provider ID already has a credential not managed by Scranton\n');
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/core/config.js';
import { AGENT_MESSAGE, PiNotFoundError, buildPiArgs, findOnPath, quoteForCmd, resolvePiCommand } from '../../src/core/pi-command.js';
import { tempDir } from './helpers.js';

const config = (pi = {}) => loadConfig({ cwd: process.cwd(), env: {}, hasBash: true, fileConfig: { pi } });

function fakeLocalPi(root, bin = { pi: 'dist/cli.js' }) {
  const dir = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '9.9.9', bin }));
  fs.writeFileSync(path.join(dir, 'dist', 'cli.js'), '');
  return path.join(dir, 'dist', 'cli.js');
}

test('1. config pi.command wins over everything', (t) => {
  const root = tempDir(t);
  fakeLocalPi(root);
  const spec = resolvePiCommand({ config: config({ command: [process.execPath, 'x.js'] }), roots: [root], env: { PATH: '' } });
  assert.equal(spec.source, 'config');
  assert.deepEqual(spec.argv, [process.execPath, 'x.js']);
  assert.equal(spec.shell, false);
});

test('1. SCRANTON_PI_COMMAND (env) is reported as source "env"', () => {
  const c = loadConfig({ cwd: process.cwd(), env: { SCRANTON_PI_COMMAND: 'node a.js' }, hasBash: true, fileConfig: {} });
  const spec = resolvePiCommand({ config: c, env: {} });
  assert.equal(spec.source, 'env');
  assert.deepEqual(spec.argv, ['node', 'a.js']);
});

test('2. the local dependency runs as `node <bin.pi>`, no shim', (t) => {
  const root = tempDir(t);
  const script = fakeLocalPi(root);
  const spec = resolvePiCommand({ config: config(), roots: [root], env: { PATH: '' } });
  assert.equal(spec.source, 'local');
  assert.deepEqual(spec.argv, [process.execPath, script]);
  assert.equal(spec.shell, false);
});

test('2. bin may be a plain string, and ancestors of the root are searched', (t) => {
  const root = tempDir(t);
  const script = fakeLocalPi(root, 'dist/cli.js');
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const spec = resolvePiCommand({ config: config(), roots: [nested], env: { PATH: '' } });
  assert.deepEqual(spec.argv, [process.execPath, script]);
});

test('3. falls back to pi on PATH; a .cmd shim needs a shell on Windows only', (t) => {
  const bin = tempDir(t);
  const cmd = path.join(bin, 'pi.cmd');
  fs.writeFileSync(cmd, '@echo off\n');
  const win = resolvePiCommand({ config: config(), roots: [], env: { PATH: bin, PATHEXT: '.CMD' }, platform: 'win32' });
  assert.equal(win.source, 'path');
  assert.equal(win.shell, true);
  assert.equal(win.argv[0].toLowerCase(), cmd.toLowerCase());
  assert.equal(findOnPath('pi', { env: { PATH: bin }, platform: 'linux' }), null);
});

test('3. on Windows an extensionless sh script next to pi.cmd never wins (npm global install layout)', (t) => {
  const bin = tempDir(t);
  fs.writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\n');
  const cmd = path.join(bin, 'pi.cmd');
  fs.writeFileSync(cmd, '@echo off\n');
  const env = { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const spec = resolvePiCommand({ config: config(), roots: [], env, platform: 'win32' });
  assert.equal(spec.argv[0].toLowerCase(), cmd.toLowerCase());
  assert.equal(spec.shell, true);
  const configured = resolvePiCommand({ config: config({ command: ['pi'] }), env, platform: 'win32' });
  assert.equal(configured.argv[0].toLowerCase(), cmd.toLowerCase());
  assert.equal(configured.shell, true);
});

test('3. PATHEXT order decides between extensions; an extensionless file alone is not found on Windows', (t) => {
  const bin = tempDir(t);
  fs.writeFileSync(path.join(bin, 'pi'), '');
  assert.equal(findOnPath('pi', { env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32' }), null);
  fs.writeFileSync(path.join(bin, 'pi.cmd'), '');
  fs.writeFileSync(path.join(bin, 'pi.exe'), '');
  assert.equal(path.extname(findOnPath('pi', { env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32' })).toLowerCase(), '.exe');
  assert.equal(path.extname(findOnPath('pi', { env: { PATH: bin, PATHEXT: '.CMD;.EXE' }, platform: 'win32' })).toLowerCase(), '.cmd');
  assert.equal(path.basename(findOnPath('pi', { env: { PATH: bin }, platform: 'linux' }) ?? 'none'), 'pi');
});

test('a bare config command is resolved through PATH/PATHEXT on Windows', (t) => {
  const bin = tempDir(t);
  const cmd = path.join(bin, 'mypi.cmd');
  fs.writeFileSync(cmd, '');
  const spec = resolvePiCommand({ config: config({ command: ['mypi', '--flag'] }), env: { PATH: bin, PATHEXT: '.CMD' }, platform: 'win32' });
  assert.equal(spec.argv[0].toLowerCase(), cmd.toLowerCase());
  assert.equal(spec.argv[1], '--flag');
  assert.equal(spec.shell, true);
});

test('nothing found -> a clear PiNotFoundError', (t) => {
  const empty = tempDir(t);
  assert.throws(() => resolvePiCommand({ config: config(), roots: [], env: { PATH: empty } }), PiNotFoundError);
});

test('this project resolves its installed pi (real package)', () => {
  const spec = resolvePiCommand({ config: config(), env: { PATH: '' } });
  assert.equal(spec.source, 'local');
  assert.ok(spec.argv[1].endsWith(path.join('dist', 'bundle', 'cli.js')) || fs.existsSync(spec.argv[1]));
});

test('quoteForCmd quotes, protects trailing backslashes and rejects unsafe characters', () => {
  assert.equal(quoteForCmd('C:\\a b\\c'), '"C:\\a b\\c"');
  assert.equal(quoteForCmd('C:\\dir\\'), '"C:\\dir\\\\"');
  for (const bad of ['a"b', '50%', 'a\nb']) assert.throws(() => quoteForCmd(bad), /cmd\.exe/);
});

test('buildPiArgs: json mode, allowlist, session dir, attached inbox and one fixed message', () => {
  const c = loadConfig({ cwd: process.cwd(), env: { SCRANTON_ANGELA_MODEL: 'anthropic/sonnet', SCRANTON_ANGELA_THINKING: 'high' }, hasBash: true, fileConfig: {} });
  const args = buildPiArgs({ agent: c.agents.angela, pi: c.pi, inboxFile: '/h/angela/inbox.md', systemPromptFile: '/h/angela/system.md', sessionDir: '/h/sessions/angela' });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--mode'), 'json');
  assert.equal(at('--model'), 'anthropic/sonnet');
  assert.equal(at('--thinking'), 'high');
  assert.equal(at('--tools'), 'read,grep,find,ls,bash');
  assert.equal(at('--append-system-prompt'), '/h/angela/system.md');
  assert.equal(at('--session-dir'), '/h/sessions/angela');
  assert.ok(!args.includes('--provider'));
  for (const f of ['--no-skills', '--no-context-files', '--no-extensions', '--no-mcp', '--no-approve']) assert.ok(args.includes(f), f);
  assert.deepEqual(args.slice(-2), ['@/h/angela/inbox.md', AGENT_MESSAGE]);
  assert.ok(!args.at(-3).startsWith('@'));
});

test('buildPiArgs: provider needs a model; minimalContext false drops the isolation flags; extra args come before the inbox', () => {
  const c = loadConfig({
    cwd: process.cwd(),
    env: { SCRANTON_DWIGHT_PROVIDER: 'ollama', SCRANTON_DWIGHT_MODEL: 'qwen2.5-coder:7b' },
    hasBash: true,
    fileConfig: { pi: { minimalContext: false, extraArgs: ['--offline'] }, agents: { dwight: { extraArgs: '--verbose' } } }
  });
  const args = buildPiArgs({ agent: c.agents.dwight, pi: c.pi, inboxFile: '/i.md' });
  assert.deepEqual(args.slice(args.indexOf('--provider'), args.indexOf('--provider') + 4), ['--provider', 'ollama', '--model', 'qwen2.5-coder:7b']);
  assert.ok(!args.includes('--no-skills'));
  assert.ok(args.indexOf('--offline') < args.indexOf('--verbose'));
  assert.ok(args.indexOf('--verbose') < args.indexOf('@/i.md'));
});

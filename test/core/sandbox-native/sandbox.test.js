import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { runTool } from '../../../src/core/tools/index.js';
import { once } from 'node:events';
import { createSandbox, createOwnedDirectory, hardenCredentials, available, resolveSandboxHelper, seatbeltProfile, bubblewrapArgs, credentialLocations } from '../../../src/core/sandbox-native/index.js';

const base = path.resolve('.scratch/sandbox-native-tests');
fs.mkdirSync(base, { recursive: true });
function fixture() {
  const dir = fs.mkdtempSync(path.join(base, 'run-'));
  const worktree = createOwnedDirectory(path.join(dir, 'work tree'));
  const tempDir = createOwnedDirectory(path.join(dir, 'private temp'));
  const outside = path.join(dir, 'outside.txt');
  const credentialsDir = path.join(dir, 'credentials'); fs.mkdirSync(credentialsDir);
  const secret = path.join(credentialsDir, 'test.txt'); fs.writeFileSync(secret, 'TEST_SECRET_MARKER');
  return { dir, worktree, tempDir, outside, credentialsDir, secret };
}
async function collect(child) {
  let stdout = '', stderr = '';
  child.stdout?.on('data', (v) => { stdout += v; }); child.stderr?.on('data', (v) => { stderr += v; });
  const [code, signal] = await once(child, 'close'); return { code, signal, stdout, stderr };
}
const options = (f) => ({ cwd: f.worktree, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const win = process.platform === 'win32';
const cmd = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe');
const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const bash = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/bin/bash.exe');
const shells = [
  { name: 'cmd', file: cmd, args: (s) => ['/d', '/s', '/c', s], write: (p) => `echo sandbox-data > "${p}"`, read: (p) => `type "${p}"`, node: 'node -v', git: 'git status --porcelain' },
  { name: 'powershell', file: ps, args: (s) => ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${s}`], write: (p) => `Set-Content -LiteralPath '${p}' -Value 'sandbox-data'`, read: (p) => `Get-Content -LiteralPath '${p}'`, node: 'node -v', git: 'git status --porcelain' },
  { name: 'Git Bash', file: bash, args: (s) => ['--noprofile', '--norc', '-c', s], write: (p) => `echo sandbox-data > '${p.replaceAll('\\', '/')}'`, read: (p) => `cat '${p.replaceAll('\\', '/')}'`, node: 'node -v', git: 'git status --porcelain' },
];

test('generated Seatbelt profile escapes strings, limits writes, masks credentials and denies network', () => {
  const profile = seatbeltProfile({ worktree: '/work/"quoted', tempDir: '/private/tmp/run', network: false, credentials: ['/home/.ssh', '/data/credentials'] });
  assert.ok(profile.includes('(deny default)'));
  assert.ok(profile.includes('(allow file-read* file-write* (subpath "/work/\\"quoted") (subpath "/private/tmp/run"))')); 
  assert.ok(profile.includes('"/work/\\"quoted"'));
  assert.ok(profile.includes('(deny file-read* (subpath "/home/.ssh") (subpath "/data/credentials"))'));
  assert.ok(profile.includes('(deny network*)'));
  assert.ok(!seatbeltProfile({ worktree: '/w', tempDir: '/t', credentials: [] }).includes('(deny network*)'));
});
test('bubblewrap root is read-only; exactly worktree/temp are writable; namespaces and credentials', () => {
  const f = fixture();
  const args = bubblewrapArgs({ ...f, network: false, credentials: [f.credentialsDir] }, '/bin/sh', ['-c', 'echo hi']);
  assert.deepEqual(args.slice(0, 10), ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/', '/', '--dev']);
  assert.equal(args.filter((v) => v === '--bind').length, 2);
  assert.ok(args.includes('--unshare-net')); assert.ok(args.some((v, i) => v === '--tmpfs' && args[i + 1] === f.credentialsDir));
  assert.deepEqual(args.slice(-4), ['--', '/bin/sh', '-c', 'echo hi']);
});
test('credential defaults use desktop data location, not config', () => {
  assert.ok(credentialLocations({ platform: 'linux', home: '/home/test', env: {} })[0].replaceAll('\\', '/').endsWith('.local/share/dev.scranton.desktop/credentials'));
  assert.ok(credentialLocations({ platform: 'darwin', home: '/home/test', env: {} }).some((v) => v.replaceAll('\\', '/').endsWith('Library/Keychains')));
});
test('fail closed before prepare, unknown limits/mode, low network denial and invalid helper override', () => {
  const f = fixture();
  assert.throws(() => createSandbox({ ...f }).spawn(process.execPath), /prepared/);
  assert.throws(() => createSandbox({ ...f, mode: 'host' }), /mode/);
  assert.throws(() => createSandbox({ ...f, limits: { typo: 1 } }), /limit/);
  assert.throws(() => createSandbox({ ...f, platform: 'win32', network: false }), /cannot block network/);
  assert.throws(() => resolveSandboxHelper({ env: { SCRANTON_SANDBOX_HELPER: path.join(f.dir, 'missing') } }), /existing absolute/);
});

test('Windows native helper and adapter integration', { skip: !win && 'Windows token/Job/AppContainer tests require Windows' }, async (t) => {
  assert.ok(resolveSandboxHelper(), 'Build the real helper before running Windows tests');
  const diagnostic = await available();
  assert.equal(diagnostic.available, true);
  assert.equal(diagnostic.tools.bash.available, false);
  assert.match(diagnostic.tools.bash.reason, /Use powershell/);
  assert.equal(diagnostic.recommendedShell, 'powershell');
  for (const shell of shells) {
    await t.test(`${shell.name}: boundary/tools or explicit unavailable result`, { skip: !fs.existsSync(shell.file) && `${shell.name} is not installed` }, async (t) => {
      const f = fixture(); const sandbox = createSandbox(f);
      const backup = path.join(f.dir, 'labels.backup');
      const hardening = hardenCredentials(f.credentialsDir, { backup });
      t.after(async () => { await sandbox.dispose(); hardening.restore(); });
      sandbox.prepare();
      if (shell.name === 'Git Bash') {
        assert.throws(() => sandbox.spawn(shell.file, shell.args('echo SHOULD_NOT_RUN'), options(f)), /bash is unavailable in Windows low mode.*Use powershell/);
        const result = await runTool('bash', { command: 'echo SHOULD_NOT_RUN' }, { root: f.worktree, allow: ['bash'], spawn: sandbox.spawn });
        assert.equal(result.isError, true);
        assert.match(result.content, /bash is unavailable in Windows low mode.*Use powershell/);
        return;
      }
      const exec = (s, isolated = true) => collect((isolated ? sandbox.spawn : spawn)(shell.file, shell.args(s), { ...options(f), ...(!isolated && shell.name === 'cmd' ? { windowsVerbatimArguments: true } : {}) }));
      const inside = path.join(f.worktree, 'inside.txt');
      let result = await exec(shell.write(inside)); assert.equal(result.code, 0, JSON.stringify(result)); assert.match(fs.readFileSync(inside, 'utf8'), /sandbox-data/);
      result = await exec(shell.write(f.outside)); assert.notEqual(result.code, 0, JSON.stringify(result)); assert.equal(fs.existsSync(f.outside), false);
      result = await exec(shell.write(f.outside), false); assert.equal(result.code, 0, 'negative control must succeed outside without sandbox'); assert.match(fs.readFileSync(f.outside, 'utf8'), /sandbox-data/);
      result = await exec(shell.read(f.secret)); assert.notEqual(result.code, 0, JSON.stringify(result)); assert.ok(!result.stdout.includes('TEST_SECRET_MARKER'));
      result = await exec(shell.read(f.secret), false); assert.equal(result.code, 0); assert.match(result.stdout, /TEST_SECRET_MARKER/, 'negative control reads unisolated');
      result = await exec(shell.write(inside), false); assert.equal(result.code, 0, 'unisolated inside-write control');
      const init = spawnSync('git', ['init', f.worktree], { encoding: 'utf8' }); assert.equal(init.status, 0, init.stderr);
      // git init created Medium files after prepare: a second instance prepares the full owned tree.
      const tools = createSandbox(f); tools.prepare(); t.after(() => tools.dispose());
      result = await collect(tools.spawn(shell.file, shell.args(shell.node), options(f))); assert.equal(result.code, 0, JSON.stringify(result)); assert.match(result.stdout, /^v\d+/);
      result = await collect(tools.spawn(shell.file, shell.args(shell.git), options(f))); assert.equal(result.code, 0, JSON.stringify(result));
      // The same shell starts a descendant and remains alive until the helper is killed/times out.
      const script = path.join(f.worktree, 'tree.cjs');
      fs.writeFileSync(script, `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`);
      // Relabel newly host-created fixture scripts.
      const tree = createSandbox({ ...f, limits: { timeoutMs: 4000 } }); tree.prepare(); t.after(() => tree.dispose());
      const command = shell.name === 'powershell' ? `& '${process.execPath}' '${script}'` : `"${process.execPath}" "${script}"`;
      for (const terminate of ['kill', 'timeout', 'dispose']) {
        const child = tree.spawn(shell.file, shell.args(command), options(f));
        const done = collect(child); let text = '';
        const pid = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('No descendant PID')), 3000); child.stdout.on('data', (v) => { text += v; const match = text.match(/\b(\d+)\r?\n/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } }); child.once('error', reject); });
        assert.doesNotThrow(() => process.kill(pid, 0));
        if (terminate === 'kill') child.kill('SIGKILL');
        if (terminate === 'dispose') await tree.dispose();
        const ended = await done; if (terminate === 'timeout') assert.equal(ended.code, 124);
        let alive = true; for (let n = 0; n < 40; n++) { try { process.kill(pid, 0); } catch { alive = false; break; } await new Promise((resolve) => setTimeout(resolve, 25)); }
        assert.equal(alive, false, `descendant ${pid} survived ${terminate}`);
      }
    });
  }
});

test('strict AppContainer denies a reachable network endpoint and removes profile/ACLs', { skip: !win && 'AppContainer requires Windows' }, async (t) => {
  const f = fixture(); const server = createServer((socket) => { socket.on('error', () => {}); socket.end('reachable'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const sandbox = createSandbox({ ...f, windowsMode: 'strict', network: false }); sandbox.prepare();
  const name = sandbox.profileName; const sid = sandbox.profileSid;
  const mapping = `HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\${sid}`;
  const profileExists = () => spawnSync(ps, ['-NoProfile', '-Command', `Test-Path -LiteralPath '${mapping}'`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(profileExists(), 'True', `profile ${name} must exist before dispose`);
  t.after(() => sandbox.dispose());
  const port = server.address().port;
  const script = `$c=New-Object Net.Sockets.TcpClient; try {$c.Connect('127.0.0.1',${port}); Write-Output 'CONNECTED'; exit 0} catch {Write-Output ('BLOCKED '+$_.Exception.InnerException.SocketErrorCode); exit 17}`;
  const baseline = await collect(spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], options(f)));
  assert.equal(baseline.code, 0, JSON.stringify(baseline)); assert.match(baseline.stdout, /CONNECTED/);
  const result = await collect(sandbox.spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], options(f)));
  assert.equal(result.code, 17, JSON.stringify(result)); assert.match(result.stdout, /BLOCKED (AccessDenied|TimedOut)/);
  await sandbox.dispose(); assert.equal(sandbox.profileName, undefined);
  assert.equal(profileExists(), 'False');
  const acl = spawnSync('icacls', [f.worktree], { encoding: 'utf8' }); assert.ok(!acl.stdout.includes('S-1-15-2-'));
});

test('prepare refuses unowned directories and credential overlap; dispose forbids later launches', { skip: !win && 'Host execution validation is exercised on Windows' }, async () => {
  const f = fixture();
  assert.throws(() => createSandbox({ ...f, worktree: f.dir }).prepare());
  assert.throws(() => createSandbox({ ...f, credentialsDir: f.worktree }).prepare(), /overlap/);
  const sandbox = createSandbox(f); sandbox.prepare(); await sandbox.dispose();
  assert.throws(() => sandbox.spawn(cmd, ['/c', 'exit']), /prepared/);
});

for (const [platform, label] of [['darwin', 'Seatbelt'], ['linux', 'bubblewrap']]) {
  test(`${label} execution matrix`, { skip: process.platform !== platform && `Host is ${process.platform}; execution needs a ${platform} validation host` }, async (t) => {
    const diagnostic = await available();
    if (!diagnostic.available) { t.skip(diagnostic.reason); return; }
    const f = fixture(); const sandbox = createSandbox({ ...f, network: false }); sandbox.prepare(); t.after(() => sandbox.dispose());
    const write = (file, isolated) => collect((isolated ? sandbox.spawn : spawn)('/bin/sh', ['-c', 'printf sandbox-data > "$1"', 'sh', file], options(f)));
    assert.equal((await write(path.join(f.worktree, 'inside'), true)).code, 0);
    assert.notEqual((await write(f.outside, true)).code, 0);
    assert.equal((await write(f.outside, false)).code, 0);
    const read = (isolated) => collect((isolated ? sandbox.spawn : spawn)('/bin/cat', [f.secret], options(f)));
    const denied = await read(true); assert.ok(!denied.stdout.includes('TEST_SECRET_MARKER'));
    assert.match((await read(false)).stdout, /TEST_SECRET_MARKER/);
  });
}

test('Windows relay preserves stdin, concurrent large stdout/stderr and exact exit status', { skip: !win && 'Windows relay requires Windows' }, async (t) => {
  const f = fixture(); const sandbox = createSandbox(f); sandbox.prepare(); t.after(() => sandbox.dispose());
  const child = sandbox.spawn(process.execPath, ['-e', `process.stdin.on('data', c=>process.stdout.write(c)); process.stdin.on('end',()=>{process.stdout.write('X'.repeat(262144)); process.stderr.write('Y'.repeat(262144),()=>process.exit(23));});`], { ...options(f), stdio: ['pipe', 'pipe', 'pipe'] });
  const done = collect(child); child.stdin.end('INPUT_MARKER'); const result = await done;
  assert.equal(result.code, 23, result.stderr.slice(0, 200)); assert.equal(result.stdout, 'INPUT_MARKER' + 'X'.repeat(262144)); assert.equal(result.stderr, 'Y'.repeat(262144));
});

test('Windows process-count limit prevents descendants; native low network option also fails closed', { skip: !win && 'Windows limits require Windows' }, async (t) => {
  const f = fixture(); const sandbox = createSandbox({ ...f, limits: { processes: 1, timeoutMs: 5000 } }); sandbox.prepare(); t.after(() => sandbox.dispose());
  const result = await collect(sandbox.spawn(process.execPath, ['-e', `const denied=()=>{console.log('LIMITED');process.exit(0)}; try {require('node:child_process').spawn(process.execPath,['-v']).on('error',denied).on('spawn',()=>process.exit(42));} catch {denied();}`], options(f)));
  assert.equal(result.code, 0, JSON.stringify(result)); assert.match(result.stdout, /LIMITED/);
  const denied = spawnSync(resolveSandboxHelper(), ['exec', '--cwd', f.worktree, '--mode', 'low', '--network', 'none', '--', cmd, '/d', '/c', `echo escaped > "${f.outside}"`], { encoding: 'utf8' });
  assert.equal(denied.status, 125); assert.match(denied.stderr, /cannot block network/); assert.equal(fs.existsSync(f.outside), false);
});

test('credential hardening is explicit, reversible and refuses to overwrite the backup', { skip: !win && 'Windows mandatory label test' }, async (t) => {
  const f = fixture(); const sandbox = createSandbox(f); sandbox.prepare(); t.after(() => sandbox.dispose());
  const read = () => collect(sandbox.spawn(cmd, ['/d', '/s', '/c', `type "${f.secret}"`], options(f)));
  assert.match((await read()).stdout, /TEST_SECRET_MARKER/, 'low alone does not hide Medium files');
  const hardening = hardenCredentials(f.credentialsDir, { backup: path.join(f.dir, 'backup') });
  try {
    assert.throws(() => hardenCredentials(f.credentialsDir, { backup: hardening.backup }), /setup failed/);
    const denied = await read(); assert.notEqual(denied.code, 0); assert.ok(!denied.stdout.includes('TEST_SECRET_MARKER'));
  } finally { hardening.restore(); }
  assert.match((await read()).stdout, /TEST_SECRET_MARKER/, 'unharden restores the original label');
});


test('label-low refuses real hard links before changing any mandatory label', { skip: !win && 'Windows mandatory label test' }, () => {
  const f = fixture(); fs.writeFileSync(f.outside, 'outside');
  const linked = path.join(f.worktree, 'hard-linked.txt'); fs.linkSync(f.outside, linked);
  assert.equal(fs.statSync(linked).nlink, 2);
  const labels = (files) => {
    const result = spawnSync('icacls', files, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  const before = labels([f.outside]); const treeBefore = labels([f.worktree]);
  const result = spawnSync(resolveSandboxHelper(), ['label-low', '--path', f.worktree], { encoding: 'utf8' });
  assert.equal(labels([f.outside]), before, 'outside hard-link target must keep its original label');
  assert.equal(labels([f.worktree]), treeBefore, 'preflight must reject before labelling even the root');
  assert.equal(result.status, 125); assert.match(result.stderr, /hard link/i);
});

test('Seatbelt denies broker escapes and only permits named mach services', () => {
  const profile = seatbeltProfile({ worktree: '/w', tempDir: '/t', network: false, credentials: ['/private/etc/secret'] });
  const lines = profile.split('\n');
  for (const rule of ['(deny default)', '(allow process-exec)', '(allow process-fork)', '(allow sysctl-read)', '(deny appleevent-send)', '(allow file-read* file-write* (subpath "/w") (subpath "/t"))']) assert.ok(lines.includes(rule), rule);
  assert.ok(lines.includes('(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd.") (global-name-prefix "com.apple.ae") (global-name "com.apple.launchservicesd") (global-name "com.apple.launchd") (global-name "com.apple.xpc.launchd"))'));
  assert.ok(lines.includes('(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.SystemConfiguration.configd") (global-name "com.apple.system.mDNSResponder"))'));
  assert.ok(!profile.includes('(allow default)'));
  assert.ok(!lines.includes('(allow mach-lookup)'));
  assert.ok(!profile.includes('(allow appleevent-send'));
  assert.ok(!lines.some((line) => line.startsWith('(allow mach-lookup') && line.includes('global-name-prefix')));
  assert.ok(!profile.includes('(subpath "/")'));
  assert.ok(profile.indexOf('(deny file-read*') > profile.indexOf('(allow file-read*'));
});

test('bubblewrap hides host broker and display sockets and removes discovery environment', () => {
  const env = { XDG_RUNTIME_DIR: '/custom/runtime', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom/runtime/bus', DBUS_CUSTOM_ADDRESS: 'secret', WAYLAND_DISPLAY: '/tmp/custom-wayland', DISPLAY: ':0' };
  const args = bubblewrapArgs({ worktree: '/w', tempDir: '/t', credentials: [], env }, '/bin/sh');
  const values = (option) => args.flatMap((value, i) => value === option ? [args[i + 1]] : []);
  for (const dir of ['/tmp', '/run', '/run/user', '/custom/runtime']) assert.ok(values('--tmpfs').includes(dir), dir);
  assert.ok(args.indexOf('/run') > args.lastIndexOf('--bind'), 'brokers stay hidden after writable binds');
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'DBUS_CUSTOM_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XAUTHORITY', 'SESSION_MANAGER', 'AT_SPI_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'PULSE_SERVER', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO']) assert.ok(values('--unsetenv').includes(name), name);
  for (const flag of ['--new-session', '--unshare-ipc', '--die-with-parent', '--unshare-pid']) assert.ok(args.includes(flag), flag);
  assert.deepEqual(values('--bind'), ['/w', '/t']);
  assert.ok(!args.includes('--share-net')); assert.ok(!args.includes('--share-ipc')); assert.ok(!args.includes('--setenv'));
  assert.throws(() => bubblewrapArgs({ worktree: '/w', tempDir: '/t', env: { XDG_RUNTIME_DIR: '/' } }, '/bin/sh'), /non-root/);
});

test('label preflight refuses junctions and hardening refuses hard links without creating a backup', { skip: !win && 'Windows reparse/mandatory label test' }, () => {
  const f = fixture();
  const junction = path.join(f.worktree, 'junction'); fs.symlinkSync(f.credentialsDir, junction, 'junction');
  try {
    const denied = spawnSync(resolveSandboxHelper(), ['label-low', '--path', f.worktree], { encoding: 'utf8' });
    assert.equal(denied.status, 125); assert.match(denied.stderr, /reparse point/i);
  } finally { fs.unlinkSync(junction); }
  fs.linkSync(f.secret, path.join(f.worktree, 'secret-link'));
  const backup = path.join(f.dir, 'refused.backup');
  assert.throws(() => hardenCredentials(f.credentialsDir, { backup }), /hard link/i);
  assert.equal(fs.existsSync(backup), false);
});

// A unique DLL path gives MSYS a fresh installation key, independent of host shells.
test('Git Bash namespace collision is deterministic; adapter refuses both cold and warm launches', { skip: (!win || !fs.existsSync(bash)) && 'Requires Windows and installed Git Bash', timeout: 30000 }, async (t) => {
  const f = fixture();
  const source = path.join(path.dirname(path.dirname(bash)), 'usr/bin');
  const bin = path.join(f.dir, 'git/usr/bin'); fs.mkdirSync(bin, { recursive: true });
  for (const name of fs.readdirSync(source).filter((name) => name.endsWith('.dll') || name === 'bash.exe')) fs.copyFileSync(path.join(source, name), path.join(bin, name));
  const isolatedBash = path.join(bin, 'bash.exe');
  const sandbox = createSandbox(f); sandbox.prepare(); t.after(() => sandbox.dispose());
  const args = ['--noprofile', '--norc', '-c', 'echo LOW_OK'];
  const refused = () => assert.throws(() => sandbox.spawn(isolatedBash, args, options(f)), /bash is unavailable.*Use powershell/);
  const rawLow = () => collect(spawn(resolveSandboxHelper(), ['exec', '--cwd', f.worktree, '--mode', 'low', '--timeout-ms', '5000', '--', isolatedBash, ...args], { ...options(f), env: { ...process.env, TEMP: f.tempDir, TMP: f.tempDir, TMPDIR: f.tempDir } }));
  refused();
  let result = await rawLow(); assert.equal(result.code, 0, JSON.stringify(result)); assert.match(result.stdout, /LOW_OK/);
  const medium = spawn(isolatedBash, ['--noprofile', '--norc', '-c', 'echo MEDIUM_READY; read line'], { ...options(f), stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = once(medium, 'close');
  t.after(async () => { if (medium.exitCode === null) medium.kill(); await ended; });
  medium.stderr.resume();
  const [ready] = await once(medium.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  assert.match(String(ready), /MEDIUM_READY/);
  refused();
  result = await rawLow();
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.match(result.stderr, /NtCreateDirectoryObject\(\\BaseNamedObjects\\msys-[^)]+\): 0xC0000022/);
  medium.stdin.end('done\n'); await ended;
  refused();
  result = await rawLow(); assert.equal(result.code, 0, JSON.stringify(result)); assert.match(result.stdout, /LOW_OK/);
  assert.throws(() => sandbox.spawn(path.join(bin, 'sh.exe'), args, options(f)), /bash is unavailable.*Use powershell/);
});

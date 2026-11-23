import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = process.env.USERPROFILE;
const release = profile && path.join(profile, '.scranton-release');
const key = release && path.join(release, 'updater.key.dpapi');
const scratch = path.join(root, '.scratch', 'desktop-updater');

function powershell(script, input, output = 'ignore') {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input, stdio: ['pipe', output, 'ignore'], windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Windows DPAPI operation failed');
  return result.stdout;
}

function generate() {
  if (fs.existsSync(key)) throw new Error(`Refusing to overwrite ${key}`);
  fs.mkdirSync(release, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'keygen-'));
  const temporary = path.join(dir, 'updater.key');
  try {
    const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
    const result = spawnSync(process.execPath, [cli, 'signer', 'generate', '--ci', '--write-keys', temporary], {
      cwd: root, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
    });
    if (result.status !== 0) throw new Error('Tauri key generation failed; check that npm dependencies are installed');
    const publicKey = fs.readFileSync(`${temporary}.pub`, 'utf8').trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(publicKey)) throw new Error('Invalid Tauri public key');
    const encrypted = powershell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $stream = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($stream); [Console]::OpenStandardOutput().Write([byte[]]($bytes = [Security.Cryptography.ProtectedData]::Protect($stream.ToArray(), $null, 'CurrentUser')), 0, $bytes.Length)", fs.readFileSync(temporary), 'pipe');
    if (!encrypted?.length) throw new Error('DPAPI returned no encrypted key');
    fs.writeFileSync(key, encrypted, { flag: 'wx' });
    console.log(`DPAPI key: ${key}\nPublic key: ${publicKey}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function exportKey(file) {
  if (fs.existsSync(file)) throw new Error(`Refusing to overwrite ${file}`);
  const bytes = powershell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $stream = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($stream); $bytes = [Security.Cryptography.ProtectedData]::Unprotect($stream.ToArray(), $null, 'CurrentUser'); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)", fs.readFileSync(key), 'pipe');
  if (!bytes?.length) throw new Error('DPAPI returned no private key');
  try { fs.writeFileSync(file, bytes, { flag: 'wx' }); } finally { bytes.fill(0); }
  console.log(`Plaintext backup exported to ${path.resolve(file)}`);
}

try {
  if (process.platform !== 'win32' || !key) throw new Error('Updater key management requires Windows and USERPROFILE');
  const args = process.argv.slice(2);
  if (!args.length) generate();
  else if (args.length === 2 && args[0] === '--export' && args[1]) exportKey(args[1]);
  else throw new Error('Usage: node scripts/updater-keygen.mjs [--export <file>]');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Updater key operation failed');
  process.exitCode = 1;
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyMinisignFile } from '../../scripts/minisign-verify.mjs';
import { generateTestKeypair, latestManifest, readReleaseConfig, tauriCliPath, verifyReleaseArtifact, withoutSigningEnv } from '../../scripts/release-updater.mjs';

const scratch = fileURLToPath(new URL('../../.scratch/updater-release/', import.meta.url));
const wrap = (text) => Buffer.from(text).toString('base64');

async function fixtureDirectory(t) {
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function keypair(keyId = randomBytes(8)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPacket = Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]);
  return { privateKey, keyId, publicKey: wrap(`untrusted comment: test key\n${publicPacket.toString('base64')}\n`) };
}

async function signedFixture(t, algorithm = 'ED', comment = 'timestamp:42\tfile:fixture.exe\tversion:1.2.3\tGrüße') {
  const { keyId, privateKey, publicKey } = keypair();
  const bytes = Buffer.from([0, 42, 100, 255]);
  const file = path.join(await fixtureDirectory(t), 'fixture.exe');
  await fs.writeFile(file, bytes);
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const signature = sign(null, message, privateKey);
  const packet = Buffer.concat([Buffer.from(algorithm), keyId, signature]);
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  const text = ['untrusted comment: test signature', packet.toString('base64'), `trusted comment: ${comment}`, globalSignature.toString('base64'), ''].join('\n');
  return { file, publicKey, keyId, signature: wrap(text), text };
}

for (const algorithm of ['Ed', 'ED']) {
  test(`minisign verifies ${algorithm} and rejects a tampered file`, async t => {
    const { file, signature, publicKey } = await signedFixture(t, algorithm);
    await verifyMinisignFile(file, signature, publicKey);
    await fs.writeFile(file, 'tampered');
    await assert.rejects(verifyMinisignFile(file, signature, publicKey), /file signature verification failed/);
  });
}

test('minisign rejects a mismatched signature key ID before checking crypto', async t => {
  const { file, publicKey, text } = await signedFixture(t);
  const lines = text.split('\n');
  const packet = Buffer.from(lines[1], 'base64');
  packet[2] ^= 1;
  lines[1] = packet.toString('base64');
  await assert.rejects(verifyMinisignFile(file, wrap(lines.join('\n')), publicKey), /key ID mismatch/);
});

test('minisign rejects a wrong key even with the correct key ID', async t => {
  const { file, keyId, signature } = await signedFixture(t);
  await assert.rejects(verifyMinisignFile(file, signature, keypair(keyId).publicKey), /verification failed/);
});

test('minisign rejects a tampered trusted comment and a missing global signature', async t => {
  const { file, publicKey, text } = await signedFixture(t);
  const tampered = text.replace('version:1.2.3', 'version:9.9.9');
  await assert.rejects(verifyMinisignFile(file, wrap(tampered), publicKey), /trusted comment verification failed/);
  const incomplete = text.split('\n').slice(0, 3).join('\n');
  await assert.rejects(verifyMinisignFile(file, wrap(incomplete), publicKey), /signature format/);
});

test('release requires one signed version and filename, matching the installer and manifest exactly', async t => {
  const valid = await signedFixture(t);
  await verifyReleaseArtifact(valid.file, valid.signature, valid.publicKey, '1.2.3');
  for (const [comment, error] of [
    ['timestamp:42\tfile:fixture.exe', /release version/],
    ['timestamp:42\tfile:fixture.exe\tversion:1.2.4', /release version/],
    ['timestamp:42\tfile:fixture.exe\tversion:1.2.3+different', /release version/],
    ['timestamp:42\tfile:fixture.exe version:1.2.3', /release version/],
    ['timestamp:42\tfile:fixture.exe\tversion:1.2.3\tversion:9.9.9', /release version/],
    ['timestamp:42\tversion:1.2.3', /installer filename/],
    ['timestamp:42\tfile:other.exe\tversion:1.2.3', /installer filename/],
    ['file:fixture.exe\tfile:other.exe\tversion:1.2.3', /installer filename/],
  ]) {
    const signed = await signedFixture(t, 'ED', comment);
    await assert.rejects(verifyReleaseArtifact(signed.file, signed.signature, signed.publicKey, '1.2.3'), error);
  }
  const tampered = valid.text.replace('version:1.2.3', 'version:9.9.9');
  await assert.rejects(verifyReleaseArtifact(valid.file, wrap(tampered), valid.publicKey, '9.9.9'), /trusted comment verification failed/);
});

test('latest.json includes notes, an ISO date and the signed Windows platform only', () => {
  const signature = wrap('signature text');
  const notes = 'Release notes\n\nA second paragraph.\n';
  assert.deepEqual(latestManifest({ version: '1.2.3', notes, date: new Date('2026-11-23T00:00:00Z'), artifacts: [
    { platform: 'windows-x86_64', filename: 'Scranton_1.2.3_x64-setup.exe', signature },
  ] }), {
    version: '1.2.3', notes, pub_date: '2026-11-23T00:00:00.000Z', platforms: {
      'windows-x86_64': {
        url: 'https://github.com/ypuma/scranton/releases/download/v1.2.3/Scranton_1.2.3_x64-setup.exe', signature,
      },
    },
  });
});

test('manifest encodes asset basenames and rejects duplicate updater keys', () => {
  const artifact = { platform: 'windows-x86_64', filename: 'Scranton + 0.8.2.exe', signature: 'signature' };
  assert.equal(latestManifest({ version: '0.8.2', artifacts: [artifact] }).platforms[artifact.platform].url,
    'https://github.com/ypuma/scranton/releases/download/v0.8.2/Scranton%20%2B%200.8.2.exe');
  assert.throws(() => latestManifest({ version: '0.8.2', artifacts: [artifact, artifact] }), /Duplicate updater platform key/);
});

test('release refuses version mismatches, including a matching version outside [package]', async t => {
  const directory = await fixtureDirectory(t);
  const desktop = path.join(directory, 'src-tauri');
  await fs.mkdir(desktop);
  const config = (version) => fs.writeFile(path.join(desktop, 'tauri.conf.json'), JSON.stringify({ version, plugins: { updater: { pubkey: 'from config' } } }));
  const cargo = (version) => fs.writeFile(path.join(desktop, 'Cargo.toml'), `[package]\r\nname = "desktop"\r\nversion = "${version}" # release version\r\n[package.metadata]\r\nversion = "1.2.3"\r\n`);
  await fs.writeFile(path.join(directory, 'package.json'), '{"version":"1.2.3"}');
  await config('1.2.3');
  await cargo('1.2.3');
  assert.deepEqual(await readReleaseConfig(directory), { version: '1.2.3', publicKey: 'from config' });
  await cargo('1.2.4');
  await assert.rejects(readReleaseConfig(directory), /Release version mismatch/);
  await cargo('1.2.3');
  await config('1.2.4');
  await assert.rejects(readReleaseConfig(directory), /Release version mismatch/);
});

test('inherited signing variables are stripped regardless of Windows env casing', () => {
  assert.deepEqual(withoutSigningEnv({ tauri_signing_private_key: 'ignored', TAURI_SIGNING_PRIVATE_KEY_PATH: 'ignored', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'ignored', tauri_private_key: 'ignored', TaUrI_PrIvAtE_KeY_PaSsWoRd: 'ignored', Path: 'kept' }), { Path: 'kept' });
});

test('verifier accepts a file signed with the installed Tauri CLI', async t => {
  let cli;
  try { cli = tauriCliPath(); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return t.skip('Tauri CLI unavailable');
  }
  const directory = await fixtureDirectory(t);
  const env = { ...withoutSigningEnv(), SCRANTON_CREDENTIALS_DIR: path.join(directory, 'credentials'), PI_CODING_AGENT_DIR: path.join(directory, 'pi') };
  const options = { cwd: directory, env, stdio: 'ignore', timeout: 30000, windowsHide: true };
  if (spawnSync(process.execPath, [cli, '--version'], options).status !== 0) return t.skip('Tauri CLI unavailable');
  const { privateKey, publicKey } = await generateTestKeypair(cli, directory, env);
  assert.deepEqual(await fs.readdir(directory), [], 'throwaway key files were removed');
  const file = path.join(directory, 'tauri-signed.bin');
  await fs.writeFile(file, 'Real Tauri CLI signature fixture\n');
  const result = spawnSync(process.execPath, [cli, 'signer', 'sign', '--app-version', '1.2.3', file], {
    ...options, env: { ...env, TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
  });
  assert.equal(result.status, 0, 'Tauri signer sign failed');
  await verifyReleaseArtifact(file, await fs.readFile(`${file}.sig`, 'utf8'), publicKey, '1.2.3');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveMember, verifyToolArchive } from '../../scripts/desktop-tools.mjs';
import { stageWhisperLicense } from '../../scripts/desktop-licenses.mjs';
import lock from '../../tools-lock.json' with { type: 'json' };
import models from '../../voice-models.lock.json' with { type: 'json' };

const root = path.resolve(import.meta.dirname, '../..');
const app = path.join(root, 'src-tauri/staged/app');
const manifest = path.join(app, 'packaging-manifest.json');
const tool = lock.tools.whisper;
const pin = tool.targets['x86_64-pc-windows-msvc'];
const cache = path.join(root, '.scratch/packaging/tools-cache');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('model lock contains only the measured revision-pinned releases and default', () => {
  assert.equal(models.default, 'small-q5_1');
  assert.deepEqual(models.models.map(({ id, bytes, sha256 }) => [id, bytes, sha256]), [
    ['small-q5_1', 190085487, 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'],
    ['large-v3-turbo-q5_0', 574041195, '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'],
  ]);
  for (const { id, url, label } of models.models) {
    assert.ok(label);
    assert.equal(url, `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-${id}.bin`);
  }
  assert.deepEqual(Object.keys(tool.targets), ['x86_64-pc-windows-msvc']);
  assert.equal(tool.version, '1.9.5');
  assert.equal(pin.url, 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip');
  assert.equal(pin.sha256, '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb');
});

test('only Windows x64 stages the verified Whisper binary, CPU DLLs and MIT text', { skip: !existsSync(manifest) && 'Run app:prepare first' }, async () => {
  const staged = JSON.parse(await fs.readFile(manifest, 'utf8'));
  const licenses = JSON.parse(await fs.readFile(path.join(app, staged.licenseIndex), 'utf8'));
  const { resolveWhisper } = await import(pathToFileURL(path.join(app, 'src/core/voice/whisper.js')));
  assert.deepEqual(await fs.readFile(path.join(app, 'voice-models.lock.json')), await fs.readFile(path.join(root, 'voice-models.lock.json')));
  const receipt = staged.tools.whisper;
  if (staged.target !== 'x86_64-pc-windows-msvc') {
    assert.equal(receipt, undefined);
    assert.equal(licenses.tools.whisper, undefined);
    assert.equal(resolveWhisper().reason, 'unsupported_platform');
    return;
  }
  assert.equal(receipt.version, tool.version);
  assert.equal(receipt.sha256, pin.sha256);
  const archive = path.join(cache, `whisper-${pin.sha256.slice(0, 16)}.zip`);
  const bytes = await fs.readFile(archive);
  verifyToolArchive(bytes, pin);
  bytes[0] ^= 1;
  assert.throws(() => verifyToolArchive(bytes, pin), /SHA-256 mismatch/);
  assert.deepEqual(receipt.files.map(item => item.member), [pin.binary, ...pin.dlls]);
  for (const item of receipt.files) {
    const stagedBytes = await fs.readFile(path.join(app, item.file));
    assert.deepEqual(stagedBytes, archiveMember(archive, item.member));
    assert.equal(digest(stagedBytes), item.sha256);
  }
  assert.equal(resolveWhisper().executable, path.join(app, receipt.file));
  assert.equal(resolveWhisper({ packageRoot: root }).executable, path.join(cache, `whisper-${pin.sha256.slice(0, 16)}`, 'whisper-cli.exe'));
  assert.equal(existsSync(path.join(app, 'models')), false);
  assert.equal(existsSync(path.join(app, 'tools/bin/whisper/whisper-server.exe')), false);
  const [license] = licenses.tools.whisper.files;
  assert.equal(license.file, 'licenses/tools/whisper/LICENSE');
  assert.equal(license.source, tool.license.url);
  const text = await fs.readFile(path.join(app, license.file));
  assert.equal(digest(text), tool.license.sha256);
  assert.match(text.toString('utf8'), /^MIT License/);
});

test('whisper license staging stays offline with cache and rejects corruption', async t => {
  const scratch = path.join(root, '.scratch/voice-engine');
  await fs.mkdir(scratch, { recursive: true });
  const temp = await fs.mkdtemp(path.join(scratch, 'license-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const text = Buffer.from('Test MIT text');
  const testPin = { ...tool.license, sha256: digest(text) };
  const cached = path.join(temp, `whisper-license-${testPin.sha256.slice(0, 16)}`);
  await fs.writeFile(cached, text);
  const stage = async (file, bytes) => { assert.deepEqual(bytes, text); return { file }; };
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  assert.equal((await stageWhisperLicense(temp, testPin, stage)).file, 'tools/whisper/LICENSE');
  await fs.writeFile(cached, 'tampered');
  await assert.rejects(stageWhisperLicense(temp, testPin, stage), /SHA-256 mismatch/);
  assert.equal(network.mock.callCount(), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeHeader, readyUrl, validateAppArchiveListing, verifyDmg } from '../../scripts/desktop-package-smoke.mjs';

test('ready line requires the launched PID and an explicit HTTP IPv4 loopback port', () => {
  const ready = { ready: true, pid: 123, url: 'http://127.0.0.1:49213' };
  assert.equal(readyUrl(JSON.stringify(ready), 123), 'http://127.0.0.1:49213/');
  assert.throws(() => readyUrl('not JSON', 123));
  for (const patch of [{ ready: false }, { pid: 124 }, ...[
    'https://127.0.0.1:49213', 'http://localhost:49213', 'http://127.0.0.1', 'http://127.0.0.1:0',
    'http://127.0.0.1:80', 'http://127.0.0.1:65536', 'http://127.0.0.1:49213@elsewhere.test',
    'http://127.0.0.1:49213/path', 'http://127.0.0.1:49213?query',
  ].map(url => ({ url }))]) assert.throws(() => readyUrl(JSON.stringify({ ...ready, ...patch }), 123));
});

test('macOS updater tarball has one app root and no AppleDouble sidecars', () => {
  const listing = 'Scranton.app/\nScranton.app/Contents/MacOS/scranton-desktop\nScranton.app/Contents/Resources/app/bin/scranton.js\n';
  assert.doesNotThrow(() => validateAppArchiveListing(listing));
  assert.throws(() => validateAppArchiveListing('Scranton.app/\n'), /Missing/);
  for (const entry of ['other.app/', './Scranton.app/file', 'Scranton.app/../escape', 'Scranton.app/Contents/._Info.plist', '._Scranton.app']) {
    assert.throws(() => validateAppArchiveListing(listing + entry + '\n'), /Unexpected/);
  }
});

test('ELF architecture is decoded from a 64-bit little-endian header', () => {
  const elf = Buffer.alloc(64);
  elf.writeUInt32BE(0x7f454c46);
  elf.set([2, 1, 1], 4);
  for (const [cpu, arch] of [[62, 'x64'], [183, 'arm64'], [3, 'cpu-3']]) {
    elf.writeUInt16LE(cpu, 18);
    assert.deepEqual(nativeHeader(elf), { format: 'elf', arches: [arch] });
  }
  assert.deepEqual(nativeHeader(elf.subarray(0, 20)), { format: 'elf', arches: [] });
  elf[4] = 1;
  assert.deepEqual(nativeHeader(elf), { format: 'elf', arches: [] });
});

test('Mach-O architecture is decoded for thin and universal binaries', () => {
  const thin = Buffer.alloc(32);
  thin.writeUInt32BE(0xcffaedfe);
  thin.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(nativeHeader(thin), { format: 'mach-o', arches: ['arm64'] });
  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8);
  fat.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(nativeHeader(fat), { format: 'mach-o', arches: ['x64', 'arm64'] });
  fat.writeUInt32BE(65, 4);
  assert.equal(nativeHeader(fat), null, 'Java class version does not describe Mach-O slices');
  assert.equal(nativeHeader(Buffer.from('#!/bin/sh\n')), null);
});

test('DMG smoke mounts read-only, verifies the app, and detaches even if verification fails', async t => {
  const parent = path.resolve('.scratch/multi-platform');
  await fs.mkdir(parent, { recursive: true });
  const work = await fs.mkdtemp(path.join(parent, 'dmg-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const mount = path.join(work, 'mount');
  const artifact = path.join(work, 'Scranton.dmg');
  const app = path.join(mount, 'Scranton.app');
  await fs.mkdir(app, { recursive: true });
  const verify = ['codesign', '--verify', '--deep', '--strict', '--verbose=2', app];
  const attach = ['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', mount, artifact];
  const detach = ['hdiutil', 'detach', mount];
  const calls = [];
  const execute = (...[exe, args]) => calls.push([exe, ...args]);
  verifyDmg(artifact, mount, execute);
  assert.deepEqual(calls.splice(0), [attach, verify, detach]);
  assert.throws(() => verifyDmg(artifact, mount, (exe, args) => {
    execute(exe, args);
    if (exe === 'codesign') throw Error('bad signature');
  }), /bad signature/);
  assert.deepEqual(calls.splice(0), [attach, verify, detach]);
  await fs.rmdir(app);
  assert.throws(() => verifyDmg(artifact, mount, execute), /ENOENT/);
  assert.deepEqual(calls, [attach, detach]);
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function verifyToolArchive(bytes, pin) {
  if (!/^[a-f0-9]{64}$/.test(pin.sha256) || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('Tool archive SHA-256 mismatch');
}

export function archiveMember(archive, member, maxBuffer = 32 * 1024 * 1024) {
  const result = spawnSync('tar', ['-xOf', archive, member], { maxBuffer, windowsHide: true, timeout: 30000 });
  if (result.status !== 0 || !result.stdout?.length) throw new Error(`Cannot extract ${member}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export async function stageTools(root, app, host, stageLicense, stageWhisperLicense) {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'tools-lock.json'), 'utf8'));
  const cache = path.join(root, '.scratch/packaging/tools-cache');
  const destination = path.join(app, 'tools/bin');
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  const receipt = {};
  for (const name of ['rg', 'fd']) {
    const tool = lock.tools[name], pin = tool.targets[host.target];
    if (!pin) throw new Error(`No pinned ${name} for ${host.target}`);
    const repo = name === 'rg' ? 'BurntSushi/ripgrep' : 'sharkdp/fd';
    if (!pin.url.startsWith(`https://github.com/${repo}/releases/download/`) || !/^[\w.-]+\/[\w.-]+$/.test(pin.binary)) throw new Error('Invalid tool lock');
    const archive = path.join(cache, path.basename(new URL(pin.url).pathname));
    let bytes;
    try { bytes = await fs.readFile(archive); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(pin.url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Tool download failed: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      verifyToolArchive(bytes, pin);
      await fs.writeFile(archive, bytes);
    }
    verifyToolArchive(bytes, pin);
    // Read only named members of the hash-pinned archive, never extract its paths onto disk.
    const binary = archiveMember(archive, pin.binary);
    const licenseNames = name === 'rg' ? ['COPYING', 'LICENSE-MIT', 'UNLICENSE'] : ['LICENSE-APACHE', 'LICENSE-MIT'];
    const licenses = await Promise.all(licenseNames.map(file => stageLicense(`tools/${name}/${file}`, archiveMember(archive, `${path.posix.dirname(pin.binary)}/${file}`))));
    const file = `tools/bin/${name}${host.platform === 'win32' ? '.exe' : ''}`;
    await fs.writeFile(path.join(app, file), binary, { mode: 0o755 });
    const smoke = spawnSync(path.join(app, file), ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (smoke.status !== 0 || !smoke.stdout.includes(tool.version)) throw new Error(`Bundled ${name} version smoke failed`);
    receipt[name] = { version: tool.version, ...pin, file, binarySha256: createHash('sha256').update(binary).digest('hex'), licenses };
  }
  if (lock.tools.whisper.targets[host.target]) receipt.whisper = await stageWhisper(app, cache, lock.tools.whisper, host.target, stageLicense, stageWhisperLicense);
  return receipt;
}

async function stageWhisper(app, cache, tool, target, stageLicense, stageWhisperLicense) {
  const pin = tool.targets[target];
  if (!/^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b\d+\/whisper-bin-x64\.zip$/.test(pin.url)) throw new Error('Invalid Whisper archive URL');
  const archive = path.join(cache, `whisper-${pin.sha256.slice(0, 16)}.zip`);
  let bytes = await fs.readFile(archive).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!bytes) {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Whisper download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    verifyToolArchive(bytes, pin);
    const temp = `${archive}.${randomUUID()}.part`;
    try { await fs.writeFile(temp, bytes); await fs.rename(temp, archive); }
    finally { await fs.rm(temp, { force: true }); }
  }
  verifyToolArchive(bytes, pin);
  const dev = path.join(cache, `whisper-${pin.sha256.slice(0, 16)}`);
  const destination = 'tools/bin/whisper';
  await fs.mkdir(dev, { recursive: true });
  await fs.mkdir(path.join(app, destination), { recursive: true });
  const files = [];
  for (const member of [pin.binary, ...pin.dlls]) {
    if (!/^Release\/[\w-]+\.(?:exe|dll)$/.test(member)) throw new Error('Invalid Whisper archive member');
    const contents = archiveMember(archive, member);
    const name = path.posix.basename(member);
    const file = `${destination}/${name}`;
    await fs.writeFile(path.join(app, file), contents, { mode: 0o755 });
    await fs.writeFile(path.join(dev, name), contents, { mode: 0o755 });
    files.push({ member, file, sha256: createHash('sha256').update(contents).digest('hex') });
  }
  const file = files[0].file;
  const smoke = spawnSync(path.join(app, file), ['--version'], { env: { SystemRoot: process.env.SystemRoot, PATH: '' }, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (smoke.status !== 0 || `${smoke.stdout}\n${smoke.stderr}`.trim() !== `whisper.cpp version: ${tool.version}`) throw new Error('Bundled Whisper version smoke failed');
  const licenses = [await stageWhisperLicense(cache, tool.license, stageLicense)];
  return { version: tool.version, ...pin, file, files, licenses };
}

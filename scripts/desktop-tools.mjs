import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function verifyToolArchive(bytes, pin) {
  if (!/^[a-f0-9]{64}$/.test(pin.sha256) || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('Tool archive SHA-256 mismatch');
}

export async function stageTools(root, app, host) {
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
    // Extract only the hash-pinned executable, never archive paths or links onto disk.
    const extracted = spawnSync('tar', ['-xOf', archive, pin.binary], { encoding: null, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30000 });
    if (extracted.status !== 0 || !extracted.stdout?.length) throw new Error(`Cannot extract ${name}: ${extracted.error?.message ?? extracted.stderr}`);
    const file = `tools/bin/${name}${host.platform === 'win32' ? '.exe' : ''}`;
    await fs.writeFile(path.join(app, file), extracted.stdout, { mode: 0o755 });
    const smoke = spawnSync(path.join(app, file), ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (smoke.status !== 0 || !smoke.stdout.includes(tool.version)) throw new Error(`Bundled ${name} version smoke failed`);
    receipt[name] = { version: tool.version, ...pin, file, binarySha256: createHash('sha256').update(extracted.stdout).digest('hex') };
  }
  return receipt;
}

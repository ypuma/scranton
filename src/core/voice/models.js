import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { voiceError } from './wav.js';
import { artifactIsActive, plainDirectory, sweepArtifacts } from './artifacts.js';

const activeParts = new Set();

export function localVoiceData(platform = process.platform, env = process.env, home = homedir()) {
  const base = platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'dev.scranton.desktop');
}

export function createModelManager({ models, directory, fetchModel }) {
  directory = path.resolve(directory);
  const byId = new Map(models.map(pin => [pin.id, pin]));
  const downloads = new Map();
  const checks = new Map();
  const file = id => path.join(directory, `ggml-${id}.bin`);
  function sweep(prefix = '') {
    sweepArtifacts(directory, name => name.startsWith(prefix) && name.endsWith('.part') &&
      !artifactIsActive(/\.bin\.(\d{1,10})-[a-f0-9-]{36}\.part$/.exec(name)?.[1], name, activeParts));
  }
  sweep();
  const identity = async (pin) => {
    const s = await fs.lstat(file(pin.id), { bigint: true }).catch(() => null);
    if (!s?.isFile() || s.size !== BigInt(pin.bytes)) return null;
    return `${s.dev}:${s.ino}:${s.size}:${s.birthtimeNs}:${s.mtimeNs}:${s.ctimeNs}`;
  };

  async function installed(pin) {
    const key = await identity(pin);
    if (!key) { checks.delete(pin.id); return false; }
    const cached = checks.get(pin.id);
    if (cached?.key === key) return cached.result;
    const result = (async () => {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file(pin.id))) hash.update(chunk);
      return hash.digest('hex') === pin.sha256 && key === await identity(pin);
    })().catch(() => false);
    checks.set(pin.id, { key, result });
    return result;
  }

  function lookup(id) {
    const pin = byId.get(id);
    if (!pin) throw voiceError(404, 'unknown_model');
    return pin;
  }

  async function transfer(pin, item) {
    const target = file(pin.id);
    sweep(`${path.basename(target)}.`);
    if (await installed(pin)) return;
    const signal = AbortSignal.any([item.controller.signal, AbortSignal.timeout(30 * 60_000)]);
    signal.throwIfAborted();
    if (!plainDirectory(directory, true)) throw new Error('Invalid voice model cache');
    const staged = `${target}.${process.pid}-${randomUUID()}.part`;
    const name = path.basename(staged);
    activeParts.add(name);
    try {
      const response = await fetchModel(pin.url, { signal });
      if (!response.ok || !response.body) throw new Error('Model download failed');
      const hash = createHash('sha256');
      await pipeline(Readable.fromWeb(response.body, { signal }), async function* (source) {
        for await (const chunk of source) {
          item.received += chunk.length;
          if (item.received > pin.bytes) throw new Error('Model exceeds pinned size');
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(staged, { flags: 'wx', mode: 0o600 }), { signal });
      if (item.received !== pin.bytes || hash.digest('hex') !== pin.sha256) throw new Error('Model does not match pin');
      signal.throwIfAborted();
      await fs.rename(staged, target);
      checks.delete(pin.id);
    } finally {
      try { await fs.rm(staged, { force: true }); }
      finally { activeParts.delete(name); }
    }
  }

  return {
    lookup,
    async status() {
      return Promise.all(models.map(async pin => {
        const valid = await installed(pin);
        const item = downloads.get(pin.id);
        return { id: pin.id, label: pin.label, bytes: pin.bytes, installed: valid,
          ...(item && { download: { received: Math.min(item.received, pin.bytes), total: pin.bytes } }) };
      }));
    },
    async verifiedFile(id) {
      return await installed(lookup(id)) ? file(id) : null;
    },
    download(id) {
      const pin = lookup(id);
      if (downloads.has(id)) return;
      const item = { controller: new AbortController(), received: 0 };
      downloads.set(id, item);
      // The status reconciles to not installed on a failed/cancelled background download.
      item.done = transfer(pin, item).catch(() => {}).finally(() => downloads.delete(id));
    },
    async remove(id) {
      lookup(id);
      const item = downloads.get(id);
      item?.controller.abort();
      if (item) await item.done;
      await fs.rm(file(id), { force: true });
      checks.delete(id);
    },
    async close() {
      const items = [...downloads.values()];
      for (const item of items) item.controller.abort();
      await Promise.all(items.map(item => item.done));
    },
  };
}

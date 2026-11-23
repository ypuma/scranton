import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import toolsLock from '../../../tools-lock.json' with { type: 'json' };
import { killTree } from '../process-tree.js';
import { artifactIsActive, plainDirectory, sweepArtifacts } from './artifacts.js';

const activeRecordings = new Set();

export function sweepRecordings(temporaryRoot) {
  sweepArtifacts(temporaryRoot, name => name.startsWith('recording-') &&
    !artifactIsActive(/^recording-(\d{1,10})-[a-z0-9]{6}$/i.exec(name)?.[1], name, activeRecordings), true);
}

const root = path.resolve(import.meta.dirname, '../../..');
const tool = toolsLock.tools.whisper;
export const whisperVersion = tool.version;

export function resolveWhisper({ platform = process.platform, arch = process.arch, packageRoot = root } = {}) {
  if (platform !== 'win32' || arch !== 'x64') return { reason: 'unsupported_platform' };
  const pin = tool.targets['x86_64-pc-windows-msvc'];
  const archiveDigest = pin.sha256.slice(0, 16);
  for (const directory of ['tools/bin/whisper', `.scratch/packaging/tools-cache/whisper-${archiveDigest}`]) {
    const base = path.join(packageRoot, directory);
    if ([pin.binary, ...pin.dlls].every(member => lstatSync(path.join(base, path.basename(member)), { throwIfNoEntry: false })?.isFile())) {
      return { executable: path.join(base, path.basename(pin.binary)), version: whisperVersion };
    }
  }
  return { reason: 'engine_missing' };
}

export async function runWhisper({ executable, prefix = [], audio, model, language, signal, temporaryRoot }) {
  if (!plainDirectory(temporaryRoot, true)) throw new Error('Invalid voice temporary root');
  const directory = mkdtempSync(path.join(temporaryRoot, `recording-${process.pid}-`));
  const name = path.basename(directory);
  activeRecordings.add(name);
  try {
    const wav = path.join(directory, 'audio.wav');
    const output = path.join(directory, 'result');
    await fs.writeFile(wav, audio, { mode: 0o600, signal });
    signal.throwIfAborted();
    const threads = String(Math.min(8, availableParallelism()));
    const child = spawn(executable, [...prefix, '-ng', '-t', threads, '-m', model, '-l', language, '-f', wav, '-oj', '-of', output], {
      cwd: directory, env: { SystemRoot: process.env.SystemRoot, PATH: '' },
      stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
    });
    const kill = () => { void killTree(child); };
    // The normal app quit path awaits close(); the exit hook covers explicit Node exits.
    const onExit = () => { try { child.kill('SIGKILL'); } catch {} };
    process.once('exit', onExit);
    signal.addEventListener('abort', kill, { once: true });
    try {
      await new Promise((resolve, reject) => {
        let failure;
        child.once('error', error => { failure = error; });
        child.once('close', code => code === 0 && !failure ? resolve() : reject(new Error('Whisper process failed')));
      });
    } finally {
      process.off('exit', onExit);
      signal.removeEventListener('abort', kill);
    }
    signal.throwIfAborted();
    const result = JSON.parse(await fs.readFile(`${output}.json`, { encoding: 'utf8', signal }));
    if (!Array.isArray(result.transcription) || result.transcription.some(chunk => typeof chunk.text !== 'string') ||
        !/^[a-z]{2,3}$/.test(result.result?.language ?? '')) throw new Error('Invalid Whisper result');
    return { text: result.transcription.map(chunk => chunk.text).join('').trim(), language: result.result.language };
  } finally {
    try {
      if (plainDirectory(temporaryRoot)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } finally { activeRecordings.delete(name); }
  }
}

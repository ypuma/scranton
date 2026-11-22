import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree, helperEnv } from './process-tree.js';
import { credentialsDirectory } from './credentials/store.js';

const helper = fileURLToPath(new URL('../../tools/dreaming-complete.js', import.meta.url));
const invalid = () => new Error('Invalid dreaming completion request');
const failed = () => new Error('Dreaming completion failed');

export function validateDreamingRequest({ model, system, user, maxOutputTokens = 2048, timeoutMs = 60000 }) {
  if (typeof model === 'string') {
    const slash = model.indexOf('/');
    model = { provider: model.slice(0, slash), model: model.slice(slash + 1) };
    if (slash < 1) throw invalid();
  }
  if (!model || typeof model !== 'object' || Array.isArray(model) || Object.keys(model).some((k) => !['provider', 'model'].includes(k)) ||
      ['provider', 'model'].some((k) => typeof model[k] !== 'string' || !model[k] || model[k].length > 256 || /[\s\x00-\x1f\x7f]/.test(model[k])) ||
      typeof system !== 'string' || typeof user !== 'string' || !user.trim() || system.length + user.length > 12000 ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 4096 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw invalid();
  return { model: { ...model }, system, user, maxOutputTokens, timeoutMs };
}

export function validateDreamingResult(result, maxOutputTokens) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some((k) => !['text', 'usage'].includes(k)) ||
      typeof result.text !== 'string' || !result.text.trim() || result.text.length > 4096) throw failed();
  const usage = result.usage;
  if (usage !== null && (!usage || typeof usage !== 'object' || Array.isArray(usage) ||
      Object.keys(usage).some((k) => !['inputTokens', 'outputTokens', 'costUsd'].includes(k)) ||
      !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 ||
      !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || usage.outputTokens > maxOutputTokens ||
      (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)))) throw failed();
  return { text: result.text, usage };
}

export async function completeDreaming({ dataDir, signal, ...options }) {
  const request = validateDreamingRequest(options);
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || (signal !== undefined && !(signal instanceof AbortSignal))) throw invalid();
  const cancelled = () => new Error('Dreaming completion cancelled');
  if (signal?.aborted) throw cancelled();
  let dir;
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    dir = await fs.mkdtemp(path.join(dataDir, 'dreaming-completion-'));
    await fs.chmod(dir, 0o700);
    if (signal?.aborted) throw cancelled();
    const env = helperEnv(process.env);
    env.SCRANTON_CREDENTIALS_DIR = credentialsDirectory({ env });
    // Node preload hooks would run before our trusted helper could disable discovery.
    for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|SCRANTON_PIPELINE_KEY_.*)$/i.test(key)) delete env[key];
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = childProcess.spawn(process.execPath, [helper], { cwd: dir, env, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { reject(failed()); return; }
      let error, result, pending = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0, kill;
      const stop = (reason) => {
        error ??= reason;
        kill ??= killTree(child).catch(() => {});
      };
      const abort = () => stop(cancelled());
      const timer = setTimeout(() => stop(new Error('Dreaming completion timed out')), request.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      const frame = (bytes) => {
        try {
          if (result || !bytes.length) throw failed();
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          result = validateDreamingResult(JSON.parse(text), request.maxOutputTokens);
        } catch { stop(failed()); }
      };
      child.stdout.on('data', (chunk) => {
        if (error) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > 65536) return stop(failed());
        pending = Buffer.concat([pending, chunk]);
        let end;
        while ((end = pending.indexOf(10)) !== -1) {
          if (end > 32768) return stop(failed());
          frame(pending.subarray(0, end));
          pending = pending.subarray(end + 1);
          if (error) return;
        }
        if (pending.length > 32768) stop(failed());
      });
      child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 8192) stop(failed()); });
      child.stdin.on('error', () => stop(failed()));
      child.once('error', () => stop(failed()));
      child.once('close', async (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (kill) await kill;
        if (!error && (code !== 0 || pending.length || !result)) error = failed();
        error ? reject(error) : resolve(result);
      });
      if (signal?.aborted) abort();
      child.stdin.end(JSON.stringify(request));
    });
  } catch (error) {
    if (['Dreaming completion cancelled', 'Dreaming completion timed out'].includes(error?.message)) throw error;
    throw failed();
  } finally {
    if (dir) {
      try { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
      catch { throw failed(); }
    }
  }
}

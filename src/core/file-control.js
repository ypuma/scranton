import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { withFsRetry } from './util.js';

export function validDecision(value, options) {
  return value && options.includes(value.decision) &&
    (value.feedback === undefined || (typeof value.feedback === 'string' && value.feedback.length <= 8000)) &&
    (value.decision !== 'feedback' || Boolean(value.feedback?.trim()));
}

const validStamp = (ts) => typeof ts === 'string' && /^\d{4}-\d\d-\d\dT/.test(ts) && Number.isFinite(Date.parse(ts));

export function rejectResponse(hiveDir, log) {
  const file = path.join(hiveDir, 'human', 'response.json');
  if (!fs.existsSync(file)) return;
  const archive = path.join(hiveDir, 'human', 'archive');
  fs.mkdirSync(archive, { recursive: true });
  withFsRetry(() => fs.renameSync(file, path.join(archive, `rejected-${Date.now()}-${randomUUID()}.json`)));
  log('warn', 'Rejected stale, invalid or mismatched human response');
}

export async function waitForResponse(hiveDir, request, { signal, log }) {
  const file = path.join(hiveDir, 'human', 'response.json');
  while (!signal.aborted) {
    try {
      if (fs.existsSync(file)) {
        let value;
        try {
          value = JSON.parse(withFsRetry(() => fs.readFileSync(file, 'utf8')));
        } catch (err) {
          if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(err.code) ||
              (err instanceof SyntaxError && Date.now() - fs.statSync(file).mtimeMs < 1000)) {
            await sleep(250, undefined, { signal });
            continue;
          }
          if (!(err instanceof SyntaxError)) throw err;
        }
        if (value?.v === 1 && value.runId === request.runId && value.requestSeq === request.seq &&
            validStamp(value.ts) && validDecision(value, request.options)) {
          const archive = path.join(hiveDir, 'human', 'archive');
          fs.mkdirSync(archive, { recursive: true });
          withFsRetry(() => fs.renameSync(file, path.join(archive, `response-${request.runId}-${request.seq}.json`)));
          return value;
        }
        rejectResponse(hiveDir, log);
      }
      await sleep(250, undefined, { signal });
    } catch (err) {
      if (signal.aborted) break;
      throw err;
    }
  }
  return { decision: 'abort', interrupted: true };
}

export function pollStop(hiveDir, runId, abort, log) {
  const file = path.join(hiveDir, 'control', 'stop.json');
  return setInterval(() => {
    try {
      if (!fs.existsSync(file)) return;
      let value;
      try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* discard below */ }
      withFsRetry(() => fs.rmSync(file, { force: true }));
      if (value?.v === 1 && value.runId === runId && validStamp(value.ts)) abort('Interrupted by stop request');
      else log('warn', 'Discarded invalid or mismatched stop request');
    } catch (err) {
      log('warn', `Cannot read stop request: ${err.message}`);
    }
  }, 250);
}

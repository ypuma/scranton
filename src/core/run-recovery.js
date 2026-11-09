import fs from 'node:fs';
import path from 'node:path';
import { readRunLease, readRunHeartbeat, runOwnerStatus, releaseRunLease } from './run-lease.js';
import { EventRecorder } from './events.js';
import { cleanupRunContainers } from './sandbox.js';
import { rejectResponse } from './file-control.js';
import { withFsRetry } from './util.js';

const recovering = new Map();
const conflict = (message) => Object.assign(Error(message), { status: 409 });

export function orphanSnapshot(hive, recoveryError = null) {
  const lease = readRunLease(hive);
  if (!lease) return null;
  const beat = readRunHeartbeat(hive);
  let stopRequestedAt = null;
  try {
    const stop = JSON.parse(fs.readFileSync(path.join(hive, 'control', 'stop.json'), 'utf8'));
    if (stop.runId === lease.runId && typeof stop.ts === 'string') stopRequestedAt = stop.ts;
  } catch { /* no readable matching request */ }
  return { runId: lease.runId ?? null, startedAt: lease.startedAt ?? null, owner: runOwnerStatus(hive, lease), heartbeatAt: beat?.runId === lease.runId && typeof beat?.at === 'string' ? beat.at : null, stopRequestedAt, recoveryError: beat?.runId === lease.runId && beat?.cleanup === 'unresolved' ? `Cleanup of this run could not be verified: ${beat.reason}` : recoveryError };
}

export function recoverOrphan(hive, runId, summary, dockerDependencies, { automatic = false } = {}) {
  hive = path.resolve(hive);
  if (recovering.has(hive)) return Promise.reject(conflict('Recovery is already in progress. Try again in a moment.'));
  const task = recover(hive, runId, summary, dockerDependencies, automatic);
  recovering.set(hive, task);
  return task.finally(() => recovering.delete(hive));
}

async function recover(hive, runId, summary, dockerDependencies, automatic) {
  const lease = readRunLease(hive);
  if (!lease?.token || lease.runId !== runId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) throw conflict('No matching orphan exists');
  if (runOwnerStatus(hive, lease) === 'alive') throw conflict('The run is still running. Request a stop instead.');
  const lock = path.join(hive, 'control', 'recovery.lock');
  try {
    const text = fs.readFileSync(lock, 'utf8');
    let stale = !text.trim() || Date.now() - fs.statSync(lock).mtimeMs > 300000;
    if (!stale) {
      const holder = JSON.parse(text);
      if (Number.isSafeInteger(holder.pid) && holder.pid > 0) {
        try { process.kill(holder.pid, 0); }
        catch (err) { if (err.code === 'ESRCH') stale = true; }
      }
    }
    if (stale) fs.unlinkSync(lock);
  } catch (err) { if (err.code !== 'ENOENT') throw conflict('Recovery lock cannot be verified'); }
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (err) { if (err.code === 'EEXIST') throw conflict('Recovery is already in progress. Try again in a moment.'); throw err; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    const recorder = new EventRecorder({ hiveDir: hive, runId }).resume();
    const state = recorder.state;
    const docker = state.execution?.sandbox?.mode === 'docker' || Object.values(state.instances ?? {}).some((i) => i.sandbox === 'docker');
    const workspaces = Object.values(state.instances ?? {}).filter((i) => i.sandbox === 'docker').map((i) => i.worktree).filter((p) => typeof p === 'string');
    const warnings = [];
    if (docker) {
      try { warnings.push(...await cleanupRunContainers(runId, workspaces, dockerDependencies)); }
      catch (err) { if (automatic) throw err; warnings.push(err.message); }
    }
    if (automatic && warnings.length) throw Error(warnings.join('\n'));
    if (readRunLease(hive)?.token !== lease.token || runOwnerStatus(hive, lease) === 'alive') throw conflict('Run ownership changed during recovery');
    rejectResponse(hive, () => {});
    if (!recorder.seq) recorder.emit('run_started', { request: lease.request ?? '', workspace: lease.workspace ?? null, maxFailedCycles: 3, roles: [] });
    if (!['finished', 'aborted', 'failed'].includes(recorder.state.status)) {
      recorder.emit('run_finished', { status: 'aborted', summary: [summary, ...warnings].join('\n') });
    }
    recorder.persist();
    withFsRetry(() => fs.rmSync(path.join(hive, 'control', 'stop.json'), { force: true }));
    releaseRunLease(hive, lease.token);
    return warnings;
  } finally {
    fs.closeSync(fd);
    withFsRetry(() => fs.rmSync(lock, { force: true }));
  }
}

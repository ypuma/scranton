import fs from 'node:fs';
import { DEFAULT_MAX_FAILED_CYCLES, DEFAULT_MAX_STALLED_CYCLES, DEFAULT_MILESTONE_TOKEN_BUDGET } from './config.js';
import path from 'node:path';
import { readRunLease, readRunHeartbeat, runOwnerStatus, releaseRunLease, cliRecoveryStatus } from './run-lease.js';
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

export function recoverOrphan(hive, runId, summary, dockerDependencies, { automatic = false, local = false } = {}) {
  hive = path.resolve(hive);
  if (recovering.has(hive)) return Promise.reject(conflict('Recovery is already in progress. Try again in a moment.'));
  const task = recover(hive, runId, summary, dockerDependencies, automatic, local);
  recovering.set(hive, task);
  return task.finally(() => recovering.delete(hive));
}

async function recover(hive, runId, summary, dockerDependencies, automatic, local) {
  const lease = readRunLease(hive);
  if (!lease?.token || lease.runId !== runId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) throw conflict('No matching orphan exists');
  const owner = runOwnerStatus(hive, lease);
  if (owner === 'alive') throw conflict('The run is still running. Request a stop instead.');
  if (automatic && owner !== 'gone') throw conflict('Automatic recovery requires a gone owner');
  if (automatic && local && !cliRecoveryStatus(hive, lease).automatic) throw conflict('Automatic CLI recovery requires a stale heartbeat from this host or a legacy lease');
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
    if (lease.mode === 'undo') {
      const currentOwner = runOwnerStatus(hive, lease);
      if (readRunLease(hive)?.token !== lease.token || currentOwner === 'alive' || automatic && (currentOwner !== 'gone' || local && !cliRecoveryStatus(hive, lease).automatic)) throw conflict('Run ownership changed during recovery');
      releaseRunLease(hive, lease.token);
      return [];
    }
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
    const currentOwner = runOwnerStatus(hive, lease);
    if (readRunLease(hive)?.token !== lease.token || currentOwner === 'alive' || automatic && (currentOwner !== 'gone' || local && !cliRecoveryStatus(hive, readRunLease(hive)).automatic)) throw conflict('Run ownership changed during recovery');
    rejectResponse(hive, () => {});
    if (!recorder.seq) recorder.emit('run_started', { request: lease.request ?? '', workspace: lease.workspace ?? null, maxFailedCycles: DEFAULT_MAX_FAILED_CYCLES, maxStalledCycles: DEFAULT_MAX_STALLED_CYCLES, milestoneTokenBudget: DEFAULT_MILESTONE_TOKEN_BUDGET, roles: [] });
    if (!['finished', 'aborted', 'failed'].includes(recorder.state.status)) {
      const outcome = [summary, ...warnings].join('\n');
      if (state.execution?.conversation === true && !state.reply) {
        for (const role of state.roles ?? []) recorder.emit('agent_status', { agent: role.id, status: 'idle', activity: 'Idle' });
        const text = `Run finished with status "aborted": ${outcome}\nRequest: ${state.request ?? ''}`;
        recorder.emit('run_reply', { from: 'system', kind: 'summary', text: text.slice(0, 16000), ...(text.length > 16000 ? { truncated: true } : {}) });
      }
      recorder.emit('run_finished', { status: 'aborted', summary: outcome });
    }
    recorder.persist();
    withFsRetry(() => fs.rmSync(path.join(hive, 'control', 'stop.json'), { force: true }));
    withFsRetry(() => fs.rmSync(path.join(hive, 'human', 'request.json'), { force: true }));
    releaseRunLease(hive, lease.token);
    return warnings;
  } finally {
    fs.closeSync(fd);
    withFsRetry(() => fs.rmSync(lock, { force: true }));
  }
}

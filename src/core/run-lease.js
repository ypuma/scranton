import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeFileAtomicSync, withFsRetry } from './util.js';

export const RUN_STALE_MS = 30000;

const leaseFile = (hiveDir) => path.join(hiveDir, 'control', 'owner.json');

export function readRunLease(hiveDir) {
  try {
    const lease = JSON.parse(withFsRetry(() => fs.readFileSync(leaseFile(hiveDir), 'utf8')));
    if (!lease || lease.v !== 1 || typeof lease.runId !== 'string' || !lease.runId || typeof lease.token !== 'string' || !lease.token) throw Error('Invalid ownership record');
    return lease;
  }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    return { recoveryRequired: true, error: 'Run ownership cannot be verified' };
  }
}

export function acquireRunLease(hiveDir, info) {
  const file = leaseFile(hiveDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lease = { v: 1, ...info, host: os.hostname(), token: randomUUID() };
  // Exclusive creation also blocks concurrent servers and an incomplete crash-time record.
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(lease)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return lease;
}

export function readRunHeartbeat(hiveDir) {
  try { return JSON.parse(withFsRetry(() => fs.readFileSync(path.join(hiveDir, 'control', 'heartbeat.json'), 'utf8'))); }
  catch { return null; }
}

export function runOwnerStatus(hiveDir, lease = readRunLease(hiveDir)) {
  const beat = readRunHeartbeat(hiveDir);
  if (!lease?.runId || beat?.v !== 1 || beat.runId !== lease.runId || !Number.isSafeInteger(beat.pid) || beat.pid <= 0) return 'unknown';
  if (beat.cleanup === 'unresolved') return 'unknown';
  try { process.kill(beat.pid, 0); }
  catch (err) { if (err.code === 'ESRCH') return 'gone'; if (err.code !== 'EPERM') return 'unknown'; }
  const age = Date.now() - Date.parse(beat.at);
  return age >= 0 && age <= RUN_STALE_MS ? 'alive' : 'unknown';
}

export function cliRecoveryStatus(hiveDir, lease = readRunLease(hiveDir)) {
  const beat = readRunHeartbeat(hiveDir), owner = runOwnerStatus(hiveDir, lease);
  const age = beat?.runId === lease?.runId ? Date.now() - Date.parse(beat?.at) : NaN;
  return { owner, host: lease?.host ?? null, seconds: Number.isFinite(age) ? Math.max(0, Math.floor(age / 1000)) : null,
    automatic: owner === 'gone' && (lease?.host === undefined || lease.host === os.hostname()) && age > RUN_STALE_MS };
}

export function startRunHeartbeat(hiveDir, token) {
  const write = () => {
    const lease = readRunLease(hiveDir);
    if (lease?.token !== token) throw Error('Run ownership cannot be verified');
    writeFileAtomicSync(path.join(hiveDir, 'control', 'heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: process.pid, at: new Date().toISOString() }) + '\n');
  };
  write();
  const timer = setInterval(() => { try { write(); } catch { /* Never publish liveness without verified ownership. */ } }, 5000);
  timer.unref();
  return (reason) => {
    clearInterval(timer);
    const lease = readRunLease(hiveDir);
    if (reason && lease?.token === token) {
      writeFileAtomicSync(path.join(hiveDir, 'control', 'heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: process.pid, at: new Date().toISOString(), cleanup: 'unresolved', reason }) + '\n');
    }
  };
}

export function releaseRunLease(hiveDir, token) {
  const lease = readRunLease(hiveDir);
  if (lease?.token === token) {
    withFsRetry(() => fs.rmSync(path.join(hiveDir, 'control', 'heartbeat.json'), { force: true }));
    withFsRetry(() => fs.rmSync(leaseFile(hiveDir)));
  }
}

function startupMessage(env, type, send = process.send?.bind(process)) {
  if (env.SCRANTON_PARENT_GUARD !== '1' || !env.SCRANTON_RUN_LEASE || !send) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try { send({ type, token: env.SCRANTON_RUN_LEASE }, (err) => err ? reject(err) : resolve()); }
    catch (err) { reject(err); }
  });
}

export function registerParentStartup({ env = process.env, send = process.send?.bind(process) } = {}) {
  let begun = false;
  return {
    async begin() {
      begun = true;
      await startupMessage(env, 'scranton-startup-begun', send);
    },
    async refuse() {
      if (!begun) await startupMessage(env, 'scranton-startup-refused', send);
    }
  };
}

/** CLI calls release only after the orchestrator has stopped every owned child. */
export function guardParent({ hiveDir, abort, stdin = process.stdin, env = process.env }) {
  if (env.SCRANTON_PARENT_GUARD !== '1') return () => {};
  if (!env.SCRANTON_RUN_LEASE || readRunLease(hiveDir)?.token !== env.SCRANTON_RUN_LEASE) {
    throw new Error('Run ownership cannot be verified');
  }
  startupMessage(env, 'scranton-guard-registered').catch(() => ended());
  let disconnected = false;
  const ended = () => {
    if (!disconnected) { disconnected = true; abort('App server disconnected'); }
  };
  let lastHeartbeat = Date.now();
  const heartbeat = () => { lastHeartbeat = Date.now(); };
  let lastCheck = lastHeartbeat;
  const timer = setInterval(() => {
    const now = Date.now();
    // A stalled child cannot service buffered pipe data; only count responsive watchdog time.
    if (now - lastCheck > 1500) lastHeartbeat += now - lastCheck;
    lastCheck = now;
    if (now - lastHeartbeat > 5000) ended();
  }, 500);
  timer.unref();
  stdin.on('data', heartbeat);
  stdin.once('end', ended);
  stdin.once('error', ended);
  stdin.once('close', ended);
  stdin.resume();
  if (stdin.readableEnded || stdin.destroyed) ended();
  return ({ clean = false } = {}) => {
    clearInterval(timer);
    stdin.off('data', heartbeat);
    stdin.off('end', ended);
    stdin.off('error', ended);
    stdin.off('close', ended);
    stdin.pause();
    if (clean) releaseRunLease(hiveDir, env.SCRANTON_RUN_LEASE);
  };
}

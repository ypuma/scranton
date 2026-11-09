// Runs the real orchestrator (RPC, worktrees, trusted host) against a scripted pi in project-local scratch,
// so the UI tests check combinations the producer really emits instead of hand-written fixtures.
import '../../core/isolation-test-root.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../src/core/config.js';
import { Orchestrator } from '../../../src/core/orchestrator.js';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SCRIPTED_PI = fileURLToPath(new URL('./scripted-pi.js', import.meta.url));
export const FAKE_PI = path.join(ROOT, 'tools', 'fake-pi.js');
const SCRATCH = path.join(ROOT, '.scratch', 'fix-ui');

export function scratchDir(t) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'run-'));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

// transport 'json' is the legacy serial mode: shared workspace, no instances.
export function createRun(dir, { command = [process.execPath, SCRIPTED_PI], env = {}, hitl, onBreaker = 'ask', maxParallel = 2, maxFailedCycles = 3, transport = 'rpc', simulated = false } = {}) {
  const config = loadConfig({
    cwd: dir, env: {}, hasBash: true,
    fileConfig: {
      workspace: path.join(dir, 'workspace'), hiveDir: path.join(dir, 'hive'), maxFailedCycles,
      execution: { maxParallel: 1, isolation: 'shared', sandbox: { mode: 'host' } },
      pi: { command, transport },
    },
  });
  if (transport === 'rpc') config.execution = { ...config.execution, maxParallel, isolation: 'worktree', sandbox: { mode: 'host' } };
  if (simulated) config.execution.simulated = true;
  const orchestrator = new Orchestrator({
    config, onBreaker, hitl, stdin: { isTTY: false }, stdout: { isTTY: false, write() {} }, extraEnv: env,
  });
  return { config, orchestrator, hive: config.hiveDir };
}

export function readEvents(hive) {
  try {
    return fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function readState(hive) {
  return JSON.parse(fs.readFileSync(path.join(hive, 'state.json'), 'utf8'));
}

// What a UI would load at this moment: every event so far and the state.json written with them. The
// orchestrator runs in this process and writes both synchronously per event, so they always agree here.
export function capture(hive) {
  const events = readEvents(hive);
  const state = readState(hive);
  if (state.lastSeq !== events.at(-1)?.seq) throw new Error(`state.json at ${state.lastSeq}, events at ${events.at(-1)?.seq}`);
  return { events, state };
}

export async function until(predicate, ms = 15000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('scripted run did not reach the expected point');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A human message as POST /api/chat spools it.
export function spoolChat(hive, runId, to, text) {
  const id = randomUUID();
  const dir = path.join(hive, 'control', 'chat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ v: 1, id, runId, from: 'human', to, text }));
  return id;
}

// Runs the real orchestrator and own durable agent against scripted LLM turns in project-local scratch,
// so the UI tests check combinations the producer really emits instead of hand-written fixtures.
import '../../core/isolation-test-root.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../src/core/config.js';
import { Orchestrator } from '../../../src/core/orchestrator.js';
import { startAgent } from '../../../src/core/agent/index.js';
import { createScriptedProvider, getModel } from '../../../src/core/llm/index.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = path.join(ROOT, '.scratch', 'fix-ui');

export function scratchDir(t) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'run-'));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

// maxStalledCycles: only set when given, so a runtime from before the progress check still loads the config
export function createRun(dir, { env = {}, hitl, onBreaker = 'ask', maxParallel = 2, maxFailedCycles = 3, maxStalledCycles, simulated = false } = {}) {
  const config = loadConfig({
    cwd: dir, env: {}, hasBash: true,
    fileConfig: {
      workspace: path.join(dir, 'workspace'), hiveDir: path.join(dir, 'hive'), maxFailedCycles, ...(maxStalledCycles ? { maxStalledCycles } : {}),
      execution: { maxParallel: 1, isolation: 'shared', sandbox: { mode: 'host' } },
    },
  });
  config.execution = { ...config.execution, maxParallel, isolation: 'worktree', sandbox: { mode: 'host' } };
  if (simulated) config.execution.simulated = true;
  const orchestrator = new Orchestrator({
    config, onBreaker, hitl, stdin: { isTTY: false }, stdout: { isTTY: false, write() {} }, extraEnv: {...env, SCRANTON_FAKE_MODE: '0'},
    startRunner: options => {
      if (env.SCRANTON_FAKE_FAIL && options.agentId === env.SCRANTON_FAKE_FAIL_ROLE) return startAgent({...options, scripted: {scenario: 'happy', fail: env.SCRANTON_FAKE_FAIL}});
      const {agentId, instanceId, milestone, cycle} = options;
      const call = (name, args) => ({text: 'Using ' + name, toolCalls: [{id: name, name, arguments: args}]});
      let turns;
      if (agentId === 'michael' && /\/michael\/progress\//.test(options.invocationKey ?? '')) {
        // the progress check after a failed cycle (.enma/adaptive-cycles-contract.md)
        turns = [{text: env.SCRIPTED_STALLED ? '[STALLED]\nThe same failure came back.' : '[PROGRESS]\nThe failure is narrower than before.'}];
      } else if (agentId === 'michael') {
        const milestones = [
          {id: 'm1', title: 'Todo storage module', description: 'Implement storage.', dependsOn: []},
          {id: 'm2', title: 'Command line interface', description: 'Implement CLI.', dependsOn: []},
          {id: 'm3', title: 'Tests and README', description: 'Document and test.', dependsOn: ['m1', 'm2']}
        ];
        turns = [call('ls', {path: '.'}), {text: '\x60\x60\x60json\n' + JSON.stringify({milestones}) + '\n\x60\x60\x60\n[PLAN_READY]'}];
      } else if (agentId === 'dwight') {
        turns = [call('ls', {path: '.'})];
        if (env.SCRIPTED_CRASH === instanceId) turns.push({error: {message: 'Scripted agent crash'}});
        else if (env.SCRIPTED_MODE === 'hang') turns.push({text: 'Never reached', delayMs: 2147483647});
        else if (env.SCRIPTED_MODE === 'hang-tool') turns.push(call('bash', {command: 'node --test --watch'}));
        else turns.push(call('write', {path: milestone + '.txt', content: milestone}), {text: '[TASK_COMPLETE]'});
      } else turns = [{text: env.SCRIPTED_FLAKY === milestone && cycle === 1 ? '[TEST_FAILED]' : '[TEST_PASSED]'}];
      return startAgent({...options, llm: createScriptedProvider(turns), model: getModel('openai', 'gpt-4o'), spawn() {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { queueMicrotask(() => {child.stdout.end(); child.stderr.end(); child.emit('close', 1);}); return true; };
        return child;
      }});
    },
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

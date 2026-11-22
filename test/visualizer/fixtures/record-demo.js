// Records the offline demo: node test/visualizer/fixtures/record-demo.js
// A real orchestrator run (RPC, worktrees, two parallel pipelines, agent and human chat, a QA failure whose
// progress check stalls and trips the breaker, and a human answer) against the scripted pi in project scratch; no
// model is called. The checked-in recording's progress checks were written by hand to the contract
// (.enma/adaptive-cycles-contract.md) while the runtime lane built them: a new recording replaces them.
// Machine paths, ids and wall-clock times are then replaced by fixed ones, so the file is the same on every
// machine and replays at a readable pace. Rebuild the terminal fixtures afterwards (build-fixtures.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir, createRun, readEvents, until, spoolChat } from './real-orchestrator.js';

const OUT = fileURLToPath(new URL('../../../visualizer/public/demo/sample-events.jsonl', import.meta.url));
const REQUEST = 'Build a tiny todo CLI with add, list and done, stored in todos.json, with tests and a README';
const RUN_ID = 'run-20261108-091500-demo';
const START = Date.parse('2026-11-08T09:15:00.000Z');
const DEMO = 'C:\\demo';

// Seconds before each event type in the replay; the order of the recording is kept exactly.
const GAP = {
  run_started: 0, plan_ready: 0.6, milestone_started: 0.5, hive_write: 0.6, instance_started: 0.8, agent_tool: 3,
  agent_finished: 2, cycle_result: 0.8, progress_check: 0.3, circuit_breaker: 0.4, hitl_request: 0.4, hitl_response: 45, milestone_finished: 0.5,
  milestone_integrated: 1.2, chat_message: 1.5, chat_delivery: 0.8, run_finished: 1, log: 0.2,
};
const STATUS_GAP = { working: 0.4, thinking: 1.6, idle: 0.3, done: 0.3, waiting: 0.3, blocked: 0.3, error: 0.3 };

async function record() {
  const dir = scratchDir();
  try {
    let asked = 0;
    const { orchestrator, hive, config } = createRun(dir, {
      maxParallel: 2, maxFailedCycles: 12, maxStalledCycles: 1, simulated: true,
      env: { SCRIPTED_MODE: 'chat', SCRIPTED_FLAKY: 'm2:2', SCRIPTED_STEP_MS: '120' },
      hitl: async () => {
        asked += 1;
        await new Promise((r) => setTimeout(r, 300));
        return { decision: 'feedback', feedback: 'Treat a missing todos.json as an empty list instead of crashing.' };
      },
    });
    const running = orchestrator.run(REQUEST);
    await until(() => orchestrator.active.has('dwight-m2'), 30000);
    spoolChat(hive, readEvents(hive)[0].runId, 'dwight-m2', 'Keep the commands short: add, list and done.');
    const result = await running;
    if (result.status !== 'success' || asked !== 1) throw new Error(`unexpected recording: ${result.status} ${result.summary}, ${asked} questions`);
    return { events: readEvents(hive), dir, workspace: config.workspace };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    throw err;
  }
}

function normalize(events, { dir, workspace }) {
  const ids = new Map();
  const uuid = (v) => {
    if (!ids.has(v)) ids.set(v, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
    return ids.get(v);
  };
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
  const realRun = events[0].runId;
  const started = new Map();
  let t = START;
  return events.map((raw) => {
    let text = JSON.stringify(raw)
      .replaceAll(JSON.stringify(workspace).slice(1, -1), JSON.stringify(`${DEMO}\\todo-cli`).slice(1, -1))
      .replaceAll(JSON.stringify(dir).slice(1, -1), JSON.stringify(DEMO).slice(1, -1))
      .replaceAll(realRun, RUN_ID);
    text = text.replace(UUID, uuid);
    const e = JSON.parse(text);
    t += 1000 * (e.type === 'agent_status' ? STATUS_GAP[e.status] ?? 0.3 : GAP[e.type] ?? 0.5);
    e.ts = new Date(t).toISOString();
    if (e.type === 'instance_started') {
      started.set(e.instanceId, t);
      if (e.worktree) e.worktree = `${DEMO}\\hive\\isolation\\${e.instanceId}`;
    }
    if (e.type === 'agent_finished') e.durationMs = t - (started.get(e.instanceId) ?? t);
    return e;
  });
}

const recording = await record();
const events = normalize(recording.events, recording);
fs.rmSync(recording.dir, { recursive: true, force: true, maxRetries: 5 });
const leaked = events.map((e) => JSON.stringify(e)).find((l) => /Users|scratch|isolation\\\\run-/i.test(l));
if (leaked) throw new Error(`a machine path survived: ${leaked}`);
fs.writeFileSync(OUT, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
console.log(`${path.relative(process.cwd(), OUT)}: ${events.length} events`);

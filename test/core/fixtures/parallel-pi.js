import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const env = process.env;
const role = env.SCRANTON_AGENT;
const milestone = env.SCRANTON_MILESTONE;
const cycle = Number(env.SCRANTON_CYCLE);
const args = process.argv.slice(2);
const flag = (key) => args[args.indexOf(key) + 1];
const out = (r) => process.stdout.write(JSON.stringify(r) + '\n');
let timer;
const finish = (text) => {
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
  out({ type: 'agent_settled', aborted: false });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.type === 'extension_ui_response') return;
  out({ type: 'response', id: r.id, command: r.type, success: true });
  if (r.type === 'abort') { clearTimeout(timer); finish('[BLOCKED]'); return; }
  if (r.type === 'steer') {
    fs.appendFileSync(env.PARALLEL_LOG, JSON.stringify({ type: 'steer', instance: env.SCRANTON_INSTANCE_ID }) + '\n');
    return;
  }
  if (r.type !== 'prompt') return;
  fs.appendFileSync(env.PARALLEL_LOG, JSON.stringify({ type: 'start', role, milestone, cycle, sessionId: flag('--session-id'), instance: env.SCRANTON_INSTANCE_ID, cwd: process.cwd(), hasM1: fs.existsSync('m1.txt') }) + '\n');
  out({ type: 'agent_start' });
  if (role === 'michael') return finish('```json\n' + env.PARALLEL_PLAN + '\n```\n[PLAN_READY]');
  if (env.PARALLEL_MODE === 'hang') return;
  timer = setTimeout(() => {
    if (env.PARALLEL_MODE === 'blocked') return finish('[BLOCKED]');
    if (role === 'dwight') {
      fs.writeFileSync(`${milestone}.txt`, milestone);
      finish('[TASK_COMPLETE]');
    } else {
      // Deliberate QA mutation must never enter the user workspace.
      fs.writeFileSync('qa-only.txt', milestone);
      if (env.PARALLEL_MODE === 'flaky' && cycle === 1) finish('[TEST_FAILED]');
      else finish('[TEST_PASSED]');
    }
  }, milestone === 'm1' ? 180 : 240);
}).once('close', () => { clearTimeout(timer); process.exit(0); });

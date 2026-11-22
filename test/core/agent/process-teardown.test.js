import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createDurableRuntime } from '../../../src/core/durable/index.js';
import { createScriptedProvider, getModel } from '../../../src/core/llm/index.js';
import { startAgent } from '../../../src/core/agent/index.js';
import { killTree } from '../../../src/core/process-tree.js';
import { resolveShell } from '../../../src/core/tools/process.js';

const base = path.resolve('.scratch/agent-process-teardown');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;

for (const mode of ['timeout', 'injected spawn timeout', 'abort']) test(`host workflow ${mode} tears down shell descendants`, { timeout: 20000 }, async t => {
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  try { resolveShell(shell); } catch (error) { t.skip(error.message); return; }
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'run-'));
  const pidFile = path.join(dir, 'pids.json');
  let runtime, runner, pids, watchdog;
  t.after(async () => {
    clearTimeout(watchdog);
    pids ??= await fs.readFile(pidFile, 'utf8').then(JSON.parse, () => null);
    if (pids) {
      await killTree({ pid: pids.parent, kill: () => { try { process.kill(pids.parent, 'SIGKILL'); } catch {} } });
      await killTree({ pid: pids.grandchild, kill: () => { try { process.kill(pids.grandchild, 'SIGKILL'); } catch {} } });
    }
    if (runner) await runner.abort();
    await runtime?.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, 'parent.cjs'), `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, grandchild: child.pid }));
    setTimeout(() => {}, 60000);
  `);
  runtime = await createDurableRuntime({ databasePath: path.join(dir, 'db.sqlite'), markerDir: path.join(dir, 'markers'), executorId: 'teardown-test', appVersion: 'test', env: {} });
  const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(path.join(dir, 'parent.cjs'))}`;
  const llm = createScriptedProvider([
    { toolCalls: [{ id: 'sleep', name: shell, arguments: { command, timeout: mode === 'abort' ? 60 : 2 } }] },
    { text: '[TASK_COMPLETE]' },
  ]);
  const started = Date.now();
  runner = startAgent({ runtime, llm, model: getModel('openai', 'gpt-4o'), cwd: dir, hiveDir: dir,
    message: 'Run the teardown fixture', agentId: 'dwight', instanceId: 'teardown', runId: mode,
    agentConfig: { tools: [shell] }, ...(mode === 'injected spawn timeout' ? { spawn } : {}),
    extraEnv: { SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'), PI_CODING_AGENT_DIR: path.join(dir, 'pi') },
  });
  const bounded = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Workflow teardown did not return within 8 seconds')), 8000); });
  const exercise = async () => {
    for (let i = 0; i < 100 && !pids; i++) {
      pids = await fs.readFile(pidFile, 'utf8').then(JSON.parse, () => null);
      if (!pids) await delay(25);
    }
    assert.ok(pids?.grandchild, 'shell started a long-sleeping grandchild');
    if (mode === 'abort') {
      assert.equal(alive(pids.grandchild), true);
      await runner.abort();
    } else {
      assert.equal((await runner.done).ok, true);
      const result = llm.calls[1].context.messages.find(message => message.role === 'toolResult');
      assert.equal(result.isError, true);
      assert.match(result.content, /Command timed out after 2 seconds/);
    }
    assert.ok(Date.now() - started < 8000, 'tool returns promptly');
    for (let i = 0; i < 40 && alive(pids.grandchild); i++) await delay(25);
    assert.equal(alive(pids.grandchild), false, `grandchild PID ${pids.grandchild} is gone`);
  };
  try { await Promise.race([exercise(), bounded]); } finally { clearTimeout(watchdog); }
});

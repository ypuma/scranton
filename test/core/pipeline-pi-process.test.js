import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree } from '../../src/core/pi-command.js';

const helper = path.resolve(process.env.SCRANTON_LIFECYCLE_TEST_ADAPTER || 'tools/pipeline-pi-complete.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch { return false; }
}
async function until(check, message) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); }
  assert.ok(check(), message);
}

for (const mode of ['adapter-timeout', 'shared-group-timeout', 'engine-timeout', 'engine-stop', 'adapter-kill', 'pi-exit']) {
  test(`pi completion lifecycle: ${mode}`, { timeout: 20000, skip: process.platform === 'win32' && !['adapter-timeout', 'shared-group-timeout'].includes(mode) }, async (t) => {
    const base = path.resolve('.scratch/desktop-lifecycle-fix'); fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'case-'));
    const request = path.join(root, 'request.json'), response = path.join(root, 'response.json');
    const record = path.join(root, 'pids.json'), heartbeat = path.join(root, 'heartbeat');
    const fake = path.join(root, 'fake.mjs');
    fs.writeFileSync(request, JSON.stringify({ v: 1, system: 'private prompt', user: 'private prompt' }));
    fs.writeFileSync(response, 'stale');
    fs.writeFileSync(fake, `import { spawn } from 'node:child_process';
import fs from 'node:fs';
const child = spawn(process.execPath, ['--input-type=module', '-e', "import fs from 'node:fs'; setInterval(() => fs.appendFileSync(process.env.PORT_HEARTBEAT, 'x'), 30);"], { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('spawn', () => fs.writeFileSync(process.env.PORT_RECORD, JSON.stringify({ pi: process.pid, descendant: child.pid, owner: process.ppid })));
if (process.env.PORT_EXIT === '1') setTimeout(() => { console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:'done'}})); process.exit(0); }, 400);
setInterval(() => {}, 1000);
`);
    // The control deliberately shares the test runner's group, not an owned adapter group.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const args = [helper, '--provider', 'fake', '--model', 'fake', request, response];
    const env = { ...process.env, SCRANTON_PI_COMMAND: JSON.stringify([process.execPath, fake]), SCRANTON_PIPELINE_PI_TIMEOUT_MS: mode.endsWith('timeout') && !mode.startsWith('engine-') ? '1600' : '600000', PORT_RECORD: record, PORT_HEARTBEAT: heartbeat, PORT_EXIT: mode === 'pi-exit' ? '1' : '0' };
    let command = process.execPath, runArgs = args;
    if (mode.startsWith('engine-')) {
      const runner = path.join(root, 'engine.py');
      fs.writeFileSync(runner, `import json, os, threading, time\nfrom pathlib import Path\nfrom scranton_pipeline.tools.process import run_process, StopSignal\nroot = Path(${JSON.stringify(root)})\nstop = StopSignal(root / 'cancel')\ndef cancel():\n    while not (root / 'heartbeat').exists(): time.sleep(0.01)\n    stop.request_suspend()\nif ${mode === 'engine-stop' ? 'True' : 'False'}: threading.Thread(target=cancel, daemon=True).start()\nresult = run_process(${JSON.stringify([process.execPath, ...args])}, cwd=root, env=os.environ, timeout_s=${mode === 'engine-timeout' ? '1.6' : '10'}, stop=stop)\nprint(json.dumps({'timed_out':result.timed_out,'stopped':result.stopped,'exit_code':result.exit_code,'output':result.output_tail}))\n`);
      command = 'python3'; runArgs = ['-B', runner];
      env.PYTHONPATH = path.resolve('engine/src');
    }
    const adapter = spawn(command, runArgs, { detached: process.platform !== 'win32' && mode !== 'shared-group-timeout', stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '', ids, expired = false;
    adapter.stdout.on('data', (d) => { output += d; }); adapter.stderr.on('data', (d) => { output += d; });
    const closed = new Promise((resolve, reject) => { adapter.once('error', reject); adapter.once('close', (code) => resolve(code)); });
    const rescue = async () => {
      if (fs.existsSync(record)) ids = JSON.parse(fs.readFileSync(record));
      if (process.platform === 'win32') await killTree(adapter);
      else for (const pid of [ids?.descendant, ids?.pi, ids?.owner, adapter.pid]) {
        if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    };
    const watchdog = setTimeout(() => { expired = true; void rescue(); }, 12000);
    t.after(async () => {
      clearTimeout(watchdog); await rescue(); unrelated.kill();
      await closed.catch(() => {});
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await until(() => fs.existsSync(record), 'fake pi started its descendant');
    ids = JSON.parse(fs.readFileSync(record));
    await until(() => fs.existsSync(heartbeat), 'descendant actually ran');
    if (mode === 'adapter-kill') process.kill(-adapter.pid, 'SIGKILL');
    // Observe liveness before awaiting close: inherited output pipes can otherwise hide the leak.
    await until(() => !alive(ids.pi) && !alive(ids.descendant), 'pi and descendant terminated without rescue');
    const code = await closed;
    assert.equal(expired, false, 'no watchdog rescue');
    assert.equal(alive(unrelated.pid), true, 'unrelated process survives');
    if (process.platform !== 'win32') assert.equal(alive(ids.owner), false, 'group owner terminated');
    if (mode.startsWith('engine-')) {
      assert.equal(code, 0);
      const result = JSON.parse(output);
      assert.equal(result.timed_out, mode === 'engine-timeout');
      assert.equal(result.stopped, mode === 'engine-stop');
      assert.equal(result.exit_code, -9);
      assert.equal(result.output, '');
    } else {
      assert.equal(code, ['adapter-timeout', 'shared-group-timeout'].includes(mode) ? 75 : mode === 'pi-exit' ? 0 : null);
      assert.equal(output, '');
    }
    assert.equal(fs.existsSync(response), mode === 'pi-exit');
    if (mode === 'pi-exit') assert.equal(JSON.parse(fs.readFileSync(response)).text, 'done');
    if (['adapter-timeout', 'shared-group-timeout', 'pi-exit'].includes(mode)) assert.equal(fs.readdirSync(root).some((name) => name.startsWith('pi-')), false);
    const size = fs.statSync(heartbeat).size;
    assert.ok(size > 0);
    await delay(150); assert.equal(fs.statSync(heartbeat).size, size, 'no writes after cleanup');
  });
}

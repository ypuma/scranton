import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScriptedProvider } from '../src/core/llm/scripted.js';
import { runDreamingCompletion } from '../tools/dreaming-complete.js';
import { runPipelineCompletion } from '../tools/pipeline-complete.js';
import { DatabaseSync } from 'node:sqlite';
import { startAgent } from '../src/core/agent/index.js';

assert.equal(typeof startAgent, 'function');
const db = new DatabaseSync(':memory:');
assert.equal(db.prepare('select 42 as value').get().value, 42);
db.close();
globalThis.fetch = () => { throw new Error('Network forbidden in runtime smoke'); };
const model = { id: 'offline', provider: 'scripted', api: 'openai-completions' };
const clientFactory = async () => ({ model, llm: createScriptedProvider([{ text: 'offline runtime ready', usage: { input: 1, output: 3 } }]), close: async () => {} });
const result = await runDreamingCompletion({ model: 'scripted/offline', system: '', user: 'smoke', maxOutputTokens: 256 }, { clientFactory });
assert.equal(result.text, 'offline runtime ready');
const dir = await fs.mkdtemp(path.join(process.cwd(), 'runtime-smoke-'));
try {
  const request = path.join(dir, 'request.json'), response = path.join(dir, 'response.json');
  await fs.writeFile(request, JSON.stringify({ v: 1, system: '', user: 'smoke', max_output_tokens: 256, temperature: 0 }));
  assert.equal(await runPipelineCompletion(['--provider', 'scripted', '--model', 'offline', request, response], { env: {}, clientFactory }), 0);
  assert.equal(JSON.parse(await fs.readFile(response, 'utf8')).text, result.text);
  const runner = fileURLToPath(new URL('../tools/pipeline-sandbox.js', import.meta.url));
  const probe = JSON.parse(execFileSync(process.execPath, [runner, 'probe', '--protocol', '1', '--windows-mode', 'low', '--scratch', dir], {
    encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }));
  assert.equal(probe.protocol, 1);
  assert.equal(probe.windows_mode, 'low');
  assert.equal(typeof probe.available, 'boolean');
  if (probe.available) {
    assert.equal(probe.backend, 'low-integrity');
    assert.equal(probe.check_network, 'allow');
    assert.equal(probe.setup_network_allowed, true);
    assert.equal(probe.reason, null);
  } else {
    assert.equal(probe.backend, null);
    assert.equal(probe.check_network, null);
    assert.equal(probe.setup_network_allowed, false);
    assert.ok(typeof probe.reason === 'string' && probe.reason.trim());
  }
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log('Scranton offline runtime smoke passed (scripted Dreaming/Pipeline, agent import, SQLite, Pipeline sandbox protocol 1)');

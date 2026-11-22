import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPipelineCompletion } from '../../tools/pipeline-complete.js';
import { runDreamingCompletion } from '../../tools/dreaming-complete.js';
import { completionError } from '../../tools/completion-client.js';
import { createScriptedProvider } from '../../src/core/llm/index.js';

const secret = 'fixture-completion-env-8372';
const diagnostic = `Authorization: Bearer sk-test-123456789\nhttps://user:pass@example.test/error\nremote said ${secret}`;
const env = { FIXTURE_API_KEY: secret };
function masked(text) {
  for (const raw of ['sk-test-123456789', 'user:pass', secret]) assert.equal(text.includes(raw), false, 'leaked ' + raw);
  assert.match(text, /redacted/);
}

test('completion diagnostics and JSON error fields use hardened masking', () => {
  masked(JSON.stringify({ error: completionError(new Error(diagnostic), env) }));
});

for (const mode of ['factory', 'stream', 'close']) test(`Pipeline ${mode} errors are masked, with permanent/transient exit codes preserved`, async t => {
  const base = path.resolve('.scratch/completion-redaction'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'case-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const request = path.join(dir, 'request.json'), response = path.join(dir, 'response.json');
  await fs.writeFile(request, JSON.stringify({ v: 1, system: 'system', user: 'user', max_output_tokens: 256, temperature: 0 }));
  let stderr = ''; t.mock.method(process.stderr, 'write', text => { stderr += text; return true; });
  for (const transient of [false, true]) {
    stderr = '';
    const error = Object.assign(new Error(diagnostic), { status: transient ? 503 : 401 });
    const clientFactory = async () => {
      if (mode === 'factory') throw error;
      return { model: {}, close() { if (mode === 'close') throw error; }, llm: mode === 'close' ? createScriptedProvider([{ text: 'normal' }]) : {
        stream() { return { async *[Symbol.asyncIterator]() { yield { type: 'error', error: { errorMessage: diagnostic, error: { status: error.status } } }; } }; }
      } };
    };
    const code = await runPipelineCompletion(['--provider', 'offline', '--model', 'test', request, response], { env, clientFactory });
    assert.equal(code, mode !== 'close' && transient ? 75 : 1);
    if (mode === 'stream') assert.equal(stderr, '');
    else masked(stderr);
  }
});

for (const mode of ['factory', 'stream', 'close']) test(`Dreaming ${mode} rejection text is masked`, async () => {
  const clientFactory = async () => {
    if (mode === 'factory') throw new Error(diagnostic);
    return { model: {}, close() { if (mode === 'close') throw new Error(diagnostic); }, llm: mode === 'close' ? createScriptedProvider([{ text: 'normal' }]) : {
      stream() { return { async *[Symbol.asyncIterator]() { throw new Error(diagnostic); } }; }
    } };
  };
  await assert.rejects(runDreamingCompletion({ model: 'offline/test', system: 'system', user: 'user' }, { env, clientFactory }), error => { masked(error.message); return true; });
});

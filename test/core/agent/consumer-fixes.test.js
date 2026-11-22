import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createScriptedProvider } from '../../../src/core/llm/index.js';

for (const source of ['message', 'messages', 'prefixed', 'blocks', 'prefixed-blocks']) test(`status instruction is present exactly once for ${source}`, async t => {
  const f = await fixture(t);
  const instruction = 'Your Hive inbox message is attached. Do the work it describes and end your final message with exactly one status keyword on its own line, as your role instructions require.';
  const llm = createScriptedProvider([{ text: '[TASK_COMPLETE]' }]);
  const options = source.endsWith('blocks') ? { messages: [{ role: 'user', content: [{ type: 'text', text: source === 'prefixed-blocks' ? instruction + '\n\nRaw task' : 'Raw task' }] }] }
    : source === 'messages' ? { messages: [{ role: 'user', content: 'Raw task' }] }
    : { message: source === 'prefixed' ? instruction + '\n\nRaw task' : 'Raw task' };
  assert.equal((await f.start({ ...options, llm }).done).ok, true);
  const raw = llm.calls[0].context.messages[0].content;
  const content = typeof raw === 'string' ? raw : raw.map(block => block.text ?? '').join('\n');
  assert.equal(content.split(instruction).length - 1, 1);
  assert.match(content, /Raw task/);
});

test('cancelled invocation retains usage from completed requests', async t => {
  const f = await fixture(t);
  let accounted;
  const checkpoint = new Promise(resolve => { accounted = resolve; });
  const llm = createScriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'absent' } }], usage: { input: 12, output: 4 } },
    { text: 'late [TASK_COMPLETE]', delayMs: 1000 },
  ]);
  const deltas = [];
  const runner = f.start({ llm, onUsage: event => { deltas.push(event.usage); accounted(); } });
  await checkpoint;
  const result = await runner.kill('user');
  assert.equal(result.failure.kind, 'interrupted');
  assert.equal(result.usage.input, 12);
  assert.equal(result.usage.output, 4);
  for (const key of ['input', 'output', 'cost']) assert.equal(result.usage[key], deltas.reduce((n, delta) => n + delta[key], 0));
});

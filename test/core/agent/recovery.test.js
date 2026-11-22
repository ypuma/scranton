import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const base = path.resolve('.scratch/agent-tests');
function child(dir, phase, mode) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['test/core/agent/crash-child.js', dir, phase, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    process.stdout.on('data', v => { output += v; }); process.stderr.on('data', v => { output += v; });
    process.on('error', reject); process.on('close', code => resolve({ code, output }));
  });
}
for (const mode of ['file', 'shell']) test(`hard crash recovery: ${mode === 'shell' ? 'at-most-once interrupted command' : 'completed LLM and tool are not rerun'}`, async t => {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'crash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await child(dir, 'crash', mode); assert.equal(first.code, 77, first.output);
  if (mode === 'file') await fs.writeFile(path.join(dir, 'target.txt'), 'sentinel');
  const second = await child(dir, 'recover', mode); assert.equal(second.code, 0, second.output);
  const calls = (await fs.readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2, 'first LLM checkpoint replayed, only final request newly executed');
  const history = JSON.parse(await fs.readFile(path.join(dir, 'history.json')));
  assert.deepEqual(calls[1].messages, history.slice(0, -1), 'model sees the exact reconstructed checkpoint conversation');
  assert.equal(history.length, 4); assert.equal(history.at(-1).content[0].text, 'Recovered [TASK_COMPLETE]');
  assert.equal((await fs.readFile(path.join(dir, 'tools.jsonl'), 'utf8')).trim().split('\n').length, 1, 'tool-start callback not duplicated');
  assert.equal((await fs.readFile(path.join(dir, 'assistant.jsonl'), 'utf8')).trim().split('\n').length, 2, 'checkpointed assistant callbacks not duplicated');
  const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'))); assert.equal(result.keyword, 'TASK_COMPLETE'); assert.equal(result.sessionId, 'stable');
  if (mode === 'file') assert.equal(await fs.readFile(path.join(dir, 'target.txt'), 'utf8'), 'sentinel', 'committed write is not replayed');
  else {
    assert.equal(await fs.readFile(path.join(dir, 'spawn.txt'), 'utf8'), 'spawn\n');
    assert.equal(history[2].isError, true); assert.match(history[2].content, /interrupted.*outcome is unknown/);
  }
});

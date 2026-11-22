import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost, classifyError, createScriptedProvider, models, getModel, resolveModel } from '../../../src/core/llm/index.js';
import { model, context, rates } from './helpers.js';

test('scripted turns, immutable snapshots, usage, exhaustion and completion', async () => {
  const m = model('scripted', 'unused');
  const p = createScriptedProvider([{ thinking: 'Consider', text: 'Answer', toolCalls: [{ name: 'read', arguments: { path: 'a' } }], chunkSize: 2, usage: { input: 10, output: 5 } }, { text: 'Done' }]);
  const stream = p.stream(m, context);
  const events = await Array.fromAsync(stream), message = await stream.result();
  assert.deepEqual(message.content.map(b => b.type), ['thinking', 'text', 'toolCall']);
  assert.equal(message.stopReason, 'toolUse');
  assert.deepEqual(message.content[2].arguments, { path: 'a' });
  assert.equal(events.find(e => e.type === 'text_start').partial.content[1].text, '');
  assert.equal(events.find(e => e.type === 'toolcall_delta').partial.content[2].arguments.path, undefined);
  assert.ok(Math.abs(message.usage.cost.total - (2 * 10 + 8 * 5) / 1e6) < 1e-12);
  assert.equal((await p.complete(m, context)).content[0].text, 'Done');
  assert.equal((await p.complete(m, context)).error.code, 'SCRIPT_EXHAUSTED');
  assert.equal(p.calls.length, 3);
});
test('scripted delays abort, errors classify and result can be awaited with iteration', async () => {
  const c = new AbortController();
  const p = createScriptedProvider([{ delayMs: 2000, text: 'late' }, { error: { status: 429 } }]);
  const s = p.stream(model('scripted', 'unused'), context, { signal: c.signal });
  const events = Array.fromAsync(s); const result = s.result(); c.abort();
  assert.equal((await result).stopReason, 'aborted'); assert.equal((await events).at(-1).type, 'error');
  assert.equal((await p.complete(model('scripted', 'unused'), context)).error.transient, true);
});
test('catalogue is immutable and resolves known and custom refs', () => {
  assert.ok(models.length >= 80);
  assert.ok(getModel('anthropic', 'claude-haiku-4-5'));
  assert.equal(resolveModel({ provider: 'google-antigravity', model: 'gemini-3-pro' }).api, 'google-antigravity');
  assert.throws(() => resolveModel({ provider: 'unknown', model: 'nope' }));
  assert.throws(() => { models[0].cost.input = 0; });
  const m = model('openai-completions', 'http://127.0.0.1'); assert.equal(resolveModel(m), m);
});
test('cost tiers use strict threshold and total cached input; 1h cache write pricing', () => {
  const m = { cost: { ...rates, tiers: [{ inputTokensAbove: 100, input: 4, output: 16, cacheRead: 1, cacheWrite: 6 }, { inputTokensAbove: 200, input: 8, output: 32, cacheRead: 2, cacheWrite: 12 }] } };
  const u = { input: 60, output: 10, cacheRead: 20, cacheWrite: 20, cacheWrite1h: 10 };
  assert.equal(calculateCost(m, u).total, (120 + 80 + 10 + 30 + 40) / 1e6);
  u.input++;
  assert.equal(calculateCost(m, u).total, (244 + 160 + 20 + 60 + 80) / 1e6);
  u.input = 300;
  assert.ok(Math.abs(calculateCost(m, u).total - (2400 + 320 + 40 + 120 + 160) / 1e6) < 1e-12);
  assert.equal(u.cost.totalFromProvider, false);
});
test('error retry taxonomy does not leak response details', () => {
  for (const status of [408, 429, 500, 503, 599]) assert.equal(classifyError({ status, message: 'secret' }).transient, true);
  for (const status of [400, 401, 403, 404]) assert.equal(classifyError({ status }).transient, false);
  for (const error of [new TypeError('fetch failed'), { code: 'ECONNRESET' }, { name: 'TimeoutError' }, { cause: { code: 'UND_ERR_SOCKET' } }]) assert.equal(classifyError(error).transient, true);
  assert.equal(classifyError({ name: 'AbortError' }).transient, false);
  assert.equal(classifyError({ code: 'PROTOCOL_ERROR', message: 'secret' }).message.includes('secret'), false);
});

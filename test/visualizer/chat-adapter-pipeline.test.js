import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pipelineChatAdapter } from '../../visualizer/public/js/chat-adapter-pipeline.js';
import { parseRunDoc, parseRunList } from '../../visualizer/public/js/pipeline-model.js';
import { createChatView } from '../../visualizer/public/js/chat-view.js';
import { installTree } from './fixtures/tree-dom.js';

// Payloads copied from the engine lane's CHANGES.md, so this test also runs in a clean checkout without .scratch.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/pipeline-conversation.json', import.meta.url), 'utf8'));
const event = (seq, type, data = {}) => ({ seq, type, ts: '2026-11-11T10:00:00Z', data });
function run(sample = fixture.basic, over = {}) {
  const id = sample.events[0].run_id;
  return { runId: id, ...parseRunDoc({ status: { run_id: id, status: 'succeeded', task: 'Explain or fix addition', reply: sample.reply }, events: sample.events, ...over }) };
}
const entries = (r) => pipelineChatAdapter({ run: r });

test('recorded answer envelopes become seq-ordered planner turns and exactly one answer with citations', () => {
  const r = run(fixture.answer);
  const got = entries(r);
  assert.deepEqual(got.map((x) => x.kind), ['request', 'agent', 'agent', 'reply']);
  assert.deepEqual(got.filter((x) => x.kind === 'agent').map((x) => [x.who.id, x.text, x.context]), fixture.answer.events.slice(0, 2).map((e) => [e.data.role, e.data.text, e.data.context]));
  assert.equal(got.at(-1).text, fixture.answer.reply.text);
  assert.equal(got.at(-1).replyKind, 'answer');
  assert.match(got.at(-1).context, /cites E-9f596c1b8c/);
  r.events.reverse();
  assert.deepEqual(entries(r), got, 'seq, never timestamp or arrival order, owns the transcript');
});

test('recorded edit envelopes retain planner, implementer and reviewer; approval is a question then a human decision', () => {
  const r = run();
  r.events.push(event(27, 'gate_waiting', { gate: 'plan', digest: 'abc' }), event(30, 'gate_decided', { gate: 'plan', decision: 'approve', by: 'human' }));
  const got = entries(r);
  assert.deepEqual(got.map((x) => x.kind), ['request', 'agent', 'agent', 'question', 'human', 'agent', 'agent', 'reply']);
  assert.deepEqual(got.filter((x) => x.kind === 'agent').map((x) => x.who.id), ['planner', 'planner', 'implementer', 'reviewer']);
  assert.equal(got.find((x) => x.kind === 'question').tone, null, 'a decided gate no longer offers action');
  assert.equal(got.find((x) => x.kind === 'human').text, 'You approved the plan');
  assert.equal(got.at(-1).text, fixture.basic.reply.text);
  assert.equal(got.at(-1).tone, 'ok');
});

test('replies survive run-list-only and current-document-only responses, without duplication', () => {
  const r = run(fixture.answer, { events: [], reply: fixture.answer.reply, status: { status: 'succeeded', task: 'Question' } });
  const list = parseRunList({ active: null, runs: [{ runId: r.runId, task: 'Question', status: 'succeeded', reply: { ...fixture.answer.reply, truncated: true } }] });
  assert.deepEqual(pipelineChatAdapter({ list }).map((x) => x.kind), ['request', 'reply']);
  assert.equal(pipelineChatAdapter({ list }).at(-1).truncated, true);
  assert.equal(entries(r).at(-1).text, fixture.answer.reply.text);
  assert.equal(pipelineChatAdapter({ list, run: r }).filter((x) => x.kind === 'reply').length, 1);
});

test('failed, cancelled and rejected runs retain their reason; suspended runs have no fabricated terminal reply', () => {
  for (const status of ['failed', 'cancelled', 'rejected']) {
    const r = run(fixture.basic, { events: [], status: { status, task: 'Fix', failure: { message: 'unit failed' } } });
    assert.match(entries(r).at(-1).text, /Reason: unit failed/);
    assert.equal(entries(r).at(-1).tone, 'fail');
  }
  const r = run(fixture.basic, { events: [], status: { status: 'suspended', task: 'Fix', resumable: true } });
  assert.equal(entries(r).some((x) => x.kind === 'reply'), false);
  assert.match(entries(r).at(-1).text, /Resume it under Details/);
});

test('legacy plan and review summaries are used only without native role messages', () => {
  const old = run(fixture.basic, { events: [], status: { status: 'succeeded', task: 'Fix' }, plan: { summary: 'Old plan', steps: [] }, review: { verdict: 'approve', summary: 'Old review' } });
  assert.deepEqual(entries(old).filter((x) => x.kind === 'agent').map((x) => x.text), ['Old plan', 'Old review']);
  old.events = run().events;
  assert.equal(entries(old).some((x) => x.text === 'Old plan' || x.text === 'Old review'), false);
});

test('hostile and overlong role/reply text remains bounded literal DOM text, never executable markup', () => {
  const $ = installTree();
  const hostile = '<img src=x onerror=alert(1)> [x](javascript:alert(1))\u202E\u0000';
  const r = run(fixture.basic, { events: [event(1, 'agent_message', { role: '__proto__', text: hostile, final: true }), event(2, 'agent_message', { role: 'planner', text: 'x'.repeat(16001) }), event(3, 'run_reply', { kind: 'answer', text: hostile })] });
  const got = entries(r);
  assert.equal(got[2].text.length, 16000);
  assert.equal(got[2].truncated, true);
  assert.doesNotMatch(got[1].text, /[\u202E\u0000]/);
  const view = createChatView({ getEntries: () => got, currentRunId: () => r.runId });
  view.render();
  assert.equal($('chat-view-list').querySelectorAll('img').length, 0);
  assert.equal($('chat-view-list').querySelectorAll('a').length, 0);
  assert.match($('chat-view-list').textContent, /<img src=x onerror=alert\(1\)>/);
});

// The input limits of context budget v2 (.enma/context-budget-contract.md sections 11 and 12): the composer and the
// New run request take 32768 chars, a Pipeline chat's shared composer counts and refuses in UTF-8 bytes, the user's
// own request is shown in full, a message to a running agent and HITL feedback take 16000. The last tests hold the
// browser constants against the server's values (owner: lane F, section 13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { REQUEST_MAX, FEEDBACK_MAX } from '../../visualizer/public/js/control.js';
import { CHAT_MAX } from '../../visualizer/public/js/chat.js';
import { CHAT_TEXT_MAX } from '../../visualizer/public/js/state.js';
import { NOTES_MAX, previewText, parseProjectContext } from '../../visualizer/public/js/context.js';
import { TASK_MAX_BYTES, PIPELINE_MODELS_KEY, storedPlannerPick, taskBytesError } from '../../visualizer/public/js/pipeline-model.js';
import { createPipelineForm } from '../../visualizer/public/js/pipeline-form.js';
import { createContextPanel } from '../../visualizer/public/js/context-panel.js';
import { teamChatAdapter } from '../../visualizer/public/js/chat-adapter-team.js';
import { pipelineChatAdapter } from '../../visualizer/public/js/chat-adapter-pipeline.js';
import { createThread } from '../../visualizer/public/js/thread.js';
import { createScope, parseProjects } from '../../visualizer/public/js/scope.js';
import { installDom } from './fixtures/fake-dom.js';
import { LIMITS, pipelineAllowance } from '../../src/core/context/limits.js';
import { validDecision } from '../../src/core/file-control.js';
import { ChatRouter } from '../../src/core/chat-router.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const PUBLIC = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

test('the raised maxima: the constants, and the markup that pins them', () => {
  assert.deepEqual([REQUEST_MAX, FEEDBACK_MAX, CHAT_MAX, CHAT_TEXT_MAX, NOTES_MAX, TASK_MAX_BYTES], [32768, 16000, 16000, 16000, 16000, 32768]);
  const max = (id) => Number(new RegExp(`<textarea id="${id}"[^>]*maxlength="(\\d+)"`).exec(html)?.[1]);
  const count = (id) => new RegExp(`id="${id}">([^<]*)<`).exec(html)?.[1];
  for (const [field, counter, limit] of [
    ['followup-text', 'followup-count', REQUEST_MAX], ['f-request', 'f-request-count', REQUEST_MAX],
    ['chat-view-input', 'chat-view-count', CHAT_MAX], ['chat-text', 'chat-count', CHAT_MAX], ['hitl-text', 'hitl-count', FEEDBACK_MAX],
  ]) {
    assert.equal(max(field), limit, `#${field} maxlength`);
    assert.equal(count(counter), `0 / ${limit}`, `#${counter}`);
  }
  assert.equal(max('context-notes'), NOTES_MAX);
  // the Pipeline form's own task field keeps its byte cap; its textarea stops at as many chars
  assert.equal(max('pf-task'), TASK_MAX_BYTES);
});

// the Follow up composer of a chat of either engine; the pipeline hooks record what they were asked to start
function composer(engine) {
  const $ = installDom();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ runs: [] }) });
  const projects = parseProjects({ mode: 'registry', projects: [{ id: 'core', name: 'Core', workspace: 'C:\\code\\core', chats: [{ id: 'a', title: 'First', status: 'done', runs: 1, engine }] }] });
  const started = [];
  const thread = createThread({
    scope: createScope({ project: 'core', chat: 'a' }),
    nav: { doc: () => projects, refresh() {}, newChat() {}, newProject() {}, rename() {} },
    control: { snapshot: () => ({ control: { enabled: true }, mode: 'live', gates: { alive: false, recovery: false } }), openRun() {}, startFollowUp: async (goal) => { started.push(goal); return { ok: true }; } },
    onReplay() {},
    view: () => 'chat',
    hasRun: () => true,
    pipeline: { gate: () => ({ loaded: true, active: null, runs: 1 }), note: () => null, start: async (task) => { started.push(task); return { ok: true }; }, options() {} },
  });
  thread.activate();
  const type = async (text) => {
    $('followup-text').value = text;
    await $('followup-text').fire('input');
  };
  const submit = async () => {
    await $('followup').fire('submit');
    await new Promise((r) => setTimeout(r, 5));
  };
  return { $, started, type, submit };
}

test('a Pipeline chat counts the shared composer in bytes and refuses an over-long non-ASCII task before sending', async () => {
  const p = composer('pipeline');
  assert.equal(p.$('followup-count').textContent, `0 / ${TASK_MAX_BYTES} bytes`);
  // 16384 two-byte characters are exactly the cap
  await p.type('\u00e4'.repeat(16384));
  assert.equal(p.$('followup-count').textContent, '32768 / 32768 bytes');
  await p.submit();
  assert.equal(p.started.length, 1);
  await p.type(`${'\u00e4'.repeat(16384)}x`);
  assert.equal(p.$('followup-count').textContent, '32769 / 32768 bytes');
  await p.submit();
  assert.equal(p.started.length, 1, 'nothing is sent');
  assert.equal(p.$('followup-status').textContent, 'The task is 32,769 bytes of UTF-8; a pipeline run takes at most 32,768. Characters outside ASCII take 2 to 4 bytes each.');
  assert.equal(p.$('followup-status').dataset.tone, 'error');
  assert.equal(p.$('followup-text').getAttribute('aria-invalid'), 'true');
  await p.type('\u{1F680}'.repeat(8193));
  assert.equal(p.$('followup-count').textContent, '32772 / 32768 bytes', 'an astral character is 4 bytes');
  assert.equal(p.$('followup-text').getAttribute('aria-invalid'), null, 'typing clears the mark');
  assert.equal(taskBytesError('x'.repeat(32768)), '');

  // a Team chat counts characters against 32768: the same text of 16385 chars goes
  const t = composer('team');
  assert.equal(t.$('followup-count').textContent, `0 / ${REQUEST_MAX}`);
  await t.type(`${'\u00e4'.repeat(16384)}x`);
  assert.equal(t.$('followup-count').textContent, '16385 / 32768');
  await t.submit();
  assert.deepEqual(t.started.map((s) => s.length), [16385]);
});

test('the stored Pipeline planner pick is read from the Pipeline form\'s models, never from the Team picks', () => {
  assert.deepEqual(storedPlannerPick(JSON.stringify({ planner: JSON.stringify(['openai', 'gpt-5']), implementer: '' })), { provider: 'openai', model: 'gpt-5' });
  for (const junk of [null, '', 'x', '[]', '{"planner":""}', '{"planner":"[\\"openai\\"]"}', JSON.stringify({ planner: JSON.stringify(['', 'm']) }), JSON.stringify({ michael: JSON.stringify(['a', 'b']) })]) {
    assert.equal(storedPlannerPick(junk), null, String(junk));
  }
});

const provider = (id, model) => ({ provider: id, label: id, supported: true, via: 'pi', reason: null, models: [{ id: model, label: model }] });
const value = (p, m) => JSON.stringify([p, m]);

// The Pipeline form and the context panel wired as main.js wires them, on one fake DOM; the server answers
// /api/pipeline with `providers` and every chat context read with a minimal v2 Pipeline document.
function pickHarness({ stored, engine = 'pipeline' }) {
  const $ = installDom();
  const kept = new Map([[PIPELINE_MODELS_KEY, JSON.stringify(stored)]]);
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) };
  const h = { $, kept, reads: [], providers: [] };
  const json = (doc) => ({ ok: true, status: 200, json: async () => structuredClone(doc) });
  globalThis.fetch = async (url, opts = {}) => {
    if (url === '/api/pipeline') return json({ available: true, reason: null, version: '0.1.0', sandbox: {}, models: h.providers });
    if (opts.method === 'POST') return json({ git: true, checks: [], setup: [] });
    h.reads.push(url);
    return json({ v: 2, engine });
  };
  const nav = { mode: 'registry', projects: [{ id: 'core', name: 'Core', workspace: '', chats: [{ id: 'a', title: 'A', status: 'idle', runs: 1, engine }] }] };
  let context = null;
  const form = createPipelineForm({ onPlanner: () => context.plannerChanged() });
  context = createContextPanel({ getProjects: () => nav, plannerModel: () => form.plannerPick() });
  h.form = form;
  h.tick = () => new Promise((r) => setTimeout(r, 10));
  h.scope = async () => {
    context.setScope({ project: 'core', chat: 'a' });
    await h.tick();
  };
  h.choose = async (role, v) => {
    $(`pf-model-${role}`).value = v;
    await $(`pf-model-${role}`).fire('change');
    await h.tick();
  };
  return h;
}

const CHAT = '/api/projects/core/chats/a/context';

test('a Pipeline chat reads its context for the planner pick the form will send, and again when that pick changes', async () => {
  const h = pickHarness({ stored: { planner: value('openai', 'gpt-5'), implementer: '', reviewer: '' } });
  await h.scope();
  assert.deepEqual(h.reads, [`${CHAT}?provider=openai&model=gpt-5`], 'before the form knows the models, its next run starts from the stored pick');

  // the server no longer offers that model: the select drops it, so the read names no model, though storage keeps it
  h.providers = [provider('anthropic', 'claude')];
  await h.form.open({ fixed: true, project: 'core' });
  await h.tick();
  assert.equal(h.$('pf-model-planner').value, '');
  assert.deepEqual(h.form.plannerPick(), null);
  assert.equal(h.reads.at(-1), CHAT);
  assert.equal(storedPlannerPick(h.kept.get(PIPELINE_MODELS_KEY))?.model, 'gpt-5');

  // the human picks a planner: the indicator follows at once
  await h.choose('planner', value('anthropic', 'claude'));
  assert.equal(h.reads.at(-1), `${CHAT}?provider=anthropic&model=claude`);
  const n = h.reads.length;
  // the other roles are not the recipient, and the same pick again is no change
  await h.choose('reviewer', value('anthropic', 'claude'));
  await h.$('pf-model-all').fire('click');
  await h.tick();
  assert.equal(h.reads.length, n);

  // the model comes back: the form restores the stored pick of the role, and the read follows
  h.providers = [provider('anthropic', 'claude'), provider('openai', 'gpt-5')];
  h.kept.set(PIPELINE_MODELS_KEY, JSON.stringify({ planner: value('openai', 'gpt-5') }));
  h.$('pf-model-planner').value = '';
  await h.form.open({ fixed: true, project: 'core' });
  await h.tick();
  assert.equal(h.$('pf-model-planner').value, value('openai', 'gpt-5'));
  assert.equal(h.reads.at(-1), `${CHAT}?provider=openai&model=gpt-5`);
});

test('a Team chat in scope is not read again when the Pipeline planner changes', async () => {
  const h = pickHarness({ stored: { planner: value('openai', 'gpt-5') }, engine: 'team' });
  await h.scope();
  assert.deepEqual(h.reads, [CHAT]);
  h.providers = [provider('anthropic', 'claude')];
  await h.form.open({ fixed: true, project: 'core' });
  await h.tick();
  await h.choose('planner', value('anthropic', 'claude'));
  assert.deepEqual(h.reads, [CHAT]);
});

test('the user\'s own request is shown in full in the chat view, up to the request cap', () => {
  const long = 'r'.repeat(REQUEST_MAX);
  const ev = (type, fields) => ({ v: 1, seq: 1, ts: '2026-11-17T10:00:00.000Z', runId: 'r1', type, ...fields });
  const [fromEvent] = teamChatAdapter({ events: [ev('run_started', { request: long })] });
  assert.deepEqual([fromEvent.kind, fromEvent.text.length, fromEvent.truncated], ['request', REQUEST_MAX, false]);
  const [listed] = teamChatAdapter({ runs: [{ runId: 'r1', goal: long, status: 'success' }] });
  assert.deepEqual([listed.kind, listed.text.length, listed.truncated], ['request', REQUEST_MAX, false]);
  const [task] = pipelineChatAdapter({ list: { runs: [{ runId: 'p1', task: long, status: 'succeeded' }] } });
  assert.deepEqual([task.kind, task.text.length, task.truncated], ['request', REQUEST_MAX, false]);
  // still a bounded copy: anything beyond the cap is not a request the server took
  assert.equal(teamChatAdapter({ events: [ev('run_started', { request: `${long}x` })] })[0].truncated, true);
  // a message to a running agent is kept up to its own cap
  const said = teamChatAdapter({ events: [ev('run_started', { request: 'go' }), { ...ev('chat_message', { id: 'm1', from: 'human', to: 'dwight-m1', text: 'm'.repeat(CHAT_MAX), delivery: 'queued' }), seq: 2 }] });
  assert.deepEqual([said[1].kind, said[1].text.length, said[1].truncated], ['human', CHAT_MAX, false]);
});

// ------------------------------------------------------------ parity with the server (section 13, owner F)
// These read the other lanes' values: NOTES_MAX against lane A1, the rest against lane S.

test('parity: NOTES_MAX is the notes limit of the context core', () => {
  assert.equal(NOTES_MAX, LIMITS.notes);
});

test('parity: FEEDBACK_MAX is what the HITL answer check accepts', () => {
  const answer = (k) => validDecision({ decision: 'feedback', feedback: 'f'.repeat(k) }, ['feedback']);
  assert.ok(answer(FEEDBACK_MAX), 'the browser maximum is accepted');
  assert.ok(!answer(FEEDBACK_MAX + 1), 'one more is refused');
});

test('parity: CHAT_MAX is the chat router\'s text limit', () => {
  assert.equal(new ChatRouter({ hiveDir: '', runId: 'r', emit() {} }).maxText, CHAT_MAX);
});

function post(srv, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${srv.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1' } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode, value }); });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('parity: REQUEST_MAX is what POST /api/runs accepts as a request', async (t) => {
  const base = path.resolve('.scratch/context-budget/lane-f');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, port: 0, control: { workspace: path.join(dir, 'ws') } });
  t.after(() => srv.close());
  // an invalid maxCycles after the request keeps the run from starting: which error comes back tells the request passed
  const at = await post(srv, '/api/runs', { request: 'x'.repeat(REQUEST_MAX), maxCycles: 11 });
  assert.deepEqual([at.status, at.value.error], [400, 'Invalid maxCycles'], 'the browser maximum is a valid request');
  const over = await post(srv, '/api/runs', { request: 'x'.repeat(REQUEST_MAX + 1) });
  assert.deepEqual([over.status, over.value.error], [400, 'Invalid request'], 'one more is refused');
});

const pipelineDefaults = { pipeline: [4000, 18750], pipelineBytes: { history: [12000, 50000], context: [4000, 25000] } };
test('project parsing preserves Pipeline byte allowances and rejects malformed metadata', () => {
  const parse = defaults => parseProjectContext({ v: 2, defaults }).defaults;
  assert.deepEqual(parse(pipelineDefaults).pipelineBytes, pipelineDefaults.pipelineBytes);
  for (const pipelineBytes of [null, {}, { history: [12000, 50000] }, { history: [0, 50000], context: [4000, 25000] }, { history: [50000, 12000], context: [4000, 25000] }]) assert.equal(parse({ pipelineBytes }).pipelineBytes, null);
});
test('Pipeline browser preview has parity with the server allowances across windows and rules', () => {
  for (const window of [32000, 64000, 128000, 200000, 400000, 1048576]) {
    const model = { id: 'p/m', window, known: true }, d = { model, engine: 'pipeline' };
    const rules = [{ mode: 'percent', value: 10 }, ...Array.from({ length: 50 }, (_, i) => ({ mode: 'percent', value: i + 1 })), { mode: 'tokens', value: 200000 }];
    for (let value = 256; value <= 200000; value += 257) rules.push({ mode: 'tokens', value });
    for (const rule of rules) {
      const text = previewText(rule, d, pipelineDefaults), expected = pipelineAllowance({ budget: rule }, model).tokens;
      assert.equal(Number(/^\u2248([\d,]+)/.exec(text)?.[1]?.replaceAll(',', '')), expected, JSON.stringify({ window, rule, text }));
    }
  }
});
test('older Pipeline metadata does not claim a numeric engine allowance', () => {
  assert.match(previewText({ mode: 'percent', value: 10 }, { engine: 'pipeline', model: { id: null, window: 200000 } }, { pipeline: [4000, 18750] }), /can raise or lower it/);
});
test('the budget mode option leaves room for the select arrow', () => {
  assert.match(html, /<option value="percent">Share of the context window \(%\)<\/option>/);
});

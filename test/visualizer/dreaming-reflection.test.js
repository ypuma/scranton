// Model reflection in the Dreams drawer (claude-code-dreaming plan, final contract overrides): an explicit, confirmed
// provider request that only proposes typed notes, the review of that proposal with its quotes, Apply / Reject /
// Cancel, and replies that can never land on another project. Offline: the server and the model catalog are fakes,
// nothing here reaches a provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDreamingPanel } from '../../visualizer/public/js/dreaming-panel.js';
import {
  parseDreaming, parseReflection, buildSettings, modelRef, proposeBlock, usageText, disclosure, reflectBadge, dreamingUrl,
  REFLECT_POLL_MS, TOKENS_DEFAULT, TIMEOUT_DEFAULT,
} from '../../visualizer/public/js/dreaming.js';
import { parseModels, modelKey } from '../../visualizer/public/js/accounts.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const SHA = 'b'.repeat(64);
const PROJECTS = { mode: 'registry', projects: [{ id: 'core', name: 'Core', chats: [] }, { id: 'web', name: 'Web', chats: [] }] };
const MODELS = {
  providers: [
    { id: 'anthropic', label: 'Claude', signedIn: true, models: [{ id: 'claude-x', name: 'Claude X' }] },
    { id: 'openrouter', label: 'OpenRouter', signedIn: true, models: [{ id: 'vendor/model-a', name: 'Model A' }] },
    { id: 'openai', label: 'ChatGPT', signedIn: false, models: [{ id: 'gpt-y', name: 'GPT Y' }] },
  ],
};
const CATALOG = parseModels(MODELS);

const note = (over = {}) => ({ id: 'n1', type: 'project', title: 'Tests run with npm.cmd', text: 'Run the suite with npm.cmd test on Windows.', createdAt: '2026-11-15T11:00:00.000Z', evidence: [], ...over });
const proposal = (over = {}) => ({
  id: 'p1', createdAt: '2026-11-15T12:00:00.000Z', model: 'anthropic/claude-x', summary: 'One correction from the user.',
  usage: { inputTokens: 1800, outputTokens: 240, costUsd: null },
  operations: [
    { action: 'add', targetIds: [], type: 'feedback', title: 'Prefer small commits', text: 'The user asked for small, focused commits.', reason: 'The user said so twice.',
      evidence: [
        { signalId: 's1', quote: 'please keep commits small', role: 'user', at: '2026-11-15T10:00:00.000Z', path: 'projects/core/chats/a/chat.jsonl', sha256: SHA },
        { signalId: 's2', quote: 'I split the change into three commits', role: 'assistant', at: null, path: 'projects/core/chats/a/chat.jsonl', sha256: SHA },
        { signalId: 's3', quote: 'checks passed', role: 'outcome', at: null, path: 'projects/core/chats/a/run.json', sha256: SHA },
      ],
      before: [], after: { id: 'new', type: 'feedback', title: 'Prefer small commits', text: 'The user asked for small, focused commits.' } },
    { action: 'remove', targetIds: ['n1'], type: null, title: null, text: null, reason: 'The project moved off npm.', evidence: [], before: [note()], after: null },
  ],
  ...over,
});
const reflection = (over = {}) => ({ state: 'idle', jobId: null, startedAt: null, finishedAt: null, error: null, usage: null, proposal: null, memory: [], limitations: ['Quotes are provenance, not proof.'], ...over });

function status(projectId = 'core', over = {}) {
  return {
    v: 1, projectId, enabled: false, applyPolicy: false, intervalMinutes: 360, state: 'idle', lastSweepAt: null, nextSweepAt: null, canRollback: false,
    counts: { episodes: 0, candidates: 0, promoted: 0, worlds: 0 }, phases: [], memory: [], candidates: [],
    replay: { objective: '', worlds: 0, evaluations: [], recommendations: [], limitations: [] }, diary: [], limitations: [],
    reflectionEnabled: false, reflectionModel: null, reflectionMaxOutputTokens: 2048, reflectionTimeoutSeconds: 60,
    reflection: reflection(),
    ...over,
  };
}

// ------------------------------------------------------------ pure logic
test('parseReflection: known states only, nullable fields explicit, an older server has none', () => {
  const d = parseDreaming(status(), 'core');
  assert.equal(d.reflectionSupported, true);
  assert.deepEqual([d.reflectionEnabled, d.reflectionModel, d.reflectionMaxOutputTokens, d.reflectionTimeoutSeconds], [false, null, TOKENS_DEFAULT, TIMEOUT_DEFAULT]);
  assert.equal(d.reflection.state, 'idle');
  assert.equal(d.reflection.proposal, null);
  const old = status();
  delete old.reflection;
  assert.equal(parseDreaming(old, 'core').reflectionSupported, false);
  assert.equal(parseDreaming(old, 'core').reflection, null);
  const odd = parseReflection(reflection({ state: 'thinking' }));
  assert.equal(odd.state, 'failed', 'an unknown state never reads as idle or ready');
  assert.match(odd.error, /does not know/);
  assert.equal(parseDreaming(status('core', { reflectionTimeoutSeconds: 120, reflectionMaxOutputTokens: 9000 }), 'core').reflectionTimeoutSeconds, 60, 'out of range falls back to the default');
});

test('parseReflection: a proposal is kept whole, a removal has no new text, anything cut makes it incomplete', () => {
  const p = parseReflection(reflection({ state: 'ready', proposal: proposal() })).proposal;
  assert.equal(p.complete, true);
  assert.deepEqual(p.operations.map((o) => [o.action, o.after?.title ?? null, o.before.length]), [['add', 'Prefer small commits', 0], ['remove', null, 1]]);
  assert.deepEqual(p.operations[0].evidence.map((q) => q.role), ['user', 'assistant', 'outcome']);
  assert.equal(p.operations[1].type, '');
  assert.deepEqual(p.usage, { inputTokens: 1800, outputTokens: 240, costUsd: null });
  const cut = (over) => parseReflection(reflection({ state: 'ready', proposal: proposal(over) })).proposal.complete;
  assert.equal(cut({ summary: 'x'.repeat(2001) }), false, 'a long summary is not silently shortened');
  assert.equal(cut({ operations: Array(13).fill(proposal().operations[0]) }), false, 'more operations than the contract allows');
  assert.equal(cut({ operations: [{ ...proposal().operations[0], action: 'rewrite' }] }), false, 'an unknown action');
  assert.equal(cut({ operations: [{ ...proposal().operations[0], evidence: [{ quote: 'x', role: 'system' }] }] }), false, 'an unknown evidence role');
  assert.equal(cut({ operations: [{ ...proposal().operations[0], after: null }] }), false, 'an add without its note');
  assert.equal(parseReflection(reflection({ proposal: { id: '', operations: [] } })).proposal, null);
});

test('buildSettings: reflection fields bounded, a model required for automatic proposals, a new pick must be signed in', () => {
  const saved = parseDreaming(status(), 'core');
  const form = { enabled: false, applyPolicy: false, interval: '360', reflectionEnabled: false, model: '', tokens: '2048', timeout: '60' };
  assert.deepEqual(buildSettings(form, saved, CATALOG), { body: {} });
  assert.deepEqual(buildSettings({ ...form, model: modelKey('openrouter', 'vendor/model-a') }, saved, CATALOG).body, { reflectionModel: 'openrouter/vendor/model-a' });
  assert.deepEqual(buildSettings({ ...form, tokens: '256', timeout: '10' }, saved, CATALOG).body, { reflectionMaxOutputTokens: 256, reflectionTimeoutSeconds: 10 });
  for (const tokens of ['255', '4097', '1.5', '']) assert.equal(buildSettings({ ...form, tokens }, saved).field, 'tokens', tokens);
  for (const timeout of ['9', '61', '120', '300']) assert.equal(buildSettings({ ...form, timeout }, saved).field, 'timeout', timeout);
  assert.equal(buildSettings({ ...form, reflectionEnabled: true }, saved).field, 'model', 'automatic proposals never fall back to a default model');
  assert.equal(buildSettings({ ...form, model: modelKey('openai', 'gpt-y') }, saved, CATALOG).field, 'model', 'a signed-out provider is refused');
  assert.deepEqual(buildSettings({ ...form, reflectionEnabled: true, model: modelKey('anthropic', 'claude-x') }, saved, CATALOG).body, { reflectionEnabled: true, reflectionModel: 'anthropic/claude-x' });
  const old = status();
  delete old.reflection;
  assert.deepEqual(buildSettings({ ...form, enabled: true, tokens: '1' }, parseDreaming(old, 'core')).body, { enabled: true }, 'an older server is never sent reflection fields');
});

test('wording: model refs, Generate prerequisites, the disclosure, usage and routes', () => {
  assert.deepEqual(modelRef('openrouter/vendor/model-a'), { provider: 'openrouter', model: 'vendor/model-a' });
  for (const bad of ['', 'nomodel', '/x', 'a/ ', null, 7]) assert.equal(modelRef(bad), null, String(bad));
  const d = parseDreaming(status(), 'core');
  const c = { provider: 'anthropic', model: 'claude-x' };
  assert.match(proposeBlock(d, { catalog: CATALOG, choice: null }), /no default model/);
  assert.match(proposeBlock(d, { catalog: null, choice: c }), /not available/);
  assert.match(proposeBlock(d, { catalog: undefined, choice: c }), /Loading/);
  assert.match(proposeBlock(d, { catalog: CATALOG, choice: { provider: 'openai', model: 'gpt-y' } }), /not signed in/);
  assert.equal(proposeBlock(d, { catalog: CATALOG, choice: c }), '');
  assert.match(proposeBlock(parseDreaming(status('core', { state: 'busy' }), 'core'), { catalog: CATALOG, choice: c }), /idle/);
  assert.match(proposeBlock(parseDreaming(status('core', { reflection: reflection({ state: 'ready', proposal: proposal() }) }), 'core'), { catalog: CATALOG, choice: c }), /pending proposal/);
  const text = disclosure({ tokens: 2048, timeout: 60 });
  for (const part of [/redacted excerpts/, /up to 4 recent runs/, /1,000 characters per run/, /12,000 characters of input/, /may charge/, /2,048 output tokens/, /4,096 characters/, /60 seconds/, /nothing is saved to memory until you apply it/]) assert.match(text, part);
  assert.equal(usageText(null), 'Usage: not reported.');
  assert.equal(usageText({ inputTokens: 1800, outputTokens: 240, costUsd: null }), 'Usage: 1,800 input tokens \u00b7 240 output tokens.', 'no cost is invented');
  assert.match(usageText({ inputTokens: null, outputTokens: 5, costUsd: 0.002 }), /\$0\.002 reported cost/);
  assert.deepEqual(reflectBadge({ state: 'ready' }), ['Proposal ready', 'loud']);
  assert.equal(dreamingUrl('core', 'proposal/apply'), '/api/projects/core/dreaming/proposal/apply');
  for (const gone of ['reflect', 'accept', 'discard']) assert.equal(dreamingUrl('core', gone), null, `no /${gone} route`);
});

// ------------------------------------------------------------ the drawer
// held: request keys whose answer waits for release(key); answers: key -> [code, body]
function harness({ answers = {}, held = [], over = {}, models = MODELS, proposeBody = 'status' } = {}) {
  const $ = installDom();
  const close = new FakeEl();
  $('dreams-dialog').querySelectorAll = () => [close];
  const requests = [];
  const waiting = new Map();
  const server = { core: status('core', over), web: status('web') };
  // as the server does: its own reflection job alone makes the project read busy
  const served = (body) => (body?.reflection?.state === 'running' ? { ...body, state: 'busy' } : body);
  const reply = (code, body) => ({ ok: code < 300, status: code, json: async () => (body === undefined ? Promise.reject(new Error('empty')) : structuredClone(served(body))) });
  globalThis.fetch = (url, opts = {}) => {
    if (url === '/api/models') {
      requests.push({ url, key: 'models', method: 'GET' });
      return Promise.resolve(models ? reply(200, models) : reply(404, { error: 'Not found' }));
    }
    const m = /^\/api\/projects\/([a-z0-9-]+)\/dreaming(?:\/([a-z/]+))?$/.exec(url);
    const key = `${m[1]}:${m[2] ?? 'status'}`;
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    requests.push({ url, key, method: opts.method ?? 'GET', body });
    const answer = () => {
      if (answers[key]) return reply(...answers[key]);
      const doc = server[m[1]];
      const r = doc.reflection;
      if (m[2] === 'propose') {
        doc.reflection = reflection({ state: 'running', jobId: 'j1', startedAt: '2026-11-15T12:00:00.000Z', memory: r.memory });
        return reply(202, proposeBody === 'status' ? doc : undefined);
      }
      if (m[2] === 'cancel') doc.reflection = { ...r, state: 'cancelled', finishedAt: '2026-11-15T12:00:05.000Z' };
      if (m[2] === 'proposal/apply') doc.reflection = reflection({ state: 'idle', memory: [{ ...r.proposal.operations[0].after, createdAt: '2026-11-15T12:01:00.000Z', evidence: r.proposal.operations[0].evidence }] });
      if (m[2] === 'proposal/reject') doc.reflection = reflection({ state: 'idle', memory: r.memory });
      if (m[2] === 'settings') Object.assign(doc, body);
      return reply(200, doc);
    };
    if (held.includes(key)) return new Promise((res) => waiting.set(key, () => res(answer())));
    return Promise.resolve(answer());
  };
  const confirms = [];
  const panel = createDreamingPanel({ confirm: (c) => confirms.push(c), getProjects: () => PROJECTS });
  // setImmediate, so the mocked setTimeout of the poll tests does not stall it
  const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  };
  const open = async (id = 'core') => {
    panel.open(id);
    await flush();
  };
  const release = async (key) => {
    waiting.get(key)();
    await flush();
  };
  const posts = () => requests.filter((r) => r.method === 'POST');
  const pick = async (value) => {
    $('dreams-model').value = value;
    await $('dreams-settings').fire('change', { target: $('dreams-model') });
  };
  return { $, panel, requests, posts, confirms, flush, open, release, server, pick, close };
}

const readyOver = () => ({ reflectionModel: 'anthropic/claude-x', reflection: reflection({ state: 'ready', finishedAt: '2026-11-15T12:00:30.000Z', usage: proposal().usage, proposal: proposal() }) });

test('opening shows the reflection section apart from local consolidation, with the disclosure and signed-in models only', async () => {
  const h = harness({ over: { reflectionModel: 'openrouter/vendor/model-a' } });
  await h.open();
  assert.equal(h.$('dreams-reflect').hidden, false);
  assert.equal(h.$('dreams-reflect-settings').hidden, false);
  assert.match(h.$('dreams-disclosure').textContent, /redacted excerpts .* may charge/);
  assert.equal(h.$('dreams-reflect-state').textContent, 'No proposal');
  const groups = h.$('dreams-model').childNodes;
  assert.equal(groups[0].textContent, 'No model chosen', 'no silent default model');
  assert.deepEqual(groups.slice(1).map((g) => [g.label, g.disabled]), [['Claude', false], ['OpenRouter', false], ['ChatGPT (signed out)', true]]);
  assert.equal(h.$('dreams-model').value, modelKey('openrouter', 'vendor/model-a'), 'the saved model is selected');
  assert.equal(h.$('dreams-propose').disabled, false);
  assert.match(h.$('dreams-propose-hint').textContent, /Uses openrouter\/vendor\/model-a/);
  assert.equal(h.$('dreams-notes-empty').hidden, false);
  assert.deepEqual(h.$('dreams-reflect-limits').childNodes.map((li) => li.textContent), ['Quotes are provenance, not proof.']);
  assert.equal(h.$('dreams-settings-save').disabled, true, 'opening is not a change');
});

test('without a chosen or available model Generate stays off and says why', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.$('dreams-propose').disabled, true);
  assert.match(h.$('dreams-propose-hint').textContent, /Choose a model under Settings/);
  await h.$('dreams-propose').fire('click');
  assert.equal(h.confirms.length, 0);
  const none = harness({ models: null, over: { reflectionModel: 'anthropic/claude-x' } });
  await none.open();
  assert.equal(none.$('dreams-propose').disabled, true);
  assert.match(none.$('dreams-model-hint').textContent, /model list is not available/);
  assert.match(none.$('dreams-model').childNodes.at(-1).textContent, /anthropic\/claude-x \(not in the model list\)/, 'the saved choice is kept in the form');
});

test('Generate asks first, names the model, posts it explicitly, then follows the job until the proposal is ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  t.after(() => h.$('dreams-dialog').close());
  await h.open();
  await h.pick(modelKey('anthropic', 'claude-x'));
  assert.equal(h.$('dreams-propose').disabled, false, 'an unsaved pick is enough; the request names it');
  await h.$('dreams-propose').fire('click');
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].detail, /with anthropic\/claude-x\. Sends redacted excerpts .* may charge/);
  assert.equal(h.posts().length, 0, 'nothing is sent before the confirm');
  const r = await h.confirms[0].action();
  await h.flush();
  assert.deepEqual(h.posts().map((p) => [p.url, p.body]), [['/api/projects/core/dreaming/propose', { provider: 'anthropic', model: 'claude-x' }]]);
  assert.equal(r.focus, h.$('dreams-status'));
  assert.match(h.$('dreams-status').textContent, /Generating a proposal with anthropic\/claude-x/);
  assert.equal(h.$('dreams-reflect-state').textContent, 'Generating');
  assert.equal(h.$('dreams-cancel').hidden, false);
  for (const id of ['dreams-sweep', 'dreams-rollback', 'dreams-propose']) assert.equal(h.$(id).disabled, true, `${id} waits for the job`);
  assert.equal(h.$('dreams-run-preview').disabled, false, 'the read-only preview never waits for a model');
  assert.equal(h.$('dreams-settings-save').disabled, true, 'the picked model is unsaved, but saving waits for the job');
  assert.match(h.$('dreams-settings-status').textContent, /Saving waits/);
  const sent = h.posts().length;
  await h.$('dreams-sweep').fire('click');
  await h.$('dreams-settings').fire('submit');
  await h.$('dreams-rollback').fire('click');
  await h.flush();
  assert.equal(h.posts().length, sent, 'no sweep, settings or rollback is posted while the job runs');
  assert.equal(h.confirms.length, 1, 'no rollback confirm either');

  h.server.core.reflection = readyOver().reflection;
  const before = h.requests.length;
  t.mock.timers.tick(REFLECT_POLL_MS - 1);
  await h.flush();
  assert.equal(h.requests.length, before, 'not before the poll delay');
  t.mock.timers.tick(1);
  await h.flush();
  assert.equal(h.requests.at(-1).key, 'core:status');
  assert.equal(h.$('dreams-reflect-state').textContent, 'Proposal ready');
  assert.equal(h.$('dreams-status').textContent, 'Proposal ready: 2 changes to review. Nothing is applied until you apply it.');
  assert.equal(h.$('dreams-cancel').hidden, true);
  const after = h.requests.length;
  t.mock.timers.tick(REFLECT_POLL_MS * 4);
  await h.flush();
  assert.equal(h.requests.length, after, 'polling stops once the job ended');
});

test('a 202 without a status body still follows the job', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ proposeBody: 'none', over: { reflectionModel: 'anthropic/claude-x' } });
  t.after(() => h.$('dreams-dialog').close());
  await h.open();
  await h.$('dreams-propose').fire('click');
  await h.confirms[0].action();
  await h.flush();
  assert.equal(h.requests.at(-1).key, 'core:status', 'read again right away');
  assert.equal(h.$('dreams-reflect-state').textContent, 'Generating');
  assert.equal(h.$('dreams-reflect-error').hidden, true);
});

test('the proposal shows before and after, the reason, and quotes marked by who said them, as text', async () => {
  const over = readyOver();
  over.reflection.proposal.summary = '<img src=x onerror=alert(1)>';
  const h = harness({ over });
  await h.open();
  assert.equal(h.$('dreams-proposal').hidden, false);
  assert.equal(h.$('dreams-proposal-summary').textContent, '<img src=x onerror=alert(1)>');
  assert.match(h.$('dreams-proposal-meta').textContent, /Model anthropic\/claude-x .* 2 changes/);
  assert.match(h.$('dreams-reflect-usage').textContent, /1,800 input tokens/);
  const [add, remove] = h.$('dreams-ops').childNodes;
  assert.deepEqual(add.childNodes[0].childNodes.map((c) => c.textContent), ['Add', 'Feedback', 'Prefer small commits']);
  const [beforeAdd, afterAdd] = add.childNodes[1].childNodes;
  assert.equal(beforeAdd.childNodes[1].textContent, 'No note yet.');
  assert.deepEqual(afterAdd.childNodes.map((c) => c.textContent), ['After', 'Feedback: Prefer small commits', 'The user asked for small, focused commits.']);
  assert.equal(add.childNodes[2].textContent, "Model's reason: The user said so twice.");
  const quotes = add.childNodes[3].childNodes;
  assert.deepEqual(quotes.map((q) => [q.dataset.role, q.childNodes[0].textContent, q.childNodes[1].textContent]), [
    ['user', 'User said', 'please keep commits small'],
    ['assistant', 'Assistant reported, not verified', 'I split the change into three commits'],
    ['outcome', 'Recorded outcome', 'checks passed'],
  ]);
  assert.match(quotes[0].childNodes[2].textContent, /chat\.jsonl \u00b7 bbbbbbbbbbbb/);
  assert.deepEqual(remove.childNodes[0].childNodes.map((c) => c.textContent), ['Remove', 'Project', 'Tests run with npm.cmd'], 'a removal is named by the note it removes');
  assert.deepEqual(remove.childNodes[1].childNodes[0].childNodes.map((c) => c.textContent), ['Before', 'Project: Tests run with npm.cmd', 'Run the suite with npm.cmd test on Windows.']);
  assert.equal(remove.childNodes[1].childNodes[1].childNodes[1].textContent, 'Removed. No note takes its place.');
  assert.match(remove.childNodes[3].textContent, /needs none/);
  assert.equal(h.$('dreams-propose').disabled, true);
  assert.match(h.$('dreams-propose-hint').textContent, /Apply or reject the pending proposal first/);
  assert.equal(h.$('dreams-foot').textContent, 'Proposal waiting for review');
  const src = readFileSync(new URL('../../visualizer/public/js/dreaming-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no markup is ever built from strings');
});

test('Apply asks first, posts the shown proposal id, and the accepted note shows with its quotes', async () => {
  const h = harness({ over: readyOver() });
  await h.open();
  await h.$('dreams-apply-proposal').fire('click');
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].detail, /Applies 2 changes .* advisory history, not as instructions or evidence/);
  assert.equal(h.posts().length, 0);
  await h.confirms[0].action();
  assert.deepEqual(h.posts().map((p) => [p.url, p.body]), [['/api/projects/core/dreaming/proposal/apply', { proposalId: 'p1' }]]);
  assert.equal(h.$('dreams-proposal').hidden, true);
  const [n] = h.$('dreams-notes').childNodes;
  assert.deepEqual(n.childNodes[0].childNodes.map((c) => c.textContent), ['Feedback', 'Prefer small commits']);
  assert.match(n.childNodes[2].textContent, /^Proposed .* 3 quotes$/, 'the note carries the proposal time; the server records no apply time');
  assert.equal(h.$('dreams-notes-empty').hidden, true);
  assert.match(h.$('dreams-status').textContent, /Proposal applied/);
});

test('Reject asks first and warns a new proposal may be charged; Cancel stops a running job', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ over: readyOver() });
  await h.open();
  await h.$('dreams-reject').fire('click');
  assert.match(h.confirms[0].detail, /may be charged again/);
  await h.confirms[0].action();
  assert.deepEqual(h.posts().map((p) => [p.url, p.body]), [['/api/projects/core/dreaming/proposal/reject', { proposalId: 'p1' }]]);
  assert.equal(h.$('dreams-proposal').hidden, true);
  assert.equal(h.$('dreams-status').textContent, 'Proposal rejected. No note changed.');

  const run = harness({ over: { reflectionModel: 'anthropic/claude-x', reflection: reflection({ state: 'running', jobId: 'j1', startedAt: '2026-11-15T12:00:00.000Z' }) } });
  t.after(() => run.$('dreams-dialog').close());
  await run.open();
  assert.equal(run.$('dreams-cancel').hidden, false);
  await run.$('dreams-cancel').fire('click');
  await run.flush();
  assert.deepEqual(run.posts().map((p) => [p.url, p.body]), [['/api/projects/core/dreaming/cancel', {}]]);
  assert.equal(run.$('dreams-reflect-state').textContent, 'Cancelled');
  assert.equal(run.$('dreams-reflect-note').textContent, 'Generation was cancelled. Nothing was saved.');
  assert.equal(globalThis.document.activeElement, run.$('dreams-status'), 'focus does not stay on the hidden Cancel');
});

test('an incomplete or empty proposal cannot be applied; a failure shows its reason and usage', async () => {
  const cut = readyOver();
  cut.reflection.proposal.summary = 'y'.repeat(3000);
  const h = harness({ over: cut });
  await h.open();
  assert.equal(h.$('dreams-apply-proposal').disabled, true);
  assert.match(h.$('dreams-proposal-note').textContent, /cannot be applied from this drawer/);
  await h.$('dreams-apply-proposal').fire('click');
  assert.equal(h.confirms.length, 0, 'not even a confirm');
  assert.equal(h.$('dreams-reject').disabled, false, 'it can still be rejected');

  const empty = readyOver();
  empty.reflection.proposal.operations = [];
  const e = harness({ over: empty });
  await e.open();
  assert.equal(e.$('dreams-apply-proposal').disabled, true);
  assert.match(e.$('dreams-proposal-note').textContent, /proposed no changes/);

  const failed = harness({ over: { reflection: reflection({ state: 'failed', error: 'Provider timed out after 60 s', usage: null, finishedAt: '2026-11-15T12:01:00.000Z' }) } });
  await failed.open();
  assert.equal(failed.$('dreams-reflect-state').textContent, 'Failed');
  assert.equal(failed.$('dreams-reflect-note').textContent, 'Generation failed: Provider timed out after 60 s. Nothing was saved.');
  assert.equal(failed.$('dreams-reflect-usage').textContent, 'Usage: not reported.');
  assert.equal(failed.$('dreams-proposal').hidden, true);
});

test('a proposal that changed while the confirm was open is not applied', async () => {
  const h = harness({ over: readyOver() });
  await h.open();
  await h.$('dreams-apply-proposal').fire('click');
  h.server.core.reflection.proposal.id = 'p2';
  await h.panel.open('core');
  await h.flush();
  const r = await h.confirms[0].action();
  assert.deepEqual(r, {}, 'the reopened drawer is another generation: the old confirm acts on nothing');
  assert.equal(h.posts().length, 0);

  const same = harness({ over: readyOver() });
  await same.open();
  await same.$('dreams-apply-proposal').fire('click');
  same.server.core.reflection.proposal.id = 'p2';
  same.$('dreams-retry').fire('click');
  await same.flush();
  const r2 = await same.confirms[0].action();
  assert.match(r2.error, /changed meanwhile/);
  assert.equal(same.posts().length, 0, 'the id on screen when the human said yes is the only one sent');
});

test('a busy project blocks Save, Generate and Apply, and posts nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ over: { ...readyOver(), state: 'busy' } });
  t.after(() => h.$('dreams-dialog').close());
  await h.open();
  h.$('dreams-enabled').checked = true;
  await h.$('dreams-settings').fire('change', { target: h.$('dreams-enabled') });
  assert.equal(h.$('dreams-foot').textContent, 'Unsaved settings');
  assert.equal(h.$('dreams-settings-save').disabled, true);
  assert.match(h.$('dreams-settings-status').textContent, /Saving waits until the project is idle/);
  await h.$('dreams-settings').fire('submit');
  for (const id of ['dreams-propose', 'dreams-apply-proposal', 'dreams-reject']) assert.equal(h.$(id).disabled, true, id);
  await h.$('dreams-apply-proposal').fire('click');
  await h.$('dreams-reject').fire('click');
  assert.equal(h.confirms.length, 0);
  assert.deepEqual(h.posts(), [], 'the server would answer 409; nothing is sent');
});

test('a propose reply after the drawer moved to another project never fills it in', async () => {
  const h = harness({ held: ['core:propose'], over: { reflectionModel: 'anthropic/claude-x' } });
  await h.open();
  await h.$('dreams-propose').fire('click');
  const going = h.confirms[0].action();
  await h.flush();
  assert.equal(h.$('dreams-reflect-status').textContent, 'Starting generation...');
  await h.open('web');
  await h.release('core:propose');
  await going;
  assert.equal(h.panel.project(), 'web');
  assert.equal(h.$('dreams-reflect-state').textContent, 'No proposal', "Core's job never shows under Web");
  assert.equal(h.$('dreams-status').textContent, '');
  assert.equal(h.$('dreams-propose').disabled, true, 'Web has no model chosen');
  assert.equal(h.$('dreams-reflect-status').textContent, '', 'the new drawer is not left busy');
});

test('a poll answer for the project the drawer left is dropped, and closing stops the polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = { reflectionModel: 'anthropic/claude-x', reflection: reflection({ state: 'running', jobId: 'j1', startedAt: '2026-11-15T12:00:00.000Z' }) };
  const h = harness({ over: running, held: ['core:status'] });
  t.after(() => h.$('dreams-dialog').close());
  h.panel.open('core');
  await h.flush();
  await h.release('core:status');
  assert.equal(h.$('dreams-reflect-state').textContent, 'Generating');
  t.mock.timers.tick(REFLECT_POLL_MS);
  await h.flush();
  assert.equal(h.requests.filter((r) => r.key === 'core:status').length, 2, 'the poll is on its way');
  h.server.core.reflection = readyOver().reflection;
  await h.open('web');
  await h.release('core:status');
  assert.equal(h.$('dreams-project').textContent, 'Web');
  assert.equal(h.$('dreams-proposal').hidden, true, "Core's proposal never shows under Web");
  assert.equal(h.$('dreams-status').textContent, '', 'no "Proposal ready" under Web');

  const c = harness({ over: running });
  await c.open();
  const before = c.requests.length;
  c.$('dreams-dialog').close();
  t.mock.timers.tick(REFLECT_POLL_MS * 5);
  await c.flush();
  assert.equal(c.requests.length, before, 'a closed drawer reads nothing');
});

test('an older server without reflection: no section, no model request is needed, settings stay as before', async () => {
  const h = harness();
  delete h.server.core.reflection;
  await h.open();
  assert.equal(h.$('dreams-reflect').hidden, true);
  assert.equal(h.$('dreams-reflect-settings').hidden, true);
  h.$('dreams-enabled').checked = true;
  await h.$('dreams-settings').fire('change', { target: h.$('dreams-enabled') });
  await h.$('dreams-settings').fire('submit');
  assert.deepEqual(h.posts().map((p) => p.body), [{ enabled: true }]);
});

test('settings: automatic proposals need a model, and the reflection limits are saved with the rest', async () => {
  const h = harness();
  await h.open();
  h.$('dreams-reflect-auto').checked = true;
  await h.$('dreams-settings').fire('change', { target: h.$('dreams-reflect-auto') });
  await h.$('dreams-settings').fire('submit');
  assert.equal(h.posts().length, 0);
  assert.match(h.$('dreams-settings-error').textContent, /needs a model/);
  assert.equal(globalThis.document.activeElement, h.$('dreams-model'));
  assert.equal(h.$('dreams-model').getAttribute('aria-invalid'), 'true');
  await h.pick(modelKey('anthropic', 'claude-x'));
  h.$('dreams-timeout').value = '30';
  await h.$('dreams-settings').fire('input', { target: h.$('dreams-timeout') });
  await h.$('dreams-settings').fire('submit');
  assert.deepEqual(h.posts().at(-1).body, { reflectionEnabled: true, reflectionModel: 'anthropic/claude-x', reflectionTimeoutSeconds: 30 });
  assert.match(h.$('dreams-status').textContent, /Automatic proposals are on/);
  assert.equal(h.$('dreams-model').value, modelKey('anthropic', 'claude-x'));
  assert.equal(h.$('dreams-settings-save').disabled, true, 'saved: nothing left to save');
});

test('a running job reads busy on the server, yet Preview still reads through it while everything that saves waits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = { reflectionModel: 'anthropic/claude-x', reflection: reflection({ state: 'running', jobId: 'j1', startedAt: '2026-11-15T12:00:00.000Z' }) };
  const h = harness({ over: running });
  t.after(() => h.$('dreams-dialog').close());
  await h.open();
  assert.equal(h.$('dreams-state').textContent, 'Generating', 'the cause is known, so no unexplained busy');
  assert.match(h.$('dreams-state-note').textContent, /while a reflection proposal is generated\. Preview still works/);
  assert.doesNotMatch(h.$('dreams-state-note').textContent, /gave no reason|running chat/);
  assert.equal(h.$('dreams-run-preview').disabled, false);
  for (const id of ['dreams-sweep', 'dreams-rollback', 'dreams-propose']) assert.equal(h.$(id).disabled, true, id);
  await h.$('dreams-run-preview').fire('click');
  await h.flush();
  assert.deepEqual(h.posts().map((p) => p.url), ['/api/projects/core/dreaming/preview']);
  assert.match(h.$('dreams-status').textContent, /^Preview ready: .* Nothing was saved\.$/);
  assert.equal(h.$('dreams-state').textContent, 'Preview');
  await h.$('dreams-sweep').fire('click');
  await h.$('dreams-rollback').fire('click');
  await h.flush();
  assert.deepEqual(h.posts().map((p) => p.url), ['/api/projects/core/dreaming/preview'], 'nothing that saves is posted during the job');
  assert.equal(h.confirms.length, 0);

  // a chat that starts meanwhile: the server refuses the preview, and the drawer says so and reads again
  const both = harness({ over: running, answers: { 'core:preview': [409, { error: 'Dreaming is busy' }] } });
  t.after(() => both.$('dreams-dialog').close());
  await both.open();
  await both.$('dreams-run-preview').fire('click');
  await both.flush();
  assert.match(both.$('dreams-error').textContent, /^Refused: the server reports this project as busy/);
  assert.equal(both.requests.at(-1).key, 'core:status');
});

test('a repeated attempt on unchanged runs: the hint says what the server does, and its refusal says nothing was charged', async () => {
  const h = harness({
    over: { reflectionModel: 'anthropic/claude-x', reflection: reflection({ state: 'cancelled', finishedAt: '2026-11-15T12:00:05.000Z', error: 'Reflection cancelled.' }) },
    answers: { 'core:propose': [409, { error: 'Reflection input already attempted' }] },
  });
  await h.open();
  assert.equal(h.$('dreams-propose').disabled, false, 'the page cannot see the fingerprints, so it does not guess');
  assert.match(h.$('dreams-propose-hint').textContent, /refuses a new one before contacting the provider, so nothing is charged/);
  await h.$('dreams-propose').fire('click');
  const r = await h.confirms[0].action();
  assert.match(r.error, /^Refused before sending: these recent runs were already sent once\..*Nothing was sent or charged\.$/);
  assert.equal(h.$('dreams-reflect-state').textContent, 'Cancelled');

  const fresh = harness({ over: { reflectionModel: 'anthropic/claude-x' } });
  await fresh.open();
  assert.doesNotMatch(fresh.$('dreams-propose-hint').textContent, /refuses/, 'no attempt yet, no warning');
});

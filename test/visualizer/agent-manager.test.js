// The Agents drawer as an agent manager (.enma/custom-agents-contract.md sections 2, 6 and 10): built-in and custom
// agents in catalog order with their model and prompt source, New agent (POST), per-agent settings (PATCH) with
// pinned fields read only, Delete (confirm, then DELETE), one unsaved guard over every form, late replies dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentsPanel } from '../../visualizer/public/js/agents-panel.js';
import {
  parseAgents, roleView, idProblem, keywordProblem, defaultKeywords, buildNewAgent, buildAgentPatch, agentErrorField, CUSTOM_MAX, INSTRUCTION_MAX,
  RESERVED_IDS, THINKING_LEVELS,
} from '../../visualizer/public/js/agents.js';
import { modelKey } from '../../visualizer/public/js/accounts.js';
import { parseControl } from '../../visualizer/public/js/control.js';
import { validateAgentId } from '../../src/core/agents-config.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const css = readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const PICK = { provider: 'openai', model: 'gpt-a' };
const GPT = modelKey('openai', 'gpt-a');
const CATALOG = { providers: [{ id: 'openai', label: 'ChatGPT', signedIn: true, models: [{ id: 'gpt-a', name: 'GPT A' }] }] };
const none = { value: null, source: 'none', pinned: false };
const TOOLS5 = ['read', 'grep', 'find', 'ls', 'bash'];
const role = (id, name, title, kind, keywords, extra = {}) => ({
  id, name, title, kind, builtin: true, gate: kind === 'gate', keywords, tools: TOOLS5, instruction: '', model: none, thinking: none,
  prompt: { source: 'builtin', text: `# ${name}\n[${keywords[0]}]`, editable: true, builtinText: `# ${name}\n[${keywords[0]}]`, missingKeywords: [] }, ...extra,
});
const custom = (id, name, title, extra = {}) => role(id, name, title, 'gate', [`${id.toUpperCase()}_PASSED`, `${id.toUpperCase()}_FAILED`, 'BLOCKED'], {
  builtin: false, passKeyword: `${id.toUpperCase()}_PASSED`, failKeyword: `${id.toUpperCase()}_FAILED`, tools: ['read', 'grep'],
  instruction: `Check ${title.toLowerCase()}.`, ...extra,
});
const DOC = {
  roles: [
    role('michael', 'Michael', 'Orchestrator', 'planner', ['PLAN_READY'], { model: { value: PICK, source: 'settings', pinned: false }, thinking: { value: 'high', source: 'settings', pinned: false } }),
    role('dwight', 'Dwight', 'Developer', 'developer', ['TASK_COMPLETE', 'BLOCKED']),
    role('oscar', 'Oscar', 'Reviewer', 'gate', ['REVIEW_APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'], {
      instruction: 'Review only the parser.', defaultInstruction: 'Review the changes for correctness.',
    }),
    role('hank', 'Hank', 'Security', 'gate', ['SECURITY_PASSED', 'SECURITY_ISSUES', 'BLOCKED'], {
      instruction: 'Audit the changes for security vulnerabilities.', defaultInstruction: 'Audit the changes for security vulnerabilities.',
      model: { value: { provider: 'anthropic', model: 'claude-x' }, source: 'config', pinned: true }, thinking: { value: null, source: 'none', pinned: false },
    }),
    role('angela', 'Angela', 'QA', 'gate', ['TEST_PASSED', 'TEST_FAILED', 'BLOCKED'], {
      instruction: 'Verify every acceptance criterion independently.', defaultInstruction: 'Verify every acceptance criterion independently.',
      thinking: { value: 'low', source: 'env', pinned: true },
    }),
    custom('seclint', 'Seclint', 'Lint'),
  ],
  workflow: { default: [['oscar', 'hank'], ['angela']] },
  warnings: ['agents.json: skipped "bad-x": the id may not contain a dash'],
};

// The drawer with a fake server that applies what it is sent. fail: { method: { status, error } } refuses requests.
function harness({ answer = DOC, fail = {}, on = { value: true }, control = null } = {}) {
  const $ = installDom();
  const close = new FakeEl();
  $('agents-dialog').querySelectorAll = () => [close];
  const requests = [];
  const changes = [];
  const doc = structuredClone(answer);
  const hold = {};
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => structuredClone(body) });
  const server = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    requests.push({ url, method, headers: opts.headers ?? {}, body });
    if (method === 'GET') return url === '/api/models' ? reply(200, CATALOG) : reply(200, doc);
    if (fail[method]) return reply(fail[method].status, fail[method].error === undefined ? {} : { error: fail[method].error });
    const id = /\/api\/agents\/([a-z0-9]+)/.exec(url)?.[1];
    const r = doc.roles.find((x) => x.id === id);
    if (method === 'POST') {
      doc.roles.push(custom(body.id, body.name, body.title, { passKeyword: body.passKeyword ?? `${body.id.toUpperCase()}_PASSED`, tools: body.tools, instruction: body.instruction }));
      return reply(201, { ok: true });
    }
    if (url.endsWith('/prompt')) {
      Object.assign(r.prompt, method === 'PUT' ? { source: 'custom', text: body.text } : { source: 'builtin', text: r.prompt.builtinText });
      return reply(200, { ok: true });
    }
    if (method === 'DELETE') {
      doc.roles.splice(doc.roles.indexOf(r), 1);
      return reply(200, { ok: true });
    }
    for (const [k, v] of Object.entries(body)) {
      if (k === 'model' || k === 'thinking') r[k] = v === null ? none : { value: v, source: 'settings', pinned: false };
      else if (k === 'instruction') r.instruction = v ?? r.defaultInstruction;
      else r[k] = v;
    }
    return reply(200, { ok: true });
  };
  globalThis.fetch = (url, opts = {}) => (hold[opts.method] ? new Promise((res) => { hold.release = () => res(server(url, opts)); }) : server(url, opts));
  const confirms = [];
  const panel = createAgentsPanel({ getControl: () => ({ control, gates: { on: on.value } }), confirm: (c) => confirms.push(c), onChange: () => changes.push(1) });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const rows = () => $('agents-list').childNodes;
  const row = (i) => {
    const [head, detail, actions] = rows()[i].childNodes;
    return {
      name: head.childNodes[0], title: head.childNodes[1], source: head.childNodes[2], kind: head.childNodes[3],
      keywords: detail.childNodes[0], tools: detail.childNodes[1], model: detail.childNodes[2], edit: actions.childNodes[0], settings: actions.childNodes[1],
    };
  };
  const ready = async () => {
    panel.render();
    await tick();
    panel.open();
    await tick();
  };
  const type = (id, value, form) => {
    $(id).value = value;
    return Promise.all([$(id).fire('input'), $(form).fire('input', { target: $(id) })]);
  };
  const check = (id, on, form) => {
    $(id).checked = on;
    return $(form).fire('change', { target: $(id) });
  };
  const mutations = () => requests.filter((r) => r.method !== 'GET');
  return { $, panel, requests, mutations, confirms, changes, tick, rows, row, ready, type, check, close, on, doc, hold };
}

test('parseAgents: catalog order, custom agents after the built-ins, settings and warnings read safely', () => {
  const p = parseAgents({ ...DOC, roles: [DOC.roles[5], ...DOC.roles.slice(0, 5)], warnings: ['one', 7, ''], thinkingLevels: ['off', 'high'] });
  assert.deepEqual(p.roles.map((r) => r.id), ['michael', 'dwight', 'oscar', 'hank', 'angela', 'seclint']);
  assert.deepEqual(p.warnings, ['one']);
  assert.deepEqual(p.thinkingLevels, ['off', 'high']);
  const hank = p.roles.find((r) => r.id === 'hank');
  assert.deepEqual(hank.model, { value: { provider: 'anthropic', model: 'claude-x' }, source: 'config', pinned: true });
  const loose = parseAgents({ roles: [{ id: 'oscar', model: { value: { provider: 'x', model: 'y' }, source: 'env', pinned: false } }] }).roles[0];
  assert.equal(loose.model.pinned, true, 'env always pins');
  assert.equal(loose.builtin, true, 'an older server: the built-ins by id');
  const seclint = p.roles.find((r) => r.id === 'seclint');
  assert.deepEqual([seclint.builtin, seclint.kind, seclint.passKeyword], [false, 'gate', 'SECLINT_PASSED']);
  assert.equal(roleView(seclint).source, 'Starter', 'a custom agent on its generated prompt');
  assert.equal(roleView({ ...seclint, prompt: { ...seclint.prompt, source: 'custom' } }).source, 'Custom');
  assert.equal(roleView(p.roles[0]).model, 'openai/gpt-a (set here) \u00b7 thinking high');
  assert.equal(roleView(hank).model, 'anthropic/claude-x (scranton.config.json)');
  assert.equal(roleView(p.roles[1]).model, 'pi default');
  assert.equal(roleView({ ...p.roles[0], title: 'Planner' }).kind, '', 'a title that says the kind is not repeated');
  assert.equal(roleView(p.roles[0]).kind, 'Planner');
});

test('validation: the id and keyword rules of the contract, reserved words included', () => {
  const roles = parseAgents(DOC).roles;
  assert.match(idProblem('', roles), /Give the agent an id/);
  for (const bad of ['a', 'A1', '1abc', 'sec-lint', 'sec_lint', 'x'.repeat(21), 'Seclint']) assert.match(idProblem(bad, roles), /2-20 characters/, bad);
  for (const word of ['human', 'runs', 'orchestrator', 'default', 'hitl', 'oscar', 'angela']) assert.equal(idProblem(word, roles), `${word} is reserved. Pick another id.`, word);
  assert.equal(idProblem('seclint', roles), 'There is an agent with the id seclint already.');
  assert.equal(idProblem('docs2', roles), '');
  assert.equal(idProblem('ab', roles), '');
  assert.deepEqual(defaultKeywords('docs2'), { pass: 'DOCS2_PASSED', fail: 'DOCS2_FAILED' });
  assert.deepEqual(defaultKeywords(''), { pass: '<ID>_PASSED', fail: '<ID>_FAILED' });

  const kw = (p, f, self) => keywordProblem(p, f, { roles, self })?.field ?? null;
  assert.equal(kw('DOCS_OK', 'DOCS_BAD'), null);
  assert.equal(kw('BLOCKED', 'DOCS_BAD'), 'passKeyword');
  assert.equal(kw('DOCS_OK', 'TEST_FAILED'), 'failKeyword', 'a built-in keyword');
  assert.equal(kw('SECLINT_PASSED', 'DOCS_BAD'), 'passKeyword', "another custom agent's keyword");
  assert.equal(kw('SECLINT_PASSED', 'SECLINT_FAILED', 'seclint'), null, 'its own keywords');
  assert.equal(kw('ok_lower', 'DOCS_BAD'), 'passKeyword');
  assert.equal(kw('AB', 'DOCS_BAD'), 'passKeyword', 'at least three characters');
  assert.equal(kw(`A${'B'.repeat(40)}`, 'DOCS_BAD'), 'passKeyword', 'at most forty');
  assert.equal(kw('DOCS_X', 'DOCS_X'), 'failKeyword', 'pass and fail differ');
  assert.match(keywordProblem('BLOCKED', 'X_FAILED', { roles }).error, /BLOCKED is the answer of every gate/);
});

test('buildNewAgent: the body the contract names, default keywords left to the server, every rule checked', () => {
  const roles = parseAgents(DOC).roles;
  const form = { id: 'docs2', name: ' Doris ', title: 'Docs', passKeyword: '', failKeyword: '', instruction: 'Check the docs.\r\n', tools: ['grep', 'read'], model: '', thinking: '' };
  assert.deepEqual(buildNewAgent(form, roles), { body: { id: 'docs2', name: 'Doris', title: 'Docs', instruction: 'Check the docs.', tools: ['read', 'grep'] } });
  assert.deepEqual(buildNewAgent({ ...form, passKeyword: 'DOCS_OK', model: GPT, thinking: 'high' }, roles).body,
    { id: 'docs2', name: 'Doris', title: 'Docs', instruction: 'Check the docs.', tools: ['read', 'grep'], passKeyword: 'DOCS_OK', model: PICK, thinking: 'high' });
  assert.equal(buildNewAgent({ ...form, id: 'human' }, roles).field, 'id');
  assert.equal(buildNewAgent({ ...form, name: '' }, roles).field, 'name');
  assert.equal(buildNewAgent({ ...form, name: 'x'.repeat(41) }, roles).field, 'name');
  assert.equal(buildNewAgent({ ...form, title: 'x'.repeat(61) }, roles).field, 'title');
  assert.equal(buildNewAgent({ ...form, failKeyword: 'SECURITY_ISSUES' }, roles).field, 'failKeyword');
  assert.equal(buildNewAgent({ ...form, instruction: ' ' }, roles).field, 'instruction');
  assert.equal(buildNewAgent({ ...form, instruction: 'x'.repeat(INSTRUCTION_MAX + 1) }, roles).field, 'instruction');
  assert.equal(buildNewAgent({ ...form, instruction: 'x'.repeat(INSTRUCTION_MAX) }, roles).body.instruction.length, INSTRUCTION_MAX);
  assert.equal(buildNewAgent({ ...form, tools: [] }, roles).field, 'tools');
  assert.deepEqual(buildNewAgent({ ...form, tools: ['write', 'edit', 'read'] }, roles).body.tools, ['read'], 'no write or edit');
  assert.equal(buildNewAgent({ ...form, tools: ['write'] }, roles).field, 'tools');
  const full = [...roles, ...Array.from({ length: CUSTOM_MAX - 1 }, (_, i) => ({ ...roles[5], id: `extra${i}` }))];
  assert.match(buildNewAgent(form, full).error, /12 custom agents/);
  assert.equal(agentErrorField('passKeyword collides with oscar', ['passKeyword', 'name']), 'passKeyword');
  assert.equal(agentErrorField('Invalid name: control characters', ['passKeyword', 'name']), 'name');
  assert.equal(agentErrorField('Too many custom agents', ['passKeyword', 'name']), null);
});

test('buildAgentPatch: only what changed, never a pinned field, null to reset', () => {
  const roles = parseAgents(DOC).roles;
  const [michael, , oscar, hank, angela, seclint] = roles;
  const same = (r) => ({
    model: r.model.value ? modelKey(r.model.value.provider, r.model.value.model) : '', thinking: r.thinking.value ?? '', instruction: r.instruction || r.defaultInstruction || '',
    name: r.name, title: r.title, passKeyword: r.passKeyword ?? '', failKeyword: r.failKeyword ?? '', tools: r.tools,
  });
  assert.deepEqual(buildAgentPatch(same(michael), michael, roles), { body: {} });
  assert.deepEqual(buildAgentPatch({ ...same(michael), model: '', thinking: '' }, michael, roles), { body: { model: null, thinking: null } });
  assert.deepEqual(buildAgentPatch({ ...same(hank), model: '', thinking: 'max' }, hank, roles), { body: { thinking: 'max' } }, 'the pinned model is not sent');
  assert.deepEqual(buildAgentPatch({ ...same(angela), thinking: 'high' }, angela, roles), { body: {} }, 'the pinned thinking level is not sent');
  assert.deepEqual(buildAgentPatch({ ...same(oscar), instruction: 'Review the changes for correctness.' }, oscar, roles), { body: { instruction: null } }, 'the default again is a reset');
  assert.deepEqual(buildAgentPatch({ ...same(oscar), instruction: 'Review the tests too.' }, oscar, roles), { body: { instruction: 'Review the tests too.' } });
  assert.match(buildAgentPatch({ ...same(oscar), instruction: '' }, oscar, roles).error, /Or reset it to the default\./);
  assert.deepEqual(buildAgentPatch({ ...same(seclint), name: 'Lint', tools: ['bash', 'read'], passKeyword: 'LINT_OK' }, seclint, roles),
    { body: { name: 'Lint', passKeyword: 'LINT_OK', tools: ['read', 'bash'] } });
  assert.equal(buildAgentPatch({ ...same(seclint), failKeyword: 'TEST_FAILED' }, seclint, roles).field, 'failKeyword');
  assert.equal(buildAgentPatch({ ...same(seclint), tools: [] }, seclint, roles).field, 'tools');
  assert.equal(buildAgentPatch({ ...same(seclint), instruction: '' }, seclint, roles).field, 'instruction');
});

test('list: built-in and custom agents with kind, keywords, model and prompt source; warnings once and quietly', async () => {
  const h = harness();
  await h.ready();
  assert.equal(h.rows().length, 6);
  const seen = h.rows().map((_, i) => {
    const r = h.row(i);
    return [r.name.textContent, r.title.textContent, r.kind.textContent, r.source.textContent, r.model.textContent];
  });
  assert.deepEqual(seen, [
    ['Michael', 'Orchestrator', 'Planner', 'Built-in', 'openai/gpt-a (set here) \u00b7 thinking high'],
    ['Dwight', 'Developer', '', 'Built-in', 'pi default'],
    ['Oscar', 'Reviewer', 'Gate', 'Built-in', 'pi default'],
    ['Hank', 'Security', 'Gate', 'Built-in', 'anthropic/claude-x (scranton.config.json)'],
    ['Angela', 'QA', 'Gate', 'Built-in', 'pi default \u00b7 thinking low'],
    ['Seclint', 'Lint', 'Gate \u00b7 custom', 'Starter', 'pi default'],
  ]);
  assert.deepEqual(h.row(5).keywords.childNodes.map((c) => c.textContent), ['SECLINT_PASSED', 'SECLINT_FAILED', 'BLOCKED']);
  assert.equal(h.row(5).tools.textContent, 'read \u00b7 grep');
  assert.equal(h.row(5).settings.textContent, 'Settings');
  assert.equal(h.row(5).settings.getAttribute('aria-label'), 'Settings of Seclint');
  assert.equal(h.$('agents-warnings').hidden, false);
  assert.deepEqual(h.$('agents-warnings').childNodes.map((li) => li.textContent), [DOC.warnings[0]]);
  assert.equal(h.$('agents-warnings').getAttribute('aria-live'), null, 'quiet: never announced');
  h.panel.render();
  assert.equal(h.$('agents-warnings').childNodes.length, 1, 'once');
  assert.equal(h.$('create-row').hidden, false);
  assert.equal(globalThis.document.activeElement, h.row(0).edit);

  const clean = harness({ answer: { ...DOC, warnings: undefined } });
  await clean.ready();
  assert.equal(clean.$('agents-warnings').hidden, true);
});

test('new agent: live id check, keyword previews, a counter, tools required, then POST with the control headers', async () => {
  const h = harness();
  await h.ready();
  await h.$('create-open').fire('click');
  assert.equal(h.panel.creating(), true);
  assert.equal(h.$('create-panel').hidden, false);
  assert.equal(h.$('create-open').getAttribute('aria-expanded'), 'true');
  assert.equal(globalThis.document.activeElement, h.$('create-id'));
  assert.equal(h.$('create-pass').placeholder, '<ID>_PASSED');

  await h.type('create-id', 'human', 'create-panel');
  assert.equal(h.$('create-id-hint').textContent, 'human is reserved. Pick another id.');
  assert.equal(h.$('create-id-hint').dataset.tone, 'error');
  assert.equal(h.$('create-id').getAttribute('aria-invalid'), 'true');
  await h.type('create-id', 'docs2', 'create-panel');
  assert.equal(h.$('create-id-hint').dataset.tone, '');
  assert.equal(h.$('create-id').getAttribute('aria-invalid'), null);
  assert.equal(h.$('create-pass').placeholder, 'DOCS2_PASSED');
  assert.equal(h.$('create-fail').placeholder, 'DOCS2_FAILED');
  await h.type('create-name', 'Doris', 'create-panel');
  await h.type('create-role-title', 'Docs', 'create-panel');
  await h.type('create-instruction', 'Check that the docs match the code.', 'create-panel');
  assert.equal(h.$('create-instruction-count').textContent, '35 / 1000');
  for (const t of TOOLS5) await h.check(`create-tool-${t}`, false, 'create-panel');
  await h.$('create-panel').fire('submit');
  assert.deepEqual(h.mutations(), [], 'no tool, nothing sent');
  assert.equal(h.$('create-error').textContent, 'Give the agent at least one tool.');
  assert.equal(globalThis.document.activeElement, h.$('create-tool-read'));
  await h.check('create-tool-read', true, 'create-panel');
  await h.check('create-tool-grep', true, 'create-panel');
  h.$('create-model').value = GPT;
  await h.$('create-panel').fire('submit');

  const [post] = h.mutations();
  assert.deepEqual([post.method, post.url], ['POST', '/api/agents']);
  assert.equal(post.headers['X-Scranton-Client'], '1');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.deepEqual(post.body, { id: 'docs2', name: 'Doris', title: 'Docs', instruction: 'Check that the docs match the code.', tools: ['read', 'grep'], model: PICK });
  assert.equal(h.panel.creating(), false);
  assert.equal(h.rows().length, 7, 'the new agent is listed');
  assert.equal(h.row(6).name.textContent, 'Doris');
  assert.equal(h.$('agents-status').textContent, 'Created Doris. Turn it on for a run under New run, Workflow.');
  assert.equal(globalThis.document.activeElement, h.row(6).settings);
  assert.equal(h.changes.length, 1, 'the New run drawer is told');
});

test('new agent: a 409 for the id and a 400 naming a keyword go to their fields', async () => {
  const h = harness({ fail: { POST: { status: 409, error: 'Agent docs2 already exists' } } });
  await h.ready();
  await h.$('create-open').fire('click');
  for (const [id, v] of [['create-id', 'docs2'], ['create-name', 'Doris'], ['create-role-title', 'Docs'], ['create-instruction', 'Check.']]) await h.type(id, v, 'create-panel');
  await h.$('create-panel').fire('submit');
  assert.equal(h.$('create-error').textContent, 'Agent docs2 already exists');
  assert.equal(h.$('create-id').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.$('create-id'));
  assert.equal(h.panel.creating(), true, 'the form and what was typed stay');
  assert.equal(h.$('create-name').value, 'Doris');

  const k = harness({ fail: { POST: { status: 400, error: 'failKeyword DOCS2_FAILED collides with another agent' } } });
  await k.ready();
  await k.$('create-open').fire('click');
  for (const [id, v] of [['create-id', 'docs2'], ['create-name', 'Doris'], ['create-role-title', 'Docs'], ['create-instruction', 'Check.']]) await k.type(id, v, 'create-panel');
  await k.$('create-panel').fire('submit');
  assert.equal(k.$('create-fail').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, k.$('create-fail'));

  const many = harness({ fail: { POST: { status: 409 } } });
  await many.ready();
  await many.$('create-open').fire('click');
  for (const [id, v] of [['create-id', 'docs2'], ['create-name', 'Doris'], ['create-role-title', 'Docs'], ['create-instruction', 'Check.']]) await many.type(id, v, 'create-panel');
  await many.$('create-panel').fire('submit');
  assert.match(many.$('create-error').textContent, /12 custom agents/);
});

test('settings of a built-in gate: model and thinking with PATCH, the instruction reset to its default', async () => {
  const h = harness();
  await h.ready();
  await h.row(2).settings.fire('click');
  assert.equal(h.panel.settings(), 'oscar');
  assert.equal(h.$('settings-panel').hidden, false);
  assert.equal(h.$('settings-title').textContent, "Oscar's settings");
  assert.equal(h.$('settings-identity').hidden, true, 'a built-in keeps its name, keywords and tools');
  assert.equal(h.$('settings-delete').hidden, true);
  assert.equal(h.$('settings-instruction-row').hidden, false);
  assert.equal(h.$('settings-instruction').value, 'Review only the parser.');
  assert.equal(h.$('settings-instruction-reset').hidden, false, 'it differs from the default');
  assert.equal(h.$('settings-model').value, '');
  assert.equal(h.$('settings-model').childNodes[0].textContent, 'pi default');
  assert.equal(h.$('settings-model').disabled, false);
  assert.equal(globalThis.document.activeElement, h.$('settings-model'));
  assert.equal(h.$('settings-save').disabled, true, 'nothing changed');

  h.$('settings-model').value = GPT;
  await h.$('settings-panel').fire('change', { target: h.$('settings-model') });
  await h.$('settings-instruction-reset').fire('click');
  assert.equal(h.$('settings-instruction').value, 'Review the changes for correctness.');
  assert.equal(h.$('settings-instruction-reset').hidden, true);
  assert.equal(h.$('agents-foot').textContent, 'Unsaved changes');
  await h.$('settings-panel').fire('submit');
  const [patch] = h.mutations();
  assert.deepEqual([patch.method, patch.url], ['PATCH', '/api/agents/oscar']);
  assert.equal(patch.headers['X-Scranton-Client'], '1');
  assert.deepEqual(patch.body, { model: PICK, instruction: null });
  assert.equal(h.panel.settings(), null);
  assert.equal(h.row(2).model.textContent, 'openai/gpt-a (set here)');
  assert.equal(h.$('agents-status').textContent, "Saved Oscar's settings. Runs started from now on use them.");
  assert.equal(globalThis.document.activeElement, h.row(2).settings);
  assert.equal(h.changes.length, 1);
});

test('pinned fields are read only with a note saying who sets them, and are never sent', async () => {
  const h = harness();
  await h.ready();
  await h.row(3).settings.fire('click');
  assert.equal(h.$('settings-model').disabled, true);
  assert.equal(h.$('settings-model-note').hidden, false);
  assert.equal(h.$('settings-model-note').textContent, 'Set by config (agents.hank.model in scranton.config.json), so it is read only here.');
  assert.equal(h.$('settings-model').value, modelKey('anthropic', 'claude-x'));
  assert.match(h.$('settings-model').childNodes.at(-1).textContent, /anthropic\/claude-x \(not in the model list\)/, 'the pinned model is shown though the list lacks it');
  assert.equal(h.$('settings-thinking').disabled, false);
  h.$('settings-thinking').value = 'max';
  await h.$('settings-panel').fire('change', { target: h.$('settings-thinking') });
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations()[0].body, { thinking: 'max' });

  await h.row(4).settings.fire('click');
  assert.equal(h.$('settings-thinking').disabled, true);
  assert.equal(h.$('settings-thinking-note').textContent, 'Set by env (SCRANTON_ANGELA_THINKING), so it is read only here.');

  const refused = harness({ fail: { PATCH: { status: 409, error: 'model is set by SCRANTON_OSCAR_MODEL' } } });
  await refused.ready();
  await refused.row(2).settings.fire('click');
  refused.$('settings-model').value = GPT;
  await refused.$('settings-panel').fire('submit');
  assert.equal(refused.$('settings-error').textContent, 'model is set by SCRANTON_OSCAR_MODEL');
  assert.equal(refused.$('settings-model').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, refused.$('settings-model'));
  assert.equal(refused.panel.settings(), 'oscar', 'the form stays with what was picked');
});

test('settings of a custom agent: name, title, keywords and tools; Delete asks, then sends DELETE', async () => {
  const h = harness();
  await h.ready();
  await h.row(5).settings.fire('click');
  assert.equal(h.$('settings-identity').hidden, false);
  assert.deepEqual([h.$('settings-name').value, h.$('settings-role-title').value, h.$('settings-pass').value, h.$('settings-fail').value],
    ['Seclint', 'Lint', 'SECLINT_PASSED', 'SECLINT_FAILED']);
  assert.deepEqual(TOOLS5.map((t) => h.$(`settings-tool-${t}`).checked), [true, true, false, false, false]);
  assert.equal(h.$('settings-instruction-reset').hidden, true, 'a custom instruction has no default');
  assert.equal(globalThis.document.activeElement, h.$('settings-name'));
  await h.type('settings-role-title', 'Static checks', 'settings-panel');
  await h.type('settings-fail', 'TEST_FAILED', 'settings-panel');
  await h.check('settings-tool-bash', true, 'settings-panel');
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations(), [], 'a built-in keyword is refused here first');
  assert.equal(h.$('settings-fail').getAttribute('aria-invalid'), 'true');
  await h.type('settings-fail', 'SECLINT_BAD', 'settings-panel');
  assert.equal(h.$('settings-fail').getAttribute('aria-invalid'), null);
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations()[0].body, { title: 'Static checks', failKeyword: 'SECLINT_BAD', tools: ['read', 'grep', 'bash'] });
  assert.equal(h.row(5).title.textContent, 'Static checks');

  await h.row(5).settings.fire('click');
  assert.equal(h.$('settings-delete').hidden, false);
  await h.$('settings-delete').fire('click');
  assert.equal(h.confirms.at(-1).title, 'Delete Seclint?');
  assert.equal(h.confirms.at(-1).ok, 'Delete agent');
  assert.equal(h.mutations().some((r) => r.method === 'DELETE'), false, 'nothing is deleted before the confirm');
  const r = await h.confirms.at(-1).action();
  const del = h.mutations().find((x) => x.method === 'DELETE');
  assert.equal(del.url, '/api/agents/seclint');
  assert.equal(del.headers['X-Scranton-Client'], '1');
  assert.equal(h.rows().length, 5);
  assert.equal(h.panel.settings(), null);
  assert.equal(h.$('agents-status').textContent, 'Deleted Seclint. Runs started from now on cannot use it.');
  assert.equal(r.focus, h.$('create-open'));
  assert.equal(h.changes.length, 2);
});

test('the prompt editor works for a custom agent, and resets it to its starter', async () => {
  const h = harness({ answer: { ...DOC, roles: [...DOC.roles.slice(0, 5), custom('seclint', 'Seclint', 'Lint', { prompt: { source: 'custom', text: 'My lint prompt', editable: true, builtinText: 'starter', missingKeywords: [] } })] } });
  await h.ready();
  assert.equal(h.row(5).source.textContent, 'Custom');
  await h.row(5).edit.fire('click');
  assert.equal(h.$('prompt-title').textContent, "Seclint's system prompt");
  assert.equal(h.$('prompt-text').value, 'My lint prompt');
  assert.equal(h.$('prompt-reset').textContent, 'Reset to starter');
  await h.$('prompt-reset').fire('click');
  assert.equal(h.confirms.at(-1).ok, 'Reset to starter');
  await h.confirms.at(-1).action();
  assert.equal(h.mutations()[0].url, '/api/agents/seclint/prompt');
  assert.equal(h.row(5).source.textContent, 'Starter');
});

test('one unsaved guard over every form: closing, Escape and another form ask first', async () => {
  const h = harness();
  await h.ready();
  await h.row(5).settings.fire('click');
  await h.type('settings-name', 'Lintel', 'settings-panel');
  let prevented = false;
  await h.$('agents-dialog').fire('cancel', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'Escape does not close over unsaved settings');
  assert.equal(h.confirms.at(-1).title, "Discard changes to Seclint's settings?");
  await h.row(0).edit.fire('click');
  assert.equal(h.confirms.length, 2, 'another form asks too');
  assert.equal(h.panel.settings(), 'seclint');
  assert.equal(h.$('settings-name').value, 'Lintel', 'until confirmed, the draft stays');
  h.confirms[1].action();
  assert.equal(h.panel.settings(), null);
  assert.equal(h.panel.editing(), 'michael', 'confirmed: the other form opens');

  await h.$('create-open').fire('click');
  assert.equal(h.panel.creating(), true, 'an untouched prompt asks nothing');
  await h.type('create-id', 'docs2', 'create-panel');
  await h.$('create-panel').fire('keydown', { key: 'Escape', stopPropagation() {} });
  assert.equal(h.confirms.at(-1).title, 'Discard the new agent?');
  assert.equal(h.panel.creating(), true);
  await h.close.fire('click');
  assert.equal(h.$('agents-dialog').open, true);
  h.confirms.at(-1).action();
  assert.equal(h.$('agents-dialog').open, false);
  assert.equal(h.mutations().length, 0);
});

test('a settings reply that arrives after the drawer was closed and reopened acts on nothing', async () => {
  const h = harness();
  await h.ready();
  await h.row(2).settings.fire('click');
  h.$('settings-model').value = GPT;
  h.hold.PATCH = true;
  const saving = h.$('settings-panel').fire('submit');
  await h.tick();
  assert.equal(h.$('settings-status').textContent, 'Saving...');
  await h.close.fire('click');
  h.confirms.at(-1).action();
  h.hold.PATCH = false;
  h.panel.open();
  await h.tick();
  await h.row(5).settings.fire('click');
  await h.type('settings-name', 'Lintel', 'settings-panel');
  h.hold.release();
  await saving;
  await h.tick();
  assert.equal(h.panel.settings(), 'seclint', 'the other form stays open');
  assert.equal(h.$('settings-name').value, 'Lintel');
  assert.equal(h.$('agents-status').textContent, '', "no \"Saved Oscar's settings\" for a drawer that is gone");
  assert.equal(h.$('settings-save').disabled, false, 'the new form is not left busy');
  assert.equal(h.row(2).model.textContent, 'openai/gpt-a (set here)', 'the reopened rows learn about the save');
});

test('every request carries the control header; nothing is stored or logged; no control hides the drawer', async (t) => {
  const writes = [];
  globalThis.localStorage = { getItem: () => null, setItem: (k, v) => writes.push([k, v]) };
  const logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, m, (...a) => logged.push(a));
  const h = harness();
  await h.ready();
  await h.row(5).settings.fire('click');
  await h.type('settings-instruction', 'Secret handoff text', 'settings-panel');
  await h.$('settings-panel').fire('submit');
  await h.row(5).edit.fire('click');
  h.$('prompt-text').value = 'Secretive prompt';
  await h.$('prompt-text').fire('input');
  await h.$('prompt-panel').fire('submit');
  assert.ok(h.requests.length >= 5);
  for (const r of h.requests) assert.equal(r.headers['X-Scranton-Client'], '1', `${r.method} ${r.url}`);
  assert.deepEqual(writes, []);
  assert.deepEqual(logged, []);
  delete globalThis.localStorage;

  await h.row(5).settings.fire('click');
  await h.type('settings-name', 'half written', 'settings-panel');
  h.on.value = false;
  h.panel.render();
  assert.equal(h.$('agents-dialog').open, false);
  assert.equal(h.$('agents-open').hidden, true);
  assert.equal(h.panel.settings(), null);
});

test('up to 17 agents: all listed, New agent stops at 12 custom ones, and the list scrolls inside the drawer', async () => {
  const extra = Array.from({ length: CUSTOM_MAX - 1 }, (_, i) => custom(`gate${i}`, `Gate ${i}`, `Check ${i}`));
  const h = harness({ answer: { ...DOC, roles: [...DOC.roles, ...extra] } });
  await h.ready();
  assert.equal(h.rows().length, 17);
  assert.equal(h.$('create-open').disabled, true);
  assert.equal(h.$('create-limit').hidden, false);
  assert.match(h.$('create-limit').textContent, /^12 custom agents is the most/);
  await h.$('create-open').fire('click');
  assert.equal(h.panel.creating(), false);
  const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === sel)?.[2] ?? '';
  assert.match(rule('.drawer-body'), /overflow:\s*auto/);
  assert.match(rule('.drawer-body'), /min-height:\s*0/);
  assert.match(rule('.gate-list'), /overflow:\s*auto/, 'the stage editor scrolls too');
});

const DEVICES = ['con', 'prn', 'aux', 'nul', ...Array.from({ length: 10 }, (_, i) => `com${i}`), ...Array.from({ length: 10 }, (_, i) => `lpt${i}`)];

test('idProblem: Windows device names are refused, and an id is refused here exactly when the server refuses it', () => {
  for (const d of DEVICES) assert.equal(idProblem(d, []), `${d} is a Windows device name. Pick another id.`, d);
  const serverRefuses = (id) => {
    try {
      validateAgentId(id, true);
      return false;
    } catch {
      return true;
    }
  };
  const near = ['com10', 'lpt10', 'conx', 'nul2x', 'console', 'auxx', 'prn1a', 'docs2', 'seclint', 'ab', 'a1', 'x'.repeat(20)];
  for (const id of [...RESERVED_IDS, ...DEVICES, ...near]) assert.equal(Boolean(idProblem(id, [])), serverRefuses(id), id);
});

test('new agent: a device name is marked as typed and never posted', async () => {
  const h = harness();
  await h.ready();
  await h.$('create-open').fire('click');
  await h.type('create-id', 'lpt1', 'create-panel');
  assert.equal(h.$('create-id-hint').textContent, 'lpt1 is a Windows device name. Pick another id.');
  assert.equal(h.$('create-id').getAttribute('aria-invalid'), 'true');
  for (const [id, v] of [['create-name', 'Lp'], ['create-role-title', 'Printer'], ['create-instruction', 'Check.']]) await h.type(id, v, 'create-panel');
  await h.$('create-panel').fire('submit');
  assert.deepEqual(h.mutations(), []);
  assert.equal(globalThis.document.activeElement, h.$('create-id'));
});

// Windows without bash: the server reports the custom agent's bash as powershell (section 11.7)
const PS = { ...DOC, roles: [...DOC.roles.slice(0, 5), custom('seclint', 'Seclint', 'Lint', { tools: ['read', 'grep', 'powershell'] })] };

test('settings: a powershell tool is the bash box, and powershell is never sent', async () => {
  const roles = parseAgents(PS).roles;
  const seclint = roles[5];
  const form = { model: '', thinking: '', instruction: seclint.instruction, name: 'Seclint', title: 'Lint', passKeyword: 'SECLINT_PASSED', failKeyword: 'SECLINT_FAILED' };
  assert.deepEqual(buildAgentPatch({ ...form, tools: ['read', 'grep', 'bash'] }, seclint, roles), { body: {} }, 'the same tools are no change');
  assert.deepEqual(buildAgentPatch({ ...form, tools: ['read', 'bash'] }, seclint, roles), { body: { tools: ['read', 'bash'] } });
  assert.deepEqual(buildAgentPatch({ ...form, tools: ['read', 'grep'] }, seclint, roles), { body: { tools: ['read', 'grep'] } }, 'unchecking bash drops it');

  const h = harness({ answer: PS });
  await h.ready();
  assert.equal(h.row(5).tools.textContent, 'read \u00b7 grep \u00b7 powershell', 'the row says what runs');
  await h.row(5).settings.fire('click');
  assert.deepEqual(TOOLS5.map((t) => h.$(`settings-tool-${t}`).checked), [true, true, false, false, true], 'bash is checked');
  assert.equal(h.$('settings-save').disabled, true, 'nothing changed');
  await h.type('settings-role-title', 'Static checks', 'settings-panel');
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations()[0].body, { title: 'Static checks' }, 'another field alone leaves the tools alone');

  await h.row(5).settings.fire('click');
  await h.check('settings-tool-grep', false, 'settings-panel');
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations()[1].body, { tools: ['read', 'bash'] }, 'a tool edit keeps bash');
  for (const m of h.mutations()) assert.equal(JSON.stringify(m.body).includes('powershell'), false);
});

test('the handoff instruction keeps its line breaks from the server to the form and back (section 11.2)', async () => {
  const MULTI = 'Check the lint rules.\nThen the naming.\n\n- no default exports';
  const h = harness({ answer: { ...DOC, roles: [...DOC.roles.slice(0, 5), custom('seclint', 'Seclint', 'Lint', { instruction: MULTI })] } });
  await h.ready();
  await h.row(5).settings.fire('click');
  assert.equal(h.$('settings-instruction').value, MULTI);
  assert.equal(h.$('settings-save').disabled, true);
  // a textarea may hand the text back with CRLF: line endings alone are no change
  await h.type('settings-instruction', MULTI.replace(/\n/g, '\r\n'), 'settings-panel');
  await h.type('settings-role-title', 'Static', 'settings-panel');
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations()[0].body, { title: 'Static' });

  await h.row(5).settings.fire('click');
  await h.type('settings-instruction', 'Check the lint rules.\r\nThen the naming.\r\n\r\n- no default exports\r\n- no any\r\n', 'settings-panel');
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations()[1].body, { instruction: 'Check the lint rules.\nThen the naming.\n\n- no default exports\n- no any' });
  await h.row(5).settings.fire('click');
  assert.equal(h.$('settings-instruction').value, 'Check the lint rules.\nThen the naming.\n\n- no default exports\n- no any', 'the saved text comes back with its lines');
  await h.$('settings-cancel').fire('click');

  // a built-in gate's own instruction
  await h.row(2).settings.fire('click');
  await h.type('settings-instruction', 'Review the parser.\nThen the tests.', 'settings-panel');
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations()[2].body, { instruction: 'Review the parser.\nThen the tests.' });

  // and a new agent
  await h.$('create-open').fire('click');
  for (const [id, v] of [['create-id', 'docs2'], ['create-name', 'Doris'], ['create-role-title', 'Docs'], ['create-instruction', 'Line one.\r\n\r\nLine two.']]) await h.type(id, v, 'create-panel');
  assert.equal(h.$('create-instruction-count').textContent, '20 / 1000', 'a line break counts once, as the server counts it');
  await h.$('create-panel').fire('submit');
  assert.equal(h.mutations()[3].body.instruction, 'Line one.\n\nLine two.');
});

test('thinking levels: the server\'s list from GET /api/control, else the built-in one', async () => {
  assert.deepEqual(parseControl({ v: 1, enabled: true, defaults: { thinkingLevels: ['off', 'high', 'turbo', 7, 'Bad'] } }).thinkingLevels, ['off', 'high', 'turbo']);
  assert.equal(parseControl({ v: 1, enabled: true, defaults: {} }).thinkingLevels, null, 'not reported');
  assert.equal(parseControl({ v: 1, enabled: true, defaults: { thinkingLevels: [] } }).thinkingLevels, null);
  assert.equal(parseAgents(DOC).thinkingLevels, null, 'GET /api/agents does not report them');

  const options = (h) => h.$('settings-thinking').childNodes.map((o) => o.value);
  const h = harness({ control: parseControl({ v: 1, enabled: true, defaults: { thinkingLevels: ['off', 'high', 'turbo'] } }) });
  await h.ready();
  await h.row(2).settings.fire('click');
  assert.deepEqual(options(h), ['', 'off', 'high', 'turbo']);
  h.$('settings-thinking').value = 'turbo';
  await h.$('settings-panel').fire('change', { target: h.$('settings-thinking') });
  await h.$('settings-panel').fire('submit');
  assert.deepEqual(h.mutations()[0].body, { thinking: 'turbo' }, 'a level the server lists is sent');

  // a roles document that lists its own levels wins
  const own = harness({ answer: { ...DOC, thinkingLevels: ['off', 'low'] }, control: parseControl({ v: 1, enabled: true, defaults: { thinkingLevels: ['off', 'high'] } }) });
  await own.ready();
  await own.row(2).settings.fire('click');
  assert.deepEqual(options(own), ['', 'off', 'low']);

  const older = harness();
  await older.ready();
  await older.row(2).settings.fire('click');
  assert.deepEqual(options(older), ['', ...THINKING_LEVELS], 'an older server: the built-in list');
});

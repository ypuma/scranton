// User orders win (.enma/user-orders-contract.md sections 2-5): a request_access call waits as an approval card
// with Allow read / Allow write / Deny and its warnings, the run drawer sends the permission mode, and the reducer
// and the run panel keep the grants and the writes outside the project. Paths are text, never markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduceAll, createState, ACCESS_MAX } from '../../visualizer/public/js/state.js';
import {
  accessCard, accessView, decisionText, PERMISSION_HINT, PERMISSIONS, UNDO_WARNING, PROTECTED_WARNING,
} from '../../visualizer/public/js/access.js';
import { parseApprovals, callView, askedText, buildVerdict, verdictText } from '../../visualizer/public/js/approvals.js';
import { createApprovals } from '../../visualizer/public/js/approval-panel.js';
import { buildRunRequest, parseControl, permissionsDefault, errorField } from '../../visualizer/public/js/control.js';
import { teamRunView } from '../../visualizer/public/js/activity-model.js';
import { createRunRail } from '../../visualizer/public/js/run-rail.js';
import { installTree, all } from './fixtures/tree-dom.js';
import { harness as drawer, fakeStorage, CONTROL } from './fixtures/run-drawer.js';

const NOW = Date.parse('2026-11-23T10:00:00.000Z');
const at = (s) => new Date(NOW + s * 1000).toISOString();
const SCRIPT = 'C:\\Users\\me\\<script>alert(1)</script>\\notes';
let seq = 0;
const ev = (type, fields = {}) => ({ type, runId: 'r1', seq: ++seq, ts: at(seq), ...fields });

function stream() {
  seq = 0;
  return [
    ev('run_started', { request: 'Look in ~/Documents', workspace: 'C:\\ws\\app', permissions: 'ask' }),
    ev('instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
    ev('access_request', { instanceId: 'dwight-m1', agent: 'dwight', path: 'C:\\Users\\me\\Documents', mode: 'read', reason: 'The human said: look in Documents', protected: null }),
    ev('access_decision', { instanceId: 'dwight-m1', path: 'C:\\Users\\me\\Documents', mode: 'read', decision: 'granted', by: 'order', quote: 'Look in ~/Documents', permissions: 'ask' }),
    ev('access_request', { instanceId: 'dwight-m1', agent: 'dwight', path: 'C:\\Users\\me\\Desktop\\out', mode: 'write', reason: 'Save the report', protected: null }),
    ev('access_decision', { instanceId: 'dwight-m1', path: 'C:\\Users\\me\\Desktop\\out', mode: 'read', decision: 'granted', by: 'human', quote: null, permissions: 'ask' }),
    ev('access_request', { instanceId: 'dwight-m1', agent: 'dwight', path: 'C:\\Users\\me\\.ssh', mode: 'read', reason: 'keys', protected: 'credentials' }),
    ev('access_decision', { instanceId: 'dwight-m1', path: 'C:\\Users\\me\\.ssh', mode: 'read', decision: 'denied', by: 'timeout', quote: null, permissions: 'ask' }),
    ev('access_request', { instanceId: 'dwight-m1', agent: 'dwight', path: SCRIPT, mode: 'write', reason: '<b>why</b>', protected: null }),
    ev('outside_write', { instanceId: 'dwight-m1', path: 'C:\\Users\\me\\Desktop\\out\\a.md' }),
    ev('outside_write', { instanceId: 'dwight-m1', path: 'C:\\Users\\me\\Desktop\\out\\b.md' }),
    ev('outside_write', { instanceId: 'dwight-m1', path: 'C:\\Users\\me\\Desktop\\out\\a.md' }),
  ];
}

test('reducer: requests, decisions (an order with its quote, a narrowed write, a timeout), outside writes and the mode', () => {
  const s = reduceAll(stream());
  assert.equal(s.permissions, 'ask');
  assert.deepEqual(s.access.map((r) => [r.path, r.mode, r.status, r.grant, r.by, r.quote, r.protected]), [
    ['C:\\Users\\me\\Documents', 'read', 'granted', 'read', 'order', 'Look in ~/Documents', null],
    ['C:\\Users\\me\\Desktop\\out', 'write', 'granted', 'read', 'human', '', null],
    ['C:\\Users\\me\\.ssh', 'read', 'denied', null, 'timeout', '', 'credentials'],
    [SCRIPT, 'write', 'pending', null, null, '', null],
  ]);
  assert.equal(s.access[0].agent, 'dwight');
  assert.deepEqual(s.outsideWrites.map((w) => w.path), ['C:\\Users\\me\\Desktop\\out\\b.md', 'C:\\Users\\me\\Desktop\\out\\a.md'], 'each path once, newest last');
  assert.equal(s.outsideWriteCount, 2);

  const log = s.log.filter((l) => l.type.startsWith('access_') || l.type === 'outside_write');
  assert.deepEqual(log.map((l) => [l.type, l.tone, l.category]), [
    ['access_request', 'warn', 'results'], ['access_decision', 'good', 'results'],
    ['access_request', 'warn', 'results'], ['access_decision', 'good', 'results'],
    ['access_request', 'warn', 'results'], ['access_decision', 'warn', 'results'],
    ['access_request', 'warn', 'results'],
    ['outside_write', 'warn', 'tools'], ['outside_write', 'warn', 'tools'], ['outside_write', 'warn', 'tools'],
  ]);
  assert.equal(log[0].text, 'Dwight asks to read outside the project: C:\\Users\\me\\Documents - The human said: look in Documents');
  assert.equal(log[1].text, 'Access granted: read C:\\Users\\me\\Documents (you asked for it) \u00b7 "Look in ~/Documents"');
  assert.equal(log[4].text, 'Dwight asks to read outside the project: C:\\Users\\me\\.ssh (protected: credentials) - keys');
  assert.equal(log[5].text, 'Access denied: read C:\\Users\\me\\.ssh (no answer in time)');
  assert.equal(log[7].text, 'Wrote outside the project, not covered by undo: C:\\Users\\me\\Desktop\\out\\a.md');
  assert.ok(log[6].text.includes(SCRIPT), 'the path stays the text it was');

  // a decision without a request of its own (granted at once) still lists
  seq = 0;
  const alone = reduceAll([ev('run_started', { request: 'x' }), ev('access_decision', { instanceId: 'angela-m1', path: '/home/me/Music', mode: 'read', decision: 'granted', by: 'mode', permissions: 'auto' })]);
  assert.deepEqual(alone.access.map((r) => [r.agent, r.path, r.status, r.by]), [['angela', '/home/me/Music', 'granted', 'mode']]);
  assert.equal(alone.permissions, 'auto', 'the decision names the mode of a run_started that did not');
});

test('reducer: an old stream has no access, no mode and no run panel section; a state from before the fields still takes them', () => {
  seq = 0;
  const old = reduceAll([ev('run_started', { request: 'x' }), ev('agent_tool', { agent: 'dwight', tool: 'write', detail: 'a.js' }), ev('run_finished', { status: 'success', summary: 'ok' })]);
  assert.equal(old.permissions, null);
  assert.deepEqual([old.access, old.outsideWrites, old.outsideWriteCount], [[], [], 0]);
  assert.equal(accessView(old), null);
  assert.equal(teamRunView({ state: old }).access, null);
  assert.equal(teamRunView({ state: null }).access, null);
  assert.equal(accessView({}), null);

  const before = createState();
  for (const k of ['permissions', 'access', 'outsideWrites', 'outsideWriteCount']) delete before[k];
  seq = 0;
  const s = reduceAll([ev('run_started', { request: 'x' }), ev('access_request', { instanceId: 'dwight-m1', path: '/tmp/x', mode: 'read', reason: 'r' }), ev('outside_write', { path: '/tmp/x/y' })], before);
  assert.equal(s.access.length, 1);
  assert.equal(s.outsideWriteCount, 1);
  // junk is no request mode, no decision and no write
  const junk = reduceAll([ev('access_decision', { path: '/x', decision: 'maybe' }), ev('outside_write', { path: 7 }), ev('access_request', { path: '/y', mode: 'delete', protected: 'yes' })], s);
  assert.deepEqual(junk.access.map((r) => [r.path, r.mode, r.protected]), [['/tmp/x', 'read', null], ['/y', 'read', null]]);
  assert.equal(junk.outsideWriteCount, 1);
});

test('reducer: the lists are bounded', () => {
  seq = 0;
  const events = [ev('run_started', { request: 'x' })];
  for (let i = 0; i < ACCESS_MAX + 5; i += 1) events.push(ev('access_request', { instanceId: 'dwight-m1', path: `/p/${i}`, mode: 'read', reason: 'r' }));
  const s = reduceAll(events);
  assert.equal(s.access.length, ACCESS_MAX);
  assert.equal(s.access[0].path, '/p/5');
});

const item = (over = {}) => ({
  workflowId: 'scr:p/c/r1/dwight-m1/m1:1', step: 'tool:2:0', runId: 'r1', instanceId: 'dwight-m1', agent: 'dwight', callId: 'call_a',
  tool: 'request_access', args: { path: '~/Documents', mode: 'read', reason: 'The human asked for it' }, timeoutSeconds: 600, deadline: at(300), ...over,
});

test('accessCard: read, write with the undo warning, protected paths; the resolved path from the event wins', () => {
  assert.deepEqual(accessCard(item()), {
    mode: 'read', path: '~/Documents', asked: '', reason: 'The human asked for it', protected: null, warnings: [], grants: ['read'],
  });
  const write = accessCard(item({ args: { path: 'D:\\out', mode: 'write', reason: 'save' } }));
  assert.deepEqual([write.grants, write.warnings], [['read', 'write'], [UNDO_WARNING]]);
  assert.equal(UNDO_WARNING, 'Changes outside the project are not covered by undo.');

  seq = 0;
  const state = reduceAll([
    ev('run_started', { request: 'x' }),
    ev('access_request', { instanceId: 'dwight-m1', agent: 'dwight', path: 'C:\\Users\\me\\Documents', mode: 'read', reason: 'r', protected: null }),
    ev('access_request', { instanceId: 'angela-m1', agent: 'angela', path: 'C:\\Users\\me\\.aws', mode: 'read', reason: 'r', protected: 'credentials' }),
  ]);
  const resolved = accessCard(item(), state);
  assert.deepEqual([resolved.path, resolved.asked], ['C:\\Users\\me\\Documents', '~/Documents']);
  const creds = accessCard(item({ instanceId: 'angela-m1', args: { path: '~/.aws', mode: 'read', reason: 'r' } }), state);
  assert.deepEqual([creds.protected, creds.warnings], ['credentials', [PROTECTED_WARNING.credentials]]);
  // the listing may flag it itself; writing to Scranton's own state is never offered
  const own = accessCard(item({ protected: 'scranton-state', args: { path: 'C:\\hive', mode: 'write', reason: 'r' } }));
  assert.deepEqual([own.grants, own.warnings], [['read'], [UNDO_WARNING, PROTECTED_WARNING['scranton-state']]]);
  assert.equal(accessCard(item({ args: {} })).path, '(no path given)');
  assert.equal(accessCard(item({ args: { path: '/x' } })).reason, '(no reason given)');
  assert.equal(parseApprovals({ approvals: [item({ protected: 'credentials' }), item({ callId: 'b', protected: 'nope' })] }).map((a) => a.protected).join(), 'credentials,');
});

test('verdict bodies: the grant of request_access, narrowed to read unless write was asked; other tools send none', () => {
  const read = item();
  const write = item({ args: { path: 'D:\\out', mode: 'write', reason: 'save' } });
  const base = { workflowId: read.workflowId, callId: 'call_a' };
  assert.deepEqual(buildVerdict(read, true, 'read').body, { ...base, approved: true, grant: 'read' });
  assert.deepEqual(buildVerdict(read, true, 'write').body, { ...base, approved: true, grant: 'read' }, 'write is never more than was asked');
  assert.deepEqual(buildVerdict(write, true, 'write').body, { ...base, approved: true, grant: 'write' });
  assert.deepEqual(buildVerdict(write, true, 'read').body, { ...base, approved: true, grant: 'read' });
  assert.deepEqual(buildVerdict(write, false, 'write').body, { ...base, approved: false });
  assert.deepEqual(buildVerdict(item({ tool: 'bash', args: { command: 'ls' } }), true, 'write').body, { ...base, approved: true });
  assert.deepEqual([verdictText('read'), verdictText('write'), verdictText(true), verdictText(false)], [
    'Read access allowed - the agent goes on', 'Write access allowed - the agent goes on', 'Approved - the agent goes on', 'Denied - the agent is told so',
  ]);
  assert.deepEqual(callView(write), { title: 'Change files outside the project', label: 'Path', text: 'D:\\out' });
  assert.equal(askedText(read), 'Approval needed: Dwight \u00b7 dwight-m1 wants to read files outside the project: ~/Documents');
});

function manualTimers() {
  let n = 0;
  const due = new Map();
  return {
    setTimeout(fn) { n += 1; due.set(n, fn); return n; },
    clearTimeout(id) { due.delete(id); },
    tick() { for (const [id, fn] of [...due]) { due.delete(id); fn(); } },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

function panel(list, state = null) {
  const $ = installTree();
  const posts = [];
  const fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ approvals: list }) };
  };
  const said = [];
  const p = createApprovals({
    url: () => '/api/projects/p/chats/c/approvals', wanted: () => true, getState: () => state, announce: (t) => said.push(t),
    fetch, timers: manualTimers(), now: () => NOW,
  });
  const find = (card, cls) => all(card).find((n) => ` ${n.className} `.includes(` ${cls} `));
  const button = (card, v) => card.querySelector(`button[data-verdict="${v}"]`);
  return { $, p, posts, said, find, button, cards: () => $('approvals-list').children };
}

test('card states: a read request offers Allow read and Deny, a write request Allow write too with the undo warning', async () => {
  const h = panel([item(), item({ callId: 'call_b', step: 'tool:3:0', args: { path: 'D:\\out', mode: 'write', reason: 'save the report' } })]);
  h.p.sync();
  await flush();
  const [read, write] = h.cards();
  assert.equal(h.find(read, 'approval-title').textContent, 'Read files outside the project');
  assert.equal(h.find(read, 'approval-args').textContent, '~/Documents');
  assert.equal(h.find(read, 'approval-reason').textContent, 'The human asked for it');
  assert.equal(h.find(read, 'approval-who').textContent, 'Dwight \u00b7 dwight-m1');
  assert.deepEqual(['approve', 'read', 'write', 'deny'].map((v) => h.button(read, v).hidden), [true, false, true, false]);
  assert.equal(h.find(read, 'approval-warnings').hidden, true);
  assert.equal(h.button(read, 'read').className, 'btn btn-primary');

  assert.equal(h.find(write, 'approval-title').textContent, 'Change files outside the project');
  assert.deepEqual(['approve', 'read', 'write', 'deny'].map((v) => h.button(write, v).hidden), [true, false, false, false]);
  assert.deepEqual([h.button(write, 'read').textContent, h.button(write, 'write').textContent, h.button(write, 'deny').textContent], ['Allow read', 'Allow write', 'Deny']);
  assert.equal(h.button(write, 'write').className, 'btn btn-primary', 'what was asked leads');
  assert.equal(h.find(write, 'approval-warnings').hidden, false);
  assert.deepEqual(h.find(write, 'approval-warnings').children.map((n) => n.textContent), [UNDO_WARNING]);
  assert.match(h.said[0], /wants to read files outside the project: ~\/Documents .*wants to change files outside the project: D:\\out/);

  // a plain tool call keeps its Approve and no access parts
  const plain = panel([item({ tool: 'bash', args: { command: 'npm test' } })]);
  plain.p.sync();
  await flush();
  const c = plain.cards()[0];
  assert.deepEqual(['approve', 'read', 'write', 'deny'].map((v) => plain.button(c, v).hidden), [false, true, true, false]);
  assert.equal(plain.find(c, 'approval-reason').hidden, true);
});

test('decision bodies from the card: Allow write, Allow read on a write request, Deny', async () => {
  const write = (callId) => item({ callId, step: `tool:${callId}`, args: { path: 'D:\\out', mode: 'write', reason: 'save' } });
  const h = panel([write('w1'), write('w2'), write('w3')]);
  h.p.sync();
  await flush();
  const [a, b, c] = h.cards();
  await h.button(a, 'write').click();
  await flush();
  await h.button(b, 'read').click();
  await flush();
  await h.button(c, 'deny').click();
  await flush();
  const base = { workflowId: item().workflowId };
  assert.deepEqual(h.posts, [
    { ...base, callId: 'w1', approved: true, grant: 'write' },
    { ...base, callId: 'w2', approved: true, grant: 'read' },
    { ...base, callId: 'w3', approved: false },
  ]);
  assert.deepEqual([a, b, c].map((x) => h.find(x, 'approval-status').textContent), [
    'Write access allowed - the agent goes on', 'Read access allowed - the agent goes on', 'Denied - the agent is told so',
  ]);
});

test('protected paths: the warning from the event, and no Allow write on Scranton\'s own state', async () => {
  seq = 0;
  const state = reduceAll([
    ev('run_started', { request: 'x' }),
    ev('access_request', { instanceId: 'dwight-m1', agent: 'dwight', path: 'C:\\Users\\me\\.ssh', mode: 'read', reason: 'keys', protected: 'credentials' }),
  ]);
  const h = panel([item({ args: { path: '~/.ssh', mode: 'read', reason: 'keys' } })], state);
  h.p.sync();
  await flush();
  const card = h.cards()[0];
  assert.equal(card.dataset.protected, 'credentials');
  assert.equal(h.find(card, 'approval-args').textContent, 'C:\\Users\\me\\.ssh');
  assert.equal(h.find(card, 'approval-asked').textContent, 'Asked for as ~/.ssh');
  assert.deepEqual(h.find(card, 'approval-warnings').children.map((n) => n.textContent), [PROTECTED_WARNING.credentials]);

  const own = panel([item({ protected: 'scranton-state', args: { path: 'C:\\app\\hive', mode: 'write', reason: 'r' } })]);
  own.p.sync();
  await flush();
  const o = own.cards()[0];
  assert.equal(own.button(o, 'write').hidden, true);
  assert.deepEqual(own.find(o, 'approval-warnings').children.map((n) => n.textContent), [UNDO_WARNING, PROTECTED_WARNING['scranton-state']]);
});

test('a path or reason with <script> is plain text on the card and in the run panel', async () => {
  const h = panel([item({ args: { path: SCRIPT, mode: 'write', reason: '<img src=x onerror=alert(1)>' } })]);
  h.p.sync();
  await flush();
  const card = h.cards()[0];
  assert.equal(h.find(card, 'approval-args').textContent, SCRIPT);
  assert.equal(h.find(card, 'approval-reason').textContent, '<img src=x onerror=alert(1)>');
  assert.ok(all(card).every((n) => !['SCRIPT', 'IMG'].includes(n.tagName)), 'model text is never markup');

  const $ = installTree();
  globalThis.localStorage = fakeStorage();
  const rail = createRunRail({ viewMode: () => 'chat', openBoard() {}, media: { matches: true, addEventListener() {} } });
  const events = stream();
  events.push(ev('outside_write', { instanceId: 'dwight-m1', path: SCRIPT }));
  rail.render(teamRunView({ state: reduceAll(events) }));
  assert.equal($('rail-access').hidden, false);
  const items = $('rail-access-list').children;
  assert.ok(items.some((li) => li.textContent.includes(SCRIPT)));
  assert.ok($('rail-writes').children.some((li) => li.textContent === SCRIPT));
  assert.ok(all($('rail-access')).every((n) => !['SCRIPT', 'B', 'IMG'].includes(n.tagName)));
  const js = ['access.js', 'approval-panel.js', 'run-rail.js'].map((f) => readFileSync(new URL(`../../visualizer/public/js/${f}`, import.meta.url), 'utf8'));
  for (const text of js) assert.doesNotMatch(text, /innerHTML|insertAdjacentHTML/);
});

test('run panel: the grants with who decided and the quote, the outside writes, and the mode', () => {
  const v = accessView(reduceAll(stream()));
  assert.equal(v.label, 'Permissions: Ask');
  assert.deepEqual(v.entries.map((x) => [x.path, x.line, x.quote]), [
    ['C:\\Users\\me\\Documents', 'Read \u00b7 granted: you asked for it \u00b7 Dwight', 'Look in ~/Documents'],
    ['C:\\Users\\me\\Desktop\\out', 'Read (write was asked) \u00b7 allowed by you \u00b7 Dwight', ''],
    ['C:\\Users\\me\\.ssh', 'Read \u00b7 denied: no answer in time \u00b7 Dwight \u00b7 protected: credentials', ''],
    [SCRIPT, 'Write \u00b7 waiting for your answer \u00b7 Dwight', ''],
  ]);
  assert.equal(v.writeCount, 2);
  assert.equal(decisionText('granted', 'mode', 'auto'), 'granted by the permission mode (Auto-approve)');
  assert.equal(decisionText('denied', 'human'), 'denied by you');
  assert.equal(decisionText('denied', 'mode'), 'refused: read-only role or Scranton state');
  seq = 0;
  const refused = reduceAll([ev('run_started', { request: 'x' }), ev('access_request', { instanceId: 'angela-m1', agent: 'angela', path: '/srv/x', mode: 'write', reason: 'r' }),
    ev('access_decision', { instanceId: 'angela-m1', path: '/srv/x', mode: 'write', decision: 'denied', by: 'mode', quote: null, permissions: 'bypass' })]);
  assert.equal(refused.log.at(-1).text, 'Access refused: write /srv/x');

  const $ = installTree();
  globalThis.localStorage = fakeStorage();
  const rail = createRunRail({ viewMode: () => 'chat', openBoard() {}, media: { matches: true, addEventListener() {} } });
  rail.render(teamRunView({ state: reduceAll(stream()) }));
  assert.equal($('rail-access-aside').textContent, 'Permissions: Ask');
  const first = $('rail-access-list').children[0];
  assert.deepEqual(first.children.map((n) => [n.tagName, n.textContent]), [
    ['SPAN', 'C:\\Users\\me\\Documents'], ['SPAN', 'Read \u00b7 granted: you asked for it \u00b7 Dwight'], ['Q', 'Look in ~/Documents'],
  ]);
  assert.equal($('rail-access-list').children[2].dataset.status, 'denied');
  assert.equal($('rail-writes-title').textContent, '2 files written outside the project, not covered by undo');
  assert.deepEqual($('rail-writes').children.map((n) => n.textContent), ['C:\\Users\\me\\Desktop\\out\\b.md', 'C:\\Users\\me\\Desktop\\out\\a.md']);
  // a run without any of it shows no section
  seq = 0;
  rail.render(teamRunView({ state: reduceAll([ev('run_started', { request: 'x' })]) }));
  assert.equal($('rail-access').hidden, true);
});

test('start body: permissions as picked, checked, never for a demo, and absent from an older form', () => {
  const control = parseControl({ ...CONTROL });
  const form = { request: 'Build it' };
  for (const p of PERMISSIONS) assert.equal(buildRunRequest({ ...form, permissions: p }, control).body.permissions, p);
  assert.equal(buildRunRequest(form, control).body.permissions, undefined);
  assert.deepEqual(buildRunRequest({ ...form, permissions: 'yolo' }, control), { error: 'Pick Ask, Auto-approve or Bypass for the permissions.', field: 'permissions' });
  assert.equal(buildRunRequest({ demo: true, scenario: 'happy', permissions: 'bypass' }, parseControl({ ...CONTROL, scenarios: ['happy'] })).body.permissions, undefined);
  assert.equal(errorField('Invalid permissions'), 'permissions');
  assert.equal(permissionsDefault(control), 'ask');
  assert.equal(permissionsDefault(parseControl({ ...CONTROL, defaults: { permissions: 'auto' } })), 'auto');
  assert.equal(permissionsDefault(parseControl({ ...CONTROL, defaults: { execution: { permissions: 'bypass' } } })), 'bypass');
  assert.equal(permissionsDefault(parseControl({ ...CONTROL, defaults: { permissions: 'all' } })), 'ask');
  assert.equal(parseControl(null).permissions, null);
});

test('drawer: Ask by default, the configured mode preselected, the pick sent and carried by a follow-up, off for a demo', async (t) => {
  const h = drawer();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('f-permissions-ask').checked, true);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[0].body.permissions, 'ask');

  await h.open();
  h.$('f-permissions-ask').checked = false;
  h.$('f-permissions-bypass').checked = true;
  await h.$('f-permissions-bypass').fire('change');
  assert.match(h.$('run-options-summary').textContent, /bypasses permissions/);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[1].body.permissions, 'bypass');
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true });
  assert.equal(h.posts[2].body.permissions, 'bypass', 'a follow-up starts with the same choice');

  await h.open();
  h.$('f-demo').checked = true;
  await h.$('f-demo').fire('change');
  assert.equal(h.$('f-permissions-bypass').disabled, true);

  const configured = drawer({ control: { ...CONTROL, defaults: { permissions: 'auto' } } });
  t.after(() => configured.panel.setMode('demo'));
  await configured.open();
  assert.equal(configured.$('f-permissions-auto').checked, true);
  assert.equal(configured.$('f-permissions-ask').checked, false);
  assert.match(configured.$('run-options-summary').textContent, /auto-approves access/);
});

test('page: the permission radios beside the sandbox with the contract hints, the run panel section, no hue', () => {
  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  const exec = html.slice(html.indexOf('id="exec-fields"'), html.indexOf('id="model-fields"'));
  assert.ok(exec.indexOf('id="f-sandbox"') < exec.indexOf('id="f-permissions"'), 'in the Execution fields, after the sandbox');
  assert.match(exec, /<input type="radio" name="permissions" value="ask" id="f-permissions-ask" checked>/);
  for (const [p, label] of [['ask', 'Ask'], ['auto', 'Auto-approve'], ['bypass', 'Bypass']]) {
    assert.ok(exec.includes(`id="f-permissions-${p}"`));
    assert.ok(exec.includes(`<span>${label} <span class="hint">${PERMISSION_HINT[p]}</span></span>`), `${p}: the hint of the mode table`);
  }
  assert.match(html, /<section class="rail-sec rail-access" id="rail-access" aria-labelledby="rail-access-title" hidden>/);
  const css = readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8');
  const cards = css.slice(css.indexOf('.approvals {'), css.indexOf('/* what a release could not check'));
  assert.match(cards, /\.approval-warnings \{/);
  assert.doesNotMatch(cards, /--(ok|bad|warn|run)\b|#[0-9a-f]{3,6}\b|rgba?\(/i);
  const rail = css.slice(css.indexOf('/* access outside the project'), css.indexOf('#rail-usage[data-chart'));
  assert.ok(rail.length > 100);
  assert.doesNotMatch(rail, /--(ok|bad|warn|run)\b|#[0-9a-f]{3,6}\b|rgba?\(/i, 'no hue in the access list');
});

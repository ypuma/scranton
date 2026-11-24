// Tool approvals (.enma/run-options-contract.md, Approvals API): the pending calls of the live run as cards under
// the answer panel, read about once a second, with Approve and Deny posted once per call with the control headers.
// Model-written arguments are text; a late answer for another chat paints nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseApprovals, approvalKey, callView, whoText, countdownText, secondsLeft, askedText, buildVerdict, verdictError, BADGE,
} from '../../visualizer/public/js/approvals.js';
import { createApprovals } from '../../visualizer/public/js/approval-panel.js';
import { scopedUrl } from '../../visualizer/public/js/scope.js';
import { installTree, all } from './fixtures/tree-dom.js';

const NOW = Date.parse('2026-11-21T18:00:00.000Z');
const at = (s) => new Date(NOW + s * 1000).toISOString();
const item = (over = {}) => ({
  workflowId: 'scr:p/c/r1/dwight-m1/m1:1', step: 'tool:0:0', runId: 'r1', instanceId: 'dwight-m1', agent: 'dwight', callId: 'call_1',
  tool: 'bash', args: { command: 'npm test' }, timeoutSeconds: 600, deadline: at(300), ...over,
});
const APPROVALS_URL = '/api/projects/p/chats/c/approvals';

test('parseApprovals: the pending calls; anything without its identity is dropped, the identity is kept exactly', () => {
  assert.equal(parseApprovals(null), null);
  assert.equal(parseApprovals({ approvals: 'x' }), null);
  const list = parseApprovals({ approvals: [
    item(), item(), { ...item(), callId: '' }, { ...item(), tool: 7 }, 'x',
    item({ callId: 'call_2', workflowId: 'scr:p/c/r1/angela-m2/m2:1\u202E', agent: 'angela\u202E', instanceId: 'angela-m2', tool: 'write', args: null, deadline: 'soon', timeoutSeconds: -1 }),
  ] });
  assert.deepEqual(list.map((a) => a.key), [approvalKey(item()), JSON.stringify(['scr:p/c/r1/angela-m2/m2:1\u202E', 'tool:0:0', 'call_2'])]);
  assert.equal(list[1].workflowId, 'scr:p/c/r1/angela-m2/m2:1\u202E', 'the id goes back to the server as it came');
  assert.equal(list[1].agent, 'angela', 'shown text is cleaned');
  assert.deepEqual([list[1].args, list[1].deadline, list[1].timeoutSeconds], [{}, null, null]);
  // a call id the provider used again in a later turn is another call; without a step the deadline tells them apart
  assert.equal(parseApprovals({ approvals: [item(), item({ step: 'tool:1:0' })] }).length, 2);
  const old = parseApprovals({ approvals: [item({ step: undefined }), item({ step: undefined, deadline: at(400) })] });
  assert.deepEqual(old.map((a) => a.key), [JSON.stringify([item().workflowId, at(300), 'call_1']), JSON.stringify([item().workflowId, at(400), 'call_1'])]);
});

test('callView: a command, the path or paths of a file change, anything else as JSON, always text', () => {
  assert.deepEqual(callView(item()), { title: 'Run a shell command', label: 'Command', text: 'npm test' });
  assert.deepEqual(callView(item({ tool: 'powershell', args: { command: 'Remove-Item -Recurse x\u0007' } })), { title: 'Run a PowerShell command', label: 'Command', text: 'Remove-Item -Recurse x' });
  assert.deepEqual(callView(item({ tool: 'write', args: { path: 'src/a.js', content: 'secret body' } })), { title: 'Write a file', label: 'File', text: 'src/a.js' });
  assert.deepEqual(callView(item({ tool: 'edit', args: { edits: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'a.js' }] } })), { title: 'Edit a file', label: 'Files', text: 'a.js\nb.js' });
  assert.deepEqual(callView(item({ tool: 'edit', args: {} })).text, '(no path given)');
  assert.deepEqual(callView(item({ tool: 'grep', args: { pattern: '<img src=x>' } })), { title: 'Use grep', label: 'Arguments', text: '{\n  "pattern": "<img src=x>"\n}' });
  assert.equal(callView(item({ args: { command: 'x'.repeat(5000) } })).text.length, 2000);
  assert.equal(whoText(item()), 'Developer \u00b7 m1');
  assert.equal(whoText(item({ instanceId: 'michael', agent: 'michael' })), 'Planner');
  assert.equal(whoText({}), 'An agent');
  assert.equal(askedText(item()), 'Approval needed: the Developer (m1) wants to run a shell command: npm test');
});

test('countdown: minutes and seconds to the deadline, hours when long, and what happens once it is up', () => {
  assert.equal(countdownText(item(), NOW), '5:00 left');
  assert.equal(countdownText(item({ deadline: at(59.2) }), NOW), '1:00 left');
  assert.equal(countdownText(item({ deadline: at(3725) }), NOW), '1:02:05 left');
  assert.equal(countdownText(item({ deadline: at(-3) }), NOW), 'Time is up: the call is denied');
  assert.equal(secondsLeft(item({ deadline: null }), NOW), null);
  assert.equal(countdownText(item({ deadline: null }), NOW), '');
});

test('verdicts: exactly the contract body; 404 and 409 in words', () => {
  assert.deepEqual(buildVerdict(item(), true), { body: { workflowId: item().workflowId, callId: 'call_1', approved: true } });
  assert.deepEqual(buildVerdict(item(), 'yes').body.approved, false, 'only a real true approves');
  assert.equal(verdictError(404), 'This call is no longer waiting for an answer.');
  assert.equal(verdictError(409), 'Too late: the wait for this call ran out, so it was denied.');
  assert.equal(verdictError(0), 'The server did not answer. Is it still running?');
  assert.equal(verdictError(403, { error: 'Forbidden origin' }), 'Forbidden origin');
  assert.equal(scopedUrl(null, 'approvals'), '/api/approvals');
  assert.equal(scopedUrl({ project: 'p', chat: 'c' }, 'approvals'), APPROVALS_URL);
});

function manualTimers() {
  let n = 0;
  const due = new Map();
  return {
    setTimeout(fn, ms) { n += 1; due.set(n, { fn, ms }); return n; },
    clearTimeout(id) { due.delete(id); },
    tick() {
      for (const [id, d] of [...due]) {
        due.delete(id);
        d.fn();
      }
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function harness({ list = [item()], verdict = null } = {}) {
  const $ = installTree();
  const server = { list, gets: [], posts: [], hold: null };
  const fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      server.posts.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      if (server.hold) await server.hold;
      const status = verdict ?? 202;
      return { ok: status < 300, status, json: async () => (status < 300 ? { ok: true } : { error: 'x' }) };
    }
    server.gets.push({ url, headers: opts.headers });
    return { ok: true, status: 200, json: async () => ({ approvals: server.list }) };
  };
  const said = [];
  const timers = manualTimers();
  const ctx = { url: APPROVALS_URL, alive: true, now: NOW };
  const panel = createApprovals({
    url: () => ctx.url, wanted: () => ctx.alive, announce: (t) => said.push(t), fetch, timers, now: () => ctx.now,
  });
  const cards = () => $('approvals-list').children;
  const button = (card, verdict) => card.querySelector(`button[data-verdict="${verdict}"]`);
  return { $, panel, server, said, timers, ctx, cards, button };
}

test('the panel: one card per pending call with an inverted badge, the agent, the tool, the arguments and the countdown', async () => {
  const h = harness({ list: [item(), item({ callId: 'call_2', instanceId: 'angela-m2', agent: 'angela', tool: 'write', args: { path: 'docs/<b>.md' }, deadline: at(30) })] });
  h.panel.sync();
  await flush();
  assert.equal(h.server.gets.length, 1);
  assert.equal(h.server.gets[0].headers['X-Scranton-Client'], '1');
  assert.equal(h.$('approvals').hidden, false);
  assert.equal(h.cards().length, 2, 'parallel agents: a card each');
  const [one, two] = h.cards();
  const text = (card, cls) => all(card).find((n) => ` ${n.className} `.includes(` ${cls} `)).textContent;
  assert.equal(text(one, 'approval-badge'), BADGE);
  assert.equal(BADGE, 'Approval needed');
  assert.equal(text(one, 'approval-who'), 'Developer \u00b7 m1');
  assert.equal(text(one, 'approval-title'), 'Run a shell command');
  assert.equal(text(one, 'approval-args'), 'npm test');
  assert.equal(text(one, 'approval-left'), '5:00 left');
  assert.equal(text(two, 'approval-args'), 'docs/<b>.md');
  assert.ok(all(two).every((n) => n.tagName !== 'B'), 'model text is never markup');
  assert.equal(h.said.length, 1, 'both said once, in one announcement');
  assert.match(h.said[0], /^Approval needed: the Developer \(m1\) wants to run a shell command: npm test Approval needed: the QA Tester/);

  // the next poll a second later: the countdown moves, nothing is announced again
  h.ctx.now = NOW + 1000;
  h.timers.tick();
  await flush();
  assert.equal(h.server.gets.length, 2);
  assert.equal(text(h.cards()[0], 'approval-left'), '4:59 left');
  assert.equal(h.said.length, 1);
  assert.equal(h.cards()[0], one, 'the card stays the same node, so focus in it is kept');
  // the time ran out on the second: its buttons are off
  h.ctx.now = NOW + 31000;
  h.timers.tick();
  await flush();
  assert.equal(text(h.cards()[1], 'approval-left'), 'Time is up: the call is denied');
  assert.equal(h.button(h.cards()[1], 'approve').disabled, true);
});

test('Approve posts the contract body with the control headers once, a double click included; the card says so until it goes', async () => {
  const h = harness();
  h.panel.sync();
  await flush();
  let release;
  h.server.hold = new Promise((r) => { release = r; });
  const card = h.cards()[0];
  const approve = h.button(card, 'approve');
  approve.click();
  approve.click();
  h.button(card, 'deny').click();
  await flush();
  assert.equal(h.server.posts.length, 1, 'one POST per call');
  assert.equal(approve.disabled, true);
  assert.equal(h.button(card, 'deny').disabled, true);
  release();
  await flush();
  assert.deepEqual(h.server.posts[0], {
    url: APPROVALS_URL, headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1' },
    body: { workflowId: item().workflowId, callId: 'call_1', approved: true },
  });
  const status = all(card).find((n) => / approval-status /.test(` ${n.className} `));
  assert.equal(status.textContent, 'Approved - the agent goes on');
  assert.equal(card.querySelector('.hitl-actions').hidden, true);
  assert.ok(h.said.includes('Approved - the agent goes on'));
  // the next reading no longer lists it: the card goes, and the panel with it
  h.server.list = [];
  h.timers.tick();
  await flush();
  assert.equal(h.cards().length, 0);
  assert.equal(h.$('approvals').hidden, true);
});

test('Deny sends approved: false; a 409 says it was too late and keeps the card until the server drops it', async () => {
  const h = harness({ verdict: 409 });
  h.panel.sync();
  await flush();
  h.button(h.cards()[0], 'deny').click();
  await flush();
  assert.equal(h.server.posts[0].body.approved, false);
  const status = all(h.cards()[0]).find((n) => / approval-status /.test(` ${n.className} `));
  assert.equal(status.textContent, 'Too late: the wait for this call ran out, so it was denied.');
  assert.equal(status.dataset.tone, 'error');
  assert.equal(h.server.gets.length, 2, 'read again at once');
});

for (const [what, next] of [['step', { step: 'tool:1:0', deadline: at(330) }], ['deadline, from a server without steps', { step: undefined, deadline: at(330) }]]) {
  test(`a call id repeated in a later turn before a poll saw the gap gets its own card (told apart by the ${what})`, async () => {
    const first = next.step === undefined ? item({ step: undefined }) : item();
    const h = harness({ list: [first] });
    h.panel.sync();
    await flush();
    const card = h.cards()[0];
    h.button(card, 'approve').click();
    await flush();
    assert.equal(card.querySelector('.hitl-actions').hidden, true);
    // the next reading already lists the later call under the same workflow and call id
    h.server.list = [item(next)];
    h.timers.tick();
    await flush();
    assert.equal(h.cards().length, 1);
    const later = h.cards()[0];
    assert.notEqual(later, card, 'a new card, not the answered one');
    assert.equal(later.querySelector('.hitl-actions').hidden, false);
    assert.equal(h.button(later, 'approve').disabled, false);
    assert.equal(all(later).find((n) => / approval-status /.test(` ${n.className} `)).textContent, '');
    assert.equal(h.said.filter((t) => t.startsWith('Approval needed:')).length, 2, 'the later call is announced too');
    h.button(later, 'deny').click();
    await flush();
    assert.deepEqual(h.server.posts.map((p) => p.body), [
      { workflowId: item().workflowId, callId: 'call_1', approved: true },
      { workflowId: item().workflowId, callId: 'call_1', approved: false },
    ]);
  });
}

test('a chat switch while a POST is in flight: the late answer paints nothing into the other chat', async () => {
  const h = harness();
  h.panel.sync();
  await flush();
  let release;
  h.server.hold = new Promise((r) => { release = r; });
  h.button(h.cards()[0], 'approve').click();
  await flush();
  h.panel.reset();
  h.ctx.url = '/api/projects/p/chats/other/approvals';
  h.server.list = [item({ callId: 'call_9', workflowId: 'scr:p/other/r5/dwight-m1/m1:1' })];
  h.panel.sync();
  await flush();
  const before = h.said.length;
  release();
  await flush();
  assert.equal(h.said.length, before, 'nothing announced for the old chat');
  const card = h.cards()[0];
  assert.equal(card.dataset.key, JSON.stringify(['scr:p/other/r5/dwight-m1/m1:1', 'tool:0:0', 'call_9']));
  assert.equal(all(card).find((n) => / approval-status /.test(` ${n.className} `)).textContent, '');
  assert.equal(h.button(card, 'approve').disabled, false);
  assert.equal(h.server.gets.at(-1).url, '/api/projects/p/chats/other/approvals');
});

test('only while a run is live: no run, no poll; a server without the route (404) is quietly off', async () => {
  const h = harness();
  h.ctx.alive = false;
  h.panel.sync();
  await flush();
  assert.equal(h.server.gets.length, 0);
  h.ctx.alive = true;
  h.panel.sync();
  await flush();
  assert.equal(h.cards().length, 1);
  h.ctx.alive = false;
  h.panel.sync();
  assert.equal(h.cards().length, 0, 'the run ended: its cards go');
  assert.equal(h.$('approvals').hidden, true);

  const $ = installTree();
  const gets = [];
  const timers = manualTimers();
  const p = createApprovals({ url: () => APPROVALS_URL, wanted: () => true, timers, fetch: async (url) => { gets.push(url); return { ok: false, status: 404, json: async () => null }; } });
  p.sync();
  await flush();
  timers.tick();
  p.sync();
  await flush();
  assert.equal(gets.length, 1, 'a 404 is not asked again');
  assert.equal($('approvals').hidden, true);
});

test('page: the cards sit after the answer panel, keep the monochrome look, and use no inline markup', () => {
  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="approvals"') > html.indexOf('id="hitl"'));
  assert.ok(html.indexOf('id="approvals"') < html.indexOf('id="exit-panel"'));
  const css = readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8');
  const rules = css.slice(css.indexOf('.approvals {'), css.indexOf('/* what a release could not check'));
  assert.match(rules, /\.approval-badge \{[^}]*background: var\(--text\); color: var\(--bg\);/, 'the critical mark is an inversion');
  assert.doesNotMatch(rules, /--(ok|bad|warn|run)\b|#[0-9a-f]{3,6}\b|rgba?\(/i, 'no hue in the approval cards');
  const js = readFileSync(new URL('../../visualizer/public/js/approval-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML/);
});

// The panels that draw a run view (.enma/live-activity-contract.md): the run rail of the Chat view, the board,
// the usage figures with their diagram, the instance lanes and the /live poll. Driven with the tree fake DOM;
// what they draw is derived in activity-model.js (live-activity.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduce, reduceAll } from '../../visualizer/public/js/state.js';
import { teamRunView, pipelineRunView, foldCalls, parseLive, RAIL_KEY, RAIL_WIDE, NO_REASONING } from '../../visualizer/public/js/activity-model.js';
import { parseRunDoc } from '../../visualizer/public/js/pipeline-model.js';
import { createPipelineView } from '../../visualizer/public/js/pipeline-view.js';
import { createBoard, attemptText, GATE_MARK } from '../../visualizer/public/js/board.js';
import { createRunRail, railAgents, RAIL_AGENTS_SHOWN } from '../../visualizer/public/js/run-rail.js';
import { createUsage } from '../../visualizer/public/js/usage-chart.js';
import { createLiveBlock, tailIsLong } from '../../visualizer/public/js/agent-live.js';
import { createLanes } from '../../visualizer/public/js/lanes.js';
import { createLivePoll, LIVE_POLL_MS, LIVE_RETRY_MS } from '../../visualizer/public/js/live-poll.js';
import { installTree, all } from './fixtures/tree-dom.js';
import { fakeStorage } from './fixtures/run-drawer.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const RUN = 'run-live';
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const EVIL = '<img src=x onerror=alert(1)> <script>alert(2)</script>';

function journal() {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(T0 + seq * 1000).toISOString(), runId: RUN, type, ...fields });
}

// a run with a planner that waits, a developer editing a file and a reviewer thinking
function run(extra = []) {
  const e = journal();
  const state = reduceAll([
    e('run_started', { request: 'Build it', workspace: 'C:\\ws', execution: { workflow: { gates: [['oscar'], ['angela']] } } }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'Storage', acceptanceCriteria: ['todos persist'] }, { id: 'm2', title: EVIL, dependsOn: ['m1'] }] }),
    e('instance_started', { instanceId: 'michael', agent: 'michael', milestoneId: null }),
    e('agent_status', { agent: 'michael', instanceId: 'michael', status: 'waiting', activity: 'Overseeing' }),
    e('milestone_started', { milestoneId: 'm1', title: 'Storage', index: 0, total: 2 }),
    e('instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', status: 'working', activity: 'Working...' }),
    e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 900, output: 100, cost: 0.01 } }),
    e('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'read', detail: 'README.md', targetFile: 'README.md' }),
    e('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'edit', detail: 'src/cli.js', targetFile: 'src/cli.js' }),
    ...extra.map(([type, fields]) => e(type, fields)),
  ]);
  return { e, state };
}
const LIVE = (thinking, text = null, phase = 'thinking') => ({ doc: parseLive({ runId: RUN, instances: { 'dwight-m1': { agent: 'dwight', phase, thinking, text } } }), at: Date.now() });

// ------------------------------------------------------------ the board

function boardHarness() {
  installTree();
  const root = document.createElement('div');
  document.body.append(root);
  return { root, board: createBoard(root, { name: 'board' }) };
}
const cardsOf = (root, column) => root.querySelector(`.board-col[data-column="${column}"]`).querySelectorAll('.card');

test('board: five labelled columns; a card says id, title, state, who works on it, the cycle and the gates', () => {
  const { e, state } = run();
  const { root, board } = boardHarness();
  board.render(teamRunView({ state }).board);
  const cols = root.querySelectorAll('.board-col');
  assert.deepEqual(cols.map((c) => [c.dataset.column, c.querySelector('h3').textContent, c.querySelector('.board-count').textContent, c.dataset.empty]), [
    ['todo', 'To do', '1', 'false'], ['in_progress', 'In progress', '1', 'false'], ['in_review', 'In review', '0', 'true'], ['blocked', 'Blocked', '0', 'true'], ['done', 'Done', '0', 'true'],
  ]);
  for (const c of cols) assert.equal(c.getAttribute('aria-labelledby'), c.querySelector('h3').id, 'each column is a labelled region');
  const card = cardsOf(root, 'in_progress')[0];
  assert.deepEqual([card.querySelector('.card-id').textContent, card.querySelector('.card-title').textContent, card.querySelector('.card-state').textContent, card.dataset.loud], ['m1', 'Storage', 'in progress', 'false']);
  assert.deepEqual(card.querySelector('.card-agents').children.map((li) => li.children.map((n) => n.textContent)), [['●', 'dwight-m1', 'Editing src/cli.js']]);
  assert.equal(card.querySelector('.card-attempt').textContent, 'cycle 1');
  assert.deepEqual(card.querySelectorAll('.card-gate').map((g) => [g.dataset.result, g.textContent, g.title]), [['pending', '○ Oscar not run yet', 'Oscar: not run yet'], ['pending', '○ Angela not run yet', 'Angela: not run yet']]);
  assert.equal(card.querySelector('summary').textContent, '1 acceptance criterion');
  const todo = cardsOf(root, 'todo')[0];
  assert.deepEqual([todo.querySelector('.card-state').textContent, todo.querySelector('.card-note').textContent], ['waiting', 'waiting on m1']);
  assert.equal(todo.querySelector('.card-foot'), null, 'nothing about cycles or gates before it started');
  // a hostile title is text
  assert.equal(todo.querySelector('.card-title').textContent, EVIL);
  assert.ok(!all(root).some((n) => ['IMG', 'SCRIPT', 'A'].includes(n.tagName)));

  // the cycle fails and the breaker trips: the card moves, inverted, with its count and the gate's glyph
  const s = [
    ['agent_finished', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 1 }],
    ['gate_result', { agent: 'oscar', milestoneId: 'm1', cycle: 1, stage: 0, result: 'failed', keyword: 'CHANGES_REQUESTED' }],
    ['cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: 'Oscar requested changes' }],
    ['circuit_breaker', { state: 'tripped', failedCycles: 1, maxFailedCycles: 1 }],
    ['hitl_request', { milestoneId: 'm1', reason: 'One cycle failed.', options: ['retry'] }],
  ].reduce((st, [type, f]) => reduce(st, e(type, f)), state);
  board.render(teamRunView({ state: s }).board);
  assert.equal(cardsOf(root, 'in_progress').length, 0);
  const blocked = cardsOf(root, 'blocked')[0];
  assert.deepEqual([blocked.dataset.loud, blocked.querySelector('.card-state').textContent, blocked.querySelector('.card-attempt').textContent], ['true', 'breaker tripped', 'cycle 1 · 1 failed']);
  assert.equal(blocked.querySelector('.card-reason').textContent, 'last failure Oscar requested changes');
  assert.deepEqual(blocked.querySelectorAll('.card-gate').map((g) => g.textContent), ['✕ Oscar failed', '○ Angela not run yet']);
  const notice = root.querySelector('.board-notice');
  assert.deepEqual([notice.textContent, notice.hidden, notice.dataset.loud, notice.getAttribute('role'), notice.getAttribute('aria-live')], ['Waiting for your answer: One cycle failed.', false, 'true', 'status', 'polite']);
  assert.deepEqual([GATE_MARK.passed, GATE_MARK.failed, GATE_MARK.blocked, GATE_MARK.running, GATE_MARK.pending], ['✓', '✕', '■', '◐', '○'], 'the glyphs the lanes use');
  assert.deepEqual([attemptText({ attempt: 0, failed: 0 }, 'milestone'), attemptText({ attempt: 2, failed: 1 }, 'step'), attemptText({ attempt: 3, failed: 0 }, 'milestone')], ['', 'attempt 2 · 1 failed', 'cycle 3']);
});

test('board: a card that says the same is the same node; an open disclosure stays open and keeps the focus', () => {
  const { e, state } = run();
  const { root, board } = boardHarness();
  board.render(teamRunView({ state }).board);
  const [m1] = cardsOf(root, 'in_progress');
  const [m2] = cardsOf(root, 'todo');
  const summary = m1.querySelector('summary');
  m1.querySelector('details').open = true;
  m1.querySelector('details').dispatch('toggle');
  summary.focus();

  // nothing about the board changed: no node is touched
  board.render(teamRunView({ state: reduce(state, e('log', { level: 'info', message: 'x' })) }).board);
  assert.equal(cardsOf(root, 'in_progress')[0], m1);
  assert.equal(document.activeElement, summary);
  // the developer runs another tool: m1 is drawn again (its line changed), m2 is not
  const next = reduce(state, e('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'bash', detail: 'node --test', command: 'node --test' }));
  board.render(teamRunView({ state: next }).board);
  const again = cardsOf(root, 'in_progress')[0];
  assert.notEqual(again, m1);
  assert.equal(again.querySelector('.card-line').textContent, 'Running node --test');
  assert.equal(cardsOf(root, 'todo')[0], m2, 'a card that says the same is left alone');
  assert.equal(again.querySelector('details').open, true, 'the disclosure the reader opened is still open');
  assert.equal(document.activeElement, again.querySelector('summary'), 'and the focus is on it again, not on the page');

  // an empty board says why, instead of five empty columns
  board.render(teamRunView({ state: reduceAll([journal()('run_started', { request: 'x' })]) }).board);
  assert.deepEqual([root.querySelector('.board-empty').textContent, root.querySelector('.board-empty').hidden, root.querySelector('.board-cols').hidden], ['Waiting for the plan...', false, true]);
  // one quiet note for derived pipeline steps, on the board and not on a card
  board.render({ kind: 'step', columns: [], total: 1, counts: {}, notice: null, note: 'Step states are approximate for this run.', empty: '' });
  assert.deepEqual([root.querySelector('.board-note').textContent, root.querySelector('.board-note').hidden], ['Step states are approximate for this run.', false]);
});

// ------------------------------------------------------------ the live text under an agent

test('live block: text only, no live region, the newest lines, and it opens when there is more', () => {
  installTree();
  const open = new Set();
  const block = createLiveBlock(open);
  const agent = (text, extra = {}) => ({ id: 'dwight-m1', name: 'dwight-m1', text, note: '', files: [], ...extra });
  block.update(agent(null));
  assert.equal(block.el.hidden, true, 'nothing to show: no empty box');

  block.update(agent({ kind: 'reasoning', label: 'Reasoning', body: `Checking ${EVIL}`, cut: false }));
  const body = block.el.querySelector('.live-body');
  assert.equal(block.el.hidden, false);
  assert.equal(body.getAttribute('aria-live'), 'off', 'it changes many times a second: not a live region');
  assert.equal(body.getAttribute('role'), null);
  assert.equal(body.textContent, `Checking ${EVIL}`);
  assert.equal(block.el.querySelector('.live-label').textContent, 'Reasoning');
  assert.ok(!all(block.el).some((n) => ['IMG', 'SCRIPT'].includes(n.tagName)), 'model text never becomes markup');
  assert.equal(block.el.querySelector('.live-more').hidden, true, 'a short text needs no button');

  // the same nodes carry the next text
  const text = block.el.querySelector('.live-text');
  const long = Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`).join('\n');
  block.update(agent({ kind: 'reasoning', label: 'Reasoning', body: long, cut: true }));
  assert.equal(block.el.querySelector('.live-text'), text);
  assert.equal(text.textContent, `... ${long}`, 'a dropped head is said by an ellipsis');
  const more = block.el.querySelector('.live-more');
  assert.deepEqual([more.hidden, more.textContent, more.getAttribute('aria-expanded'), more.type, block.el.getAttribute('data-open')], [false, 'Show all of the reasoning', 'false', 'button', null]);
  more.click();
  assert.deepEqual([more.textContent, more.getAttribute('aria-expanded'), block.el.getAttribute('data-open'), open.has('dwight-m1')], ['Show less', 'true', '', true]);
  block.update(agent({ kind: 'reasoning', label: 'Reasoning', body: `${long}\nLine 10`, cut: true }));
  assert.equal(block.el.getAttribute('data-open'), '', 'it stays open while the text grows');
  more.click();
  assert.equal(block.el.getAttribute('data-open'), null);
  assert.deepEqual([tailIsLong(null), tailIsLong({ body: 'a\nb\nc', cut: false }), tailIsLong({ body: 'a\nb\nc\nd', cut: false }), tailIsLong({ body: 'x', cut: true })], [false, false, true, true]);

  // the note that a model shows no reasoning is one quiet line, and the recent files are a labelled list
  block.update(agent({ kind: 'answer', label: 'Answer', body: 'Done.', cut: false }, { note: NO_REASONING, files: [{ path: 'src/cli.js', kind: 'edit', ts: null }, { path: 'README.md', kind: 'read', ts: null }] }));
  assert.deepEqual([block.el.querySelector('.live-note').textContent, block.el.querySelector('.live-note').hidden], [NO_REASONING, false]);
  assert.deepEqual(block.el.querySelector('.live-files').children.map((li) => li.children.map((n) => n.textContent)), [['edited', 'src/cli.js'], ['read', 'README.md']]);
  assert.equal(block.el.querySelector('.live-files').getAttribute('aria-label'), 'Recent files of dwight-m1');
  const css = read('styles.css');
  assert.match(css, /\.live-body \{[^}]*justify-content: flex-end;[^}]*max-height: 4\.5em;[^}]*overflow: hidden;/, 'clamped to a few lines, the newest at the bottom');
  assert.match(css, /\.live\[data-open\] \.live-body \{ max-height: none; \}/);
});

// ------------------------------------------------------------ the run rail

function railHarness({ wide = true, view = 'chat', stored = null, liveOff = false } = {}) {
  const $ = installTree();
  const storage = fakeStorage(stored === null ? {} : { [RAIL_KEY]: stored });
  globalThis.localStorage = storage;
  const media = { matches: wide, listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
  const h = { $, storage, media, view, opened: 0, off: liveOff };
  h.rail = createRunRail({ viewMode: () => h.view, openBoard: () => { h.opened += 1; }, liveOff: () => h.off, media });
  h.resize = (isWide) => {
    media.matches = isWide;
    for (const fn of media.listeners) fn();
  };
  h.acts = () => $('rail-agents').querySelectorAll('.act');
  h.act = (id) => h.acts().find((li) => li.querySelector('.act-name').textContent === id);
  return h;
}

test('rail, wide window: beside the transcript, with every agent\'s name, role, status, line, live text and files', () => {
  const { state } = run([['instance_started', { instanceId: 'oscar-m1', agent: 'oscar', milestoneId: 'm1' }]]);
  const h = railHarness();
  h.rail.render(teamRunView({ state, live: LIVE('The parser needs a second pass.') }));
  assert.deepEqual([document.body.dataset.rail, h.$('run-rail').hidden, h.$('rail-toggle').hidden, h.$('rail-toggle').getAttribute('aria-expanded'), h.$('rail-toggle').getAttribute('aria-controls')], ['open', false, false, 'true', 'run-rail']);
  assert.equal(h.$('run-live-line').hidden, true, 'no second line while the rail says it');
  // the active ones first, then the rest in reading order
  assert.deepEqual(h.acts().map((li) => [li.querySelector('.act-name').textContent, li.querySelector('.act-role').textContent, li.querySelector('.act-status').textContent, li.querySelector('.act-line').textContent, li.dataset.live]), [
    ['michael', 'Planner', 'waiting', 'Overseeing', 'true'],
    ['dwight-m1', 'Developer · m1', 'working', 'Editing src/cli.js', 'true'],
    ['oscar-m1', 'Reviewer · m1', 'thinking', 'Thinking', 'true'],
  ]);
  const dwight = h.act('dwight-m1');
  assert.deepEqual([dwight.querySelector('.live-label').textContent, dwight.querySelector('.live-text').textContent], ['Reasoning', 'The parser needs a second pass.']);
  assert.equal(dwight.querySelector('.live-body').getAttribute('aria-live'), 'off');
  assert.deepEqual(dwight.querySelector('.live-files').children.map((li) => li.textContent), ['editedsrc/cli.js', 'readREADME.md'], 'the newest file first');
  assert.equal(h.act('michael').querySelector('.live').hidden, true);
  assert.equal(h.$('rail-agents-aside').textContent, '3 active');
  assert.equal(h.$('rail-status').textContent, 'live · 3 active');
  assert.equal(h.$('rail-agents-empty').hidden, true);
  assert.equal(h.$('rail-agents-more').hidden, true);
  assert.equal(h.$('rail-toggle-fig').textContent, '$0.010', 'the cost of the run, where the rail and its absence both show it');
  assert.equal(h.$('rail-board-summary').textContent, '1 in review · 0 of 2 done');
  assert.equal(h.$('rail-live-note').hidden, true);

  // the next tick: the same nodes, written in place
  const before = { li: dwight, text: dwight.querySelector('.live-text'), line: dwight.querySelector('.act-line'), usage: h.$('rail-usage').children[0] };
  h.rail.render(teamRunView({ state, live: LIVE('The parser needs a second pass. Then the tests.') }));
  assert.equal(h.act('dwight-m1'), before.li, 'no entry is built again');
  assert.equal(h.act('dwight-m1').querySelector('.live-text'), before.text);
  assert.equal(before.text.textContent, 'The parser needs a second pass. Then the tests.');
  assert.equal(h.$('rail-usage').children[0], before.usage);
  assert.equal(h.acts().length, 3);

  // a model without reasoning: its answer, and the note once
  h.rail.render(teamRunView({ state, live: LIVE(null, 'Writing the fix.', 'text') }));
  assert.deepEqual([dwight.querySelector('.live-label').textContent, dwight.querySelector('.live-note').textContent], ['Answer', NO_REASONING]);
  assert.equal(h.$('rail-agents').querySelectorAll('.live-note').filter((n) => !n.hidden).length, 1);
  // a server without /live says so once for the whole list, and the lines still stand
  h.off = true;
  h.rail.render(teamRunView({ state, live: null }));
  assert.deepEqual([h.$('rail-live-note').hidden, h.$('rail-live-note').textContent], [false, 'This server does not report live text. The lines above come from the event stream.']);
  assert.equal(dwight.querySelector('.act-line').textContent, 'Editing src/cli.js');
  assert.equal(dwight.querySelector('.live-label').hidden, true);

  // the board in one line opens the whole board
  h.$('rail-board').click();
  assert.equal(h.opened, 1);
});

test('rail: closing it is remembered like the view switch; the toggle and the live line stand in for it', () => {
  const { state } = run();
  const h = railHarness();
  h.rail.render(teamRunView({ state }));
  h.$('rail-close').click();
  assert.deepEqual([document.body.dataset.rail, h.$('run-rail').hidden, h.$('rail-toggle').getAttribute('aria-expanded'), h.storage.map.get(RAIL_KEY)], ['closed', true, 'false', 'closed']);
  assert.equal(document.activeElement, h.$('rail-toggle'), 'the focus goes to the control that brings it back');
  assert.deepEqual([h.$('run-live-line').hidden, h.$('run-live-text').textContent], [false, 'dwight-m1 · Editing src/cli.js']);
  h.$('rail-toggle').click();
  assert.deepEqual([document.body.dataset.rail, h.storage.map.get(RAIL_KEY), h.$('run-live-line').hidden], ['open', 'open', true]);

  // the next page load starts as it was left
  const again = railHarness({ stored: 'closed' });
  again.rail.render(teamRunView({ state }));
  assert.equal(document.body.dataset.rail, 'closed');
  assert.equal(again.acts().length, 0, 'out of sight, nothing is drawn');
  // the live line opens it too
  again.$('run-live-line').click();
  assert.equal(document.body.dataset.rail, 'open');
  assert.equal(again.acts().length, 2);
  // a run that is over has no live line, whatever the rail does
  const over = reduce(state, { v: 1, seq: 99, ts: new Date(T0 + 99000).toISOString(), runId: RUN, type: 'run_finished', status: 'success', summary: 'ok' });
  again.$('rail-close').click();
  again.rail.render(teamRunView({ state: over }));
  assert.deepEqual([document.body.dataset.rail, again.$('run-live-line').hidden, again.$('rail-toggle').hidden], ['closed', true, false]);
});

test('rail, narrow window: a toggle in the chat header opens the same content as a drawer; the dashboard has none', () => {
  const { state } = run();
  const h = railHarness({ wide: false });
  h.rail.render(teamRunView({ state }));
  assert.deepEqual([document.body.dataset.rail, h.$('run-rail').hidden, h.$('rail-toggle').hidden, h.$('rail-toggle').getAttribute('aria-expanded'), h.$('rail-toggle').getAttribute('aria-haspopup'), h.$('rail-toggle').getAttribute('aria-controls')],
    ['closed', true, false, 'false', 'dialog', 'rail-dialog']);
  assert.equal(h.$('run-live-line').hidden, false, 'one live line above the composer');
  assert.equal(h.storage.map.has(RAIL_KEY), false);

  h.$('rail-toggle').click();
  assert.deepEqual([document.body.dataset.rail, h.$('rail-dialog').open, h.$('rail-toggle').getAttribute('aria-expanded')], ['overlay', true, 'true']);
  assert.equal(h.$('rail-body').parentNode, h.$('rail-dialog-body'), 'the drawer holds the rail\'s own content, not a copy');
  assert.equal(h.$('run-rail').hidden, true, 'the column itself stays away');
  assert.equal(h.acts().length, 2, 'and it is drawn there');
  assert.equal(document.activeElement, h.$('rail-dialog-close'));
  assert.equal(h.storage.map.has(RAIL_KEY), false, 'opening the drawer is no choice about the wide layout');
  h.$('rail-dialog-close').click();
  assert.deepEqual([document.body.dataset.rail, h.$('rail-dialog').open, h.$('rail-body').parentNode], ['closed', false, h.$('run-rail')]);
  assert.equal(document.activeElement, h.$('run-live-line'), 'the focus returns to where the reader was');

  // the window grows while the drawer is open: the drawer closes and the rail stands beside the transcript
  h.$('rail-toggle').click();
  h.resize(true);
  assert.deepEqual([document.body.dataset.rail, h.$('rail-dialog').open, h.$('run-rail').hidden, h.$('rail-body').parentNode], ['open', false, false, h.$('run-rail')]);
  // the dashboard shows the same things in its own panels
  h.view = 'dashboard';
  h.rail.render(teamRunView({ state }));
  assert.deepEqual([document.body.dataset.rail, h.$('run-rail').hidden, h.$('rail-toggle').hidden, h.$('run-live-line').hidden], ['none', true, true, true]);
  // and a chat without a run has nothing to show
  h.view = 'chat';
  h.rail.render(teamRunView({ state: reduceAll([]) }));
  assert.equal(document.body.dataset.rail, 'none');
  assert.equal(RAIL_WIDE, '(min-width: 1200px)');
});

test('rail: a long list shows the active agents and offers the rest; another chat starts clean', () => {
  const e = journal();
  const events = [e('run_started', { request: 'x' }), e('plan_ready', { milestones: Array.from({ length: 5 }, (_, i) => ({ id: `m${i + 1}`, title: `M${i + 1}` })) })];
  for (let i = 1; i <= 5; i += 1) {
    events.push(e('milestone_started', { milestoneId: `m${i}`, title: `M${i}`, index: i - 1, total: 5 }));
    for (const agent of ['dwight', 'angela']) events.push(e('instance_started', { instanceId: `${agent}-m${i}`, agent, milestoneId: `m${i}` }));
    if (i < 5) events.push(e('milestone_finished', { milestoneId: `m${i}`, status: 'passed' }));
  }
  const view = teamRunView({ state: reduceAll(events) });
  assert.deepEqual(railAgents(view.agents).shown.map((a) => a.id).slice(0, 2), ['dwight-m5', 'angela-m5'], 'the active ones lead');
  assert.deepEqual([railAgents(view.agents).shown.length, railAgents(view.agents).hidden, railAgents(view.agents, true).shown.length], [RAIL_AGENTS_SHOWN, 4, 10]);
  const h = railHarness();
  h.rail.render(view);
  const more = h.$('rail-agents-more');
  assert.deepEqual([h.acts().length, more.hidden, more.textContent, more.getAttribute('aria-expanded')], [6, false, 'Show all 10 agents', 'false']);
  const first = h.acts()[0];
  more.click();
  assert.deepEqual([h.acts().length, more.textContent, more.getAttribute('aria-expanded')], [10, 'Show fewer', 'true']);
  assert.equal(h.acts()[0], first, 'the ones already listed are not built again');
  h.rail.reset();
  assert.deepEqual([h.acts().length, document.body.dataset.rail], [0, 'none']);
});

// ------------------------------------------------------------ cost and usage

function usageHarness(opts) {
  installTree();
  const u = createUsage({ id: 'u', ...opts });
  document.body.append(u.el);
  return { u, root: u.el, chart: u.el.querySelector('.chart'), readout: u.el.querySelector('.chart-readout') };
}

test('usage: the run\'s cost and tokens as figures, the diagram as SVG built in code, and a real empty state', () => {
  const { e, state } = run();
  const { u, root, chart, readout } = usageHarness({ table: true });
  u.render(teamRunView({ state: reduceAll([journal()('run_started', { request: 'x' })]) }).usage, { live: true });
  assert.deepEqual([chart.dataset.empty, root.querySelector('.chart-empty').hidden, root.querySelector('.chart-empty').textContent], ['true', false, 'No usage yet. The diagram starts with the first model call.']);
  assert.equal(root.querySelector('svg').children.length, 0);
  assert.equal(root.querySelector('.chart-data').hidden, true);
  assert.equal(root.querySelector('.usage-value').textContent, '$0.00', 'the figures are there from the start');
  assert.match(chart.getAttribute('aria-label'), /nothing to show yet/);

  const s = [
    ['agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 1900, output: 100, cost: 0.02 } }],
    ['agent_usage', { agent: 'angela', instanceId: 'angela-m1', usage: { input: 400, output: 100, cost: 0.005 } }],
  ].reduce((st, [type, f]) => reduce(st, e(type, f)), state);
  const usage = teamRunView({ state: s, runs: [{ runId: 'r-old', usage: { tokens: 1000, cost: 0.1 } }] }).usage;
  u.render(usage, { live: false });
  const figs = root.querySelectorAll('.usage-fig');
  assert.deepEqual(figs.map((f) => [f.querySelector('dt').textContent, f.querySelector('.usage-value').textContent, f.querySelector('.usage-tokens').textContent, f.querySelector('.usage-sub').textContent, f.hidden]), [
    ['This run', '$0.035', '3.5k tokens', 'in 3.2k · out 300 · 3 model calls', false],
    ['This chat', '$0.135', '4.5k tokens', '2 runs', false],
  ]);
  assert.equal(figs[0].querySelector('.usage-est').hidden, true, 'a reported cost is not marked');
  assert.match(read('index.html'), /id="rail-usage"/);

  const svg = root.querySelector('svg');
  assert.deepEqual([svg.getAttribute('aria-hidden'), svg.getAttribute('viewBox'), chart.dataset.empty], ['true', '0 0 320 150', 'false']);
  assert.deepEqual(svg.querySelectorAll('path').map((p) => [p.getAttribute('class'), p.getAttribute('data-band')]), [['chart-band', 'dwight'], ['chart-band', 'angela'], ['chart-total', null]], 'the agents stacked, the total drawn last, on top');
  assert.ok(svg.querySelectorAll('line').length >= 3, 'a grid');
  assert.ok(svg.querySelectorAll('text').every((t) => t.textContent), 'labelled ticks');
  assert.equal(readout.textContent, 'Latest: $0.035 after 4s');
  assert.equal(readout.getAttribute('aria-live'), 'off', 'the diagram redraws as the run goes: not a live region');
  assert.equal(chart.getAttribute('aria-label'), 'Cumulative cost over 4s: $0.035 (Dwight $0.030, Angela $0.005). Arrow keys read the points.');
  assert.deepEqual([chart.tabIndex, chart.getAttribute('role'), chart.getAttribute('aria-describedby')], [0, 'group', readout.id]);

  // the table every agent has a row in: calls, tokens, cost, share
  const table = root.querySelector('table.usage-table');
  assert.deepEqual(table.querySelector('thead').querySelectorAll('th').map((th) => th.textContent), ['Agent', 'Calls', 'Tokens', 'Cost', 'Cost share']);
  assert.deepEqual(table.querySelector('tbody').children.map((tr) => tr.children.map((c) => c.textContent)), [['Dwight', '2', '3.0k', '$0.030', '86%'], ['Angela', '1', '500', '$0.005', '14%']]);
  assert.deepEqual(table.querySelector('tbody').querySelectorAll('.chart-swatch').map((x) => x.dataset.tone), ['0', '1'], 'the swatch of its band');
  // the diagram as a table, for whoever cannot use the picture
  const data = root.querySelector('.chart-data');
  assert.deepEqual([data.hidden, data.querySelector('summary').textContent], [false, 'Diagram as a table']);
  assert.deepEqual(data.querySelector('thead').querySelectorAll('th').map((th) => th.textContent), ['Elapsed', 'Total', 'Dwight', 'Angela']);
  assert.deepEqual(data.querySelector('tbody').children.at(-1).children.map((c) => c.textContent), ['4s', '$0.035', '$0.030', '$0.005']);
});

test('usage: the diagram is read with the pointer and with the keys, and switches to tokens', () => {
  const { e, state } = run();
  const s = [
    ['agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 1900, output: 100, cost: 0.02 } }],
    ['agent_usage', { agent: 'angela', instanceId: 'angela-m1', usage: { input: 400, output: 100, cost: 0.005 } }],
  ].reduce((st, [type, f]) => reduce(st, e(type, f)), state);
  const { u, root, chart, readout } = usageHarness();
  u.render(teamRunView({ state: s }).usage, {});
  const spoken = root.querySelector('p[role="status"]');
  assert.deepEqual([spoken.getAttribute('aria-live'), spoken.className, spoken.textContent], ['polite', 'sr-only', '']);
  const pressed = () => root.querySelectorAll('button[data-metric]').map((b) => [b.textContent, b.getAttribute('aria-pressed'), b.type]);
  assert.deepEqual(pressed(), [['Cost', 'true', 'button'], ['Tokens', 'false', 'button']]);

  // keys: the newest point first, then back and forth; each point is shown and said once
  chart.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(readout.textContent, '3s · $0.030 total · Dwight $0.030');
  assert.equal(spoken.textContent, readout.textContent, 'what the keys reach is announced politely');
  assert.equal(root.querySelector('svg').children.at(-1).getAttribute('class'), 'chart-cursor', 'a marker on the point');
  chart.dispatch('keydown', { key: 'Home' });
  assert.equal(readout.textContent, '0s · $0.010 total · Dwight $0.010');
  chart.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(readout.textContent, '0s · $0.010 total · Dwight $0.010', 'it stops at the first point');
  chart.dispatch('keydown', { key: 'End' });
  assert.equal(readout.textContent, '4s · $0.035 total · Dwight $0.030 · Angela $0.005');
  let prevented = 0;
  chart.dispatch('keydown', { key: 'ArrowRight', preventDefault: () => { prevented += 1; } });
  chart.dispatch('keydown', { key: 'Tab', preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, 'only the keys it uses are taken');
  chart.dispatch('keydown', { key: 'Escape' });
  assert.equal(readout.textContent, 'Latest: $0.035 after 4s');
  assert.notEqual(root.querySelector('svg').children.at(-1).getAttribute('class'), 'chart-cursor');

  // the pointer: the value under it is that of the last call before it, and nothing is announced
  const svg = root.querySelector('svg');
  svg.getBoundingClientRect = () => ({ left: 100, width: 640 });
  spoken.textContent = '';
  chart.dispatch('pointermove', { clientX: 100 + 640 * 0.9 });
  assert.match(readout.textContent, /^3s · \$0\.030 total/);
  assert.equal(spoken.textContent, '');
  chart.dispatch('pointerleave');
  assert.equal(readout.textContent, 'Latest: $0.035 after 4s');

  // tokens instead of cost: the same component, another series
  root.querySelectorAll('button[data-metric]')[1].click();
  assert.deepEqual(pressed().map((p) => p[1]), ['false', 'true']);
  assert.equal(readout.textContent, 'Latest: 3.5k after 4s');
  assert.match(chart.getAttribute('aria-label'), /^Cumulative tokens over 4s: 3\.5k \(Dwight 3\.0k, Angela 500\)/);
  // the choice holds when the next figures come in
  u.render(teamRunView({ state: reduce(s, e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 500, output: 0, cost: 0.001 } })) }).usage, {});
  assert.equal(readout.textContent, 'Latest: 4.0k after 5s');
});

test('usage: an estimated cost is marked, and a run without cost per call draws tokens and says why cost is empty', () => {
  const { u, root, chart } = usageHarness();
  const usage = {
    run: { cost: 0.031, tokens: 14200, input: 12400, output: 1800, calls: 4, estimated: true }, hasCost: true, costSeries: false, chat: null,
    agents: [{ id: 'planner', name: 'Planner', calls: 1, tokens: 10000, input: 9000, output: 1000, cost: 0, share: 1 }],
    series: [{ at: T0 + 5000, tokens: 10000, cost: null, by: { planner: { tokens: 10000, cost: null } } }], startedAt: T0,
  };
  u.render(usage, {});
  const fig = root.querySelector('.usage-fig');
  assert.deepEqual([fig.querySelector('.usage-value').textContent, fig.querySelector('.usage-est').textContent, fig.querySelector('.usage-est').hidden], ['~$0.031', 'estimated', false]);
  assert.ok(fig.querySelector('.usage-est').title, 'and it says what estimated means');
  assert.equal(root.querySelectorAll('.usage-fig')[1].hidden, true, 'no chat total where the server reports none');
  assert.deepEqual(root.querySelectorAll('button[data-metric]').map((b) => b.getAttribute('aria-pressed')), ['false', 'true'], 'tokens, because there is no cost to draw');
  assert.equal(chart.dataset.empty, 'false');
  root.querySelectorAll('button[data-metric]')[0].click();
  assert.deepEqual([chart.dataset.empty, root.querySelector('.chart-empty').textContent], ['true', 'This run reports no cost per call. Tokens can be shown instead.']);
  // the legend of the rail names the bands
  root.querySelectorAll('button[data-metric]')[1].click();
  assert.deepEqual(root.querySelector('.chart-legend').children.map((li) => li.children.map((n) => n.textContent)), [['', 'Planner', '10.0k']]);

  const css = read('styles.css');
  const section = css.match(/\/\* -+ live activity[^\n]*\*\/[\s\S]*?(?=\/\* -+ chat view \*\/)/)?.[0] ?? '';
  assert.ok(section.length > 4000, 'the live activity styles are found');
  assert.doesNotMatch(section, /animation|@keyframes|transition/, 'nothing in the rail, the lanes or the diagram moves on its own');
  assert.match(section, /\.chart-total \{[^}]*stroke: var\(--text\);/, 'the total in the text colour');
  assert.match(section, /\.chart-grid line \{ stroke: var\(--line\);/, 'a hairline grid');
  assert.match(section, /\.chart-grid text \{[^}]*var\(--mono\);[^}]*tabular-nums;/, 'mono tabular tick labels');
  for (let i = 0; i < 5; i += 1) {
    const hex = section.match(new RegExp(`--chart-${i}: #([a-f0-9]{6})`))?.[1];
    assert.ok(hex, `band ${i} has a grayscale tone`);
    assert.equal(hex.slice(0, 2), hex.slice(2, 4));
    assert.equal(hex.slice(0, 2), hex.slice(4, 6));
    const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const bg = read('styles.css').match(/--bg: #([a-f0-9]{6})/)[1];
    assert.ok((linear(parseInt(hex.slice(0, 2), 16) / 255) + 0.05) / (linear(parseInt(bg.slice(0, 2), 16) / 255) + 0.05) >= 3, `band ${i} contrasts at least 3:1 with the page`);
  }
  assert.match(section, /\.chart-band \{ stroke: var\(--bg\); stroke-width: 1\.5;/, 'a separating outline between adjacent tones');
  assert.doesNotMatch(section, /gradient\((?!transparent, #000)/, 'no gradient but the fade of the clamped text');
});

// ------------------------------------------------------------ instance lanes

test('lanes: the row says what the instance does now; the live text and files stand under it and change in place', () => {
  const { state } = run();
  const $ = installTree();
  const list = document.createElement('ul');
  const lanes = createLanes({ block: $('lanes-block'), list, exec: $('lanes-exec') });
  lanes.render(state, teamRunView({ state, live: LIVE('Reading the README first.') }));
  const row = (id) => list.children.find((li) => li.dataset.lane === id);
  const dwight = row('dwight-m1');
  assert.equal(dwight.querySelector('.lane-activity').textContent, 'Editing src/cli.js', 'the same words as the rail and the board');
  assert.equal(dwight.children.length, 7, 'the live block is the row\'s last part');
  assert.deepEqual([dwight.querySelector('.live-label').textContent, dwight.querySelector('.live-text').textContent], ['Reasoning', 'Reading the README first.']);
  assert.equal(dwight.querySelector('.live-body').getAttribute('aria-live'), 'off');
  assert.deepEqual(dwight.querySelector('.live-files').children.map((li) => li.textContent), ['editedsrc/cli.js', 'readREADME.md']);
  assert.equal(row('michael').querySelector('.live').hidden, true);

  // only the live text changed: no row is built again
  lanes.render(state, teamRunView({ state, live: LIVE('Reading the README first. Now the CLI.') }));
  assert.equal(row('dwight-m1'), dwight);
  assert.equal(dwight.querySelector('.live-text').textContent, 'Reading the README first. Now the CLI.');
  // without a run view (a caller that only has the state) the lane still says the line
  const plain = document.createElement('ul');
  createLanes({ block: $('lanes-block'), list: plain, exec: $('lanes-exec') }).render(state);
  assert.equal(plain.children.find((li) => li.dataset.lane === 'dwight-m1').querySelector('.lane-activity').textContent, 'Editing src/cli.js');
});

// ------------------------------------------------------------ the /live poll

function pollHarness({ answers = [], url = '/api/projects/p/chats/c/live' } = {}) {
  const h = { asked: [], changes: 0, wanted: true, url, timers: [], visibility: 'visible', listeners: [], now: 1000 };
  const doc = { get visibilityState() { return h.visibility; }, addEventListener: (type, fn) => h.listeners.push(fn) };
  const timers = { setTimeout: (fn, ms) => { h.timers.push({ fn, ms }); return h.timers.length; }, clearTimeout: (id) => { if (id) h.timers[id - 1] = null; } };
  h.poll = createLivePoll({
    url: () => h.url, wanted: () => h.wanted, onChange: () => { h.changes += 1; }, timers, doc, now: () => h.now,
    fetch: async (at, opts) => {
      h.asked.push([at, opts.headers['X-Scranton-Client'], opts.cache]);
      const a = answers.shift() ?? { status: 200, body: { v: 1, runId: null, updatedAt: null, instances: {} } };
      if (a.throws) throw new Error('offline');
      return { ok: a.status === 200, status: a.status, json: async () => a.body };
    },
  });
  h.settle = () => new Promise((r) => setTimeout(r, 5));
  // run the timer the poll armed last
  h.tick = async () => {
    const t = h.timers.findLast((x) => x);
    h.timers[h.timers.indexOf(t)] = null;
    t.fn();
    await h.settle();
  };
  h.armed = () => h.timers.filter(Boolean).map((t) => t.ms);
  return h;
}
const TAILS = (text) => ({ v: 1, runId: RUN, updatedAt: 'x', instances: { 'dwight-m1': { agent: 'dwight', phase: 'thinking', thinking: text, text: null } } });

test('live poll: once a second, only while the run on screen is live and the page is visible', async () => {
  const h = pollHarness({ answers: [{ status: 200, body: TAILS('one') }, { status: 200, body: TAILS('one') }, { status: 200, body: TAILS('two') }] });
  h.wanted = false;
  h.poll.sync();
  assert.deepEqual([h.asked.length, h.armed()], [0, []], 'no run is live: nothing is asked');
  h.wanted = true;
  h.poll.sync();
  h.poll.sync();
  await h.settle();
  assert.deepEqual(h.asked, [['/api/projects/p/chats/c/live', '1', 'no-store']], 'one request, with the client header, however often the page renders');
  assert.deepEqual([h.poll.get().doc.instances['dwight-m1'].thinking.body, h.poll.get().at, h.changes], ['one', 1000, 1]);
  assert.deepEqual(h.armed(), [LIVE_POLL_MS]);
  assert.equal(LIVE_POLL_MS, 1000);

  // the same answer again: the tails stay fresh, and nothing is drawn again
  h.now = 2000;
  await h.tick();
  assert.deepEqual([h.asked.length, h.changes, h.poll.get().at], [2, 1, 2000]);
  await h.tick();
  assert.deepEqual([h.poll.get().doc.instances['dwight-m1'].thinking.body, h.changes], ['two', 2]);

  // the page is hidden: the poll stops and the tails go; visible again, it asks at once
  h.visibility = 'hidden';
  for (const fn of h.listeners) fn();
  assert.deepEqual([h.armed(), h.poll.get(), h.changes], [[], null, 3]);
  h.poll.sync();
  await h.settle();
  assert.equal(h.asked.length, 3);
  h.visibility = 'visible';
  for (const fn of h.listeners) fn();
  await h.settle();
  assert.equal(h.asked.length, 4);
  // the run ended: the next tick asks nothing more
  h.wanted = false;
  await h.tick();
  assert.deepEqual([h.asked.length, h.armed(), h.poll.get()], [4, [], null]);
});

test('live poll: a 404 turns the feature quietly off; an error hides the tails and is tried again later', async () => {
  const h = pollHarness({ answers: [{ status: 404, body: { error: 'Not found' } }] });
  h.poll.sync();
  await h.settle();
  assert.deepEqual([h.poll.get(), h.poll.off(), h.changes], [null, true, 0], 'nothing was shown, nothing changes, nothing is said');
  await h.tick();
  h.poll.sync();
  await h.settle();
  assert.deepEqual([h.asked.length, h.armed()], [1, []], 'a server without the route is not asked again');
  // another chat may have it
  h.poll.reset();
  h.url = '/api/projects/p/chats/other/live';
  assert.equal(h.poll.off(), false);
  h.poll.sync();
  await h.settle();
  assert.equal(h.asked.length, 2);

  const e = pollHarness({ answers: [{ status: 200, body: TAILS('one') }, { throws: true }, { status: 500, body: null }, { status: 200, body: 'garbage' }, { status: 200, body: TAILS('back') }] });
  e.poll.sync();
  await e.settle();
  assert.equal(e.changes, 1);
  for (const what of ['the network failed', 'the server failed', 'the answer was no live document']) {
    await e.tick();
    assert.deepEqual([e.poll.get(), e.poll.off(), e.armed()], [null, false, [LIVE_RETRY_MS]], what);
  }
  assert.equal(e.changes, 2, 'the tails went once');
  await e.tick();
  assert.equal(e.poll.get().doc.instances['dwight-m1'].thinking.body, 'back');
  // no chat on screen: no address, no request
  const none = pollHarness({ url: null });
  none.poll.sync();
  await none.settle();
  assert.equal(none.asked.length, 0);
});

// ------------------------------------------------------------ the page

test('page: the rail is a column beside the main column, the dashboard shows the board instead of a milestone list', () => {
  const html = read('index.html');
  const main = html.slice(html.indexOf('<div class="main" id="main-col">'), html.indexOf('<aside class="rail" id="run-rail"'));
  assert.ok(main.length > 5000 && main.trimEnd().endsWith('</div>'), 'the rail follows the main column: it scrolls on its own and adds nothing to the page');
  assert.match(html, /<aside class="rail" id="run-rail" aria-labelledby="rail-title" hidden>/, 'out of sight until a run is on screen in the Chat view');
  assert.match(html, /id="rail-status" role="status" aria-live="polite"/, 'status changes are polite');
  assert.match(html, /<button type="button" class="btn btn-small rail-toggle" id="rail-toggle" aria-expanded="false" aria-controls="run-rail"[^>]*hidden>/);
  assert.ok(html.indexOf('id="rail-toggle"') > html.indexOf('id="view-mode-toggle"') && html.indexOf('id="rail-toggle"') < html.indexOf('id="thread-runs"'), 'the toggle is in the chat header');
  assert.ok(html.indexOf('id="run-live-line"') > html.indexOf('id="chat-view"') && html.indexOf('id="run-live-line"') < html.indexOf('id="followup"'), 'the live line is above the composers');
  assert.match(html, /<button type="button" class="rail-board" id="rail-board" aria-haspopup="dialog">/);
  assert.match(html, /<dialog class="sheet" id="board-dialog" aria-labelledby="board-dialog-title">/);
  assert.match(html, /<dialog class="drawer" id="rail-dialog" aria-labelledby="rail-dialog-title">/);
  // the dashboard: one board, no second list of the same milestones
  assert.match(html, /<main class="dash" id="dash">\s*<section class="section board-panel" aria-labelledby="h-board">/, 'the board leads the dashboard, across both columns');
  assert.doesNotMatch(html, /id="milestones"|milestones-panel/);
  assert.match(html, /<section class="section usage-panel" aria-labelledby="h-usage">/);
  assert.match(html, /<dt>Cost<\/dt>\s*<dd><span class="fig-value" id="kpi-cost">/, 'the cost is a first-class figure of the run line');
  assert.ok(html.indexOf('id="kpi-cost"') < html.indexOf('id="run-more-toggle"'), 'not behind More figures');
  // a pipeline chat's Details get the same two panels
  assert.match(html, /id="pv-live" hidden>[\s\S]*id="pv-board"[\s\S]*id="pv-usage"/);

  const css = read('styles.css');
  assert.match(css, /--rail-w: 22rem;/);
  assert.match(css, /\.rail \{[^}]*flex: 0 0 var\(--rail-w\);[^}]*overflow: hidden;/);
  assert.match(css, /\.rail-body \{[^}]*overflow: hidden auto;/, 'the rail scrolls on its own');
  assert.match(css, /\.dash > \.board-panel \{ grid-column: 1 \/ -1; \}/);
  // the dashboard reads the usage of the run, which counts every call as it is reported
  const dashboard = read('js/dashboard.js');
  assert.match(dashboard, /e\.kCost\.textContent = formatCost\(u\.cost\);/);
  assert.doesNotMatch(dashboard, /renderMilestones|\$\('milestones'\)/);
});

test('usage: token shares are named when a priced Pipeline run has no per-agent costs', () => {
  const { u, root } = usageHarness({ table: true });
  u.render({
    run: { cost: 0.031, tokens: 400, input: 320, output: 80, calls: 2, estimated: true },
    shareMetric: 'tokens', hasCost: true, costSeries: false, chat: null, startedAt: T0,
    agents: [{ id: 'planner', name: 'Planner', tokens: 300, calls: 1, cost: null, share: 0.75 }, { id: 'implementer', name: 'Implementer', tokens: 100, calls: 1, cost: null, share: 0.25 }],
    series: [{ at: T0 + 1000, tokens: 400, cost: null, by: { planner: { tokens: 300, cost: null }, implementer: { tokens: 100, cost: null } } }],
  });
  const table = root.querySelector('.usage-table');
  assert.equal(table.querySelector('thead').querySelectorAll('th').at(-1).textContent, 'Token share');
  assert.deepEqual(table.querySelector('tbody').children.map((r) => r.children.slice(-2).map((c) => c.textContent)), [['-', '75%'], ['-', '25%']]);
  assert.equal(root.querySelector('.usage-value').textContent, '~$0.031');
});

test('Dashboard allocates a page scroller, compact composer, bounded Board and independent Activity viewport', () => {
  // Structural guards only. Real viewport measurements belong to the Browser-panel integration check.
  const css = read('styles.css');
  assert.match(css, /body\[data-view="dashboard"\] \.main \{[^}]*height: calc\(100dvh - var\(--topbar-h\)\);[^}]*overflow-y: auto;/);
  assert.match(css, /body\[data-view="dashboard"\] \.main > \* \{ flex-shrink: 0; \}/);
  assert.match(css, /body\[data-view="dashboard"\]\[data-run="yes"\] \.followup:not\(\[data-off="true"\]\) textarea \{ height: 3\.25rem; min-height: 3\.25rem; \}/);
  assert.match(css, /\.board-panel \.board-cols \{[^}]*max-height: min\(17rem, 28vh\);/);
  assert.match(css, /\.board-panel \.board-cards \{ overflow: hidden auto;/);
  assert.match(css, /\.board-panel \.board-cols \{ grid-template-rows: none; max-height: min\(26rem, 55vh\); overflow-y: auto;/, 'stacked columns scroll as a board');
  assert.match(css, /\.activity-panel \{ height: clamp\(20rem, 55vh, 36rem\); min-height: 0; \}/);
  assert.match(css, /\.dash \.lanes \{ max-height: 20rem; overflow-y: auto;/);
  assert.doesNotMatch(css, /\.dash-main \{[^}]*overflow:/, 'Usage remains in the page flow below agent history, not a clipped inner dashboard');
});

test('serial JSON rail and Dashboard show role tails, current tools and recent files without instance lanes', () => {
  const e = journal();
  let state = reduceAll([
    e('run_started', { request: 'Fix it', workspace: 'C:\\ws' }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One' }] }),
    e('milestone_started', { milestoneId: 'm1', title: 'One', index: 0, total: 1 }),
    e('agent_status', { agent: 'dwight', status: 'thinking', activity: 'Thinking...' }),
    e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 10, output: 2, cost: 0.001 } }),
    e('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'edit', detail: 'src/a.js', targetFile: 'src/a.js' }),
    e('agent_status', { agent: 'dwight', status: 'working', activity: 'Working...' }),
  ]);
  const h = railHarness();
  const list = document.createElement('ul');
  const heading = document.createElement('h3');
  const block = h.$('lanes-block');
  block.append(heading, list);
  const dashboard = createLanes({ block, list, exec: h.$('lanes-exec') });
  dashboard.setMessageable(() => true);
  const live = LIVE('The serial edit.');
  const draw = () => {
    const view = teamRunView({ state, live });
    h.rail.render(view);
    dashboard.render(state, view);
  };
  draw();
  assert.equal(h.act('Dwight').querySelector('.live-text').textContent, 'The serial edit.');
  assert.equal(h.act('Dwight').querySelector('.act-line').textContent, 'Editing src/a.js');
  assert.deepEqual(h.act('Dwight').querySelector('.live-files').children.map((li) => li.textContent), ['editedsrc/a.js']);
  assert.equal(heading.textContent, 'Role activity');
  assert.equal(block.hidden, false, 'serial runs without execution metadata still show their activity');
  assert.equal(h.$('lanes-exec').textContent, '3 roles · 1 busy');
  assert.equal(list.querySelectorAll('[data-lane]').length, 0, 'no invented lane identities');
  assert.equal(list.querySelectorAll('button[data-message]').length, 0, 'JSON roles are not RPC chat targets');
  const row = (id) => list.querySelector(`[data-role="${id}"]`);
  const dwight = row('dwight');
  assert.equal(dwight.querySelector('.lane-name').textContent, 'Dwight');
  assert.equal(dwight.querySelector('.lane-activity').textContent, 'Editing src/a.js');
  assert.equal(dwight.querySelector('.live-text').textContent, 'The serial edit.');
  assert.deepEqual(dwight.querySelector('.live-files').children.map((li) => li.textContent), ['editedsrc/a.js']);
  assert.deepEqual(state.instances, {});

  live.doc.instances['dwight-m1'].thinking.body = 'The serial edit, continued.';
  draw();
  assert.equal(row('dwight'), dwight, 'tail updates do not rebuild the role row');
  assert.equal(dwight.querySelector('.live-text').textContent, 'The serial edit, continued.');
  state = reduce(state, e('agent_finished', { agent: 'dwight', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, usage: { input: 10, output: 2, cost: 0.001 } }));
  state = reduce(state, e('agent_status', { agent: 'angela', status: 'thinking', activity: 'Thinking...' }));
  state = reduce(state, e('agent_tool', { agent: 'angela', instanceId: 'angela-m1', tool: 'read', detail: 'src/a.js', targetFile: 'src/a.js' }));
  state = reduce(state, e('agent_status', { agent: 'angela', status: 'working', activity: 'Working...' }));
  live.doc.instances['angela-m1'] = parseLive({ instances: { 'angela-m1': { agent: 'angela', phase: 'text', text: 'The serial check.' } } }).instances['angela-m1'];
  draw();
  assert.equal(row('dwight').querySelector('.live-body').hidden, true, 'finished roles hide leftover ephemeral tails');
  assert.equal(row('angela').querySelector('.lane-activity').textContent, 'Reading src/a.js');
  assert.equal(row('angela').querySelector('.live-text').textContent, 'The serial check.');
  assert.deepEqual(row('angela').querySelector('.live-files').children.map((li) => li.textContent), ['readsrc/a.js']);
  assert.equal(h.act('Angela').querySelector('.live-text').textContent, 'The serial check.');
  assert.deepEqual(state.instances, {});

  const rpc = run().state;
  dashboard.render(rpc, teamRunView({ state: rpc }));
  assert.equal(heading.textContent, 'Instance lanes');
  assert.equal(list.querySelectorAll('[data-role]').length, 0);
  assert.deepEqual(list.querySelectorAll('[data-lane]').map((li) => li.dataset.lane), ['michael', 'dwight-m1']);
  assert.equal(list.querySelectorAll('button[data-message]').length, 2, 'RPC messageability is unchanged');
});

test('Pipeline rail: cancelled or rejected plan approval renders the stopped planner after finalize', () => {
  for (const terminal of ['cancelled', 'rejected']) for (const revised of [false, true]) {
    const e = (type, node = null, data = {}) => ({ type, node, data });
    const events = [
      ...(revised ? [e('agent_message', null, { role: 'implementer', text: 'Earlier work completed.' }), e('node_finished', 'verify', { duration_s: 0.1 }), e('node_finished', 'replan', { duration_s: 0.1 })] : []),
      e('node_started', 'plan'), e('agent_message', null, { role: 'planner', text: 'The proposed plan.' }), e('node_finished', 'plan', { duration_s: 0.1 }),
      e('route', null, { from: 'plan', to: 'approve_plan', reason: 'plan_valid' }), e('node_started', 'approve_plan'),
      e('gate_waiting', null, { gate: 'plan', digest: 'abc' }), e('run_resumed'), e('node_started', 'approve_plan'),
      ...(terminal === 'rejected' ? [e('gate_decided', null, { gate: 'plan', decision: 'reject', by: 'human' })] : []),
      e('node_finished', 'approve_plan', { duration_s: 0.1 }), e('route', null, { from: 'approve_plan', to: 'finalize', reason: terminal }),
      e('node_started', 'finalize'), e('run_finished', null, { status: terminal }), e('node_finished', 'finalize', { duration_s: 0.1 }),
    ].map((event, i) => ({ ...event, seq: i + 1, ts: new Date(T0 + i * 1000).toISOString(), run_id: 'abc123def456' }));
    const doc = parseRunDoc({ status: {
      run_id: 'abc123def456', status: terminal, phase: 'done', node: 'finalize', pending: null,
      progress: { step_index: -1, step_count: 1, plan_revision: revised ? 1 : 0 },
    }, events, stepsDone: revised ? ['previous'] : [] });
    const h = railHarness();
    h.rail.render(pipelineRunView({ run: { ...doc, runId: 'abc123def456' } }));
    const shown = (name) => {
      const row = h.act(name);
      return [row.dataset.status, row.querySelector('.act-status').textContent, row.querySelector('.act-line').textContent, row.querySelector('.act-glyph').textContent];
    };
    assert.deepEqual(shown('Planner'), [terminal, terminal, terminal === 'cancelled' ? 'Cancelled' : 'Rejected', '–']);
    assert.equal(h.act('Planner').dataset.live, 'false');
    assert.equal(h.act('Planner').querySelector('.live-text').textContent, 'The proposed plan.');
    assert.deepEqual(shown('Implementer'), revised ? ['done', 'done', 'Done', '✓'] : ['idle', 'idle', 'Not started', '○']);
    assert.deepEqual(shown('Reviewer'), ['idle', 'idle', 'Not started', '○']);
    assert.equal(h.$('rail-status').textContent, 'ended · 3 agents');
  }
});

for (const terminal of ['cancelled', 'failed', 'suspended', 'succeeded']) test(`Pipeline rail: ${terminal} implementation renders its status, label and glyph`, () => {
  for (const parallel of [false, true]) {
    const e = (type, node = null, data = {}) => ({ type, node, data });
    const events = [
      e('agent_message', null, { role: 'planner', text: 'Plan.' }),
      e('agent_message', null, { role: 'implementer', text: 'Last work.' }), e('node_started', 'verify'),
      ...(terminal === 'suspended' ? [e('warning', null, { code: 'suspended', message: 'Execution suspended (OSError)' })] : [
        e('node_finished', 'verify', { duration_s: 0.1 }),
        e('route', null, { from: 'verify', to: terminal === 'succeeded' ? 'select_step' : 'finalize', reason: terminal === 'failed' ? 'failure' : terminal === 'succeeded' ? 'checks_passed' : 'cancelled' }),
        ...(terminal === 'succeeded' ? [e('node_finished', 'select_step', { duration_s: 0.1 }), e('node_finished', 'ground', { duration_s: 0.1 }), e('node_finished', 'package', { duration_s: 0.1 })] : []),
        e('node_started', 'finalize'), e('run_finished', null, { status: terminal }), e('node_finished', 'finalize', { duration_s: 0.1 }),
      ]),
    ].map((event, i) => ({ ...event, seq: i + 1, ts: new Date(T0 + i * 1000).toISOString(), run_id: 'abc123def456' }));
    const doc = parseRunDoc({ status: {
      run_id: 'abc123def456', status: terminal, phase: terminal === 'suspended' ? 'implement' : 'done', node: terminal === 'suspended' ? 'verify' : 'finalize',
      failure: terminal === 'failed' ? { failure_class: 'checks_failed', code: 'checks_exhausted', message: 'Checks failed', node: 'verify' } : null,
      progress: { step_index: 0, step_count: 2, lanes: parallel ? [{ step_id: 's1', title: 'One', state: 'running' }, { step_id: 's2', title: 'Two', state: 'running' }] : [] },
    }, events, stepsDone: terminal === 'succeeded' ? ['s1', 's2'] : [] });
    const view = pipelineRunView({ run: { ...doc, runId: 'abc123def456' } });
    const h = railHarness();
    h.rail.render(view);
    const expected = terminal === 'failed' ? ['error', 'Failed: Checks failed', '✕'] : terminal === 'suspended' ? ['blocked', 'Suspended', '■']
      : terminal === 'succeeded' ? ['done', 'Done', '✓'] : ['cancelled', 'Cancelled', '–'];
    const rows = h.acts().filter((row) => row.querySelector('.act-name').textContent === 'Implementer');
    assert.equal(rows.length, parallel && terminal !== 'succeeded' ? 2 : 1);
    for (const row of rows) {
      assert.deepEqual([row.dataset.status, row.querySelector('.act-line').textContent, row.querySelector('.act-glyph').textContent], expected);
      assert.equal(row.querySelector('.act-status').textContent, expected[0]);
    }
    assert.ok(view.agents.every((a) => !a.busy));
    assert.deepEqual([h.act('Planner').dataset.status, h.act('Planner').querySelector('.act-glyph').textContent], ['done', '✓']);
    assert.deepEqual([h.act('Reviewer').dataset.status, h.act('Reviewer').querySelector('.act-glyph').textContent], ['idle', '○']);
  }
});

test('Pipeline llm_call-only fallback renders unknown role cost beside the estimated run cost', () => {
  const doc = parseRunDoc({ status: {
    run_id: 'abc123def456', status: 'running', phase: 'implement',
    usage: { calls: 2, input_tokens: 320, output_tokens: 80, estimated_cost: 0.031 },
  }, events: [
    { seq: 1, ts: '2026-11-12T09:00:01Z', type: 'llm_call', data: { role: 'planner', input_tokens: 240, output_tokens: 60 } },
    { seq: 2, ts: '2026-11-12T09:00:02Z', type: 'llm_call', data: { role: 'implementer', input_tokens: 80, output_tokens: 20 } },
  ] });
  assert.equal(doc.usage, null, 'no ledger from an older server');
  const view = pipelineRunView({ run: { ...doc, runId: 'abc123def456', calls: foldCalls(null, doc.events) } });
  const { u, root } = usageHarness({ table: true });
  u.render(view.usage, {});
  assert.equal(root.querySelector('.usage-value').textContent, '~$0.031');
  const table = root.querySelector('.usage-table');
  assert.equal(table.querySelector('thead').querySelectorAll('th').at(-1).textContent, 'Token share');
  assert.deepEqual(table.querySelector('tbody').children.map((r) => r.children.slice(-2).map((c) => c.textContent)), [['-', '75%'], ['-', '25%']]);
});

for (const terminal of ['cancelled', 'succeeded']) test(`Pipeline view activity reaches the rail with ${terminal} terminal history`, async (t) => {
  const h = railHarness();
  const runId = '9db9802d53e9';
  const e = (type, node = null, data = {}) => ({ type, node, data });
  const events = [
    e('node_started', 'plan'), e('agent_message', null, { role: 'planner', text: 'Correct independent addition and multiplication bugs' }),
    e('node_finished', 'plan', { duration_s: 0.1 }), e('node_started', 'approve_plan'),
    e('gate_waiting', null, { gate: 'plan', digest: 'plan-digest' }), e('run_resumed'), e('node_started', 'approve_plan'),
    ...(terminal === 'cancelled' ? [e('route', null, { from: 'approve_plan', to: 'finalize', reason: 'cancelled' })] : [
      e('gate_decided', null, { gate: 'plan', decision: 'approve', by: 'human' }),
      e('node_finished', 'approve_plan', { duration_s: 0.1 }), e('node_started', 'implement'),
      e('agent_message', null, { role: 'implementer', text: 'Both functions corrected.' }), e('edits_applied', null, { files: ['calculator.py'] }),
      e('node_finished', 'verify', { duration_s: 0.1 }), e('agent_message', null, { role: 'reviewer', text: 'Checks and review passed.' }),
      e('node_finished', 'review', { duration_s: 0.1 }), e('node_finished', 'package', { duration_s: 0.1 }),
    ]),
    e('node_started', 'finalize'), e('run_reply', null, { kind: 'answer', text: terminal === 'cancelled' ? 'Run cancelled.' : 'Delivered.' }),
    e('result', null, { status: terminal }), e('run_finished', null, { status: terminal }), e('node_finished', 'finalize', { duration_s: 0.1 }),
  ].map((event, i) => ({ ...event, seq: i + 1, ts: new Date(T0 + i * 1000).toISOString(), run_id: runId }));
  const status = {
    run_id: runId, status: terminal, phase: 'done', node: 'finalize', task: 'Fix calculator', pending: null,
    progress: { step_index: terminal === 'cancelled' ? -1 : 0, step_count: 1 }, artifacts: {},
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => url.endsWith('/pipeline')
    ? { active: null, runs: [{ runId, status: terminal, phase: 'done', task: status.task }] }
    : { status, live: false, events, lastSeq: events.at(-1).seq, plan: { summary: 'Fix calculator', steps: [{ id: 's1', title: 'Correct both functions', files: [] }] }, stepsDone: terminal === 'succeeded' ? ['s1'] : [], stepsDoneExact: true } });
  const view = createPipelineView({ timers: { setTimeout: () => 1, clearTimeout() {} } });
  t.after(() => { view.hide(); globalThis.fetch = oldFetch; });
  view.show({ project: 'core', chat: 'c1' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  h.rail.render(pipelineRunView(view.activity()));
  const planner = h.act('Planner');
  const expected = terminal === 'cancelled' ? ['cancelled', 'Cancelled', '–'] : ['done', 'Done', '✓'];
  assert.deepEqual([planner.dataset.status, planner.querySelector('.act-line').textContent, planner.querySelector('.act-glyph').textContent], expected);
  assert.equal(planner.querySelector('.act-status').textContent, expected[0]);
  assert.equal(planner.querySelector('.live-text').textContent, 'Correct independent addition and multiplication bugs');
  assert.equal(planner.dataset.live, 'false');
  for (const name of ['Implementer', 'Reviewer']) assert.equal(h.act(name).dataset.status, terminal === 'cancelled' ? 'idle' : 'done');
  assert.equal(pipelineRunView(view.activity()).board.counts.done, terminal === 'succeeded' ? 1 : 0);
  if (terminal === 'succeeded') assert.deepEqual(h.act('Implementer').querySelector('.live-files').children.map((li) => li.textContent), ['editedcalculator.py']);
  assert.ok(view.chat().run.events.every((event) => !['node_started', 'node_finished', 'route'].includes(event.type)), 'the transcript remains filtered');
});

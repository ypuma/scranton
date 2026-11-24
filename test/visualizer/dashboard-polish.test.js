// The dashboard's chrome after the polish pass: one look for a status wherever it is shown, an agent card whose
// meta line is never cut, a chat header that says its names in full on hover, and the style rules behind the
// scrollbars, the event filter and the event log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statusTone } from '../../visualizer/public/js/status-tone.js';
import { createPipeline } from '../../visualizer/public/js/pipeline.js';
import { createBoard, cardTone } from '../../visualizer/public/js/board.js';
import { createLanes } from '../../visualizer/public/js/lanes.js';
import { createDashboard } from '../../visualizer/public/js/dashboard.js';
import { createThread } from '../../visualizer/public/js/thread.js';
import { createScope, parseProjects } from '../../visualizer/public/js/scope.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { installDom } from './fixtures/fake-dom.js';
import { installTree, TreeEl } from './fixtures/tree-dom.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const rule = (selector) => {
  const found = rules.find((r) => r.selector === selector);
  assert.ok(found, `no rule for ${selector}`);
  return found.body;
};

// a run whose planner has finished and whose developer works in a lane of its own
function run(extra = []) {
  let seq = 0;
  const e = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: `2026-11-24T10:00:${String(seq).padStart(2, '0')}Z`, runId: 'r1', type, ...fields });
  return reduceAll([
    e('run_started', { request: 'Build', workspace: 'C:\\w' }),
    e('instance_started', { agent: 'michael', instanceId: 'michael', milestoneId: 'plan' }),
    e('agent_tool', { agent: 'michael', instanceId: 'michael', tool: 'read', detail: 'docs/a/very/long/path/to/the/architecture-notes.md' }),
    e('agent_finished', { agent: 'michael', instanceId: 'michael', keyword: 'PLAN_READY', exitCode: 0, durationMs: 1000, usage: { input: 1200, output: 300, cost: 0.02 } }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'Site' }] }),
    e('milestone_started', { milestoneId: 'm1', title: 'Site', index: 0, total: 1 }),
    e('instance_started', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1' }),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'working', activity: 'Writing index.html' }),
    ...extra.map(([type, fields]) => e(type, fields)),
  ]);
}

test('status tones: one tone per status, as the brief of the pass names them', () => {
  const tones = (words) => [...new Set(words.map(statusTone))];
  assert.deepEqual(tones(['done', 'passed', 'succeeded', 'finished']), ['ok']);
  assert.deepEqual(tones(['starting', 'thinking', 'working', 'running', 'planning']), ['run']);
  assert.deepEqual(tones(['waiting', 'paused', 'blocked', 'stopped', 'cancelled', 'rejected', 'interrupted']), ['warn']);
  assert.deepEqual(tones(['failed', 'error', 'aborted', 'exited']), ['bad']);
  assert.deepEqual(tones(['idle', 'pending', 'to do', 'unused', undefined, 'something new']), ['quiet'], 'a status that says nothing yet has no tone');
  for (const tone of ['ok', 'run', 'warn', 'bad']) {
    const body = rule(`.badge[data-tone="${tone}"]`);
    assert.match(body, new RegExp(`background: var\\(--${tone}-bg\\); border-color: var\\(--${tone}-line\\); color: var\\(--${tone}\\);`), `${tone} is built from its three tokens`);
  }
});

test('agent cards: the status is a badge with the tone of its word, set on the node that is kept', () => {
  installTree();
  const root = new TreeEl('div');
  const pipeline = createPipeline(root);
  const card = (id) => root.querySelector(`[data-node="${id}"]`);
  const status = (id) => card(id).querySelector('.status');
  pipeline.render(null);
  assert.deepEqual([status('michael').className, status('michael').dataset.tone, status('michael').textContent], ['badge status', 'quiet', '○idle']);
  const before = status('dwight');
  pipeline.render(run());
  assert.equal(status('dwight'), before, 'the badge is updated in place');
  assert.deepEqual([status('dwight').dataset.tone, status('dwight').querySelector('.status-word').textContent], ['run', 'working']);
  pipeline.render(run([['run_finished', { status: 'success' }]]));
  assert.deepEqual([status('michael').dataset.tone, status('michael').querySelector('.status-word').textContent], ['ok', 'done']);
  pipeline.render(run([['agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'error', activity: 'Failed: tests' }]]));
  assert.equal(status('dwight').dataset.tone, 'bad');
  pipeline.render(run([['agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'blocked', activity: 'Blocked: no access' }]]));
  assert.equal(status('dwight').dataset.tone, 'warn', 'blocked waits on someone');
});

test('agent cards: the meta line is labelled parts that wrap; closed it leaves the last tool to the opened list', () => {
  installTree();
  const root = new TreeEl('div');
  const pipeline = createPipeline(root);
  pipeline.render(run());
  const card = root.querySelector('[data-node="michael"]');
  const meta = card.querySelector('.agent-meta');
  assert.equal(meta.tagName, 'SUMMARY');
  assert.equal(meta.className, 'agent-meta', 'the line is set in the interface face; a keyword and a tool are mono by their own rule');
  const parts = meta.children.map((part) => [part.className, part.querySelector('.meta-label').textContent, part.querySelector('.meta-value').textContent]);
  assert.deepEqual(parts, [
    ['fact-keyword', 'Keyword ', 'PLAN_READY'],
    ['fact-tool', 'Last tool ', 'read docs/a/very/long/path/to/the/architecture-notes.md'],
    ['agent-totals', 'Totals ', '1 run\u00a0· 1.5k tok\u00a0· $0.020'],
  ]);
  assert.deepEqual(meta.querySelector('.agent-totals').querySelector('.meta-value').children.map((n) => n.textContent), ['1 run', '1.5k tok', '$0.020'], 'each figure is one piece');
  assert.deepEqual([card.querySelector('h3').title, card.querySelector('.role').title], ['Planner: Breaks the request into milestones, judges progress when a milestone fails and, in a chat, writes the final reply.', card.querySelector('.role').textContent.replace('\u00a0', ' ')], 'what the agent does in full, and the role line in plain spaces, are a hover away');

  // drawn again only when it says something else: an opened line keeps its nodes, and so a selection in it
  const tool = () => meta.querySelector('.fact-tool').querySelector('.meta-value');
  const value = tool();
  card.querySelector('.agent-more').open = true;
  pipeline.render(run());
  assert.equal(tool(), value);
  assert.equal(card.querySelector('.agent-more').open, true);
  pipeline.render(run([['agent_tool', { agent: 'michael', instanceId: 'michael', tool: 'grep', detail: 'TODO' }]]));
  assert.equal(tool().textContent, 'grep TODO');

  // closed: whole parts that wrap, never one line cut with an ellipsis
  const line = rule('.agent-meta');
  assert.match(line, /display: flex;\s*flex-wrap: wrap;/);
  assert.doesNotMatch(line, /nowrap|ellipsis|overflow: hidden/);
  assert.match(rule('.agent-meta > span'), /min-width: 0; overflow-wrap: break-word;/);
  assert.match(rule('.agent-more:not([open]) .fact-tool'), /display: none/);
  assert.match(rule('.agent-totals .meta-value > span'), /white-space: nowrap/);
  // opened: label and value side by side, the value under its label when the card is narrow
  assert.match(rule('.agent-more[open] .agent-meta > span:not(:empty)'), /display: flex; flex-wrap: wrap;/);
  assert.match(rule('.agent-more[open] .meta-value'), /flex: 1 1 7rem; min-width: 0;/);
});

test('lanes and board cards: the state is the same badge, toned by the status and by the column', () => {
  installTree();
  const list = new TreeEl('ul');
  const block = new TreeEl('section');
  const lanes = createLanes({ block, list, exec: new TreeEl('span') });
  lanes.render(run());
  const states = list.querySelectorAll('.lane-state').map((n) => [n.className, n.textContent, n.dataset.tone]);
  assert.deepEqual(states, [['badge lane-state', 'idle', 'quiet'], ['badge lane-state', 'working', 'run']]);

  const card = (column, state) => ({ id: `${column}-1`, title: 'T', column, state, loud: column === 'blocked', note: '', reason: '', check: null, agents: [], gates: [], attempt: 0, failed: 0, criteria: [], description: '' });
  const cards = [card('todo', 'waiting'), card('in_progress', 'in progress'), card('in_review', 'in review'), card('blocked', 'needs you'), card('blocked', 'failed'), card('in_progress', 'lane failed'), card('done', 'done')];
  assert.deepEqual(cards.map(cardTone), ['quiet', 'run', 'run', 'warn', 'bad', 'bad', 'ok']);
  const root = new TreeEl('div');
  createBoard(root).render({
    kind: 'milestone', notice: null, note: '', empty: '',
    columns: ['todo', 'in_progress', 'in_review', 'blocked', 'done'].map((id) => ({ id, cards: cards.filter((c) => c.column === id).slice(0, 1) })),
  });
  assert.deepEqual(root.querySelectorAll('.card-state').map((n) => [n.className, n.textContent, n.dataset.tone]), [
    ['badge card-state', 'waiting', 'quiet'], ['badge card-state', 'in progress', 'run'], ['badge card-state', 'in review', 'run'],
    ['badge card-state', 'needs you', 'warn'], ['badge card-state', 'done', 'ok'],
  ]);
  // no loose coloured text is left beside the badge
  assert.doesNotMatch(css, /\.card-state \{[^}]*color:|\.lane-state \{[^}]*color:|\.card\[data-loud="true"\] \.card-state/);
});

test('run line: the state pill is a status badge and follows the run', () => {
  const $ = installTree();
  for (const className of ['pill-glyph', 'pill-text']) $('run-status').append(Object.assign(document.createElement('span'), { className }));
  const dashboard = createDashboard();
  const tone = (state) => {
    dashboard.render(state);
    return [$('run-status').dataset.status, $('run-status').dataset.tone];
  };
  assert.deepEqual(tone(null), ['idle', 'quiet']);
  assert.deepEqual(tone(run()), ['running', 'run']);
  assert.deepEqual(tone(run([['hitl_request', { milestoneId: 'm1', reason: 'Why', options: ['retry'] }]])), ['paused', 'warn']);
  assert.deepEqual(tone(run([['run_finished', { status: 'success' }]])), ['finished', 'ok']);
  assert.deepEqual(tone(run([['run_finished', { status: 'aborted' }]])), ['aborted', 'bad']);
  assert.match(read('index.html'), /<span class="pill badge" id="run-status" data-status="idle" data-tone="quiet">/);
});

test('chat header: the title and the project carry their full text, and the title takes two lines before it is cut', () => {
  const $ = installDom();
  globalThis.fetch = async () => { throw new Error('network'); };
  const long = 'Rework the onboarding flow so that a new user reaches a first passing run without reading the documentation';
  const doc = parseProjects({ mode: 'registry', projects: [{ id: 'core', name: 'A project with a long name', workspace: 'C:\\code\\core', chats: [{ id: 'a', title: long, status: 'done', runs: 1 }] }] });
  const thread = createThread({
    scope: createScope({ project: 'core', chat: 'a' }),
    nav: { doc: () => doc, refresh() {}, newChat() {}, newProject() {}, rename() {} },
    control: { snapshot: () => ({ control: { enabled: true }, mode: 'live', gates: { alive: false, recovery: false } }), openRun() {}, startFollowUp: async () => ({ ok: true }) },
    onReplay() {},
  });
  thread.activate();
  assert.deepEqual([$('thread-title').textContent, $('thread-title').title], [long, long]);
  assert.deepEqual([$('thread-project').textContent, $('thread-project').title], ['A project with a long name', 'A project with a long name\nC:\\code\\core']);
  // the sidebar's chat links say theirs as well
  assert.match(read('js/nav.js'), /a\.title = `\$\{c\.title\} · \$\{c\.label\}/);

  const title = rule('.thread-title');
  assert.match(title, /flex: 0 1 auto;\s*min-width: 0;/, 'it gives way, and takes what is free');
  assert.match(title, /display: -webkit-box;\s*-webkit-box-orient: vertical;\s*-webkit-line-clamp: 2;/);
  assert.doesNotMatch(title, /nowrap/);
  const project = rule('.thread-project');
  assert.match(project, /flex: 0 0 auto; max-width: 50%;/, 'the project is not cut while the title can give way');
  assert.match(rule('.thread-runs'), /flex: 0 1 auto; max-width: 22rem;/, 'the run picker takes what its longest run needs, not a fixed share');
});

test('scrollbars: the webkit parts without buttons, the standard properties only where the parts are unknown', () => {
  assert.match(rule('::-webkit-scrollbar'), /width: 0\.625rem; height: 0\.625rem;/);
  assert.match(rule('::-webkit-scrollbar-button'), /display: none;/);
  assert.match(rule('::-webkit-scrollbar-thumb'), /background: var\(--scroll-thumb\);/);
  // Chromium drops the parts for an element whose scrollbar-width or scrollbar-color is not auto
  const source = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const guarded = source.match(/@supports not selector\(::-webkit-scrollbar\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(guarded, /\* \{ scrollbar-width: thin; \}\s*html \{ scrollbar-color: var\(--scroll-thumb\) transparent; \}/);
  const unguarded = source.replace(guarded, '');
  assert.doesNotMatch(unguarded, /scrollbar-(?:width|color):/, 'no standard property outside the Firefox branch, including higher contrast');
  const contrast = source.slice(source.indexOf('@media (prefers-contrast: more)'));
  assert.match(contrast, /:root \{ --scroll-thumb: var\(--text-4\); \}/, 'contrast changes the thumb token, not the rendering engine');
  assert.doesNotMatch(source, /scrollbar-[^;]*!important/, 'no override guard is needed');
});

test('activity panel: the filter wraps instead of scrolling, the log keeps its header and its cells their padding', () => {
  const filter = rule('.segmented');
  assert.match(filter, /flex-wrap: wrap;/);
  assert.doesNotMatch(filter, /overflow/);
  assert.match(rule('.log thead th'), /position: sticky;\s*top: 0;/);
  assert.match(rule('.log td'), /padding: var\(--s2\) var\(--s3\);/);
  const table = rule('.log');
  assert.match(table, /--c-source: calc\(15ch \+ 1\.5rem\);/, 'an instance like "Developer · m12" fits the Source column');
  // narrow: the Detail heading is laid out like the detail cell, not hidden in one pixel
  const narrow = css.slice(css.indexOf('@container (max-width: 34.9rem)'), css.indexOf('.log[data-filter="main"] tbody tr[data-cat="ticks"]'));
  assert.match(narrow, /\.log thead \{ position: sticky; top: 0;/);
  assert.match(narrow, /\.log thead th:last-child \{ grid-column: 1 \/ -1;/);
  assert.doesNotMatch(narrow, /width: 1px|clip:/);
  // a tab change fades, and only for a reader who has not asked for less motion
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.tabpanel \{ animation: tab-in var\(--dur\) var\(--ease-out\); \}\s*\}/);
  assert.equal(css.split('animation: tab-in').length, 2, 'nowhere else');
});

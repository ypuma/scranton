// The view bar, the side panel and Settings: what is stored is parsed strictly, the Browser frames only a dev
// server on this computer, and the page keeps the controls the bar presses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePrefs, applyPrefs, parseParallel, parseRunDefaults, PREF_DEFAULTS } from '../../visualizer/public/js/prefs.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');

// side-panel.js imports the store of control-panel.js, which needs no DOM until it is used
const { parsePreviewUrl, changedFiles, parseSide } = await import('../../visualizer/public/js/side-panel.js');

test('prefs: anything stored that is no choice is the default; a default sets no attribute', () => {
  assert.deepEqual(parsePrefs(null), PREF_DEFAULTS);
  assert.deepEqual(parsePrefs('not json'), PREF_DEFAULTS);
  assert.deepEqual(parsePrefs('[1]'), PREF_DEFAULTS);
  assert.deepEqual(parsePrefs(JSON.stringify({ density: 'huge', motion: 'wild', color: 'yes' })), PREF_DEFAULTS);
  assert.deepEqual(parsePrefs(JSON.stringify({ density: 'compact', motion: 'off', color: false })), { density: 'compact', motion: 'off', color: false });
  const root = { dataset: {} };
  applyPrefs(root, PREF_DEFAULTS);
  assert.deepEqual(root.dataset, {});
  applyPrefs(root, { density: 'airy', motion: 'subtle', color: false });
  assert.deepEqual(root.dataset, { density: 'airy', motion: 'subtle', color: 'off' });
  applyPrefs(root, PREF_DEFAULTS);
  assert.deepEqual(root.dataset, {}, 'back to the defaults clears them');
});

test('run defaults: only valid fields the human set; the host acknowledgement is never stored', () => {
  assert.deepEqual(parseRunDefaults(null), {});
  assert.deepEqual(parseRunDefaults(JSON.stringify({ maxParallel: 4, sandbox: 'docker' })), { maxParallel: 4, sandbox: 'docker' });
  assert.deepEqual(parseRunDefaults(JSON.stringify({ maxParallel: 0, sandbox: 'vm', trustedHost: true })), {});
  assert.deepEqual(parseRunDefaults(JSON.stringify({ maxParallel: 33 })), {});
  assert.deepEqual(parseRunDefaults(JSON.stringify({ sandbox: 'host', trustedHost: true })), { sandbox: 'host' });
  assert.deepEqual([parseParallel('1'), parseParallel(' 32 '), parseParallel('0'), parseParallel('1.5'), parseParallel('-2'), parseParallel('')], [1, 32, null, null, null, null]);
  const panel = read('js/control-panel.js');
  assert.match(panel, /const d = \{ \.\.\.executionDefaults\(control\), \.\.\.parseRunDefaults\(store\.get\(RUN_DEFAULTS_KEY\)\) \};/, 'the run form starts from them');
  assert.match(panel, /if \(!e\.fHost\.checked\) e\.fTrusted\.checked = false;/, 'and still never gives the acknowledgement');
});

test('Browser: only http on localhost or 127.0.0.1 is framed, never this app, a credential or another host', () => {
  assert.deepEqual(parsePreviewUrl('localhost:3000'), { url: 'http://localhost:3000/' });
  assert.deepEqual(parsePreviewUrl(' http://127.0.0.1:5173/app?x=1 '), { url: 'http://127.0.0.1:5173/app?x=1' });
  for (const bad of ['', 'example.com', 'https://localhost:3000', 'http://localhost.evil.test:3000', 'http://user:pw@localhost:3000', 'file:///c:/x.html',
    'javascript://localhost/%0aalert(1)', 'http://[::1]:3000', 'http://192.168.1.4:3000', 'http://']) {
    assert.ok(parsePreviewUrl(bad).error, `${bad} is refused`);
    assert.equal(parsePreviewUrl(bad).url, undefined);
  }
  assert.match(parsePreviewUrl('http://localhost:1725/', 'http://localhost:1725').error, /this app/);
  assert.deepEqual([parseSide('plan'), parseSide('browser'), parseSide('changes'), parseSide('run'), parseSide(null)], ['plan', 'browser', 'changes', null, null]);
});

test('Changes: each changed file once, by who touched it last; a file that was only read is no change', () => {
  const files = changedFiles([
    { id: 'dwight-m1', name: 'dwight-m1', files: [{ path: 'todo.js', kind: 'write', ts: '2026-11-08T12:00:01Z' }, { path: 'notes.md', kind: 'read', ts: '2026-11-08T12:00:00Z' }] },
    { id: 'dwight-m2', name: 'dwight-m2', files: [{ path: 'todo.js', kind: 'edit', ts: '2026-11-08T12:00:05Z' }, { path: 'cli.js', kind: 'write', ts: '2026-11-08T12:00:04Z' }] },
    { id: 'angela-m2', files: [] },
  ]);
  assert.deepEqual(files.map((f) => [f.path, f.kind, f.by]), [['cli.js', 'wrote', 'dwight-m2'], ['todo.js', 'edited', 'dwight-m2']]);
  assert.deepEqual(changedFiles(undefined), []);
});

test('page: the bar closes the shell, the frame is sandboxed, and the controls the bar presses stay in the page', () => {
  const html = read('index.html');
  const shellEnd = html.slice(html.indexOf('<aside class="rail" id="run-rail"'), html.indexOf('<dialog class="drawer" id="prefs-dialog"'));
  assert.match(shellEnd, /<\/aside>\s*<aside class="side" id="side-panel" aria-labelledby="side-title" hidden>[\s\S]*<\/aside>\s*<nav class="viewbar" id="viewbar" aria-label="Views and panels">[\s\S]*<\/nav>\s*<\/div>\s*$/);
  assert.match(html, /<iframe class="browser-frame" id="browser-frame" title="Web preview" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" hidden><\/iframe>/,
    'no top navigation, no popups, and nothing loads until an address is opened');
  const bar = html.match(/<nav class="viewbar"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...bar.matchAll(/<button type="button" class="icon-btn bar-btn[^"]*" id="([a-z-]+)"/g)].map((m) => m[1]),
    ['bar-chat', 'bar-dash', 'bar-think', 'bar-plan', 'bar-browser', 'bar-changes', 'bar-agents', 'bar-accounts', 'bar-settings']);
  for (const m of bar.matchAll(/<button [^>]*>[\s\S]*?<\/button>/g)) assert.match(m[0], /<span class="bar-label"[^>]*>[A-Z][a-z]+<\/span><\/button>$/, 'every icon shows its name');
  for (const id of ['bar-chat', 'bar-dash', 'bar-agents', 'bar-accounts']) assert.match(bar, new RegExp(`id="${id}"[^>]* hidden>`), `${id} waits for the control it presses`);
  for (const id of ['view-mode-chat', 'view-mode-dash', 'agents-open', 'accounts-open', 'notify-toggle']) assert.ok(html.includes(`id="${id}"`), `${id} is still the control`);
  assert.match(html, /<dialog class="drawer" id="prefs-dialog" aria-labelledby="prefs-title">/);

  const css = read('styles.css');
  assert.match(css, /\.thread-head \.view-mode, \.run-actions :is\(#agents-open, #accounts-open, #notify-toggle\) \{ display: none; \}/, 'drawn once, in the bar and in Settings');
  assert.match(css, /body\[data-side\] \.rail \{ display: none; \}/, 'one side panel at a time');
  assert.match(css, /:root\[data-motion="off"\] \*, :root\[data-motion="off"\] \*::before, :root\[data-motion="off"\] \*::after \{ animation: none !important; transition: none !important; \}/);
  assert.match(css, /:root\[data-color="off"\] \{ --ok: var\(--text\);/);
});

test('plan: the planner\'s JSON message is read as a plan, anything else stays text; the board gives the plan in order', async () => {
  const { parsePlanText, planOf } = await import('../../visualizer/public/js/plan.js');
  const doc = { milestones: [
    { id: 'm1', dependsOn: [], title: 'Storage', description: 'Keep todos in a file.', acceptanceCriteria: ['add works', 'list works'] },
    { id: 'm2', dependsOn: ['m1'], title: 'CLI', description: '', acceptanceCriteria: [] },
  ] };
  const fence = '`'.repeat(3);
  const json = JSON.stringify(doc);
  for (const text of [`${fence}json\n${json}\n${fence}\n[PLAN_READY]`, `${fence}\n${json}\n${fence}`, json, `  ${JSON.stringify(doc, null, 2)}\n`]) {
    assert.deepEqual(parsePlanText(text).map((m) => [m.id, m.title, m.description, m.criteria, m.dependsOn]),
      [['m1', 'Storage', 'Keep todos in a file.', ['add works', 'list works'], []], ['m2', 'CLI', '', [], ['m1']]]);
  }
  for (const text of ['', 'I planned three milestones.', '{"milestones":[]}', '{"milestones":[{"id":"m1"}]}', '{"milestones": oops', '[1,2]', null]) {
    assert.equal(parsePlanText(text), null, String(text));
  }

  const board = { columns: [
    { id: 'todo', cards: [{ id: 'm10', title: 'Ten', description: 'd10', criteria: [], state: 'waiting', note: 'after m2' }] },
    { id: 'done', cards: [{ id: 'm2', title: 'Two', description: 'd2', criteria: ['c'], state: 'passed' }, { id: 'm1', title: 'One', state: 'passed' }] },
  ] };
  assert.deepEqual(planOf(board).map((m) => [m.id, m.column, m.state, m.description, m.criteria, m.note]),
    [['m1', 'done', 'passed', '', [], ''], ['m2', 'done', 'passed', 'd2', ['c'], ''], ['m10', 'todo', 'waiting', 'd10', [], 'after m2']], 'm10 comes after m2: the ids sort as numbers');
  assert.deepEqual(planOf(null), []);

  // the adapter hands the plan to the view; the view itself stays engine neutral and parses nothing
  assert.doesNotMatch(read('js/plan.js'), /\bdocument\b|createElement/, 'parsing touches no DOM');
  assert.match(read('js/chat-adapter-team.js'), /const plan = parsePlanText\(body\.text\);/);
  assert.doesNotMatch(read('js/chat-view.js'), /parsePlanText|plan-render/);
  assert.match(read('styles.css'), /\.md pre code \{[^}]*white-space: pre-wrap; overflow-wrap: anywhere; \}/, 'a long line of code wraps instead of scrolling sideways');
  assert.ok(read('index.html').includes('<button type="button" class="btn btn-small btn-quiet section-action" id="board-plan" aria-controls="side-panel" hidden>Read the plan</button>'));
});


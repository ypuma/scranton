import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDashboard } from '../../visualizer/public/js/dashboard.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { installTree } from './fixtures/tree-dom.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');

function dashboardHarness() {
  const $ = installTree();
  for (const className of ['pill-glyph', 'pill-text']) {
    const span = document.createElement('span');
    span.className = className;
    $('run-status').append(span);
  }
  return { $, dashboard: createDashboard() };
}

const paused = (breaker = true) => reduceAll([
  { type: 'run_started', runId: 'r', seq: 1, request: 'Test', maxFailedCycles: 3 },
  ...(breaker ? [{ type: 'circuit_breaker', runId: 'r', seq: 2, state: 'tripped', failedCycles: 3, maxFailedCycles: 3 }] : []),
  { type: 'hitl_request', runId: 'r', seq: 3, milestoneId: 'm1', reason: 'The checks failed. Inspect the output.', options: ['feedback', 'retry', 'skip', 'abort'] },
]);

test('only a pending human alert is eligible for consolidation; reason and terminal fallback survive', () => {
  const { $, dashboard } = dashboardHarness();
  for (const breaker of [true, false]) {
    dashboard.render(paused(breaker));
    assert.equal($('alert').dataset.kind, 'human');
    assert.equal($('alert').hidden, false, 'without an answer card the alert is still available');
    assert.match($('alert-title').textContent, /in the orchestrator terminal/);
    assert.equal($('alert-detail').textContent, 'The checks failed. Inspect the output.');
    dashboard.setHumanWhere('here');
    assert.doesNotMatch($('alert-title').textContent, /terminal/);
    dashboard.setHumanWhere('exited');
    assert.equal($('alert').dataset.kind, 'attention', 'an exited run must never be consolidated away');
    dashboard.setHumanWhere('terminal');
  }
  const css = read('styles.css');
  assert.match(css, /\.main:has\(> #hitl:not\(\[hidden\]\)\) > \.alert\[data-kind="human"\] \{ display: none; \}/);
  assert.match(css, /body\[data-view="chat"\] \.hitl-reason \{ display: block; \}/, 'the decision reason is beside its actions even when reading history');
});

test('the transcript establishes a containing block for absolute accessible labels without clipping focus or changing follow logic', () => {
  const css = read('styles.css');
  const rule = css.match(/\.chatview-scroll \{([^}]+)\}/)?.[1] ?? '';
  assert.match(rule, /position: relative;/);
  assert.match(rule, /min-height: 0;/);
  assert.match(rule, /overflow: hidden auto;/);
  assert.doesNotMatch(rule, /(?:^|;)\s*(?:contain|clip-path|height):/);
});

test('setup help is disclosed, not its settings or safety messages', () => {
  const html = read('index.html');
  const help = [...html.matchAll(/<details class="form-help">([\s\S]*?)<\/details>/g)].map((m) => m[1]);
  assert.equal(help.length, 3);
  assert.ok(help.some((s) => s.includes('How stages run') && s.includes('stages run in ascending order')));
  assert.ok(help.some((s) => s.includes('Model selection help') && s.includes('id="models-note"')));
  for (const s of help) assert.doesNotMatch(s, /<(?:input|select|textarea|button)\b|id="exec-note"|class="trust"/);
  assert.match(html, /id="f-request"[^>]*rows="5"/);
  assert.match(html, /no sandbox: agent commands run on this computer with your user rights/);
});

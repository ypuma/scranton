// The pipeline follows the run's workflow: cards in stage order, a parallel stage as one column of stacked
// cards, no card for a role the run does not use, and a gate's result for the cycle on its card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPipeline, pipelineColumns } from '../../visualizer/public/js/pipeline.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const css = readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function run(gates, extra = []) {
  let seq = 0;
  const e = (type, fields) => ({ v: 1, seq: ++seq, ts: `2026-11-09T12:00:${String(seq).padStart(2, '0')}.000Z`, runId: 'r1', type, ...fields });
  return reduceAll([
    e('run_started', { request: 'Build', workspace: 'C:\\w', maxFailedCycles: 3, execution: gates ? { workflow: { gates } } : { maxParallel: 1 } }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One', description: '', acceptanceCriteria: [] }] }),
    e('milestone_started', { milestoneId: 'm1', index: 0, total: 1, title: 'One' }),
    ...extra.map(([type, fields]) => e(type, fields)),
  ]);
}

// what the pipeline root holds, in order: node ids, 'connector', ['stack', ...ids] and 'svg'
function shape(root) {
  return root.childNodes.map((n) => {
    if (n.dataset.node) return n.dataset.node;
    if (n.classList.contains('flow')) return 'svg';
    if (n.className === 'connector') return 'connector';
    if (n.className.includes('stage-column')) return ['stack', ...n.childNodes.map((slot) => slot.childNodes[0].dataset.node)];
    return n.className;
  });
}

function mount() {
  installDom();
  const root = new FakeEl();
  return { root, pipeline: createPipeline(root) };
}

test('no run, and an older run: Human, Michael, Dwight and Angela as before', () => {
  const { root, pipeline } = mount();
  const legacy = ['human', 'connector', 'michael', 'connector', 'dwight', 'connector', 'angela', 'svg'];
  assert.deepEqual(shape(root), legacy, 'the empty page');
  pipeline.render(run(null));
  assert.deepEqual(shape(root), legacy);
  assert.equal(root.dataset.stacked, 'false');
  assert.equal(root.dataset.wide, 'false');
});

test('the default workflow: review and security stacked in one column, then the tests', () => {
  const { root, pipeline } = mount();
  pipeline.render(run([['oscar', 'hank'], ['angela']]));
  assert.deepEqual(shape(root), ['human', 'connector', 'michael', 'connector', 'dwight', 'connector', ['stack', 'oscar', 'hank'], 'connector', 'angela', 'svg']);
  assert.equal(root.dataset.stacked, 'true');
  assert.equal(root.dataset.wide, 'true');
  const stack = root.childNodes[6];
  assert.match(stack.className, /\bstage-column\b/);
  assert.equal(stack.getAttribute('role'), 'group');
  assert.equal(stack.getAttribute('aria-label'), 'Stage 1, in parallel: Review + Security');
  assert.deepEqual(stack.childNodes.map((s) => s.className), ['stack-slot', 'stack-slot']);
});

test('stages run in workflow order, and a role the run does not use has no card', () => {
  const { root, pipeline } = mount();
  pipeline.render(run([['hank'], ['oscar']]));
  assert.deepEqual(shape(root), ['human', 'connector', 'michael', 'connector', 'dwight', 'connector', 'hank', 'connector', 'oscar', 'svg']);
  assert.equal(root.dataset.stacked, 'false');
  pipeline.render(run([['angela', 'oscar', 'hank']]));
  assert.deepEqual(shape(root), ['human', 'connector', 'michael', 'connector', 'dwight', 'connector', ['stack', 'angela', 'oscar', 'hank'], 'svg']);
  assert.deepEqual(pipelineColumns(run([['oscar']])), [['michael'], ['dwight'], ['oscar']]);
});

test('the same workflow keeps the same nodes, so an open card disclosure or focus survives a render', () => {
  const { root, pipeline } = mount();
  pipeline.render(run([['oscar', 'hank'], ['angela']]));
  const before = [...root.childNodes];
  pipeline.render(run([['oscar', 'hank'], ['angela']], [['agent_status', { agent: 'oscar', status: 'thinking', activity: 'Reading' }]]));
  assert.deepEqual(root.childNodes, before);
  assert.ok(root.childNodes.every((n, i) => n === before[i]));
});

test('a gate card shows its result for the cycle once, quiet for a pass and firm for a fail', () => {
  const { root, pipeline } = mount();
  pipeline.render(run([['oscar', 'hank'], ['angela']], [
    ['agent_finished', { agent: 'oscar', milestoneId: 'm1', cycle: 1, keyword: 'CHANGES_REQUESTED', exitCode: 0, durationMs: 5 }],
    ['gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'oscar', instanceId: 'oscar-m1', result: 'failed', keyword: 'CHANGES_REQUESTED' }],
    ['agent_finished', { agent: 'hank', milestoneId: 'm1', cycle: 1, keyword: 'SECURITY_PASSED', exitCode: 0, durationMs: 5 }],
    ['gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'hank', instanceId: 'hank-m1', result: 'passed', keyword: 'SECURITY_PASSED' }],
  ]));
  const [oscar, hank] = root.childNodes[6].childNodes.map((slot) => slot.childNodes[0]);
  const activity = (card) => card.childNodes[2];
  const line = (card) => activity(card).childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  assert.equal(oscar.dataset.gate, 'failed');
  assert.equal(line(oscar), '\u2715 Changes requested m1 \u00b7 cycle 1');
  assert.equal(hank.dataset.gate, 'passed');
  assert.equal(line(hank), '\u2713 No security issues m1 \u00b7 cycle 1');
  // the keyword is said by the result line, not a second time in the meta line
  const meta = (card) => card.childNodes[3].childNodes[0];
  assert.deepEqual(meta(oscar).childNodes[0].childNodes, []);
  const angela = root.childNodes[8];
  assert.equal(angela.dataset.gate, undefined, 'the skipped stage has no result');

  // the card speaks for what it does while it works
  pipeline.render(run([['oscar', 'hank'], ['angela']], [
    ['gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'oscar', instanceId: 'oscar-m1', result: 'passed', keyword: 'REVIEW_APPROVED' }],
    ['agent_status', { agent: 'oscar', status: 'working', activity: 'Reading diff' }],
  ]));
  assert.equal(oscar.dataset.gate, undefined);
  assert.equal(activity(oscar).textContent, 'Reading diff');
});

test('the stack keeps cards the width of any other card and the row aligns on its centre', () => {
  const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === sel)?.[2] ?? '';
  // a border-box card starts from its padding, so the column starts there too and both end up equally wide
  assert.match(rule('.agent'), /padding:\s*var\(--s3\)/);
  assert.match(rule('.stage-column'), /flex:\s*1 1 calc\(2 \* var\(--s3\)\)/, 'a stage column takes one card slot');
  assert.match(rule('.stage-column'), /flex-direction:\s*column/);
  assert.match(rule('.pipeline[data-stacked="true"]'), /align-items:\s*center/);
  assert.match(css, /@container \(max-width: 36rem\) \{\s*\.pipeline\[data-wide="true"\] \{ flex-wrap: wrap;/, 'four columns wrap into a strip a little earlier');
  assert.doesNotMatch(css.slice(css.indexOf('/* ------------------------------------------------------------ agents */'), css.indexOf('/* instance lanes')), /\.pipeline[^{]*\{ flex-direction: column/, 'never one tall stack of cards');
  assert.match(css, /\.pipeline\[data-wide="true"\] > \.stage-column, \.pipeline\[data-wide="true"\] \.stack-slot \{ display: contents; \}/, 'the cards of a parallel stage join the strip');
});

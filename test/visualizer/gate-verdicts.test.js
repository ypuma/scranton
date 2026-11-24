// A gate verdict belongs to its lane: the role card shows the verdict of the lane its status speaks for, every
// instance lane shows its own once, and a gate card that has not run yet says what it waits for, calmly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline, waitsFor, pipelineColumns } from '../../visualizer/public/js/pipeline.js';
import { createLanes } from '../../visualizer/public/js/lanes.js';
import { reduceAll, roleView, gateView, laneGate } from '../../visualizer/public/js/state.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const GATES = [['oscar', 'hank'], ['angela']];

function run(extra = [], gates = GATES) {
  let seq = 0;
  const e = (type, fields) => ({ v: 1, seq: ++seq, ts: `2026-11-09T12:00:${String(seq).padStart(2, '0')}.000Z`, runId: 'r1', type, ...fields });
  return reduceAll([
    e('run_started', { request: 'Build', workspace: 'C:\\w', maxFailedCycles: 3, execution: { maxParallel: 2, isolation: 'worktree', workflow: { gates } } }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One' }, { id: 'm2', title: 'Two' }] }),
    e('milestone_started', { milestoneId: 'm1', index: 0, total: 2, title: 'One' }),
    e('milestone_started', { milestoneId: 'm2', index: 1, total: 2, title: 'Two' }),
    ...extra.map(([type, fields]) => e(type, fields)),
  ]);
}

// one review lane that ran and reported: instance, finish, gate result
function review(id, milestoneId, result, keyword) {
  return [
    ['instance_started', { instanceId: id, agent: 'oscar', milestoneId, sessionId: `s-${id}`, worktree: 'C:\\wt', sandbox: { mode: 'docker' } }],
    ['agent_finished', { agent: 'oscar', instanceId: id, milestoneId, cycle: 1, keyword, exitCode: 0, durationMs: 5 }],
    ['gate_result', { milestoneId, cycle: 1, stage: 0, agent: 'oscar', instanceId: id, result, keyword }],
  ];
}

const FAILS_THEN_PASSES = [...review('oscar-m1', 'm1', 'failed', 'CHANGES_REQUESTED'), ...review('oscar-m2', 'm2', 'passed', 'REVIEW_APPROVED')];
const PASSES_THEN_FAILS = [...review('oscar-m1', 'm1', 'passed', 'REVIEW_APPROVED'), ...review('oscar-m2', 'm2', 'failed', 'CHANGES_REQUESTED')];

function mount() {
  installDom();
  const root = new FakeEl();
  const pipeline = createPipeline(root);
  const card = (id) => {
    const find = (nodes) => nodes.flatMap((n) => (n.dataset?.node === id ? [n] : find(n.childNodes ?? [])));
    return find(root.childNodes)[0];
  };
  return { root, pipeline, card };
}
const text = (node) => (typeof node === 'string' ? node : node.childNodes.length ? node.childNodes.map(text).join('') : node.textContent);
const parts = (card) => {
  const [head, role, activity, more] = card.childNodes;
  return { status: head.childNodes[1].childNodes[1].textContent, role, activity, more };
};

test('a later pass on m2 never hides the failure of m1 while m1 is the lane the card speaks for', () => {
  const s = run(FAILS_THEN_PASSES);
  assert.equal(s.gates.oscar.milestoneId, 'm2', 'the latest result came from m2');
  assert.equal(roleView(s, 'oscar').focus, 'oscar-m1');
  assert.deepEqual([gateView(s, 'oscar').milestoneId, gateView(s, 'oscar').label], ['m1', 'Changes requested']);

  const { pipeline, card } = mount();
  pipeline.render(s);
  const oscar = card('oscar');
  assert.equal(oscar.dataset.gate, 'failed');
  assert.equal(text(parts(oscar).activity), '\u2715 Changes requested m1 \u00b7 cycle 1');
});

test('lanes in the same state: the one whose gate sent the work back is the louder', () => {
  const s = run(PASSES_THEN_FAILS);
  assert.equal(roleView(s, 'oscar').focus, 'oscar-m2');
  assert.deepEqual([gateView(s, 'oscar').milestoneId, gateView(s, 'oscar').result], ['m2', 'failed']);
  // a busy lane still outranks any verdict, and the card then says what it does
  const busy = run([...FAILS_THEN_PASSES, ['agent_status', { agent: 'oscar', instanceId: 'oscar-m2', milestoneId: 'm2', status: 'working', activity: 'Reading' }]]);
  assert.equal(roleView(busy, 'oscar').focus, 'oscar-m2');
});

test('every instance lane shows its own verdict once', () => {
  const s = run(FAILS_THEN_PASSES);
  assert.equal(laneGate(s, s.instances['oscar-m1']).label, 'Changes requested');
  assert.equal(laneGate(s, s.instances['oscar-m2']).label, 'Approved');
  installDom();
  const list = new FakeEl();
  const lanes = createLanes({ block: new FakeEl(), list, exec: new FakeEl() });
  lanes.render(s);
  const rows = Object.fromEntries(list.childNodes.map((li) => [li.dataset.lane, li]));
  for (const [id, verdict, result] of [['oscar-m1', '\u2715 Changes requested \u00b7 cycle 1', 'failed'], ['oscar-m2', '\u2713 Approved \u00b7 cycle 1', 'passed']]) {
    const li = rows[id];
    assert.equal(li.dataset.gate, result, id);
    assert.equal(li.childNodes[3].textContent, verdict, id);
    const all = li.childNodes.map(text).join(' | ');
    assert.equal(all.split(verdict.slice(2, 10)).length - 1, 1, `${id} says its verdict once: ${all}`);
    assert.doesNotMatch(all, /CHANGES_REQUESTED|REVIEW_APPROVED/, 'not the keyword a second time');
  }
});

test('a gate card that has not run yet: one status, what it waits for, and no meta line', () => {
  const s = run();
  const { pipeline, card } = mount();
  pipeline.render(s);
  assert.deepEqual(pipelineColumns(s), [['michael'], ['dwight'], ['oscar', 'hank'], ['angela']]);
  for (const [id, waits] of [['oscar', 'Waits for the Developer'], ['hank', 'Waits for the Developer'], ['angela', 'After review + security']]) {
    const p = parts(card(id));
    assert.equal(p.status, 'idle', id);
    assert.equal(p.activity.textContent, waits, id);
    assert.equal(p.activity.hidden, false, id);
    assert.equal(p.more.hidden, true, `${id}: no meta line before the first run`);
  }
  assert.equal(waitsFor([['michael'], ['dwight'], ['oscar'], ['hank'], ['angela']], 'angela'), 'After security');

  // a role that has not run either repeats nothing; one that ran shows its meta line
  const dwight = parts(card('dwight'));
  assert.equal(dwight.activity.hidden, true, 'never "Idle" twice');
  assert.equal(dwight.more.hidden, true);
  pipeline.render(run(FAILS_THEN_PASSES));
  assert.equal(parts(card('oscar')).more.hidden, false);
  assert.equal(parts(card('angela')).more.hidden, true, 'every role, not only gates');
  assert.equal(parts(card('angela')).activity.textContent, 'After review + security');

  // a lane that only says its state ("m1: Idle") is not said a second time under the status either
  pipeline.render(run([
    ['instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }],
    ['agent_status', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', status: 'idle', activity: 'Idle' }],
  ]));
  assert.equal(parts(card('dwight')).status, 'idle');
  assert.equal(parts(card('dwight')).activity.hidden, true);
});

test('the lane count stays a separate part of the role line, so a crowded row can leave it to the lanes list', () => {
  const { pipeline, card } = mount();
  pipeline.render(run(FAILS_THEN_PASSES));
  const role = parts(card('oscar')).role;
  assert.equal(role.childNodes[0], 'Reviews the changes');
  assert.equal(role.childNodes[1].className, 'role-lanes');
  // the separator stays with the text before it, the count wraps in one piece (agent-card-wrap.test.js)
  assert.deepEqual(role.childNodes[1].childNodes.map(text), ['\u00a0\u00b7 ', '2 lanes']);
});

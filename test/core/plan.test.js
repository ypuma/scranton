import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fallbackPlan, parsePlan, planToMarkdown } from '../../src/core/plan.js';

const fence = (obj) => `\`\`\`json\n${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\`\`\``;
const ms = (n) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, title: `T${i + 1}`, description: `D${i + 1}`, acceptanceCriteria: ['a', 'b'] }));

test('parses a plan and normalises ids to m1..mN', () => {
  const plan = parsePlan(`Here you go.\n${fence({ milestones: ms(3) })}\n[PLAN_READY]`);
  assert.deepEqual(plan.milestones.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.equal(plan.milestones[1].title, 'T2');
  assert.deepEqual(plan.milestones[0].acceptanceCriteria, ['a', 'b']);
});

test('the LAST valid json fence wins; a broken later fence does not discard an earlier plan', () => {
  const text = `${fence({ milestones: ms(1) })}\nrevised:\n${fence({ milestones: ms(2) })}`;
  assert.equal(parsePlan(text).milestones.length, 2);
  const withBroken = `${fence({ milestones: ms(2) })}\n${fence('{ not json')}`;
  assert.equal(parsePlan(withBroken).milestones.length, 2);
});

test('fills defaults: missing description -> title, missing criteria -> []', () => {
  const plan = parsePlan(fence({ milestones: [{ title: '  Only a title ' }] }));
  assert.equal(plan.milestones[0].title, 'Only a title');
  assert.equal(plan.milestones[0].description, 'Only a title');
  assert.deepEqual(plan.milestones[0].acceptanceCriteria, []);
});

test('rejects: no fence, empty list, too many milestones, missing title', () => {
  assert.match(parsePlan('no plan here').error, /no .*json/);
  assert.match(parsePlan(fence({ milestones: [] })).error, /no milestones/);
  assert.match(parsePlan(fence({ milestones: ms(8) })).error, /max 7/);
  assert.equal(parsePlan(fence({ milestones: ms(7) })).milestones.length, 7);
  assert.match(parsePlan(fence({ milestones: [{ description: 'x' }] })).error, /no title/);
});

test('fallbackPlan is one milestone for the whole request', () => {
  const plan = fallbackPlan('Build a thing\nwith details');
  assert.equal(plan.milestones.length, 1);
  assert.equal(plan.milestones[0].id, 'm1');
  assert.equal(plan.milestones[0].description, 'Build a thing\nwith details');
  assert.ok(plan.milestones[0].acceptanceCriteria.length > 0);
});

test('planToMarkdown lists every milestone', () => {
  const md = planToMarkdown('req', parsePlan(fence({ milestones: ms(2) })));
  assert.match(md, /## m1: T1/);
  assert.match(md, /## m2: T2/);
  assert.match(md, /- a/);
});

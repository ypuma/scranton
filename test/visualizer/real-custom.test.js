import { isolationTestEnv } from '../core/isolation-test-root.js';
// The pinned parity of .enma/custom-agents-contract.md section 10.1: the real engine (scranton demo with the fake pi)
// runs a custom gate from the hive's agents.json, and the web reducer replaying its events has the same agents keys
// and roles as the state.json it wrote. A default-workflow run is compared the same way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduceAll, parseJsonl, AGENT_IDS, customRoles, gateView, displayName, roleTitle } from '../../visualizer/public/js/state.js';
import { createPipeline, pipelineColumns } from '../../visualizer/public/js/pipeline.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'scranton.js');
const SCRATCH = path.join(ROOT, '.scratch', 'viz-real-custom');
// the custom gate as contract section 1 stores it; single mode keeps agents.json in the hive
const SECLINT = {
  id: 'seclint', name: 'Seclint', title: 'Lint', passKeyword: 'SECLINT_PASSED', failKeyword: 'SECLINT_FAILED', tools: ['read', 'grep'],
  instruction: 'Check the lint rules.\nThen the naming.', model: null, thinking: null,
};
const RUNS = {
  custom: { scenario: 'flaky', gates: 'oscar+seclint,angela' },
  plain: { scenario: 'happy', gates: null },
};

let tmp;
const done = {};

function demo({ scenario, gates }, dir) {
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  fs.writeFileSync(path.join(hive, 'agents.json'), JSON.stringify({ v: 1, agents: { seclint: SECLINT } }, null, 2));
  const args = [CLI, 'demo', '--scenario', scenario, '--delay', '0', '--hive', hive, '--workspace', path.join(dir, 'ws'), '--on-breaker', 'skip',
    ...(gates ? ['--gates', gates] : [])];
  const env = isolationTestEnv({ NO_COLOR: '1' });
  for (const k of Object.keys(env)) if (/^SCRANTON_(SETTINGS_DIR|PROMPTS_DIR|DATA|SECLINT_)/.test(k)) delete env[k];
  return new Promise((resolve, reject) => {
    // cwd without a scranton.config.json or .env, so only agents.json and the flags shape the run
    const child = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      let events = [];
      let snapshot = null;
      try {
        events = parseJsonl(fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8'));
        snapshot = JSON.parse(fs.readFileSync(path.join(hive, 'state.json'), 'utf8'));
      } catch {
        // reported by the tests with the CLI output
      }
      resolve({ code, output, events, snapshot });
    });
  });
}

before(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  tmp = fs.mkdtempSync(path.join(SCRATCH, 'run-'));
  await Promise.all(Object.entries(RUNS).map(async ([name, run]) => {
    done[name] = await demo(run, fs.mkdtempSync(path.join(tmp, `${name}-`)));
  }));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

function parity(name) {
  const { code, output, events, snapshot } = done[name];
  assert.ok(snapshot && events.length, `no events/state written. CLI exit ${code}:\n${output.slice(-1500)}`);
  assert.equal(code, 0, `exit code. CLI output:\n${output.slice(-1500)}`);
  assert.equal(events.at(-1).type, 'run_finished');
  assert.equal(events.at(-1).status, 'success');
  const s = reduceAll(events);
  assert.equal(s.applied, events.length, 'every real event type is known to the reducer');
  assert.equal(s.lastSeq, snapshot.lastSeq);
  assert.deepEqual(Object.keys(s.agents), Object.keys(snapshot.agents), 'agents keys, in order, as state.json');
  assert.deepEqual(s.roles, snapshot.roles, 'roles as state.json');
  for (const id of Object.keys(snapshot.agents)) {
    const mine = s.agents[id].totals;
    const theirs = snapshot.agents[id].totals;
    assert.deepEqual([mine.runs, mine.input, mine.output], [theirs.runs, theirs.input, theirs.output], `${id} totals`);
    assert.ok(Math.abs(mine.cost - theirs.cost) < 1e-9, `${id} totals.cost`);
    assert.equal(s.agents[id].status, snapshot.agents[id].status, `${id} status`);
  }
  assert.deepEqual(s.milestones.map((m) => [m.id, m.status]), snapshot.milestones.map((m) => [m.id, m.status]), 'milestone statuses');
  // a reconnect replay of the same file changes nothing
  assert.equal(reduceAll(events, s), s);
  return { s, events, snapshot };
}

function mount(s) {
  installDom();
  const root = new FakeEl();
  createPipeline(root).render(s);
  const find = (nodes, pred) => nodes.flatMap((n) => (typeof n !== 'string' && pred(n) ? [n] : typeof n === 'string' ? [] : find(n.childNodes ?? [], pred)));
  return { root, find: (pred) => find(root.childNodes, pred) };
}
const text = (node) => (typeof node === 'string' ? node : node.childNodes.length ? node.childNodes.map(text).join('') : node.textContent);

test('a custom gate from agents.json: the web reducer has the agents keys and roles of state.json', () => {
  const { s, events, snapshot } = parity('custom');
  assert.deepEqual(events[0].roles.map((r) => r.id), ['michael', 'dwight', 'oscar', 'seclint', 'angela'], 'the engine lists the roles the run invokes');
  assert.deepEqual(Object.keys(snapshot.agents), [...AGENT_IDS, 'seclint']);
  assert.deepEqual(customRoles(s).map((r) => [r.id, r.name, r.title, r.passKeyword, r.failKeyword]), [['seclint', 'Seclint', 'Lint', 'SECLINT_PASSED', 'SECLINT_FAILED']]);
  assert.deepEqual(s.workflow, { gates: [['oscar', 'seclint'], ['angela']] });
  assert.equal(displayName('seclint', s), 'Seclint');
  assert.equal(roleTitle('seclint', s), 'Lint');
  assert.ok(snapshot.agents.seclint.totals.runs >= 4, `seclint ran in every milestone and again after its failure: ${snapshot.agents.seclint.totals.runs}`);
  // the flaky scenario fails the custom gate once with its own keyword, then it passes
  const verdicts = events.filter((e) => e.type === 'gate_result' && e.agent === 'seclint').map((e) => [e.milestoneId, e.cycle, e.result, e.keyword]);
  assert.deepEqual(verdicts.find((v) => v[2] === 'failed'), ['m2', 1, 'failed', 'SECLINT_FAILED']);
  assert.ok(s.log.some((l) => l.text === 'Seclint gate failed: SECLINT_FAILED \u00b7 m2 \u00b7 cycle 1 \u00b7 stage 1'), 'the log names the custom gate');
  assert.equal(gateView(s, 'seclint').label, 'Passed');
});

test('a custom gate from agents.json: the pipeline shows its card in stage 1, beside Oscar', () => {
  const { s } = parity('custom');
  assert.deepEqual(pipelineColumns(s), [['michael'], ['dwight'], ['oscar', 'seclint'], ['angela']]);
  const { find } = mount(s);
  const [stage] = find((n) => /\bstage-column\b/.test(n.className ?? ''));
  assert.ok(stage, 'stage 1 is a stage column');
  assert.deepEqual(stage.childNodes.map((slot) => slot.childNodes[0].dataset.node), ['oscar', 'seclint']);
  assert.equal(stage.getAttribute('aria-label'), 'Stage 1, in parallel: Review + Seclint');
  const [card] = find((n) => n.dataset?.node === 'seclint');
  assert.equal(card.childNodes[0].childNodes[0].textContent, 'Seclint');
  assert.equal(card.childNodes[1].childNodes[0], 'Lint');
  assert.equal(card.dataset.gate, 'passed');
  assert.equal(text(card.childNodes[2]), '\u2713 Passed m3 \u00b7 cycle 1');
  assert.deepEqual(find((n) => n.dataset?.node === 'hank'), [], 'Hank is not in this run');
});

test('the default workflow: roles without custom entries, the five built-ins, as state.json', () => {
  const { s, events, snapshot } = parity('plain');
  assert.deepEqual(events[0].roles.map((r) => r.id), ['michael', 'dwight', 'angela']);
  assert.deepEqual(Object.keys(s.agents), AGENT_IDS, 'agents.json lists seclint, but the run does not use it');
  assert.deepEqual(customRoles(s), []);
  assert.equal(snapshot.roles.every((r) => r.builtin === true), true);
  assert.deepEqual(pipelineColumns(s), [['michael'], ['dwight'], ['angela']]);
  assert.deepEqual(mount(s).find((n) => n.dataset?.node === 'seclint'), []);
});

test('the default run after the custom one: the custom role is gone from the agents and the roles', () => {
  const s = reduceAll(done.plain.events, reduceAll(done.custom.events));
  assert.deepEqual(Object.keys(s.agents), Object.keys(done.plain.snapshot.agents));
  assert.deepEqual(s.roles, done.plain.snapshot.roles);
  assert.equal(displayName('seclint', s), 'seclint');
});

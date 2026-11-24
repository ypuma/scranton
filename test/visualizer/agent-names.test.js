// The five built-in agents are shown under the name of their role (.enma/agent-names-contract.md): the table in
// state.js, what displayName, roleTitle and the instance label make of an id, that no label the UI computes still
// says a first name, that no other module keeps a table of its own, and that the browser's table is the Node one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AGENT_IDS, ROLE_NAMES, ROLE_SHORT, ROLE_TITLES, ROLE_DESCRIPTIONS, displayName, shortName, roleTitle, roleDescription, instanceLabel, theName,
  aboutAgent, roleOf, roleView, reduceAll, describe, checkView, parseJsonl,
} from '../../visualizer/public/js/state.js';
import { teamAgents, teamBoard, teamUsage, liveLine, teamRunView } from '../../visualizer/public/js/activity-model.js';
import { thoughtColumns, columnText } from '../../visualizer/public/js/thoughts.js';
import { teamChatAdapter } from '../../visualizer/public/js/chat-adapter-team.js';
import { entryLabel, announcement } from '../../visualizer/public/js/chat-entries.js';
import { chatRecipients, buildChatRequest, deliveryNews } from '../../visualizer/public/js/chat.js';
import { whoText, askedText } from '../../visualizer/public/js/approvals.js';
import { accessView } from '../../visualizer/public/js/access.js';
import { DECISION_LABEL, buildWorkflow, buildHitlRequest, gateCatalog, parseControl } from '../../visualizer/public/js/control.js';
import { buildModels, parseModels, modelKey } from '../../visualizer/public/js/accounts.js';
import { parseAgents, roleView as agentRow, resetConfirm, buildPrompt } from '../../visualizer/public/js/agents.js';
import { waitsFor } from '../../visualizer/public/js/pipeline.js';

const PUBLIC = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const read = (name) => readFileSync(`${PUBLIC}${name}`, 'utf8');
const FIRST_NAMES = /\b(Michael|Dwight|Oscar|Hank|Angela)\b/;
const RUN = 'run-names';
const D = '\u00b7';

function journal() {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 24, 9, 0, seq)).toISOString(), runId: RUN, type, ...fields });
}

// A parallel run in which every built-in role has an instance, two of them the same role, and a custom gate.
function run(extra = []) {
  const e = journal();
  const lane = (agent, m) => e('instance_started', { instanceId: `${agent}-${m}`, agent, milestoneId: m, worktree: { dir: `C:\\wt\\${agent}-${m}` } });
  const status = (agent, m, s, activity) => e('agent_status', { agent, instanceId: `${agent}-${m}`, milestoneId: m, status: s, activity });
  const events = [
    e('run_started', {
      request: 'Build it', workspace: 'C:\\ws', execution: { maxParallel: 2, workflow: { gates: [['oscar', 'hank', 'seclint'], ['angela']] } },
      roles: [{ id: 'seclint', name: 'Seclint', title: 'Lint', kind: 'gate', passKeyword: 'SECLINT_PASSED', failKeyword: 'SECLINT_FAILED' }],
    }),
    e('instance_started', { instanceId: 'michael-plan', agent: 'michael', milestoneId: 'plan' }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One' }, { id: 'm2', title: 'Two' }] }),
    e('milestone_started', { milestoneId: 'm1', title: 'One', index: 0, total: 2 }),
    e('milestone_started', { milestoneId: 'm2', title: 'Two', index: 1, total: 2 }),
    lane('dwight', 'm1'), lane('dwight', 'm2'), lane('oscar', 'm1'), lane('hank', 'm1'), lane('angela', 'm1'), lane('seclint', 'm1'), lane('michael', 'm2'),
    status('dwight', 'm1', 'working', 'Working...'), status('dwight', 'm2', 'thinking', 'Thinking...'),
    status('oscar', 'm1', 'working', 'Reviewing'), status('hank', 'm1', 'thinking', 'Thinking...'), status('angela', 'm1', 'thinking', 'Thinking...'),
    e('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'edit', detail: 'src/a.js', targetFile: 'src/a.js' }),
    e('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', usage: { input: 100, output: 10, cost: 0.01 } }),
    e('agent_usage', { agent: 'oscar', instanceId: 'oscar-m1', milestoneId: 'm1', usage: { input: 50, output: 5, cost: 0.005 } }),
    e('agent_usage', { agent: 'hank', instanceId: 'hank-m1', milestoneId: 'm1', usage: { input: 50, output: 5, cost: 0.005 } }),
    e('agent_usage', { agent: 'angela', instanceId: 'angela-m1', milestoneId: 'm1', usage: { input: 50, output: 5, cost: 0.005 } }),
    e('hive_write', { from: 'michael', to: 'dwight-m2', kind: 'task', summary: 'm2: Two', milestoneId: 'm2', instanceId: 'dwight-m2' }),
    e('hive_write', { from: 'dwight-m1', to: 'angela', kind: 'handoff', summary: 'm1 is implemented.', milestoneId: 'm1', instanceId: 'angela-m1' }),
    e('chat_message', { id: 'c1', from: 'human', to: 'dwight-m2', text: 'Keep it short.', delivery: 'queued' }),
    e('chat_message', { id: 'c2', from: 'dwight-m1', to: 'dwight-m2', text: 'The parser is in a.js.', delivery: 'delivered' }),
    e('access_request', { agent: 'dwight', instanceId: 'dwight-m1', path: 'C:\\out', mode: 'write', reason: 'the report goes there' }),
    e('gate_result', { agent: 'oscar', instanceId: 'oscar-m1', milestoneId: 'm1', cycle: 1, stage: 0, result: 'failed', keyword: 'CHANGES_REQUESTED' }),
    e('gate_result', { agent: 'hank', instanceId: 'hank-m1', milestoneId: 'm1', cycle: 1, stage: 0, result: 'passed', keyword: 'SECURITY_PASSED' }),
    e('progress_check', { milestoneId: 'm1', cycle: 1, verdict: 'progress', source: 'michael', reason: 'A narrower finding is left.' }),
    ...extra.map(([type, fields]) => e(type, fields)),
  ];
  return { e, events, state: reduceAll(events) };
}

test('the table: the names, short forms, what each agent does and its description, by id', () => {
  assert.deepEqual(ROLE_NAMES, { michael: 'Planner', dwight: 'Developer', oscar: 'Code Reviewer', hank: 'Security Auditor', angela: 'QA Tester' });
  assert.deepEqual(ROLE_SHORT, { michael: 'Planner', dwight: 'Developer', oscar: 'Reviewer', hank: 'Security', angela: 'QA' });
  assert.deepEqual(ROLE_TITLES, { michael: 'Plans the work', dwight: 'Writes the code', oscar: 'Reviews the changes', hank: 'Checks security', angela: 'Tests the result' });
  assert.deepEqual(ROLE_DESCRIPTIONS, {
    michael: 'Breaks the request into milestones, judges progress when a milestone fails and, in a chat, writes the final reply.',
    dwight: 'Implements one milestone at a time and fixes what the checks report.',
    oscar: 'Reviews each milestone\'s changes for defects, regressions and test coverage. Never edits the project.',
    hank: 'Audits each milestone\'s changes for exploitable weaknesses. Never edits the project.',
    angela: 'Runs the tests and the program against every acceptance criterion. Never edits the project.',
  });
  for (const table of [ROLE_NAMES, ROLE_SHORT, ROLE_TITLES, ROLE_DESCRIPTIONS]) assert.deepEqual(Object.keys(table), AGENT_IDS, 'the ids stay, in pipeline order');
  // the event log gives the Source column 15 characters: a short name, the separator and a milestone id up to m99
  for (const id of AGENT_IDS) assert.ok(`${ROLE_SHORT[id]} ${D} m99`.length <= 15, `${ROLE_SHORT[id]} fits the Source column`);
  // nothing is ambiguous: no two agents share a name or a short form
  for (const table of [ROLE_NAMES, ROLE_SHORT, ROLE_TITLES]) assert.equal(new Set(Object.values(table)).size, AGENT_IDS.length);
});

test('parity: the browser\'s table is the one of the Node runtime (src/core/workflow.js)', async () => {
  const node = await import('../../src/core/workflow.js');
  assert.deepEqual(node.ROLE_NAMES, ROLE_NAMES);
  assert.deepEqual(node.ROLE_SHORT, ROLE_SHORT);
  assert.deepEqual(node.ROLE_TITLES, ROLE_TITLES);
  assert.deepEqual(node.ROLE_DESCRIPTIONS, ROLE_DESCRIPTIONS);
});

test('displayName, shortName, roleTitle and roleDescription: the built-ins from the table, a custom agent as its author named it', () => {
  const { state } = run();
  assert.deepEqual(AGENT_IDS.map((id) => displayName(id)), ['Planner', 'Developer', 'Code Reviewer', 'Security Auditor', 'QA Tester']);
  assert.deepEqual(AGENT_IDS.map((id) => shortName(id)), ['Planner', 'Developer', 'Reviewer', 'Security', 'QA']);
  assert.deepEqual(AGENT_IDS.map((id) => roleTitle(id)), ['Plans the work', 'Writes the code', 'Reviews the changes', 'Checks security', 'Tests the result']);
  assert.equal(roleDescription('hank'), ROLE_DESCRIPTIONS.hank);
  assert.equal(displayName('human'), 'Human', '"Human" stays');
  assert.deepEqual([displayName('seclint', state), shortName('seclint', state), roleTitle('seclint', state), roleDescription('seclint', state)], ['Seclint', 'Seclint', 'Lint', 'Lint']);
  assert.deepEqual([displayName('seclint'), roleTitle('seclint'), roleDescription('seclint')], ['seclint', '', ''], 'without its run a custom id is all there is');
  // a run that lists a built-in under another name (an older server, a saved run) does not rename it
  const old = reduceAll([{ v: 1, seq: 1, ts: 'x', runId: 'old', type: 'run_started', request: 'x', roles: [{ id: 'dwight', name: 'Dwight', title: 'Developer', kind: 'developer' }] }]);
  assert.deepEqual([displayName('dwight', old), roleTitle('dwight', old)], ['Developer', 'Writes the code']);
  assert.equal(displayName('constructor'), 'constructor', 'never an answer from the prototype');
  assert.equal(displayName(undefined), '?');
});

test('instanceLabel: an instance is its role and where it works, never its raw id', () => {
  const { state } = run();
  assert.equal(instanceLabel('dwight-m1'), `Developer ${D} m1`);
  assert.equal(instanceLabel('hank-m1', state), `Security Auditor ${D} m1`);
  assert.equal(instanceLabel('hank-m1', state, { short: true }), `Security ${D} m1`);
  assert.equal(instanceLabel('oscar-m12', null, { short: true }), `Reviewer ${D} m12`);
  assert.equal(instanceLabel('dwight'), 'Developer', 'a role is its name');
  assert.equal(instanceLabel('michael-plan'), 'Planner', 'the planner\'s own lane is the Planner');
  assert.equal(instanceLabel('michael-m2', state), `Planner ${D} m2`, 'the planner judging a milestone says which');
  assert.equal(instanceLabel('human'), 'Human');
  assert.equal(instanceLabel('seclint-m1', state), `Seclint ${D} m1`, 'a custom agent by its name');
  assert.equal(instanceLabel('seclint-m1'), 'seclint-m1', 'unknown without its run');
  for (const id of ['orchestrator', 'system', 'gone-m9', '']) assert.equal(instanceLabel(id), id || '', `${id || 'empty'} is no agent and stays as it is`);
  assert.equal(instanceLabel(null), '?');

  // two instances of one role never read the same
  const labels = Object.keys(state.instances).map((id) => instanceLabel(id, state));
  assert.equal(new Set(labels).size, labels.length, labels.join(' | '));
  assert.deepEqual(labels.filter((l) => l.startsWith('Developer')), [`Developer ${D} m1`, `Developer ${D} m2`]);
  const short = Object.keys(state.instances).map((id) => instanceLabel(id, state, { short: true }));
  assert.equal(new Set(short).size, short.length, 'nor in the short form');
  // an id that does not start with its role: the milestone it works on, else the id itself
  const odd = { instances: { w7: { agent: 'dwight', milestoneId: 'm3' }, w8: { agent: 'dwight', milestoneId: null } } };
  assert.deepEqual([roleOf('w7', odd), instanceLabel('w7', odd), instanceLabel('w8', odd)], ['dwight', `Developer ${D} m3`, `Developer ${D} w8`]);
});

test('theName: in a sentence a built-in takes the article and keeps its capitals; custom agents and Human take none', () => {
  const { state } = run();
  assert.deepEqual(AGENT_IDS.map((id) => theName(id)), ['the Planner', 'the Developer', 'the Code Reviewer', 'the Security Auditor', 'the QA Tester']);
  assert.equal(theName('dwight-m1'), 'the Developer (m1)');
  assert.equal(theName('michael-plan'), 'the Planner');
  assert.equal(theName('seclint-m1', state), 'Seclint (m1)');
  assert.equal(theName('human'), 'Human');
  assert.equal(theName('gone-m9'), 'gone-m9');
});

test('aboutAgent: a name\'s tooltip says what the agent does and the id the label stands for', () => {
  const { state } = run();
  assert.equal(aboutAgent('dwight-m1', state), `${ROLE_DESCRIPTIONS.dwight} (id dwight-m1)`);
  assert.equal(aboutAgent('angela'), `${ROLE_DESCRIPTIONS.angela} (id angela)`);
  assert.equal(aboutAgent('seclint-m1', state), 'Lint (id seclint-m1)');
  assert.equal(aboutAgent('gone-m9'), '', 'an id that is shown as it is needs no second mention');
});

test('the run panels: name and what the agent does, the short form where there is no room, the id only in a tooltip', () => {
  const { state } = run();
  const agents = teamAgents(state);
  assert.deepEqual(agents.map((a) => [a.id, a.name, a.short, a.role]), [
    ['michael-plan', 'Planner', 'Planner', 'Plans the work'],
    ['dwight-m1', `Developer ${D} m1`, `Developer ${D} m1`, 'Writes the code'],
    ['oscar-m1', `Code Reviewer ${D} m1`, `Reviewer ${D} m1`, 'Reviews the changes'],
    ['hank-m1', `Security Auditor ${D} m1`, `Security ${D} m1`, 'Checks security'],
    ['angela-m1', `QA Tester ${D} m1`, `QA ${D} m1`, 'Tests the result'],
    ['seclint-m1', `Seclint ${D} m1`, `Seclint ${D} m1`, 'Lint'],
    ['michael-m2', `Planner ${D} m2`, `Planner ${D} m2`, 'Plans the work'],
    ['dwight-m2', `Developer ${D} m2`, `Developer ${D} m2`, 'Writes the code'],
  ]);
  // never doubled: the role line does not say the name again
  for (const a of agents) assert.equal(a.name.includes(a.role) || a.role.includes(a.name.split(` ${D} `)[0]), false, `${a.name} / ${a.role}`);
  assert.equal(agents[1].about, `${ROLE_DESCRIPTIONS.dwight} (id dwight-m1)`);
  for (const a of agents) assert.equal([a.name, a.short, a.role].some((t) => t.includes(a.id) && a.id.includes('-')), false, `${a.id} is not shown raw`);

  const card = teamBoard(state, agents).columns.flatMap((c) => c.cards).find((c) => c.id === 'm1');
  assert.deepEqual(card.agents.map((a) => [a.id, a.name]), [['dwight-m1', 'Developer'], ['oscar-m1', 'Reviewer'], ['hank-m1', 'Security'], ['angela-m1', 'QA'], ['seclint-m1', 'Seclint']],
    'on the card of its milestone an instance is its role, short');
  assert.equal(card.agents[1].about, `Code Reviewer ${D} m1: ${ROLE_DESCRIPTIONS.oscar} (id oscar-m1)`);
  assert.deepEqual(card.gates.map((g) => [g.id, g.name, g.full]), [['oscar', 'Reviewer', 'Code Reviewer'], ['hank', 'Security', 'Security Auditor'], ['seclint', 'Seclint', 'Seclint'], ['angela', 'QA', 'QA Tester']]);
  assert.deepEqual(teamUsage(state).agents.map((a) => [a.id, a.name, a.full]), [['dwight', 'Developer', 'Developer'], ['oscar', 'Reviewer', 'Code Reviewer'], ['hank', 'Security', 'Security Auditor'], ['angela', 'QA', 'QA Tester']]);
  assert.equal(liveLine(teamRunView({ state }), 'closed'), `Developer ${D} m1 ${D} Editing src/a.js ${D} +7 more`);
  // a role card names its lanes by where they work: the card already says who
  assert.equal(roleView(state, 'dwight').activity, '2 lanes: m1 working, m2 thinking');
  assert.equal(roleView(state, 'oscar').activity, 'm1: Reviewing');

  // a serial run has no instances: its roles speak, under their names
  const e = journal();
  const serial = reduceAll([e('run_started', { request: 'x' }), e('agent_status', { agent: 'dwight', status: 'working', activity: 'Working...' })]);
  assert.deepEqual(teamAgents(serial).map((a) => [a.id, a.name, a.role, a.about]), [
    ['michael', 'Planner', 'Plans the work', `${ROLE_DESCRIPTIONS.michael} (id michael)`],
    ['dwight', 'Developer', 'Writes the code', `${ROLE_DESCRIPTIONS.dwight} (id dwight)`],
    ['angela', 'QA Tester', 'Tests the result', `${ROLE_DESCRIPTIONS.angela} (id angela)`],
  ]);
});

test('the Thinking view: columns and chips are named like the lanes, an instance that only left thoughts too', () => {
  const { state } = run();
  const cols = thoughtColumns({
    agents: teamAgents(state), state,
    thoughts: [{ n: 1, ts: '2026-11-24T09:00:01.000Z', instanceId: 'dwight-m9', agent: 'dwight', kind: 'reasoning', text: 'Reading.', cut: false },
      { n: 2, ts: '2026-11-24T09:00:02.000Z', instanceId: 'seclint-m9', agent: 'seclint', kind: 'answer', text: 'Fine.', cut: false }],
  });
  assert.deepEqual(cols.map((c) => [c.id, c.name, c.short]).slice(1, 4), [
    ['dwight-m1', `Developer ${D} m1`, `Developer ${D} m1`], ['oscar-m1', `Code Reviewer ${D} m1`, `Reviewer ${D} m1`], ['hank-m1', `Security Auditor ${D} m1`, `Security ${D} m1`],
  ]);
  const left = cols.find((c) => c.id === 'dwight-m9');
  assert.deepEqual([left.name, left.short, left.role, left.about], [`Developer ${D} m9`, `Developer ${D} m9`, '', `${ROLE_DESCRIPTIONS.dwight} (id dwight-m9)`]);
  assert.equal(cols.find((c) => c.id === 'seclint-m9').name, `Seclint ${D} m9`);
  assert.equal(thoughtColumns({ thoughts: [{ n: 1, ts: null, instanceId: 'seclint-m9', agent: 'seclint', kind: 'answer', text: 'x', cut: false }] })[0].name, 'seclint-m9', 'without the run its id is all there is');
  assert.equal(new Set(cols.map((c) => c.name)).size, cols.length, 'no two columns read the same');
  assert.match(columnText(left), new RegExp(`^Developer ${D} m9\\n\\nReasoning`));
  assert.equal(columnText(cols[1]), `Developer ${D} m1 ${D} Writes the code`, 'a copied column starts with who and what it does');
});

test('sentences take the article: the log, messages, approvals, forms and the stage editor', () => {
  const { e, state } = run();
  const text = (type) => state.log.filter((l) => l.type === type).map((l) => l.text);
  assert.deepEqual(text('hive_write'), [`Planner -> Developer ${D} m2 task: m2: Two`, `Developer ${D} m1 -> QA Tester handoff: m1 is implemented.`]);
  assert.deepEqual(text('chat_message'), [`Human -> Developer ${D} m2 message: Keep it short.`, `Developer ${D} m1 -> Developer ${D} m2 message: The parser is in a.js.`]);
  assert.deepEqual(text('access_request'), ['The Developer asks to write outside the project: C:\\out - the report goes there']);
  assert.deepEqual(text('gate_result'), [`Code Reviewer gate failed: CHANGES_REQUESTED ${D} m1 ${D} cycle 1 ${D} stage 1`, `Security Auditor gate passed: SECURITY_PASSED ${D} m1 ${D} cycle 1 ${D} stage 1`]);
  assert.equal(text('instance_started')[1], `Developer started for m1 ${D} worktree`, 'the milestone is said once');
  assert.equal(describe(e('instance_started', { instanceId: 'dwight-m1' }), state).text, `Developer ${D} m1 started`);
  assert.equal(text('progress_check')[0], 'm1 cycle 1 progress (judged by the Planner): A narrower finding is left.');
  assert.equal(checkView({ progressCheck: { cycle: 1, verdict: 'stalled', source: 'michael', reason: '' } }).how, 'judged by the Planner');
  // the log keeps the raw id as the row's source: the views label it
  assert.deepEqual(state.log.filter((l) => l.type === 'gate_result').map((l) => l.source), ['oscar-m1', 'hank-m1']);

  assert.deepEqual(chatRecipients(state, null).map((r) => [r.id, r.name]).slice(0, 2), [['michael-plan', 'Planner'], ['dwight-m1', `Developer ${D} m1`]]);
  assert.equal(buildChatRequest({ to: 'angela-m7', text: 'x' }, { runId: RUN, recipients: [] }).error, 'The QA Tester (m7) is not running any more. Pick another instance.');
  assert.equal(buildChatRequest({ to: 'dwight-m1', text: 'x' }, { runId: RUN, recipients: chatRecipients(state, null) }).body.to, 'dwight-m1', 'the id is what is sent');
  assert.equal(deliveryNews(new Map(), new Map([['a', 'delivered']]), [{ id: 'a', to: 'hank-m1' }]), 'Message to the Security Auditor (m1) delivered');
  assert.equal(deliveryNews(new Map(), new Map([['a', 'delivered']]), [{ id: 'a', to: 'seclint-m1' }], (id) => theName(id, state)), 'Message to Seclint (m1) delivered');

  const call = { tool: 'bash', args: { command: 'npm test' }, agent: 'angela', instanceId: 'angela-m1' };
  assert.equal(whoText(call, state), `QA Tester ${D} m1`);
  assert.equal(askedText(call, state), 'Approval needed: the QA Tester (m1) wants to run a shell command: npm test');
  assert.equal(whoText({ tool: 'bash', args: {} }), 'An agent');
  assert.equal(accessView(state).entries[0].line, `Write ${D} waiting for your answer ${D} Developer`);

  assert.equal(DECISION_LABEL.feedback, 'Feedback for the Developer');
  assert.equal(buildHitlRequest({ decision: 'feedback', feedback: '  ' }, { options: ['feedback'] }).error, 'Write the feedback the Developer should get.');
  assert.equal(waitsFor([['michael'], ['dwight'], ['oscar', 'hank'], ['angela']], 'hank'), 'Waits for the Developer');
  assert.equal(buildWorkflow({ stages: { hank: '0' } }).error, 'The stage of the Security Auditor must be a whole number from 1 to 3.');
  assert.equal(buildWorkflow({ stages: { seclint: '9' } }, ['oscar', 'seclint'], { seclint: 'Seclint' }).error, 'The stage of Seclint must be a whole number from 1 to 2.');
  const cat = parseModels({ providers: [{ id: 'openai', label: 'ChatGPT', signedIn: true, models: [{ id: 'gpt-a', name: 'GPT A' }] }] });
  assert.equal(buildModels({ oscar: modelKey('openai', 'gone') }, cat).error, 'The model picked for the Code Reviewer is not available any more. Pick another one or the default.');
});

test('the Chat view: who speaks is the role, with what it does; a route and an announcement read as sentences', () => {
  const { events, state } = run([
    ['agent_message', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, text: 'Implemented.', final: true }],
    ['hitl_request', { milestoneId: 'm1', reason: 'Stuck on m1.', options: ['retry'] }],
    ['run_reply', { from: 'michael', kind: 'report', text: 'All done.' }],
  ]);
  const out = teamChatAdapter({ events, state });
  const said = out.find((x) => x.kind === 'agent' && x.text === 'Implemented.');
  assert.deepEqual(said.who, { id: 'dwight', name: 'Developer', title: 'Writes the code', inText: 'the Developer' });
  assert.match(entryLabel(said), /^Developer, Writes the code, m1 \u00b7 cycle 1, /);
  assert.deepEqual(out.filter((x) => x.id.startsWith('chat-')).map((x) => [x.who.name, x.context]), [['You', 'to the Developer (m2) \u00b7 queued'], ['Developer', 'to the Developer (m2)']]);
  const question = out.find((x) => x.kind === 'question');
  assert.equal(announcement(question), 'The Planner asks: Stuck on m1.');
  assert.match(entryLabel(question), /^Question from the Planner, m1, waiting for an answer/);
  assert.equal(announcement(out.find((x) => x.kind === 'reply')), 'Report from the Planner: All done.');
  // a run whose agents wrote no messages speaks through its mailbox summaries: the route names the role
  const quiet = teamChatAdapter({ events: events.filter((x) => x.type !== 'agent_message'), state });
  assert.deepEqual(quiet.filter((x) => x.id.startsWith('note-')).map((x) => [x.who.name, x.context]), [['Planner', 'm2 \u00b7 task to the Developer'], ['Developer', 'm1 \u00b7 handoff to the QA Tester']]);
});

test('the Agents drawer and the stage editor: a built-in is called what the table says, whatever the server sends', () => {
  const old = (id, name, title, extra = {}) => ({ id, name, title, builtin: true, keywords: [], tools: [], prompt: { source: 'builtin', text: 't', editable: true }, ...extra });
  const doc = parseAgents({ roles: [
    old('michael', 'Michael', 'Orchestrator', { kind: 'planner' }), old('dwight', 'Dwight', 'Developer', { kind: 'developer' }),
    old('oscar', 'Oscar', 'Reviewer', { kind: 'gate', gate: true }), old('hank', 'Hank', 'Security', { kind: 'gate', gate: true }),
    old('angela', 'Angela', 'QA', { kind: 'gate', gate: true }),
    { id: 'seclint', name: 'Seclint', title: 'Lint', builtin: false, kind: 'gate', gate: true, prompt: { source: 'custom', text: 't' } },
  ] });
  assert.deepEqual(doc.roles.map((r) => [r.id, r.name, r.title, r.inText, r.description]), [
    ['michael', 'Planner', 'Plans the work', 'the Planner', ROLE_DESCRIPTIONS.michael],
    ['dwight', 'Developer', 'Writes the code', 'the Developer', ROLE_DESCRIPTIONS.dwight],
    ['oscar', 'Code Reviewer', 'Reviews the changes', 'the Code Reviewer', ROLE_DESCRIPTIONS.oscar],
    ['hank', 'Security Auditor', 'Checks security', 'the Security Auditor', ROLE_DESCRIPTIONS.hank],
    ['angela', 'QA Tester', 'Tests the result', 'the QA Tester', ROLE_DESCRIPTIONS.angela],
    ['seclint', 'Seclint', 'Lint', 'Seclint', ''],
  ]);
  // the kind is not said twice: "Planner" and "Developer" are names now
  assert.deepEqual(doc.roles.map((r) => agentRow(r).kind), ['', '', 'Gate', 'Gate', 'Gate', `Gate ${D} custom`]);
  assert.equal(resetConfirm(doc.roles[4]).title, 'Reset the QA Tester\'s prompt?');
  assert.equal(resetConfirm(doc.roles[5]).title, 'Reset Seclint\'s prompt?');
  assert.equal(buildPrompt('x', { ...doc.roles[2], prompt: { ...doc.roles[2].prompt, editable: false } }).error, 'The Code Reviewer\'s prompt is read only here.');

  const control = parseControl({ enabled: true, defaults: { agents: [
    { id: 'michael', name: 'Michael', title: 'Orchestrator' }, { id: 'dwight', name: 'Dwight', title: 'Developer' },
    { id: 'oscar', name: 'Oscar', title: 'Reviewer' }, { id: 'hank', name: 'Hank', title: 'Security' }, { id: 'angela', name: 'Angela', title: 'QA' },
    { id: 'seclint', name: 'Seclint', title: 'Lint', gate: true },
  ] } });
  assert.deepEqual(gateCatalog(control).map((g) => [g.id, g.name, g.title]), [
    ['oscar', 'Code Reviewer', 'Reviews the changes'], ['hank', 'Security Auditor', 'Checks security'], ['angela', 'QA Tester', 'Tests the result'], ['seclint', 'Seclint', 'Lint'],
  ]);
  assert.deepEqual(gateCatalog(null).map((g) => [g.id, g.name, g.title]), [
    ['oscar', 'Code Reviewer', 'Reviews the changes'], ['hank', 'Security Auditor', 'Checks security'], ['angela', 'QA Tester', 'Tests the result'],
  ], 'a server without a catalog: the same words');
});

test('no label the UI computes says a first name any more, and a saved run\'s own text is left as it was written', () => {
  const stored = 'Dwight finished m1; Angela reported [TEST_FAILED].';
  const { events, state } = run([
    ['cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: stored }],
    ['hitl_request', { milestoneId: 'm1', reason: stored, options: ['retry'] }],
  ]);
  // what an older run wrote into its journal is shown as it is
  assert.equal(state.milestones[0].lastReason, stored);
  assert.ok(state.log.some((l) => l.text.includes(stored)));
  const view = teamRunView({ state });
  const computed = {
    agents: view.agents.map((a) => [a.name, a.short, a.role, a.about]),
    board: view.board.columns.flatMap((c) => c.cards).map((c) => [c.agents, c.gates, c.check?.how]),
    usage: view.usage.agents.map((a) => [a.name, a.full]),
    access: view.access,
    roles: AGENT_IDS.map((id) => [displayName(id, state), shortName(id, state), roleTitle(id, state), roleDescription(id, state), theName(id, state), roleView(state, id).activity]),
    instances: Object.keys(state.instances).map((id) => [instanceLabel(id, state), instanceLabel(id, state, { short: true }), theName(id, state), aboutAgent(id, state)]),
    recipients: chatRecipients(state, null).map((r) => r.name),
    log: state.log.filter((l) => !l.text.includes(stored)).map((l) => l.text),
    chat: teamChatAdapter({ events, state }).filter((x) => !String(x.text).includes(stored)).map((x) => [x.who, x.context, entryLabel(x), announcement(x)]),
    words: [DECISION_LABEL, waitsFor([['michael'], ['dwight'], ['oscar']], 'oscar'), buildWorkflow({ stages: { oscar: 'x' } }).error],
  };
  assert.doesNotMatch(JSON.stringify(computed), FIRST_NAMES);
  assert.match(JSON.stringify(computed), /Code Reviewer/, 'the probe does look at computed labels');
});

test('one table: no other module of the page names the agents, and the static page says the same words', () => {
  const files = readdirSync(`${PUBLIC}js`).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 60, `${files.length} modules`);
  for (const f of files) {
    const src = read(`js/${f}`);
    assert.doesNotMatch(src, FIRST_NAMES, `${f} says a first name`);
    // a map from an agent id to a word it is shown as lives in state.js only
    if (f !== 'state.js') assert.doesNotMatch(src, /\b(michael|dwight|oscar|hank|angela): ['"`][A-Z]/, `${f} keeps a table of its own`);
  }
  const html = read('index.html');
  assert.doesNotMatch(html, FIRST_NAMES);
  assert.doesNotMatch(read('styles.css'), FIRST_NAMES);
  // the model pickers of the New run drawer: name, what the agent does, its description and the id for config and CLI
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const id of AGENT_IDS) {
    const row = new RegExp(`<label for="f-model-${id}">${esc(ROLE_NAMES[id])} <span class="hint">${esc(ROLE_TITLES[id])}</span></label>\\s*`
      + `<select id="f-model-${id}" data-role="${id}" aria-describedby="f-model-${id}-about f-model-${id}-note"></select>\\s*`
      + `<span class="hint model-about" id="f-model-${id}-about">${esc(ROLE_DESCRIPTIONS[id])} <span class="agent-id">id <code>${id}</code></span></span>`);
    assert.match(html, row, `the ${id} row of the model pickers`);
  }
  // there and in the Agents drawer the id is a quiet line of its own, not the end of the description's sentence
  assert.match(read('styles.css'), /\n\.agent-id \{ display: block; font-size: var\(--fs-xs\); color: var\(--text-3\);/);
  assert.ok(html.includes(`<label for="hitl-text">${DECISION_LABEL.feedback} `), 'the feedback box is labelled like its button');
});

test('the demo recording reads like a current run: the new names in its text, its ids untouched', () => {
  const text = read('demo/sample-events.jsonl');
  assert.doesNotMatch(text, FIRST_NAMES);
  const events = parseJsonl(text);
  assert.deepEqual(events[0].roles.map((r) => [r.id, r.name, r.title]), [['michael', 'Planner', 'Plans the work'], ['dwight', 'Developer', 'Writes the code'], ['angela', 'QA Tester', 'Tests the result']]);
  assert.ok(events.some((x) => x.type === 'hive_write' && x.from === 'dwight' && x.to === 'angela' && x.summary.startsWith('The Developer finished m1')));
  assert.ok(events.some((x) => x.type === 'cycle_result' && x.reason.startsWith('The QA Tester reported [TEST_FAILED]')));
  assert.ok(events.some((x) => x.instanceId === 'dwight-m2') && events.some((x) => x.type === 'chat_message' && x.to === 'dwight-m2'), 'ids stay');
  const state = reduceAll(events);
  assert.deepEqual(teamAgents(state).map((a) => a.name), ['Planner', `Developer ${D} m1`, `QA Tester ${D} m1`, `Developer ${D} m2`, `QA Tester ${D} m2`, `Developer ${D} m3`, `QA Tester ${D} m3`]);
});

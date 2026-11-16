// What the agents think, on screen: the live entries at the end of the Chat transcript, and the Thinking view with
// a column per agent made from the thoughts the server saved with the run, its tool calls and the block in progress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseThoughts, thoughtColumns, createThoughtLog } from '../../visualizer/public/js/thoughts.js';
import { parseLive } from '../../visualizer/public/js/activity-model.js';
import { thinkingSummary, thinkingNote, THINK_NOTES } from '../../visualizer/public/js/thinking-view.js';
import { workingAgents } from '../../visualizer/public/js/chat-live.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const thought = (n, instanceId, kind, text, ts = `2026-11-16T10:00:${String(n).padStart(2, '0')}Z`) => ({ v: 1, n, ts, runId: 'r1', instanceId, agent: instanceId.split('-')[0], kind, text, cut: false });

test('parseThoughts: only well-formed blocks, cleaned; anything else is no document', () => {
  assert.equal(parseThoughts(null), null);
  assert.equal(parseThoughts({ runId: 'r1' }), null);
  const doc = parseThoughts({ runId: 'r1', next: 9, thoughts: [
    thought(1, 'dwight-m1', 'reasoning', 'read\r\nthe ‮file\u0007'), thought(2, 'dwight-m1', 'tool', 'x'), { n: 'x' }, thought(3, 'dwight-m1', 'answer', '   '),
    { ...thought(4, 'dwight-m1', 'answer', 'Done.'), cut: true },
  ] });
  assert.deepEqual(doc.thoughts.map((t) => [t.n, t.kind, t.text, t.cut]), [[1, 'reasoning', 'read\nthe file', false], [4, 'answer', 'Done.', true]]);
  assert.equal(doc.next, 9);
});

test('thoughtColumns: a column per agent, thoughts and tool calls in the order they happened, the open block last', () => {
  const agents = [
    { id: 'michael', name: 'michael', role: 'Planner', status: 'done', live: false, line: 'Finished: PLAN_READY' },
    { id: 'dwight-m1', name: 'dwight-m1', role: 'Developer · m1', status: 'working', live: true, line: 'Editing cli.js' },
  ];
  const thoughts = [thought(1, 'michael', 'reasoning', 'Plan it'), thought(2, 'michael', 'answer', 'The plan'), thought(3, 'dwight-m1', 'reasoning', 'Look first'), thought(4, 'gone-m9', 'reasoning', 'Left over')];
  const tools = [
    { seq: 7, type: 'agent_tool', instanceId: 'dwight-m1', agent: 'dwight', tool: 'read', targetFile: 'cli.js', ts: '2026-11-16T10:00:03Z' },
    { seq: 8, type: 'agent_tool', instanceId: 'dwight-m1', agent: 'dwight', tool: 'edit', targetFile: 'cli.js', ts: '2026-11-16T10:00:05Z' },
  ];
  const tails = parseLive({ runId: 'r1', instances: { 'dwight-m1': { agent: 'dwight', phase: 'thinking', thinking: 'Now the tests', text: null, open: 'thinking' } } }).instances;
  const cols = thoughtColumns({ agents, thoughts, tools, tails });
  assert.deepEqual(cols.map((c) => c.id), ['michael', 'dwight-m1', 'gone-m9'], 'an instance that only left thoughts still has its column');
  assert.deepEqual(cols[0].items.map((x) => [x.kind, x.text]), [['reasoning', 'Plan it'], ['answer', 'The plan']]);
  assert.deepEqual(cols[1].items.map((x) => [x.kind, x.text]), [['reasoning', 'Look first'], ['tool', 'Reading cli.js'], ['tool', 'Editing cli.js']],
    'a thought and the tool call of the same second: the thought first');
  assert.deepEqual(cols[1].open, { kind: 'reasoning', label: 'Reasoning', body: 'Now the tests', cut: false });
  assert.equal(cols[0].open, null);
  assert.deepEqual([cols[1].name, cols[1].role, cols[1].live, cols[1].line], ['dwight-m1', 'Developer · m1', true, 'Editing cli.js']);

  // a block the server already saved is not shown a second time as a tail: open says nothing is being written
  const closed = parseLive({ runId: 'r1', instances: { 'dwight-m1': { agent: 'dwight', phase: 'thinking', thinking: 'Look first', text: null, open: null } } }).instances;
  assert.equal(thoughtColumns({ agents, thoughts, tools, tails: closed })[1].open, null);
  // a server that saves nothing: the tail is all there is
  const old = parseLive({ runId: 'r1', instances: { 'dwight-m1': { agent: 'dwight', phase: 'text', thinking: 'Look first', text: 'Writing it' } } }).instances;
  assert.deepEqual(thoughtColumns({ agents, tails: old, saved: false })[1].open, { kind: 'answer', label: 'Answer', body: 'Writing it', cut: false });
});

test('thought log: asked only while the view is open, again while the run goes, once more after it ended; 404 of an ended run is "kept none"', async () => {
  const asked = [];
  let answer = () => ({ ok: true, status: 200, json: async () => ({ runId: 'r1', thoughts: [thought(1, 'michael', 'reasoning', 'Plan it')], next: 1 }) });
  const timers = { pending: [], setTimeout(fn) { this.pending.push(fn); return this.pending.length; }, clearTimeout() {} };
  const tick = async () => { await new Promise((r) => setTimeout(r, 0)); };
  const fire = async () => { const fn = timers.pending.pop(); timers.pending.length = 0; fn?.(); await tick(); };
  let changes = 0;
  const log = createThoughtLog({ url: (id) => `/runs/${id}/thoughts`, onChange: () => { changes += 1; }, fetch: async (u) => { asked.push(u); return answer(); }, timers });
  log.want('r1', { live: true, open: false });
  await tick();
  assert.deepEqual(asked, [], 'a closed view asks for nothing');
  log.want('r1', { live: true, open: true });
  await tick();
  assert.deepEqual(asked, ['/runs/r1/thoughts?after=0']);
  assert.deepEqual([log.get().thoughts.length, log.get().off, changes], [1, false, 1]);
  answer = () => ({ ok: true, status: 200, json: async () => ({ runId: 'r1', thoughts: [thought(2, 'michael', 'answer', 'The plan')], next: 2 }) });
  await fire();
  assert.equal(asked.at(-1), '/runs/r1/thoughts?after=1', 'only what is new is asked for');
  assert.deepEqual(log.get().thoughts.map((t) => t.n), [1, 2]);
  // the run ends: one more read, then nothing
  answer = () => ({ ok: true, status: 200, json: async () => ({ runId: 'r1', thoughts: [], next: 2 }) });
  log.want('r1', { live: false, open: true });
  await fire();
  const n = asked.length;
  await fire();
  assert.equal(asked.length, n, 'a run that is over and was read is not asked about again');
  // another run that kept none
  answer = () => ({ ok: false, status: 404, json: async () => ({ error: 'This run kept no thoughts' }) });
  log.want('r0', { live: false, open: true });
  await tick();
  assert.deepEqual([log.get().runId, log.get().thoughts.length, log.get().off], ['r0', 0, true]);
});

test('what the view says about itself, and who the transcript shows as working', () => {
  const col = (over) => ({ id: 'a', items: [], open: null, live: false, ...over });
  assert.equal(thinkingSummary([col({ live: true }), col({ id: 'b' })]), '2 agents · 1 working now');
  assert.equal(thinkingSummary([]), '');
  assert.equal(thinkingNote({ runId: null, columns: [], off: false, live: false }), THINK_NOTES.none);
  assert.equal(thinkingNote({ runId: 'r', columns: [col({})], off: true, live: false }), THINK_NOTES.off);
  assert.equal(thinkingNote({ runId: 'r', columns: [col({})], off: true, live: true }), THINK_NOTES.liveOnly);
  assert.equal(thinkingNote({ runId: 'r', columns: [col({})], off: false, live: true }), THINK_NOTES.empty);
  assert.equal(thinkingNote({ runId: 'r', columns: [col({ items: [{ kind: 'reasoning' }] })], off: false, live: false }), '');
  const agents = [{ id: 'a', busy: true }, { id: 'b', busy: false }, { id: 'c', busy: true }];
  assert.deepEqual(workingAgents({ live: true, agents }).map((a) => a.id), ['a', 'c'], 'every working agent, not only the newest');
  assert.deepEqual(workingAgents({ live: false, agents }), [], 'a run that is over has nobody working');
  assert.deepEqual(workingAgents(null), []);
});

test('page: the live entries end the transcript, Thinking is the third view of the bar, and model text is never markup', () => {
  const html = read('index.html');
  assert.match(html, /<div class="chatview-list" id="chat-view-list"><\/div>\s*<div class="chat-live" id="chat-live" role="group" aria-label="Agents working now" hidden><\/div>/);
  assert.match(html, /<section class="think" id="think-view" aria-labelledby="think-title" hidden>/);
  const bar = html.match(/<nav class="viewbar"[\s\S]*?<\/nav>/)[0];
  assert.match(bar, /id="bar-dash"[\s\S]*?<\/button>\s*<button type="button" class="icon-btn bar-btn" id="bar-think" aria-pressed="false" aria-controls="think-view"[^>]*>[\s\S]*?<span class="bar-label">Thinking<\/span><\/button>\s*<\/div>/);
  const css = read('styles.css');
  assert.match(css, /body\[data-think="open"\] :is\(\.main, \.rail, \.side\) \{ display: none; \}/, 'it takes the place of the chat');
  assert.match(css, /\.think-cols \{[^}]*grid-auto-flow: column; grid-auto-columns: minmax\(20rem, 1fr\);[^}]*overflow-x: auto;/, 'a column per agent, side by side');
  assert.match(css, /\.chat-live-body \{[^}]*max-height: 9\.6em; overflow: hidden;/);
  for (const file of ['js/chat-live.js', 'js/thinking-view.js']) {
    const js = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, `${file}: text nodes only`);
    assert.match(js, /aria-live', 'off'/,`${file}: a box that changes every second is no live region`);
  }
  const main = read('js/main.js');
  assert.match(main, /thoughtLog\.want\(engine === 'team' \? rv\.runId : null, \{ live: rv\.live, open: thinking\.isOpen\(\) \}\);/);
  assert.match(main, /const chatLive = createChatLive\(\{ openThinking: \(\) => thinking\.open\(\) \}\);/);
});

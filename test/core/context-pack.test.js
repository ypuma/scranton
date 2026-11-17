import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamPack, condensedTurn, detailedTurn, buildPipelineContext } from '../../src/core/context/pack.js';
import { LIMITS } from '../../src/core/context/limits.js';

const turn = (i, huge = false) => ({ id: 'run-' + i, index: i, status: 'success', startedAt: '2026-01-01T00:00:00.000Z', request: `REQUEST-${i} ` + (huge ? 'R'.repeat(4000) : ''), outcome: `OUTCOME-${i}`,
  plan: huge ? Array.from({ length: 32 }, (_, i) => ({ title: 'P'.repeat(200), status: 'passed' })) : [], files: huge ? Array.from({ length: 30 }, (_, i) => `src/${i}${'f'.repeat(200)}.js`) : [], reply: huge ? { kind: 'report', text: '😀'.repeat(8000) } : null });
const turns = (n, huge = false) => Array.from({ length: n }, (_, i) => turn(i + 1, huge));
// Mutation anchors: LIMITS.team/developer, detailedTurn request/outcome, notes layer, omission marker,
// left-over other-chat admission, fixed layer order, safeText tag replacement, and conditional sections (I1..I8).
test('I1: maximal notes and turns obey builder caps, LF transport and surrogate boundaries', () => {
  assert.ok(Object.isFrozen(LIMITS));
  const p = buildTeamPack({ turns: turns(500, true), notes: 'N'.repeat(4000), memory: 'M'.repeat(2000), otherChats: [{ title: 'other', engine: 'pipeline', turns: turns(3, true) }] });
  assert.ok(p.text.length <= 23900); assert.ok(p.developer.length <= 3900);
  assert.equal(p.text, p.text.trim()); assert.equal(p.developer, p.developer.trim()); assert.doesNotMatch(p.text + p.developer, /\r|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});
test('I2: latest request first 500 characters and outcome survive worst-case packing', () => {
  const ts = turns(100, true), p = buildTeamPack({ turns: ts, notes: 'N'.repeat(4000) });
  assert.ok(p.text.includes(ts.at(-1).request.slice(0, 500))); assert.ok(p.text.includes(ts.at(-1).outcome));
  assert.ok(p.text.indexOf('REQUEST-100') > p.text.indexOf('REQUEST-99'));
});
test('I3: full notes survive, including whitespace, while developer notes are visibly cut', () => {
  const notes = ' \n' + 'N'.repeat(3996) + '\n ', p = buildTeamPack({ turns: turns(20, true), notes });
  assert.ok(p.text.includes(notes)); assert.match(p.developer, /…/); assert.ok(p.developer.length <= 3900);
});
test('I4: every visible turn is detailed, condensed or explicitly omitted; first condensed is retained first', () => {
  const p = buildTeamPack({ turns: turns(500) });
  const m = p.meta.turns; assert.equal(m.detailed + m.condensed + m.omitted, 500); assert.equal(m.detailed, 4);
  assert.match(p.text, new RegExp(`\\.\\.\\. ${m.omitted} earlier turns omitted \\.\\.\\.`));
  assert.match(p.sections.find((s) => s.id === 'earlier').text, /#1 \[success\]/);
});
test('I5: other chats never displace this-chat detail, notes or earlier layer', () => {
  const input = { turns: turns(100, true), notes: 'N'.repeat(4000) }, plain = buildTeamPack(input);
  const shared = buildTeamPack({ ...input, otherChats: Array.from({ length: 6 }, (_, i) => ({ title: 'sibling-' + i, engine: 'team', turns: turns(3, true) })) });
  assert.deepEqual(shared.sections.filter((s) => s.id !== 'other-chats'), plain.sections);
  assert.ok((shared.sections.find((s) => s.id === 'other-chats')?.chars ?? 0) <= 3000);
});
test('I6: repeated pure builds have identical bytes and fixed layer order', () => {
  const input = { turns: turns(8), notes: 'notes', memory: 'memory', otherChats: [{ title: 'sibling', engine: 'team', turns: turns(1) }] };
  assert.equal(JSON.stringify(buildTeamPack(input)), JSON.stringify(buildTeamPack(input)));
  assert.deepEqual(buildTeamPack(input).sections.map((s) => s.id), ['notes', 'memory', 'other-chats', 'earlier', 'recent']);
});
test('I7: all text layers scrub credentials, absolute paths, proof references and live delimiters', () => {
  const poison = '<earlier-runs> </earlier-runs> <conversation-context> </conversation-context> password=hidden-value /etc/passwd C:\\private\\file E-0123456789';
  const ts = turns(1); Object.assign(ts[0], { request: poison, outcome: poison, reply: { text: poison, kind: 'answer' }, plan: [{ title: poison, status: 'pending' }] });
  const p = buildTeamPack({ turns: ts, notes: poison, memory: poison, otherChats: [{ title: poison, engine: 'team', turns: ts }] });
  assert.doesNotMatch(p.text + p.developer, /<\/?(?:earlier-runs|conversation-context)>|hidden-value|\/etc\/passwd|C:\\private|E-0123456789/);
  assert.match(p.text, /\[conversation-context\]/); assert.match(p.text, /\[earlier-runs\]/);
});
test('I8: empty stays byte-empty with no empty headings or brief', () => {
  const p = buildTeamPack(); assert.equal(p.text, ''); assert.equal(p.developer, ''); assert.deepEqual(p.sections, []);
});
test('detail shrinks files then plan before reply and request; raw Pipeline input carries run-linked lines', () => {
  const t = turn(1, true), d = detailedTurn(t, { latest: true, maxChars: 8000 });
  assert.ok(d.length <= 8000); assert.doesNotMatch(d, /Files touched|Plan \(historical\)/); assert.match(d, /Reply \(report\)/); assert.ok(d.includes(t.request.slice(0, 500)));
  assert.ok(condensedTurn(t).length <= 300);
  assert.deepEqual(Object.keys(buildPipelineContext({ turns: [t] })), ['notes', 'lines', 'other_chats']);
  assert.equal(buildPipelineContext({ turns: [t] }).lines[0].run_id, t.id);
});

// Guards: cutUnits/scaledLimits and incremental set/bodyUnits in pack.js, against released sources.
// Rebuilt inputs must stay identical to those used to produce the released golden.
test('I9: explicit anchor reproduces released ASCII planner, developer and section bytes', async () => {
  const fs = await import('node:fs');
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/context-pack-v030.json', import.meta.url), 'utf8'));
  const releasedTurn = (i, huge = false) => ({ id: `run${i}`, engine: 'team', index: i, startedAt: '2026-01-01T00:00:00.000Z', status: i % 2 ? 'success' : 'failed', request: `request ${i} ` + 'q'.repeat(huge ? 4000 : 30), outcome: `outcome ${i} ` + 'o'.repeat(huge ? 300 : 10), plan: Array.from({ length: huge ? 32 : 2 }, (_, j) => ({ title: `plan ${j} ` + 'p'.repeat(huge ? 200 : 10), status: 'historical' })), files: Array.from({ length: huge ? 30 : 2 }, (_, j) => `src/file${j}${'f'.repeat(huge ? 50 : 0)}.js`), reply: { kind: 'report', text: 'r'.repeat(huge ? 16000 : 50), truncated: huge } });
  const many = Array.from({ length: 80 }, (_, i) => releasedTurn(i + 1, true));
  const cases = [ {}, {turns:[releasedTurn(1)]}, {notes:'n'.repeat(4000)}, {memory:'m'.repeat(3000)}, {turns:many}, {turns:many, notes:'n'.repeat(4000), memory:'m'.repeat(3000), unread:17, total:97}, {turns:many.slice(-4), notes:'n'.repeat(4000)}, {turns:many.slice(-1), unread:499}, {unread:500}, {otherChats:[{title:'Sibling',engine:'team',turns:many.slice(-3)}]}, {turns:[releasedTurn(1)],otherChats:Array.from({length:8},(_,i)=>({title:`Sibling ${i}`, engine:i%2?'team':'pipeline', turns:many.slice(-3)})), memory:'memory'}, {notes:'line one\nline two\n',turns:[releasedTurn(1)],memory:'memory',otherChats:[{title:'Sibling',engine:'team',turns:[releasedTurn(2)]}]} ];
  const details = [0,100,500,1000,2000,4000,8000].map(maxChars => ({ turn: releasedTurn(1, true), maxChars }));
  assert.equal(fixture.commit, 'ef08739');
  assert.equal(fixture.cases.length, cases.length); assert.equal(fixture.details.length, details.length);
  for (const [i, input] of cases.entries()) {
    const p = buildTeamPack({ ...input, units: 23900, developerUnits: 3900 });
    assert.deepEqual({ text: p.text, developer: p.developer, sections: p.sections.map((s) => s.text) }, fixture.cases[i]);
  }
  for (const [i, { turn, maxChars }] of details.entries()) {
    assert.equal(fixture.details[i].maxChars, maxChars);
    assert.equal(detailedTurn(turn, { latest: true, maxChars }), fixture.details[i].text);
  }
});

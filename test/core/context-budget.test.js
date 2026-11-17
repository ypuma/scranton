import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { LIMITS, DEFAULT_BUDGET, UNKNOWN_RECIPIENT, scaledLimits, budgetFor, briefFor, pipelineAllowance } from '../../src/core/context/limits.js';
import { buildTeamPack, safeText } from '../../src/core/context/pack.js';
import { units, tokens, clipUnits } from '../../src/core/context/tokens.js';

const recipient = (window, id = null) => ({ id, window, known: true });
// Guards: budgetFor raw/ceiling/capped/source, briefFor's clamp, pipelineAllowance H/C formula.
test('recipient budget and brief tables cover every cap and model precedence', () => {
  for (const [window, rule, expected, capped, brief] of [[32000, null, 3200, null, 320], [32000, 50000, 16000, 'window', 1600], [128000, null, 12800, null, 1280], [200000, null, 20000, null, 2000], [400000, null, 40000, null, 2000], [1000000, null, 100000, null, 2000], [1000000, { mode: 'percent', value: 50 }, 200000, 'max', 2000], [400, 1000, 256, 'min', 250]]) {
    const settings = rule === null ? {} : { budget: typeof rule === 'number' ? { mode: 'tokens', value: rule } : rule };
    const b = budgetFor(settings, recipient(window));
    assert.equal(b.tokens, expected); assert.equal(b.capped, capped); assert.equal(b.source, 'project'); assert.equal(briefFor(settings, recipient(window)), brief);
  }
  assert.deepEqual(budgetFor(), { tokens: 12800, mode: 'percent', value: 10, source: 'project', capped: null });
  assert.equal(UNKNOWN_RECIPIENT.window, 128000); assert.equal(Object.isFrozen(DEFAULT_BUDGET), true);
  const settings = { budget: { mode: 'tokens', value: 1000 }, models: { 'provider/model': { mode: 'tokens', value: 24000 } } };
  assert.deepEqual(budgetFor(settings, recipient(200000, 'provider/model')), { tokens: 24000, mode: 'tokens', value: 24000, source: 'model', capped: null });
  assert.equal(budgetFor(settings, recipient(200000, 'other')).tokens, 1000);
  assert.equal(budgetFor({ models: Object.create({ inherited: { mode: 'tokens', value: 1000 } }) }, recipient(128000, 'inherited')).source, 'project');
});
test('Pipeline allowance examples include floors, engine ceiling and uncapped rules', () => {
  for (const [window, rule, h, c, n, capped] of [[128000, null, 38400, 12800, 12800, null], [200000, null, 50000, 20000, 17500, 'engine'], [1000000, null, 50000, 25000, 18750, 'engine'], [128000, 1000, 12000, 4000, 4000, 'engine'], [400, 1000, 12000, 4000, 4000, 'engine'], [8000, 50000, 12000, 4000, 4000, 'window']]) {
    const a = pipelineAllowance(rule ? { budget: { mode: 'tokens', value: rule } } : {}, recipient(window));
    assert.deepEqual([a.historyBytes, a.contextBytes, a.tokens, a.capped], [h, c, n, capped]);
  }
  assert.equal(pipelineAllowance({ models: { m: { mode: 'tokens', value: 12000 } } }, recipient(128000, 'm')).source, 'model');
});
test('scaled caps are exact at the released anchor and scale with floors and count clamps', () => {
  assert.deepEqual(scaledLimits(23900, 3900), LIMITS);
  const values = { latestRequest: 2000, latestReply: 6000, latestPlan: 3000, latestFiles: 1500, olderRequest: 800, olderReply: 1500, olderPlan: 1200, olderFiles: 600, minRequest: 500, earlier: 4000, other: 3000, memory: 2000 };
  for (const U of [1024, 4000, 23900, 51200, 80000, 400000, 800000]) {
    const c = scaledLimits(U, 1000);
    for (const [key, value] of Object.entries(values)) assert.equal(c[key], Math.floor(value * U / 23900));
    assert.equal(c.recent, Math.max(1, Math.min(12, Math.floor(4 * U / 23900))));
    assert.equal(c.developerNotes, Math.floor(1500 * 1000 / 3900)); assert.equal(c.developerTurns, 3);
    for (const key of ['outcome', 'planLines', 'files', 'condensed', 'condensedRequest', 'condensedOutcome', 'planLine', 'otherChats', 'otherTurns']) assert.equal(c[key], LIMITS[key]);
  }
});
const turn = (i, text) => ({ id: 'run' + i, index: i, status: 'success', startedAt: '2026-01-01', request: 'REQUEST-' + i + ' ' + text.repeat(3000), outcome: 'OUTCOME-' + i, plan: Array.from({ length: 32 }, () => ({ title: text.repeat(100), status: 'historical' })), files: ['src/a.js', 'src/b.js'], reply: { kind: 'report', text: text.repeat(8000) } });
// Guards: pack caps/unit comparisons, notesLimit/lastIndexOf, detailed/condensed/omitted sets,
// other-chat admission, safeText, and incremental layer costs. Each assertion fails if reverted to v0.3.0.
for (const text of ['A', '\u00e4\u00f6\u00fc', '\u6771\u4eac', '\ud83d\ude80', '\ud800x\udc00']) test('I1-I8 across model budgets: ' + JSON.stringify(text), () => {
  const turns = Array.from({ length: 40 }, (_, i) => turn(i + 1, text));
  const notes = safeText(('notes ' + text + '\n').repeat(250)), memory = 'memory ' + text.repeat(4000);
  for (const B of [256, 1000, 5975, 12800, 20000, 100000, 200000]) {
    const U = B * 4, Udev = Math.min(B, Math.max(250, Math.min(2000, Math.floor(B / 10)))) * 4;
    const input = { turns, notes, memory, units: U, developerUnits: Udev, unread: 3 }, p = buildTeamPack(input);
    assert.ok(units(p.text) <= U); assert.ok(units(p.developer) <= Udev);
    assert.equal(p.text, p.text.trim()); assert.equal(p.developer, p.developer.trim()); assert.doesNotMatch(p.text + p.developer, /\r/); assert.ok((p.text + p.developer).isWellFormed());
    const latest = p.sections.find((s) => s.id === 'recent').text, hasDetail = latest.includes('### #40 [success]');
    if (hasDetail) { assert.ok(latest.includes(clipUnits(safeText(turns.at(-1).request), Math.floor(500 * U / 23900)))); assert.match(latest, /OUTCOME-40/); }
    else assert.match(latest, /#40 \[success\]/);
    const body = p.sections.find((s) => s.id === 'notes').text.split('\n').slice(1).join('\n').replace(/\n\[End project notes\]$/, '');
    assert.ok(units(body) <= Math.floor(U / 2));
    if (units(notes) <= Math.floor(U / 2)) { assert.equal(body, notes); assert.equal(p.meta.notes.cut, false); }
    else { assert.match(body, /\n\[project notes cut to fit the context budget\]$/); assert.equal(p.meta.notes.cut, true); const prefix = clipUnits(notes, Math.floor(U / 2) - '[project notes cut to fit the context budget]'.length - 1); assert.equal(body.split('\n[project notes')[0], (prefix.includes('\n') ? prefix.slice(0, prefix.lastIndexOf('\n')) : prefix)); }
    const m = p.meta.turns; assert.equal(m.detailed + m.condensed + m.omitted, turns.length + 3);
    if (m.omitted) assert.ok(p.text.includes('... ' + m.omitted + ' earlier turns omitted ...'));
    for (const t of turns) if (!new RegExp('(?:### )?#' + t.index + ' \\[success\\]').test(p.text)) assert.ok(m.omitted > 0);
    const sibling = buildTeamPack({ ...input, otherChats: [{ title: 'sibling', engine: 'team', turns: turns.slice(-3) }] });
    assert.deepEqual(sibling.sections.filter((s) => ['notes', 'earlier', 'recent'].includes(s.id)), p.sections.filter((s) => ['notes', 'earlier', 'recent'].includes(s.id)));
    assert.ok(units(sibling.sections.find((s) => s.id === 'other-chats')?.text) <= Math.floor(3000 * U / 23900));
    assert.deepEqual(buildTeamPack(input), p); assert.equal(p.meta.budget.used, tokens(p.text)); assert.equal(p.meta.developer.used, tokens(p.developer));
    for (const section of p.sections) assert.equal(section.tokens, tokens(section.text));
    assert.equal(buildTeamPack({ units: U, developerUnits: Udev }).text, '');
    const poison = buildTeamPack({ ...input, notes: '<earlier-runs>\n<conversation-context>' }); assert.doesNotMatch(poison.text + poison.developer, /<\/?(?:earlier-runs|conversation-context)>/);
  }
});
test('I3 cuts unbroken notes with a plain whole-code-point prefix and keeps the trailer', () => {
  const p = buildTeamPack({ notes: '\u4e2d'.repeat(4000), units: 1024, developerUnits: 1000 });
  assert.match(p.text, /\n\[project notes cut to fit the context budget\]\n\[End project notes\]$/); assert.equal(p.meta.notes.cut, true);
  const notes = 'x '.repeat(4000), q = buildTeamPack({ notes, units: 1024, developerUnits: 1000 });
  const prefix = clipUnits(notes, 512 - '[project notes cut to fit the context budget]'.length - 1);
  assert.ok(q.text.includes(prefix + '\n[project notes cut to fit the context budget]'));
});
test('truncated compares Unicode units against scaled older caps', () => {
  const t = { ...turn(1, 'a'), request: '\u4e2d'.repeat(201), plan: [], reply: null };
  assert.equal(buildTeamPack({ turns: [t], units: 23900 }).meta.truncated, true);
  assert.equal(buildTeamPack({ turns: [t], units: 51200 }).meta.truncated, false);
});
test('P1: 500 maximal turns build well below five seconds at the ceiling', () => {
  const turns = Array.from({ length: 500 }, (_, i) => ({ ...turn(i + 1, 'x'), request: 'q'.repeat(32768), reply: { kind: 'report', text: 'r'.repeat(16000) } }));
  const start = performance.now(), p = buildTeamPack({ turns, notes: 'n'.repeat(16000), units: 800000, developerUnits: 8000 });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 4500, 'incremental build took ' + elapsed + 'ms'); assert.ok(units(p.text) <= 800000);
});

// Revert latest classification in pack.js to detailed.add unconditionally to fail this test.
test('I2 and I4: an unfit latest detail is condensed, counted once, and never silently lost', () => {
  const latest = { ...turn(1, 'x'), outcome: 'O'.repeat(300) }, input = { turns: [latest], notes: 'n'.repeat(16000), unread: 2 };
  const p = buildTeamPack({ ...input, units: 1024, developerUnits: 1000 });
  assert.deepEqual(p.meta.turns, { total: 1, visible: 3, detailed: 0, condensed: 1, omitted: 2 });
  assert.match(p.text, /#1 \[success\]/); assert.match(p.text, /2 earlier turns omitted/); assert.ok(units(p.text) <= 1024);
  const q = buildTeamPack({ ...input, units: 4000, developerUnits: 1000 }); assert.match(q.text, /### #1 \[success\]/);
});

// I3 takes precedence over I10 below 1000 tokens: this is the reviewer's exact discontinuity.
test('tiny budgets keep full notes and condense the latest turn when newly full notes consume its detail', () => {
  const turns = [1, 2].map((index) => ({ id: 'run' + index, index, status: 'done', startedAt: '2026-01-01T00:00:00.000Z', request: 'r'.repeat(100), outcome: 'o'.repeat(300) }));
  const notes = 'a\n' + 'x'.repeat(548), small = buildTeamPack({ turns, notes, units: 1024 }), larger = buildTeamPack({ turns, notes, units: 1100 });
  assert.equal(small.meta.notes.cut, true); assert.match(small.sections.find((s) => s.id === 'recent').text, /### #2 \[done\]/);
  assert.equal(larger.meta.notes.cut, false); assert.equal(larger.sections.find((s) => s.id === 'notes').text.split('\n').slice(1).join('\n'), notes + '\n[End project notes]');
  assert.match(larger.sections.find((s) => s.id === 'recent').text, /\n#2 \[done\]/);
  assert.equal(larger.meta.turns.condensed, 1); assert.ok(units(larger.text) <= 1100);
});

test('I10 sweeps fixed adversarial notes across detail and note-fit boundaries from 1000 tokens up', (t) => {
  const anchors = [4000, 4400, 8000, 23900, 51200, 80000, 400000, 800000];
  let inputs = 0, packs = 0;
  for (const glyph of ['a', '\u00e4', '\u4e2d', '\ud83d\ude80']) for (const anchor of anchors) {
    for (const offset of [-46, -1, 0, 1, 46]) for (const lineBreak of [false, true]) {
      const target = Math.floor(anchor / 2) + offset;
      const notes = (lineBreak ? 'a\n' : '') + clipUnits(glyph.repeat(Math.min(16000, target)), target - (lineBreak ? 2 : 0));
      if (notes.length > LIMITS.notes) continue;
      for (const size of [0, 100, 3000, 32768]) {
        const turns = [1, 2].map((index) => ({ id: 'run' + index, index, status: size === 3000 ? 's'.repeat(80) : 'done', startedAt: '2026-01-01T00:00:00.000Z', request: glyph.repeat(size).slice(0, 32768).toWellFormed(), outcome: glyph.repeat(300), reply: { kind: 'report', text: glyph.repeat(Math.min(size, 16000)) }, plan: size > 100 ? [{ title: glyph.repeat(200), status: 'done' }] : [] }));
        const fit = units(notes) * 2, budgets = [...new Set([...anchors, ...[-4, -1, 0, 1, 4].flatMap((n) => [anchor + n, fit + n])])].filter((U) => U >= 4000 && U <= 800000).sort((a, b) => a - b);
        let detailed = false; inputs++;
        for (const U of budgets) {
          const p = buildTeamPack({ turns, notes, units: U }), recent = p.sections.find((s) => s.id === 'recent').text;
          const hasDetail = recent.includes('### #2 ['); packs++;
          assert.ok(!detailed || hasDetail, JSON.stringify({ glyph, size, noteUnits: units(notes), lineBreak, U, anchor }));
          assert.ok(units(p.text) <= U); assert.match(recent, /#2 \[/);
          if (units(notes) <= Math.floor(U / 2)) assert.equal(p.meta.notes.cut, false);
          detailed ||= hasDetail;
        }
        assert.equal(detailed, true, 'sweep must exercise detailed latest turns');
      }
    }
  }
  t.diagnostic(`I10: ${inputs} fixed inputs, ${packs} budget comparisons; no latest-detail loss at U >= 4000`);
});

test('rule bounds and override counts have one exported source of truth', async () => {
  const { readFileSync } = await import('node:fs');
  for (const [key, expected] of Object.entries({ percentMin: 1, percentMax: 50, tokensMin: 1000, tokensMax: 200000, overrides: 32 })) assert.equal(LIMITS[key], expected, key);
  const source = (file) => readFileSync(new URL('../../src/core/' + file, import.meta.url), 'utf8');
  for (const key of ['percentMin', 'percentMax', 'tokensMin', 'tokensMax']) {
    assert.ok(source('context/store.js').includes('LIMITS.' + key), 'store ' + key);
    assert.ok(source('cli.js').includes('LIMITS.' + key), 'CLI ' + key);
    assert.ok(source('context/index.js').includes('L.' + key), 'document ' + key);
  }
  assert.ok(source('context/store.js').includes('LIMITS.overrides')); assert.ok(source('context/index.js').includes('L.overrides'));
  const scaling = source('context/limits.js').split('export function scaledLimits')[1];
  assert.doesNotMatch(scaling, /23900|3900/); assert.match(scaling, /\/ LIMITS\.team/); assert.match(scaling, /\/ LIMITS\.developer/);
});

// The Dreams drawer (.enma/dreaming-contract.md): a project's deterministic consolidation status, Preview / Run
// sweep / settings / Roll back through the project's dreaming routes, and replies that can never land on another
// project. Fixtures follow the frozen status payload; nothing here calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDreamingPanel } from '../../visualizer/public/js/dreaming-panel.js';
import {
  parseDreaming, buildSettings, dreamingUrl, dreamingError, isIncumbent, isRecommended, replaySummary, recommendationText, cohortLabel,
  stateBadge, stateText, SINGLE_NOTE, INTERVAL_MIN, INTERVAL_MAX,
} from '../../visualizer/public/js/dreaming.js';
import { createNav } from '../../visualizer/public/js/nav.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';
import { fakeStorage } from './fixtures/run-drawer.js';

const SHA = 'a'.repeat(64);
const COHORT = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);
const PROJECTS = { mode: 'registry', projects: [{ id: 'core', name: 'Core', chats: [] }, { id: 'web', name: 'Web', chats: [] }] };

function status(projectId = 'core', over = {}) {
  return {
    v: 1, projectId, enabled: false, applyPolicy: false, intervalMinutes: 360, state: 'idle',
    lastSweepAt: '2026-11-15T10:00:00.000Z', nextSweepAt: null, canRollback: true,
    counts: { episodes: 4, candidates: 2, promoted: 1, worlds: 3 },
    phases: [{ name: 'light', status: 'deduplicated', count: 4 }, { name: 'rem', status: 'grouped', count: 2 }, { name: 'deep', status: 'weighted gates evaluated', count: 1 }],
    memory: [{ id: 'm1', text: `Team: Recorded autonomous run completed successfully. (${projectId})`, score: 0.81, sources: [{ path: 'projects/core/chats/a/run.json', sha256: SHA }], promotedAt: '2026-11-15T10:00:00.000Z' }],
    candidates: [
      { id: 'c1', text: 'Team: Recorded autonomous run completed successfully.', score: 0.81, eligible: true, reasons: [],
        signals: { relevance: 1, frequency: 1, taskDiversity: 0.67, recency: 0.9, multiDayRecurrence: 1, richness: 0.33, recallCount: 3, uniqueQueries: 2 },
        sources: [{ path: 'projects/core/chats/a/run.json', sha256: SHA }] },
      { id: 'c2', text: 'Pipeline: Recorded evaluated coding attempt failed required checks.', score: 0.52, eligible: false,
        reasons: ['score below 0.65', 'fewer than 2 original task digests'], signals: { relevance: 1, frequency: 0.33 }, sources: [] },
    ],
    replay: {
      objective: 'Q - 0.05*N + 0.02*N/max(1,rounds)', worlds: 3,
      evaluations: [
        { engine: 'team', cohort: COHORT, cap: 3, baselineCap: 3, score: 0.7, quality: 1, attempts: 9, rounds: 3, eligible: true, reasons: [] },
        { engine: 'team', cohort: COHORT, cap: 2, baselineCap: 3, score: 0.75, quality: 1, attempts: 6, rounds: 3, eligible: true, reasons: [] },
        { engine: 'team', cohort: COHORT, cap: 1, baselineCap: 3, score: 0.4, quality: 0.67, attempts: 3, rounds: 3, eligible: false, reasons: ['per-world quality regression'] },
        { engine: 'team', cohort: OTHER, cap: 2, baselineCap: 3, score: 0.9, quality: 1, attempts: 6, rounds: 3, eligible: false, reasons: ['fewer than 3 complete worlds in evidence cohort'] },
      ],
      recommendations: [{ engine: 'team', cohort: COHORT, cap: 2, baselineCap: 3, rationale: 'Same frozen cohort; strictly better objective, no per-world quality regression.' }],
      limitations: ['Deterministic historical replay only; unseen continuations are unknown.'],
    },
    diary: [{ id: 'd1', at: '2026-11-15T09:00:00.000Z', text: 'Dreaming settings saved.', promoted: 0 }, { id: 'd2', at: '2026-11-15T10:00:00.000Z', text: 'Deterministic consolidation saved.', promoted: 1 }],
    limitations: ['Excluded 1: human intervention.'],
    ...over,
  };
}

test('parseDreaming: the v1 payload of this project only, bounded and with bidi controls stripped', () => {
  const d = parseDreaming(status(), 'core');
  assert.deepEqual(d.phases.map((p) => [p.name, p.count, p.known]), [['light', 4, true], ['rem', 2, true], ['deep', 1, true]]);
  assert.equal(d.replay.evaluations[0].cohort, COHORT);
  assert.equal(d.replay.recommendations[0].cohort, COHORT);
  assert.equal(parseDreaming(status('web'), 'core'), null, 'a reply about another project is no status of this one');
  assert.equal(parseDreaming({ ...status(), v: 2 }, 'core'), null);
  assert.equal(parseDreaming(null, 'core'), null);
  const odd = parseDreaming(status('core', {
    state: 'strange', intervalMinutes: 5, phases: [{ name: 'deep', status: 'x', count: 1 }],
    memory: [{ id: 'x', text: 'a\u202Eb', score: 'high', sources: [{ path: 'p', sha256: 'nothex' }] }, ...Array(400).fill({ id: 'y', text: 't', sources: [] })],
  }), 'core');
  assert.equal(odd.state, 'error', 'an unknown state reads as an error, never as idle');
  assert.equal(odd.intervalMinutes, 360);
  assert.deepEqual(odd.phases.map((p) => p.known), [false, false, true], 'a missing phase says so rather than inventing a count');
  assert.equal(odd.memory[0].text, 'ab');
  assert.equal(odd.memory[0].score, null);
  assert.equal(odd.memory[0].sources[0].sha256, '');
  assert.equal(odd.memory.length, 200, 'lists are bounded');
});

test('buildSettings: only what changed, the interval checked, the policy opt-in independent of the schedule', () => {
  const saved = parseDreaming(status(), 'core');
  assert.deepEqual(buildSettings({ enabled: true, applyPolicy: false, interval: '360' }, saved), { body: { enabled: true } });
  assert.deepEqual(buildSettings({ enabled: false, applyPolicy: true, interval: '360' }, saved), { body: { applyPolicy: true } });
  assert.deepEqual(buildSettings({ enabled: false, applyPolicy: false, interval: ' 90 ' }, saved), { body: { intervalMinutes: 90 } });
  for (const bad of ['', '14', String(INTERVAL_MAX + 1), '1.5', '-20', 'abc']) assert.equal(buildSettings({ interval: bad }, saved).field, 'interval', bad);
  assert.deepEqual(buildSettings({ interval: String(INTERVAL_MIN) }, saved).body, { intervalMinutes: INTERVAL_MIN });
});

test('routes, errors and replay wording', () => {
  assert.equal(dreamingUrl('core'), '/api/projects/core/dreaming');
  assert.equal(dreamingUrl('core', 'sweep'), '/api/projects/core/dreaming/sweep');
  assert.equal(dreamingUrl('../x'), null);
  assert.equal(dreamingUrl('core', 'delete'), null);
  for (const body of [{ error: 'Dreaming is busy' }, null]) {
    const busy = dreamingError(409, body);
    assert.match(busy, /project as busy and gave no reason/);
    assert.doesNotMatch(busy, /Another dreaming operation|sweep/i, 'a bare busy refusal names no cause it was not given');
  }
  assert.equal(dreamingError(409, { error: 'No dreaming preimage available' }), 'No dreaming preimage available');
  assert.equal(dreamingError(409, { error: 'single_mode' }), SINGLE_NOTE);
  assert.match(dreamingError(404, { error: 'Not found' }), /does not offer Dreams/);
  assert.match(dreamingError(0, null), /did not answer/);
  const r = parseDreaming(status(), 'core').replay;
  assert.deepEqual(r.evaluations.map((e) => [isIncumbent(e, r.recommendations), isRecommended(e, r.recommendations)]),
    [[true, false], [false, true], [false, false], [false, false]], 'a better score in another recipe cohort is not the recommended policy');
  assert.match(replaySummary(r), /2 separate cohorts/);
  assert.match(replaySummary({ worlds: 2, evaluations: [] }), /at least 3 complete chains/);
  assert.match(recommendationText(r.recommendations[0], false), /cohort cccccccc: retry limit 3 could be 2\. Not applied/);
  const on = recommendationText(r.recommendations[0], true);
  assert.match(on, /may start with 2, but only if its configured limit is 3, its check recipe matches this cohort and the recorded sources still verify; otherwise it keeps its own limit\. It never raises a limit\.$/);
  assert.doesNotMatch(on, /Used from the next run on/, 'eligibility is conditional, use is never promised');
  assert.match(recommendationText({ ...r.recommendations[0], cohort: '' }, true), /Not applied: no check recipe cohort/);
  assert.doesNotMatch(recommendationText({ ...r.recommendations[0], cohort: '' }, true), /may start with/);
  assert.equal(cohortLabel(''), 'cohort unknown');
});

test('state wording: a busy server is a busy project, only a sweep this window posted is called sweeping', () => {
  const idle = parseDreaming(status(), 'core');
  const busy = parseDreaming(status('core', { state: 'busy' }), 'core');
  assert.deepEqual(stateBadge(busy), ['Project busy', 'on']);
  assert.deepEqual(stateBadge(busy, { preview: true }), ['Preview', 'loud']);
  assert.deepEqual(stateBadge(idle, { sweeping: true }), ['Sweeping', 'on']);
  assert.deepEqual(stateBadge(idle, { preview: true, sweeping: true }), ['Sweeping', 'on'], 'a preview on screen does not hide the sweep on its way');
  assert.deepEqual(stateBadge(idle), ['Idle', 'quiet']);
  assert.deepEqual(stateBadge(parseDreaming(status('core', { state: 'error' }), 'core')), ['Error', 'loud']);
  assert.match(stateText(busy), /busy and gave no reason/);
  assert.doesNotMatch(stateText(busy), /sweep is running|sweep in progress/i);
  assert.equal(stateText(idle), '');
});

// the drawer with a fake server; held: suffixes whose answer waits for release(suffix)
function harness({ projects = PROJECTS, answers = {}, held = [] } = {}) {
  const $ = installDom();
  const close = new FakeEl();
  $('dreams-dialog').querySelectorAll = () => [close];
  const requests = [];
  const waiting = new Map();
  const server = { core: status('core'), web: status('web', { memory: [], counts: { episodes: 0, candidates: 0, promoted: 0, worlds: 0 } }) };
  const reply = (code, body) => ({ ok: code < 300, status: code, json: async () => structuredClone(body) });
  globalThis.fetch = (url, opts = {}) => {
    // the reflection model list; these fixtures are an older server without reflection
    if (url === '/api/models') return Promise.resolve(reply(404, { error: 'Not found' }));
    const m = /^\/api\/projects\/([a-z0-9-]+)\/dreaming(?:\/([a-z]+))?$/.exec(url);
    const key = `${m[1]}:${m[2] ?? 'status'}`;
    requests.push({ url, key, method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body === undefined ? undefined : JSON.parse(opts.body) });
    const answer = () => {
      if (answers[key]) return reply(...answers[key]);
      const doc = server[m[1]];
      if (m[2] === 'preview') return reply(200, { ...doc, preview: true, counts: { ...doc.counts, promoted: 2 } });
      if (m[2] === 'settings') Object.assign(doc, JSON.parse(opts.body));
      // a sweep that found changed chains logs itself in the diary
      if (m[2] === 'sweep') doc.diary = [...doc.diary, { id: `d${doc.diary.length + 1}`, at: '2026-11-15T11:00:00.000Z', text: 'Deterministic consolidation saved.', promoted: 1 }];
      if (m[2] === 'rollback') doc.canRollback = false;
      return reply(200, doc);
    };
    if (held.includes(key)) return new Promise((r) => waiting.set(key, () => r(answer())));
    return Promise.resolve(answer());
  };
  const confirms = [];
  const panel = createDreamingPanel({ confirm: (c) => confirms.push(c), getProjects: () => projects });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const open = async (id = 'core') => {
    panel.open(id);
    await tick();
  };
  const release = async (key) => {
    waiting.get(key)();
    await tick();
  };
  const texts = (node) => node.childNodes.map((c) => c.textContent);
  return { $, panel, requests, confirms, tick, open, release, server, texts, close };
}

test('opening loads the project status with the client header and shows phases, memory, gates, replay and diary', async () => {
  const h = harness();
  await h.open();
  assert.deepEqual(h.requests.map((r) => [r.method, r.url, r.headers['X-Scranton-Client']]), [['GET', '/api/projects/core/dreaming', '1']]);
  assert.equal(h.$('dreams-dialog').open, true);
  assert.equal(h.$('dreams-project').textContent, 'Core');
  assert.equal(h.$('dreams-content').hidden, false);
  assert.equal(h.$('dreams-empty').hidden, true);
  assert.equal(h.$('dreams-state').textContent, 'Idle');
  assert.equal(h.$('dreams-counts').textContent, '4 recorded chains · 2 candidates · 1 promoted · 3 replay worlds');
  assert.equal(h.$('dreams-schedule').textContent, 'Automatic sweeps are off.');
  assert.deepEqual(h.$('dreams-phases').childNodes.map((li) => [li.dataset.phase, li.childNodes[0].childNodes[1].textContent, li.childNodes[1].textContent]),
    [['light', '4', 'deduplicated'], ['rem', '2', 'grouped'], ['deep', '1', 'weighted gates evaluated']]);

  const mem = h.$('dreams-memory').childNodes[0];
  assert.equal(mem.childNodes[0].childNodes[1].textContent, 'score 0.81');
  assert.equal(mem.childNodes[2].childNodes[0].textContent, 'projects/core/chats/a/run.json · aaaaaaaaaaaa', 'every memory names its sources');

  const [pass, held] = h.$('dreams-candidates').childNodes;
  assert.equal(pass.childNodes[0].childNodes[1].textContent, 'Passes gates');
  const signals = h.texts(pass.childNodes[1]);
  assert.deepEqual(signals.slice(0, 4), ['Relevance', '1.00 × 0.30', 'Frequency', '1.00 × 0.24']);
  assert.ok(signals.includes('Distinct tasks') && signals.includes('Observations'), 'the counts behind the gates show too');
  assert.equal(held.dataset.eligible, 'false');
  assert.deepEqual(h.texts(held.childNodes[2]), ['score below 0.65', 'fewer than 2 original task digests'], 'the rejection reasons');

  const rows = h.$('dreams-evals').childNodes;
  assert.deepEqual(rows.map((tr) => [tr.dataset.incumbent, tr.dataset.recommended, tr.childNodes[1].textContent]),
    [['true', 'false', 'cccccccc'], ['false', 'true', 'cccccccc'], ['false', 'false', 'cccccccc'], ['false', 'false', 'dddddddd']]);
  assert.equal(rows[0].childNodes[1].title, `Evaluator recipe sha256 ${COHORT}`, 'the full cohort digest is there on request');
  assert.equal(rows[2].childNodes[7].textContent, 'per-world quality regression');
  assert.match(h.$('dreams-recs').childNodes[0].textContent, /retry limit 3 could be 2\. Not applied/);
  assert.match(h.$('dreams-replay-summary').textContent, /without running anything/);
  assert.deepEqual(h.texts(h.$('dreams-replay-limits')), ['Deterministic historical replay only; unseen continuations are unknown.']);
  assert.deepEqual(h.$('dreams-diary').childNodes.map((li) => li.childNodes[1].textContent), ['Deterministic consolidation saved.', 'Dreaming settings saved.'], 'newest first');
  assert.deepEqual(h.texts(h.$('dreams-limits')), ['Excluded 1: human intervention.']);
  assert.equal(globalThis.document.activeElement, h.$('dreams-run-preview'), 'the first action takes the focus once loaded');
  assert.equal(h.$('dreams-enabled').checked, false, 'the schedule starts off');
  assert.equal(h.$('dreams-apply').checked, false);
  assert.equal(h.$('dreams-interval').value, '360');
});

test('server text is shown as text, never parsed', async () => {
  const h = harness();
  h.server.core.memory[0].text = '<img src=x onerror=alert(1)>';
  await h.open();
  assert.equal(h.$('dreams-memory').childNodes[0].childNodes[0].childNodes[0].textContent, '<img src=x onerror=alert(1)>');
});

test('Preview posts without saving, is marked as unsaved, and Show saved goes back', async () => {
  const h = harness();
  await h.open();
  await h.$('dreams-run-preview').fire('click');
  const post = h.requests.at(-1);
  assert.deepEqual([post.method, post.url, post.body, post.headers['Content-Type'], post.headers['X-Scranton-Client']], ['POST', '/api/projects/core/dreaming/preview', {}, 'application/json', '1']);
  assert.equal(h.panel.showing(), 'preview');
  assert.equal(h.$('dreams-preview').hidden, false);
  assert.equal(h.$('dreams-state').textContent, 'Preview');
  assert.equal(h.$('dreams-foot').textContent, 'Preview shown, not saved');
  assert.match(h.$('dreams-status').textContent, /2 would be promoted .* Nothing was saved\./);
  await h.$('dreams-preview-exit').fire('click');
  assert.equal(h.panel.showing(), 'saved');
  assert.equal(h.$('dreams-preview').hidden, true);
  assert.equal(h.$('dreams-counts').textContent, '4 recorded chains · 2 candidates · 1 promoted · 3 replay worlds');
});

test('Run sweep saves; a busy server is refused with a clear message and read again', async () => {
  const h = harness();
  await h.open();
  await h.$('dreams-sweep').fire('click');
  assert.equal(h.requests.at(-1).url, '/api/projects/core/dreaming/sweep');
  assert.match(h.$('dreams-status').textContent, /^Sweep saved: 1 promoted from 4 recorded chains\.$/);
  assert.equal(globalThis.document.activeElement, h.$('dreams-status'));

  // the server's own answer decides the wording: same chains, no diary entry
  const same = harness({ answers: { 'core:sweep': [200, status('core', { lastSweepAt: '2026-11-15T11:00:00.000Z' })] } });
  await same.open();
  await same.$('dreams-sweep').fire('click');
  assert.equal(same.$('dreams-status').textContent, 'Sweep saved: 1 promoted from 4 recorded chains. No recorded chain changed since the last sweep, so it made no new rollback point.');
  // nothing recorded and never swept: the server saves nothing and reports no sweep time
  const none = { lastSweepAt: null, canRollback: false, counts: { episodes: 0, candidates: 0, promoted: 0, worlds: 0 }, memory: [], candidates: [], diary: [] };
  const empty = harness({ answers: { 'core:sweep': [200, status('core', none)] } });
  Object.assign(empty.server.core, none);
  await empty.open();
  await empty.$('dreams-sweep').fire('click');
  assert.equal(empty.$('dreams-status').textContent, 'Nothing to sweep: there is no recorded chain yet, so nothing was saved.');
  assert.doesNotMatch(empty.$('dreams-status').textContent, /Sweep saved/);
  assert.equal(empty.$('dreams-last').textContent, 'No sweep saved yet');

  const busy = harness({ answers: { 'core:sweep': [409, { error: 'Dreaming is busy' }] } });
  await busy.open();
  await busy.$('dreams-sweep').fire('click');
  await busy.tick();
  assert.match(busy.$('dreams-error').textContent, /^Refused: the server reports this project as busy and gave no reason\./);
  assert.equal(busy.$('dreams-error').hidden, false);
  assert.equal(busy.requests.at(-1).key, 'core:status', 'the state is read again after a refusal');
  assert.equal(busy.$('dreams-sweep').disabled, false);
});

test('a project the server reports busy blocks the actions, claims no sweep, and is followed until it is idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  const h = harness();
  // closed whatever happens: an open drawer over a busy server keeps polling
  t.after(() => h.$('dreams-dialog').close());
  h.server.core.state = 'busy';
  h.panel.open('core');
  await flush();
  assert.equal(h.$('dreams-state').textContent, 'Project busy', 'the server gave no cause, so no sweep is claimed');
  assert.equal(h.$('dreams-state-note').hidden, false);
  assert.match(h.$('dreams-state-note').textContent, /reports this project as busy and gave no reason/);
  assert.doesNotMatch(h.$('dreams-state-note').textContent, /sweep is running/i);
  assert.equal(h.$('dreams-sweep').disabled, true);
  assert.equal(h.$('dreams-run-preview').disabled, true);
  assert.equal(h.$('dreams-rollback').disabled, true);
  const before = h.requests.length;
  await h.$('dreams-sweep').fire('click');
  assert.equal(h.requests.length, before, 'nothing is posted while it runs');
  h.server.core.state = 'idle';
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(h.requests.length, before, 'not before the poll delay');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.requests.length, before + 1);
  assert.equal(h.requests.at(-1).key, 'core:status');
  assert.equal(h.$('dreams-sweep').disabled, false, 'free again once the server says idle');
  assert.equal(h.$('dreams-state').textContent, 'Idle');
  assert.equal(h.$('dreams-state-note').hidden, true);
});

test('a sweep this window posted reads as sweeping until it answers; other actions on their way do not', async () => {
  const h = harness({ held: ['core:sweep', 'core:preview'] });
  await h.open();
  const sweeping = h.$('dreams-sweep').fire('click');
  assert.equal(h.$('dreams-state').textContent, 'Sweeping');
  assert.equal(h.$('dreams-state').dataset.tone, 'on');
  assert.equal(h.$('dreams-state-note').hidden, true, 'no busy-project note for a sweep of our own');
  assert.equal(h.$('dreams-sweep').disabled, true);
  await h.release('core:sweep');
  await sweeping;
  assert.equal(h.$('dreams-state').textContent, 'Idle');
  const previewing = h.$('dreams-run-preview').fire('click');
  assert.equal(h.$('dreams-state').textContent, 'Idle', 'only a sweep is called sweeping');
  await h.release('core:preview');
  await previewing;
  assert.equal(h.$('dreams-state').textContent, 'Preview');
});

test('settings: schedule and policy opt-in are saved separately; a bad interval is refused before sending', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.$('dreams-settings-save').disabled, true, 'nothing to save yet');
  h.$('dreams-enabled').checked = true;
  await h.$('dreams-settings').fire('change', { target: h.$('dreams-enabled') });
  assert.equal(h.$('dreams-foot').textContent, 'Unsaved settings');
  await h.$('dreams-settings').fire('submit');
  assert.deepEqual(h.requests.at(-1).body, { enabled: true }, 'enabling the schedule does not opt into the policy');
  assert.match(h.$('dreams-status').textContent, /Automatic sweeps are on; applying retry recommendations is off/);
  assert.equal(h.$('dreams-foot').textContent, '');

  h.$('dreams-apply').checked = true;
  h.$('dreams-interval').value = '10';
  await h.$('dreams-settings').fire('input', { target: h.$('dreams-interval') });
  const sent = h.requests.length;
  await h.$('dreams-settings').fire('submit');
  assert.equal(h.requests.length, sent, 'an interval below 15 is never sent');
  assert.equal(h.$('dreams-interval').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.$('dreams-interval'));
  h.$('dreams-interval').value = '720';
  await h.$('dreams-settings').fire('input', { target: h.$('dreams-interval') });
  await h.$('dreams-settings').fire('submit');
  assert.deepEqual(h.requests.at(-1).body, { intervalMinutes: 720, applyPolicy: true });
  const rec = h.$('dreams-recs').childNodes[0].textContent;
  assert.match(rec, /Applying recommendations is on, so a new Team run may start with 2, but only if its configured limit is 3/);
  assert.doesNotMatch(rec, /Used from the next run on/);
});

test('Roll back asks first, posts only after the confirm, and says when there is nothing to roll back', async () => {
  const h = harness();
  await h.open();
  await h.$('dreams-rollback').fire('click');
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].title, 'Roll back the last change?');
  assert.match(h.confirms[0].detail, /settings and accepted notes of Core as they were before the latest saved sweep, settings change or applied proposal, and discards a pending proposal/);
  assert.match(h.$('dreams-rollback').title, /applied proposal, accepted notes included/);
  assert.equal(h.requests.some((r) => r.key === 'core:rollback'), false, 'nothing before the confirm');
  const r = await h.confirms[0].action();
  assert.equal(h.requests.at(-1).url, '/api/projects/core/dreaming/rollback');
  assert.equal(r.focus, h.$('dreams-status'));
  assert.equal(h.$('dreams-status').textContent, 'Rolled back to the state before the last saved change.');
  assert.equal(h.$('dreams-rollback').getAttribute('aria-disabled'), 'true');
  await h.$('dreams-rollback').fire('click');
  assert.equal(h.confirms.length, 1, 'no second confirm');
  assert.equal(h.$('dreams-action-status').textContent, 'Nothing to roll back: no sweep, settings change or applied proposal was saved since the last rollback.');
});

test('a status reply for the project the drawer left never fills in the next one', async () => {
  const h = harness({ held: ['core:status'] });
  h.panel.open('core');
  await h.tick();
  assert.equal(h.$('dreams-empty').textContent, 'Loading dreams...');
  await h.open('web');
  assert.equal(h.panel.project(), 'web');
  assert.equal(h.$('dreams-memory').childNodes.length, 0);
  await h.release('core:status');
  assert.equal(h.$('dreams-project').textContent, 'Web');
  assert.equal(h.$('dreams-memory').childNodes.length, 0, "Core's memory never shows under Web");
  assert.equal(h.$('dreams-counts').textContent, '0 recorded chains · 0 candidates · 0 promoted · 0 replay worlds');
});

test('a sweep reply after the drawer closed acts on nothing', async () => {
  const h = harness({ held: ['core:sweep'] });
  await h.open();
  const sweeping = h.$('dreams-sweep').fire('click');
  assert.equal(h.$('dreams-action-status').textContent, 'Sweeping...');
  h.$('dreams-dialog').close();
  await h.open('web');
  await h.release('core:sweep');
  await sweeping;
  assert.equal(h.$('dreams-status').textContent, '', 'no "Sweep saved" under another project');
  assert.equal(h.$('dreams-sweep').disabled, false, 'the new drawer is not left busy');
});

test('a single-project server and the demo get a hint and no request', async () => {
  const h = harness({ projects: { mode: 'single', projects: [{ id: 'core', name: 'Core', chats: [] }] } });
  await h.open();
  assert.equal(h.$('dreams-empty').textContent, SINGLE_NOTE);
  assert.equal(h.$('dreams-content').hidden, true);
  assert.deepEqual(h.requests, []);
  const demo = harness({ projects: null });
  await demo.open();
  assert.match(demo.$('dreams-empty').textContent, /demo has no project/);
  assert.deepEqual(demo.requests, []);
});

test('a project removed while the drawer is open stops it', async () => {
  const h = harness();
  await h.open();
  h.panel.projects({ mode: 'registry', projects: [{ id: 'web', name: 'Web', chats: [] }] });
  assert.match(h.$('dreams-error').textContent, /no longer in the project list/);
  assert.equal(h.$('dreams-sweep').disabled, true);
  assert.equal(h.$('dreams-retry-row').hidden, true);
});

test('unsaved settings: closing asks first', async () => {
  const h = harness();
  await h.open();
  h.$('dreams-apply').checked = true;
  await h.$('dreams-settings').fire('change', { target: h.$('dreams-apply') });
  let prevented = false;
  await h.$('dreams-dialog').fire('cancel', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.confirms.at(-1).title, 'Discard settings changes?');
  h.confirms.at(-1).action();
  assert.equal(h.$('dreams-dialog').open, false);
  assert.equal(h.requests.some((r) => r.key === 'core:settings'), false);
});

// ------------------------------------------------------------ the sidebar entry
async function navHarness(doc) {
  const $ = installDom();
  Object.assign(globalThis.document, { querySelector: () => null, addEventListener() {} });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.localStorage = fakeStorage();
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, json: async () => structuredClone(doc) };
  };
  const opened = [];
  const moved = [];
  const nav = createNav({ getScope: () => ({ project: 'core', chat: 'c1' }), navigate: (s) => moved.push(s), openRun() {}, announce() {}, openDreams: (id) => opened.push(id) });
  await nav.refresh();
  const actions = $('projects').childNodes[0].childNodes[1];
  const dreams = actions.childNodes.find((b) => b.dataset.act === 'dreams');
  dreams.closest = (sel) => (sel === '.nav-actions' ? actions : null);
  const click = () => $('projects').fire('click', { target: { closest: (sel) => (sel === 'button[data-act]' ? dreams : null) } });
  return { $, actions, dreams, click, opened, moved, fetched };
}

test('every project has a Dreams action that opens its drawer and leaves the chat on screen alone', async () => {
  const n = await navHarness({ mode: 'registry', projects: [{ id: 'core', name: 'Core', chats: [{ id: 'c1', title: 'One', status: 'idle' }] }] });
  assert.equal(n.dreams.textContent, 'Dreams');
  assert.equal(n.dreams.getAttribute('aria-label'), 'Dreams of Core');
  assert.equal(n.dreams.getAttribute('aria-disabled'), null);
  await n.click();
  assert.deepEqual(n.opened, ['core']);
  assert.deepEqual(n.moved, [], 'no navigation');
});

test('a single-project server shows the Dreams action disabled with its reason', async () => {
  const n = await navHarness({ mode: 'single', projects: [{ id: 'core', name: 'Core', chats: [] }] });
  assert.equal(n.dreams.getAttribute('aria-disabled'), 'true');
  assert.ok(n.actions.childNodes.some((c) => /single project/.test(c.textContent)), 'the reason is visible next to it');
  assert.equal(n.actions.childNodes.some((c) => c.dataset.act === 'rename'), false, 'still no rename or remove');
  await n.click();
  assert.deepEqual(n.opened, []);
  assert.match(n.$('nav-status').textContent, /project registry/);
  assert.deepEqual(n.fetched, ['/api/projects'], 'no dreaming request');
});

// Pure parts of orphaned-run recovery (.enma/orphan-recovery-contract.md sections 3 and 7): parsing the owner
// fields, which actions each owner status allows, the wording, the times and the markup of Release chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseControl, controlGates, canReleaseOrphan, recoveryText, recoveryTimes, RECOVERY_ERROR_MAX,
} from '../../visualizer/public/js/control.js';
import { formatWhen, formatClock } from '../../visualizer/public/js/format.js';
import { scopedUrl } from '../../visualizer/public/js/scope.js';

const BASE = { v: 1, enabled: true, workspace: 'C:\\ws', scenarios: [], run: null, lastExit: null, pendingHuman: null };
const control = (orphan) => parseControl({ ...BASE, recoveryRequired: true, orphan });

test('parseControl reads the owner fields: unknown for a value it does not know, null for an old server', () => {
  const c = control({
    runId: 'r1', startedAt: '2026-11-08T22:56:00.000Z', owner: 'gone', heartbeatAt: '2026-11-08T23:10:00.000Z',
    stopRequestedAt: '2026-11-09T17:29:59.000Z', recoveryError: 'EPERM\u202E: locked',
  });
  assert.deepEqual(c.orphan, {
    runId: 'r1', startedAt: '2026-11-08T22:56:00.000Z', owner: 'gone', heartbeatAt: '2026-11-08T23:10:00.000Z',
    stopRequestedAt: '2026-11-09T17:29:59.000Z', recoveryError: 'EPERM: locked',
  });
  for (const owner of ['dead', 'ALIVE', 1, '']) assert.equal(control({ runId: 'r1', owner }).orphan.owner, 'unknown', String(owner));
  assert.equal(control({ runId: 'r1', owner: 'unknown' }).orphan.owner, 'unknown', 'reported unknown');
  for (const owner of [undefined, null]) assert.equal(control({ runId: 'r1', owner }).orphan.owner, null, `${owner}: an old server`);
  assert.equal(control({ runId: 'r1', owner: 'unknown', recoveryError: 'Cleanup of this run could not be verified: x' }).orphan.recoveryError, 'Cleanup of this run could not be verified: x');
  const junk = control({ runId: 'r1', heartbeatAt: 5, stopRequestedAt: {}, recoveryError: [] }).orphan;
  assert.deepEqual([junk.heartbeatAt, junk.stopRequestedAt, junk.recoveryError], [null, null, null]);
  assert.equal(control({ runId: 'r1', recoveryError: 'x'.repeat(5000) }).orphan.recoveryError.length, RECOVERY_ERROR_MAX);
  assert.equal(control(undefined).orphan.owner, null, 'no orphan object at all');
  assert.equal(control(undefined).orphan.runId, null);
});

test('stop and release by owner status', () => {
  const allowed = (owner, flags = {}) => {
    const c = control({ runId: 'r1', owner });
    const g = controlGates({ control: c, mode: 'live', ...flags });
    return { stop: g.canStopOrphan, release: canReleaseOrphan(g, c, flags.releasing) };
  };
  assert.deepEqual(allowed('alive'), { stop: true, release: false });
  assert.deepEqual(allowed('unknown'), { stop: true, release: true });
  assert.deepEqual(allowed('gone'), { stop: false, release: true });
  assert.deepEqual(allowed('unknown', { releasing: true }), { stop: false, release: false });
  assert.deepEqual(allowed('unknown', { stopping: true }), { stop: false, release: true }, 'a stop that nobody read can still be followed by a release');
  assert.deepEqual(allowed(undefined), { stop: true, release: false }, 'an old server has no release route');
  assert.deepEqual(allowed('dead'), { stop: true, release: true }, 'an owner value this UI does not know is unknown');
  const noId = control({ owner: 'gone' });
  assert.equal(canReleaseOrphan(controlGates({ control: noId, mode: 'live' }), noId), false);
  const c = control({ runId: 'r1', owner: 'gone' });
  assert.equal(canReleaseOrphan(controlGates({ control: c, mode: 'demo' }), c), false);
  const free = parseControl(BASE);
  assert.equal(canReleaseOrphan(controlGates({ control: free, mode: 'live' }), free), false);
});

test('recoveryText: the release dialog says what the contract asks for, only where release is offered', () => {
  const unknown = recoveryText({ runId: 'r1', owner: 'unknown' });
  assert.match(unknown.releaseConfirm, /cannot tell whether run r1 is still running/);
  assert.match(unknown.releaseConfirm, /sure it has stopped, for example after the app was closed or the computer restarted/);
  assert.match(unknown.releaseConfirm, /lets two runs share this chat/);
  assert.match(unknown.releaseConfirm, /recorded as aborted/);
  assert.match(unknown.stopConfirm, /release the chat instead/);
  assert.equal(recoveryText({ runId: 'r1', owner: 'alive' }).releaseConfirm, '');
  assert.equal(recoveryText({ runId: 'r1', owner: 'gone' }).stopConfirm, '');
  assert.equal(recoveryText({ runId: 'r1', owner: 'gone', recoveryError: 'x' }).title, 'Chat could not be released');
  const old = recoveryText({ runId: 'r1', owner: null });
  assert.equal(old.releaseConfirm, '', 'an old server: no release');
  assert.doesNotMatch(`${old.detail} ${old.stopConfirm}`, /release/i);
  assert.match(old.detail, /Request a stop/);
  for (const o of [{ runId: 'r1', owner: 'alive' }, { runId: 'r1', owner: 'unknown' }, { runId: 'r1', owner: 'gone' }, { runId: 'r1', owner: 'gone', recoveryError: 'x' }, { runId: 'r1', owner: null }]) {
    const t = recoveryText(o);
    assert.doesNotMatch(`${t.title} ${t.detail} ${t.stopConfirm} ${t.releaseConfirm}`, /hive|mailbox|CONTROL\.md|orchestrator/i, JSON.stringify(o));
  }
});

test('recoveryTimes and formatWhen: a time of another day carries its date', () => {
  const now = new Date(2026, 10, 9, 17, 30, 0).getTime();
  const today = new Date(2026, 10, 9, 17, 29, 59).toISOString();
  const yesterday = new Date(2026, 10, 8, 22, 56, 4).toISOString();
  assert.equal(formatWhen(today, now), formatClock(today));
  assert.equal(formatWhen(yesterday, now), '2026-11-08 22:56');
  assert.equal(formatWhen('nope', now), '--:--:--');
  assert.deepEqual(recoveryTimes({ runId: 'r1', startedAt: yesterday, stopRequestedAt: today, heartbeatAt: yesterday }, now), {
    meta: 'run r1 · since 2026-11-08 22:56',
    times: `stop requested ${formatClock(today)} · last seen running 2026-11-08 22:56`,
  });
  assert.deepEqual(recoveryTimes({ runId: 'r1' }, now), { meta: 'run r1', times: '' });
});

test('the release route: unscoped for a server without projects, per chat in a registry', () => {
  assert.equal(scopedUrl(null, 'release'), '/api/runs/release');
  assert.equal(scopedUrl({ project: 'core', chat: 'a' }, 'release'), '/api/projects/core/chats/a/release');
});

test('Release chat is a plain button in the recovery panel, reachable by keyboard', () => {
  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  const panel = /<section class="recovery"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.match(panel, /<button type="button" class="btn" id="recovery-release" aria-haspopup="dialog" hidden>Release chat<\/button>/);
  assert.doesNotMatch(panel, /id="recovery-release"[^>]*tabindex/);
});

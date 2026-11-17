// The labels that name a key say Cmd on a Mac and Ctrl elsewhere; the handlers already take either modifier.
// navigator.platform is pinned per case because Node reports the host's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMac, shortcut } from '../../visualizer/public/js/platform.js';
import { createThread } from '../../visualizer/public/js/thread.js';
import { createSteering } from '../../visualizer/public/js/chat-steer.js';
import { createAccountsPanel } from '../../visualizer/public/js/accounts-panel.js';
import { createScope, parseProjects } from '../../visualizer/public/js/scope.js';
import { parseControl } from '../../visualizer/public/js/control.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { installDom } from './fixtures/fake-dom.js';

const PUBLIC = new URL('../../visualizer/public/js/', import.meta.url);
// what each WebView reports; null: a page with no navigator at all
const PLATFORMS = { mac: ['MacIntel', 'Cmd'], windows: ['Win32', 'Ctrl'], linux: ['Linux x86_64', 'Ctrl'], none: [null, 'Ctrl'] };

function pin(platform) {
  const value = platform === null ? undefined : { platform };
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function threadHint() {
  const $ = installDom();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ runs: [] }) });
  const projects = parseProjects({ mode: 'registry', projects: [{ id: 'core', name: 'Core', workspace: 'C:\\code\\core', chats: [{ id: 'a', title: 'First', status: 'done', runs: 1 }] }] });
  const thread = createThread({
    scope: createScope({ project: 'core', chat: 'a' }),
    nav: { doc: () => projects, refresh() {}, newChat() {}, newProject() {}, rename() {} },
    control: { snapshot: () => ({ control: { enabled: true }, mode: 'live', gates: { alive: false, recovery: false } }), openRun() {}, startFollowUp: async () => ({ ok: true }) },
    onReplay() {},
    hasRun: () => true,
  });
  thread.activate();
  return $('followup-hint').textContent;
}

function steerBlock() {
  const $ = installDom();
  const runId = 'run-a';
  let seq = 0;
  const ev = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 11, 12, 0, seq)).toISOString(), runId, type, ...fields });
  const state = reduceAll([
    ev('run_started', { request: 'Todo', workspace: 'C:\\ws', maxFailedCycles: 3 }),
    ev('instance_started', { id: 'dwight-m1', instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
    ev('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'working', activity: 'Coding' }),
  ]);
  const control = parseControl({
    v: 1, enabled: true, workspace: 'C:\\ws', scenarios: ['happy'], lastExit: null, pendingHuman: null,
    run: { pid: 7, mode: 'run', request: 'Todo', workspace: 'C:\\ws', startedAt: '2026-11-11T12:00:00.000Z', runId },
  });
  const steering = createSteering({ getState: () => state, getControl: () => ({ control, mode: 'live', gates: { on: true, alive: true }, gone: false }) });
  const ids = { form: 'chat-form', to: 'chat-to', text: 'chat-text', count: 'chat-count', send: 'chat-send', block: 'chat-block', status: 'chat-status' };
  steering.mount(Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, $(id)])));
  steering.update();
  assert.equal(steering.blocked(), '', 'a live instance can be messaged, so the block line shows the shortcut');
  return $('chat-block').textContent;
}

// the clipboard refuses, as navigator.clipboard does without a user grant: the address is selected instead
async function copyFallback(t) {
  const $ = installDom();
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  globalThis.document.createRange = () => ({ selectNodeContents() {} });
  globalThis.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  createAccountsPanel({ getControl: () => ({ gates: { on: false, alive: false } }), confirm() {}, onChange() {} });
  if (globalThis.navigator) globalThis.navigator.clipboard = { writeText: async () => { throw new Error('denied'); } };
  $('login-url').textContent = 'https://accounts.example/auth';
  // the status clears after 2.5 s; that timer would only hold the test up
  const setTimer = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  t.after(() => { globalThis.setTimeout = setTimer; });
  await $('login-copy').fire('click');
  globalThis.setTimeout = setTimer;
  return $('login-copy-status').textContent;
}

test('shortcut names Cmd on a Mac only, and falls back to Ctrl when the page cannot tell', () => {
  for (const [name, [platform, mod]] of Object.entries(PLATFORMS)) {
    const nav = platform === null ? undefined : { platform };
    assert.equal(isMac(nav), mod === 'Cmd', name);
    assert.equal(shortcut('Enter', nav), `${mod}+Enter`, name);
  }
  assert.equal(shortcut('C', {}), 'Ctrl+C', 'a navigator without a platform');
  assert.equal(shortcut('C', { platform: 'iPhone' }), 'Ctrl+C', 'only a Mac WebView says Mac');
  pin('MacIntel');
  assert.equal(shortcut('C'), 'Cmd+C', 'the page\'s own navigator by default');
});

for (const [name, [platform, mod]] of Object.entries(PLATFORMS)) {
  test(`${name}: the Follow up hint, the steering composer and the copy fallback name ${mod}`, async (t) => {
    pin(platform);
    assert.equal(threadHint(), `Earlier turns of this chat are given to the team as context. ${mod}+Enter starts.`);
    assert.equal(steerBlock(), `${mod}+Enter sends`);
    assert.equal(await copyFallback(t), `Selected - press ${mod}+C to copy`);
  });
}

test('no label in these modules spells a modifier key itself', () => {
  for (const file of ['thread.js', 'chat-steer.js', 'accounts-panel.js']) {
    const src = readFileSync(new URL(file, PUBLIC), 'utf8');
    assert.deepEqual(src.match(/['`][^'`\n]*\b(Ctrl|Cmd)\+[^'`\n]*/g), null, `${file} names the key through shortcut()`);
    assert.match(src, /import \{ shortcut \} from '\.\/platform\.js';/, file);
  }
});

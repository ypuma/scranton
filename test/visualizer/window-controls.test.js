// The desktop app's window has no native title bar (.enma/titlebar-contract.md): the top bar carries Minimize,
// Maximize and Close and drags the window. A browser gets none of it. A modal dialog makes the bar inert and its
// backdrop takes the bar's pointer events with the dialog as their target, so the controls are found by position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWindowControls } from '../../visualizer/public/js/window-controls.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const PUBLIC = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const INTERACTIVE = 'button, a, input, select, textarea, summary, label, [role="button"]';
// a 1280 px wide window with a 48 px bar; the controls are 46 px each, flush right
const BAR_H = 48;
const SPAN = { 'win-minimize': [1142, 1188], 'win-maximize': [1188, 1234], 'win-close': [1234, 1280] };
const box = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const over = (id) => ({ clientX: (SPAN[id][0] + SPAN[id][1]) / 2, clientY: 24 });
const tick = () => new Promise((r) => setImmediate(r));

// The Tauri window the page sees. fail: the methods that reject.
function fakeWindow({ maximized = false, fail = [] } = {}) {
  const calls = [];
  const state = { maximized };
  const method = (name, answer) => () => {
    calls.push(name);
    return fail.includes(name) ? Promise.reject(new Error(`${name} not allowed`)) : Promise.resolve(answer?.());
  };
  const win = {
    minimize: method('minimize'), close: method('close'), startDragging: method('startDragging'),
    toggleMaximize: method('toggleMaximize', () => { state.maximized = !state.maximized; }),
    isMaximized: method('isMaximized', () => state.maximized),
  };
  return { calls, state, win, tauri: { window: { getCurrentWindow: () => win } } };
}

// tauri: undefined = a browser; otherwise what the page sees as globalThis.__TAURI__. platform: navigator.platform,
// pinned because Node reports the host's own.
async function harness({ tauri, platform = 'Win32' } = {}) {
  const $ = installDom();
  Object.defineProperty(globalThis, 'navigator', { value: { platform }, configurable: true, writable: true });
  const listeners = { document: [], window: [] };
  globalThis.document.addEventListener = (type, fn, capture) => listeners.document.push({ type, fn, capture });
  globalThis.addEventListener = (type, fn) => listeners.window.push({ type, fn });
  if (tauri) globalThis.__TAURI__ = tauri;
  else delete globalThis.__TAURI__;
  // as index.html has them
  $('window-controls').hidden = true;
  $('win-maximize').setAttribute('aria-label', 'Maximize');
  $('window-controls').getBoundingClientRect = () => box(1142, 0, 1280, BAR_H);
  for (const [id, [left, right]] of Object.entries(SPAN)) $(id).getBoundingClientRect = () => box(left, 0, right, BAR_H);
  const controls = createWindowControls();
  await tick();

  // An event as the browser delivers it: the document's capture listeners, then the target's own unless stopped.
  async function send(type, target, fields = {}) {
    const ev = {
      type, target, button: 0, detail: 1, clientX: 0, clientY: 0, relatedTarget: target, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
      ...fields,
    };
    await Promise.all(listeners.document.filter((l) => l.type === type).map((l) => l.fn(ev)));
    if (!ev.stopped) await target.fire(type, ev);
    return ev;
  }
  const emit = (type) => Promise.all(listeners.window.filter((l) => l.type === type).map((l) => l.fn({ type })));
  return { $, controls, listeners, send, emit };
}

// a modal dialog as the page has them: a click that lands on the dialog element itself (its backdrop) closes it
function openDrawer($) {
  const dialog = $('run-dialog');
  dialog.tagName = 'DIALOG';
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
  dialog.showModal();
  return dialog;
}

// an element inside an interactive control of the bar, and one that is not
function barTargets() {
  const seen = [];
  const button = new FakeEl();
  button.closest = (sel) => {
    seen.push(sel);
    return button;
  };
  return { button, text: new FakeEl(), seen };
}

test('in a browser nothing is installed: no shell mark, the controls stay hidden, no listener', async () => {
  // no Tauri at all, the desktop APIs of the other features only, and a window API without getCurrentWindow
  for (const tauri of [undefined, { core: { invoke() {} }, notification: {} }, { window: {} }]) {
    const h = await harness({ tauri });
    assert.deepEqual(h.controls, { desktop: false });
    assert.equal('shell' in globalThis.document.body.dataset, false);
    assert.equal(h.$('window-controls').hidden, true);
    assert.deepEqual(h.listeners, { document: [], window: [] });
    assert.equal(h.$('win-maximize').getAttribute('aria-label'), 'Maximize');
  }
});

test('the desktop shell marks the page, shows the controls and listens ahead of every dialog', async () => {
  const w = fakeWindow();
  const h = await harness({ tauri: w.tauri });
  assert.deepEqual(h.controls, { desktop: true });
  assert.equal(globalThis.document.body.dataset.shell, 'desktop');
  assert.equal(h.$('window-controls').hidden, false);
  for (const type of ['mousedown', 'click']) {
    const found = h.listeners.document.filter((l) => l.type === type);
    assert.equal(found.length, 1, type);
    assert.equal(found[0].capture, true, `${type} is taken in the capture phase`);
  }
  assert.equal(h.listeners.document.some((l) => l.type === 'dblclick'), false, 'the second press is the double click');
  assert.deepEqual(h.listeners.window.map((l) => l.type).sort(), ['blur', 'resize']);
  assert.deepEqual(w.calls, ['isMaximized'], 'the state is read once at the start');
});

test('each control calls its window method, and a press on it neither drags nor moves the focus', async () => {
  const w = fakeWindow();
  const h = await harness({ tauri: w.tauri });
  for (const [id, method] of [['win-minimize', 'minimize'], ['win-close', 'close']]) {
    w.calls.length = 0;
    const down = await h.send('mousedown', h.$(id), over(id));
    assert.equal(down.prevented, true, id);
    const click = await h.send('click', h.$(id), over(id));
    assert.equal(click.stopped, true, id);
    assert.deepEqual(w.calls, [method], id);
  }
  w.calls.length = 0;
  await h.send('mousedown', h.$('win-maximize'), over('win-maximize'));
  await h.send('click', h.$('win-maximize'), over('win-maximize'));
  assert.deepEqual(w.calls, ['toggleMaximize', 'isMaximized']);

  // the glyph inside the button is the target of a real click; a scripted click carries no position
  const glyph = new FakeEl();
  h.$('win-close').contains = (x) => x === glyph;
  w.calls.length = 0;
  await h.send('click', glyph);
  assert.deepEqual(w.calls, ['close']);
});

test('the maximize control reads Restore while the window is maximized: at the start, after its toggle, after a resize', async () => {
  const w = fakeWindow({ maximized: true });
  const h = await harness({ tauri: w.tauri });
  const max = h.$('win-maximize');
  assert.equal(max.getAttribute('aria-label'), 'Restore');
  assert.equal(max.dataset.maximized, 'true', 'the glyph follows this attribute');

  await h.send('click', max, over('win-maximize'));
  assert.equal(w.state.maximized, false);
  assert.equal(max.getAttribute('aria-label'), 'Maximize');
  assert.equal(max.dataset.maximized, 'false');

  // maximized from outside the page: Win+Up, a snap, a drag to the screen edge
  w.state.maximized = true;
  await h.emit('resize');
  assert.equal(max.getAttribute('aria-label'), 'Restore');
  assert.equal(max.dataset.maximized, 'true');
  w.state.maximized = false;
  await h.emit('resize');
  assert.equal(max.getAttribute('aria-label'), 'Maximize');
  assert.equal(max.dataset.maximized, 'false');
});

test('resize events during a read ask once more, and the newest answer is the one shown', async () => {
  const pending = [];
  const calls = [];
  const win = { isMaximized: () => new Promise((resolve) => { calls.push('isMaximized'); pending.push(resolve); }) };
  const h = await harness({ tauri: { window: { getCurrentWindow: () => win } } });
  for (let i = 0; i < 5; i += 1) h.emit('resize');
  assert.equal(calls.length, 1, 'one read in flight');
  pending[0](false);
  await tick();
  assert.equal(calls.length, 2, 'the burst costs one more read, not five');
  pending[1](true);
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(h.$('win-maximize').getAttribute('aria-label'), 'Restore');
});

test('a press on the bare bar drags the window; a press on a control of the bar is left alone', async () => {
  const w = fakeWindow();
  const h = await harness({ tauri: w.tauri });
  const t = barTargets();
  w.calls.length = 0;

  const drag = await h.send('mousedown', t.text, { clientX: 300, clientY: 24 });
  assert.deepEqual(w.calls, ['startDragging']);
  assert.equal(drag.prevented, true, 'no text selection, no focus change');

  const onButton = await h.send('mousedown', t.button, { clientX: 1100, clientY: 24 });
  assert.deepEqual(w.calls, ['startDragging'], 'New run and its neighbours keep their press');
  assert.equal(onButton.prevented, false);
  assert.equal(onButton.stopped, false);
  assert.deepEqual(t.seen, [INTERACTIVE], 'what counts as a control is the list of the contract');

  await h.send('mousedown', t.text, { clientX: 300, clientY: 24, button: 2 });
  await h.send('mousedown', t.text, { clientX: 300, clientY: BAR_H });
  await h.send('mousedown', t.text, { clientX: 300, clientY: 400 });
  assert.deepEqual(w.calls, ['startDragging'], 'not the secondary button, not the page below the bar');

  // a bar that wrapped to a second row drags from there too
  h.$('topbar').contains = (x) => x === t.text;
  await h.send('mousedown', t.text, { clientX: 300, clientY: 70 });
  assert.deepEqual(w.calls, ['startDragging', 'startDragging']);

  const click = await h.send('click', t.text, { clientX: 300, clientY: 24 });
  assert.equal(click.stopped, false, 'a click on the bar is nobody else\'s business to lose');
});

test('the second press of a double click on the bar maximizes instead of dragging', async () => {
  const w = fakeWindow();
  const h = await harness({ tauri: w.tauri });
  const { text } = barTargets();
  w.calls.length = 0;
  await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 1 });
  await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 2 });
  assert.deepEqual(w.calls, ['startDragging', 'toggleMaximize', 'isMaximized']);
  assert.equal(w.state.maximized, true);
  assert.equal(h.$('win-maximize').getAttribute('aria-label'), 'Restore');

  // not on a control: two quick clicks on Minimize are two clicks
  w.calls.length = 0;
  await h.send('mousedown', h.$('win-minimize'), { ...over('win-minimize'), detail: 2 });
  assert.deepEqual(w.calls, []);
});

test('on Windows and Linux the press maximizes, and no release is listened to', async () => {
  for (const platform of ['Win32', 'Linux x86_64', '', undefined]) {
    const w = fakeWindow();
    const h = await harness({ tauri: w.tauri, platform });
    assert.equal(h.listeners.document.some((l) => l.type === 'mouseup'), false, String(platform));
    const { text } = barTargets();
    w.calls.length = 0;
    await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 1 });
    await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 2 });
    assert.deepEqual(w.calls, ['startDragging', 'toggleMaximize', 'isMaximized'], String(platform));
  }
});

test('on macOS a double click on the bar zooms on its release, and not when the pointer moved', async () => {
  const w = fakeWindow();
  const h = await harness({ tauri: w.tauri, platform: 'MacIntel' });
  const ups = h.listeners.document.filter((l) => l.type === 'mouseup');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].capture, true);
  const { text } = barTargets();
  w.calls.length = 0;

  await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 1 });
  const second = await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 2 });
  assert.deepEqual(w.calls, ['startDragging'], 'the second press neither drags nor zooms');
  assert.equal(second.prevented, true);
  await h.send('mouseup', text, { clientX: 300, clientY: 24, detail: 2 });
  assert.deepEqual(w.calls, ['startDragging', 'toggleMaximize', 'isMaximized']);
  assert.equal(h.$('win-maximize').getAttribute('aria-label'), 'Restore');

  w.calls.length = 0;
  await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 2 });
  await h.send('mouseup', text, { clientX: 340, clientY: 24, detail: 2 });
  await h.send('mouseup', text, { clientX: 300, clientY: 24, detail: 2 });
  assert.deepEqual(w.calls, [], 'a moved release cancels, and one press zooms at most once');

  // a release with no double press on the bar before it: a control, the page, a plain click
  await h.send('mousedown', h.$('win-close'), { ...over('win-close'), detail: 2 });
  await h.send('mouseup', h.$('win-close'), { ...over('win-close'), detail: 2 });
  await h.send('mousedown', text, { clientX: 300, clientY: 400, detail: 2 });
  await h.send('mouseup', text, { clientX: 300, clientY: 400, detail: 2 });
  await h.send('mouseup', text, { clientX: 300, clientY: 24, detail: 1 });
  assert.deepEqual(w.calls, []);

  // under a modal dialog the backdrop takes both halves
  const dialog = openDrawer(h.$);
  await h.send('mousedown', dialog, { clientX: 300, clientY: 24, detail: 2 });
  await h.send('mouseup', dialog, { clientX: 300, clientY: 24, detail: 2 });
  await h.send('click', dialog, { clientX: 300, clientY: 24, detail: 2 });
  assert.deepEqual(w.calls, ['toggleMaximize', 'isMaximized']);
  assert.equal(dialog.open, true);
});

test('a window that refuses, throws or lacks a method never throws into the page', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const refusing = fakeWindow({ fail: ['minimize', 'toggleMaximize', 'close', 'isMaximized', 'startDragging'] });
    const throwing = { window: { getCurrentWindow: () => { throw new Error('no window'); } } };
    const empty = { window: { getCurrentWindow: () => ({}) } };
    for (const tauri of [refusing.tauri, throwing, empty]) {
      const h = await harness({ tauri });
      const { text } = barTargets();
      assert.equal(h.controls.desktop, true, 'still the desktop shell: the controls stay on screen');
      for (const id of Object.keys(SPAN)) {
        await h.send('mousedown', h.$(id), over(id));
        await h.send('click', h.$(id), over(id));
      }
      await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 1 });
      await h.send('mousedown', text, { clientX: 300, clientY: 24, detail: 2 });
      await h.emit('resize');
      await tick();
      assert.equal(h.$('win-maximize').getAttribute('aria-label'), 'Maximize', 'no answer, no change');
      assert.equal('maximized' in h.$('win-maximize').dataset, false);
    }
    assert.deepEqual(refusing.calls.filter((c) => c !== 'isMaximized'), ['minimize', 'toggleMaximize', 'close', 'startDragging', 'toggleMaximize']);
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('under a modal dialog a control is found by position, and its click never reaches the dialog', async () => {
  const w = fakeWindow();
  const h = await harness({ tauri: w.tauri });
  const dialog = openDrawer(h.$);
  for (const [id, expected] of [['win-minimize', ['minimize']], ['win-maximize', ['toggleMaximize', 'isMaximized']], ['win-close', ['close']]]) {
    w.calls.length = 0;
    // the backdrop is the dialog: every event over the inert bar has the dialog as its target
    const down = await h.send('mousedown', dialog, over(id));
    const click = await h.send('click', dialog, over(id));
    assert.deepEqual(w.calls, expected, id);
    assert.equal(down.stopped, true, id);
    assert.equal(click.stopped, true, id);
    assert.equal(dialog.open, true, `${id}: the drawer stays open`);
  }
  // one pixel outside the Close control: its edges are exact
  w.calls.length = 0;
  await h.send('click', dialog, { clientX: 1233.5, clientY: 47.5 });
  assert.deepEqual(w.calls, ['toggleMaximize', 'isMaximized'], 'left of Close is Maximize');
  w.calls.length = 0;
  await h.send('click', dialog, { clientX: 1141.5, clientY: 24 });
  assert.deepEqual(w.calls, [], 'left of Minimize is the bar');
  assert.equal(dialog.open, true);
});

test('under a modal dialog the bar still drags and maximizes, and a click on it does not dismiss the dialog', async () => {
  const w = fakeWindow();
  const h = await harness({ tauri: w.tauri });
  const dialog = openDrawer(h.$);
  w.calls.length = 0;

  const first = await h.send('mousedown', dialog, { clientX: 300, clientY: 24, detail: 1 });
  const click = await h.send('click', dialog, { clientX: 300, clientY: 24, detail: 1 });
  assert.deepEqual(w.calls, ['startDragging']);
  assert.equal(first.stopped, true);
  assert.equal(click.stopped, true);
  assert.equal(dialog.open, true, 'a click on the bar is no backdrop click');

  await h.send('mousedown', dialog, { clientX: 300, clientY: 24, detail: 2 });
  assert.deepEqual(w.calls, ['startDragging', 'toggleMaximize', 'isMaximized']);
  assert.equal(dialog.open, true);

  // a keyboard click carries no position (0, 0 is inside the bar) and has the pressed button as its target
  const cancel = new FakeEl();
  cancel.closest = () => cancel;
  const keyboard = await h.send('click', cancel, { clientX: 0, clientY: 0, detail: 0 });
  assert.equal(keyboard.stopped, false, 'the dialog\'s own buttons keep working from the keyboard');

  // below the bar the backdrop is the page's again
  w.calls.length = 0;
  const below = await h.send('click', dialog, { clientX: 300, clientY: BAR_H });
  assert.equal(below.stopped, false);
  assert.equal(dialog.open, false, 'a backdrop click still dismisses the drawer');
  assert.deepEqual(w.calls, []);
});

test('hover follows the pointer, also through a backdrop, and ends when the pointer or the window is gone', async () => {
  const w = fakeWindow();
  const h = await harness({ tauri: w.tauri });
  const dialog = openDrawer(h.$);
  const hot = () => Object.keys(SPAN).filter((id) => h.$(id).dataset.hot === 'true');

  await h.send('mousemove', dialog, over('win-close'));
  assert.deepEqual(hot(), ['win-close']);
  await h.send('mousemove', dialog, over('win-maximize'));
  assert.deepEqual(hot(), ['win-maximize'], 'one control at a time');
  await h.send('mousemove', dialog, { clientX: 300, clientY: 300 });
  assert.deepEqual(hot(), []);

  await h.send('mousemove', h.$('win-minimize'), over('win-minimize'));
  assert.deepEqual(hot(), ['win-minimize']);
  await h.send('mouseout', h.$('win-minimize'), { relatedTarget: h.$('topbar') });
  assert.deepEqual(hot(), ['win-minimize'], 'still inside the window');
  await h.send('mouseout', h.$('win-minimize'), { relatedTarget: null });
  assert.deepEqual(hot(), [], 'the pointer left the window');

  await h.send('mousemove', dialog, over('win-close'));
  await h.emit('blur');
  assert.deepEqual(hot(), []);

  // a minimized window reports no pointer leaving it
  await h.send('mousemove', h.$('win-minimize'), over('win-minimize'));
  await h.send('click', h.$('win-minimize'), over('win-minimize'));
  assert.deepEqual(hot(), []);
});

// ------------------------------------------------------------ markup and styles
const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const css = readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }));
const GATE = 'body[data-shell="desktop"]';
const rule = (selector) => {
  const found = rules.find((r) => r.selectors.includes(selector));
  assert.ok(found, `no rule for ${selector}`);
  return found.body;
};

test('the controls are the last thing in the top bar, hidden until the desktop shell shows them', () => {
  assert.match(html, /<header class="topbar" id="topbar">/);
  const m = /<div class="window-controls" id="window-controls" hidden>([\s\S]*?)<\/div>\s*<\/div>\s*<\/header>/.exec(html);
  assert.ok(m, 'the controls close the bar');
  const buttons = [...m[1].matchAll(/<button type="button" tabindex="-1" id="([a-z-]+)" aria-label="([A-Za-z]+)">(.*?)<\/button>/g)];
  assert.deepEqual(buttons.map((b) => [b[1], b[2]]), [['win-minimize', 'Minimize'], ['win-maximize', 'Maximize'], ['win-close', 'Close']]);
  assert.equal(m[1].match(/<button\b/g).length, 3);
  for (const b of buttons) assert.match(b[3], /^<svg [^>]*aria-hidden="true"><path [^>]*fill="none" stroke="currentColor"[^>]*\/>.*<\/svg>$/, `${b[1]}: an inline line glyph`);
  assert.match(buttons[1][3], /<path class="glyph-maximize" [^>]*\/><path class="glyph-restore" [^>]*\/>/, 'both glyphs of the maximize control');
  const main = readFileSync(path.join(PUBLIC, 'js', 'main.js'), 'utf8');
  assert.match(main, /import \{ createWindowControls \} from '\.\/window-controls\.js';/);
  assert.match(main, /^createWindowControls\(\);$/m);
});

test('a browser keeps its page: every title bar rule waits for the desktop shell or for the hidden controls', () => {
  assert.match(rule('[hidden]'), /display:\s*none\s*!important/, 'hidden controls take no room in a browser');
  const shellRules = rules.filter((r) => r.selectors.some((s) => s.includes('data-shell')));
  assert.ok(shellRules.length >= 8, `only ${shellRules.length} desktop rules found - is the scan still reading styles.css?`);
  for (const r of shellRules) for (const s of r.selectors) assert.ok(s.startsWith(GATE), `${s} applies outside the desktop shell`);
  // the room the controls take is used nowhere else
  const sized = rules.filter((r) => r.body.includes('var(--win-control-w)'));
  assert.ok(sized.length >= 3);
  for (const r of sized) for (const s of r.selectors) assert.ok(s.startsWith(GATE) || s.startsWith('.window-controls'), `${s} uses the controls' width`);
  const js = readFileSync(path.join(PUBLIC, 'js', 'window-controls.js'), 'utf8');
  assert.equal(js.match(/dataset\.shell\b/g).length, 1, 'one place sets the mark');
  assert.ok(js.indexOf("return { desktop: false }") < js.indexOf('dataset.shell'), 'and a browser has left before it');
});

test('in the desktop shell nothing opens over the bar and the backdrop leaves the window controls clear', () => {
  assert.match(rule(`${GATE} .topbar`), /padding-right:\s*calc\(3 \* var\(--win-control-w\) \+ var\(--s3\)\)/, 'the app actions end before the controls');
  const drawer = rule(`${GATE} .drawer`);
  assert.match(drawer, /top:\s*var\(--topbar-h\)/);
  assert.match(drawer, /max-height:\s*calc\(100% - var\(--topbar-h\)\)/);
  assert.match(drawer, /clip-path:\s*inset\(0 0 0 -[\d.]+rem\)/, 'its shadow stays off the bar');
  assert.match(rule(`${GATE} .confirm`), /top:\s*var\(--topbar-h\)/);
  assert.match(rule(`${GATE} .sidebar`), /top:\s*var\(--topbar-h\)/);
  assert.match(rule(`${GATE} .nav-scrim`), /top:\s*var\(--topbar-h\)/);
  const backdrop = rule(`${GATE} dialog::backdrop`).replace(/\s+/g, ' ');
  assert.match(backdrop, /linear-gradient\(var\(--scrim\), var\(--scrim\)\) 0 0 \/ calc\(100% - 3 \* var\(--win-control-w\)\) var\(--topbar-h\) no-repeat/, 'the bar is dimmed up to the controls');
  assert.match(backdrop, /linear-gradient\(var\(--scrim\), var\(--scrim\)\) 0 var\(--topbar-h\) \/ 100% 100% no-repeat/, 'and the page below it as before');
  assert.doesNotMatch(backdrop, /\b(inset|top|height|display|pointer-events)\s*:/, 'it still spans the window: a press on the bar must land on the dialog');
  assert.match(rule(GATE), /overflow:\s*hidden/, 'no window scrollbar beside the controls');
});

test('the controls are flush in the corner, as tall as the bar, and Close inverts instead of turning red', () => {
  const boxRule = rule('.window-controls');
  assert.match(boxRule, /position:\s*absolute/);
  assert.match(boxRule, /top:\s*0/);
  assert.match(boxRule, /right:\s*0/);
  assert.match(boxRule, /height:\s*var\(--topbar-h\)/);
  assert.match(css, /--win-control-w:\s*2\.875rem/, '46 px at the default text size');
  assert.match(rule('.window-controls button'), /width:\s*var\(--win-control-w\)/);
  assert.match(rule('.window-controls button[data-hot="true"]'), /background:\s*var\(--fill-hover\)/);
  const close = rule('#win-close[data-hot="true"]');
  assert.match(close, /background:\s*var\(--text\)/);
  assert.match(close, /color:\s*var\(--bg\)/);
  assert.match(rule('#win-maximize[data-maximized="true"] .glyph-maximize'), /display:\s*none/);
  assert.match(rule('.glyph-restore'), /display:\s*none/);
  assert.match(rule('#win-maximize[data-maximized="true"] .glyph-restore'), /display:\s*inline/);
});

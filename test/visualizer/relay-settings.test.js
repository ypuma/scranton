// The phone relay in the dashboard: the pairing page the relay serves (src/server/relay-page.js) works without
// scripts under its own strict CSP, and Settings shows the local relay command or, on a phone proven to be paired,
// the disconnect form, and nothing anywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pairPage } from '../../src/server/relay-page.js';
import { relayTarget, relayCommands, mayBeRelay, relayPaired } from '../../visualizer/public/js/phone-relay.js';
import { createSettings } from '../../visualizer/public/js/settings-panel.js';

const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');

function render(status, headers = {}) {
  const res = {
    getHeader: (name) => headers[name.toLowerCase()],
    writeHead(code, head) { this.status = code; this.head = head; },
    end(body) { this.body = body; },
  };
  pairPage(res, status);
  return res;
}
const sha = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

test('pairing page: a native form under a CSP that allows only its own hashed style and script', () => {
  const page = render(undefined);
  assert.equal(page.status, 200);
  assert.deepEqual(Object.keys(page.head), ['Content-Type', 'Content-Security-Policy']);
  assert.equal(page.head['Content-Type'], 'text/html; charset=utf-8');
  const csp = page.head['Content-Security-Policy'];
  const styles = [...page.body.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  const scripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(styles.length, 1);
  assert.equal(scripts.length, 1);
  assert.equal(csp, `default-src 'none'; style-src ${sha(styles[0][1])}; script-src ${sha(scripts[0][1])}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
  assert.doesNotMatch(csp, /unsafe|\*/);
  assert.doesNotMatch(page.body, /\son[a-z]+\s*=|\sstyle\s*=|<script\s[^>]*src|<link|https?:/i, 'nothing inline beyond the hashed blocks, nothing fetched');
  for (const hex of styles[0][1].match(/#[0-9a-f]{6}\b/gi)) {
    const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
    assert.ok(r === g && g === b, `${hex} is a gray`);
  }

  // without scripts: the form posts the masked code and the Show control stays out of the way
  const form = page.body.match(/<form [^>]*>[\s\S]*<\/form>/)[0];
  assert.match(form, /^<form method="post" action="\/_relay\/pair">/);
  assert.match(form, /<label for="code">Pairing code<\/label>/);
  const input = form.match(/<input [^>]*>/)[0];
  for (const attr of ['id="code"', 'name="code"', 'type="password"', 'autocomplete="off"', 'autocapitalize="none"', 'spellcheck="false"', 'required', 'maxlength="64"', 'aria-describedby="code-hint"']) {
    assert.ok(input.includes(attr), attr);
  }
  assert.doesNotMatch(input, /\svalue=|autofocus|aria-invalid/);
  assert.match(input, /pattern="\[A-Za-z0-9_\\-\]\+"/);
  assert.ok(new RegExp(`^${input.match(/pattern="([^"]+)"/)[1]}$`, 'v').test('Ab0_-x'), 'the pattern compiles with the v flag browsers use');
  assert.match(form, /<button type="button" class="reveal" id="reveal" aria-controls="code" hidden>Show code<\/button>/);
  assert.match(form, /<p class="hint" id="code-hint">[^<]+case-sensitive[^<]+<\/p>/);
  assert.match(form, /<button type="submit">Connect to Scranton<\/button>/);
  assert.doesNotMatch(page.body, /role="alert"/);
  assert.match(page.body, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test('pairing page: a wrong code and a cooldown say what to do, and the code is never echoed', () => {
  const wrong = render(401);
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /<p role="alert" id="code-error">That code did not match\.[^<]*relay terminal[^<]*<\/p>/);
  const input = wrong.body.match(/<input [^>]*>/)[0];
  assert.match(input, /aria-describedby="code-hint code-error"/);
  assert.match(input, / aria-invalid="true" autofocus>$/);
  assert.match(wrong.body, /<title>Try again - Pair with Scranton<\/title>/);

  const paused = render(429, { 'retry-after': '30' });
  assert.equal(paused.status, 429);
  assert.match(paused.body, /<p role="alert" id="code-error">Pairing is paused for 30 seconds, after several wrong codes or because the most browsers are paired already\. Wait, or disconnect another phone/);
  assert.doesNotMatch(paused.body.match(/<input [^>]*>/)[0], /autofocus|aria-invalid/, 'no keyboard pops up while it has to wait');
  assert.match(render(429).body, /paused for a minute,/);
  assert.match(render(429, { 'retry-after': '300' }).body, /paused for 5 minutes,/);
  assert.match(render(429, { 'retry-after': '43200' }).body, /paused for 12 hours,/, 'a full session table waits for the oldest to expire');
  assert.match(render(429, { 'retry-after': 'soon' }).body, /paused for a minute,/);
  for (const page of [render(200), wrong, paused]) {
    assert.equal(page.head['Content-Security-Policy'], render(200).head['Content-Security-Policy'], 'the hashes cover every status');
    assert.doesNotMatch(page.body, /value=|localStorage|sessionStorage|location|\?code/);
  }
});

test('pairing page script: Show reveals the code, and pasted spaces are dropped', () => {
  const page = render(200);
  const listeners = {};
  const el = (id) => ({ id, hidden: true, type: 'password', value: '', textContent: 'Show code', focused: 0,
    focus() { this.focused++; }, addEventListener(type, fn) { listeners[`${id}:${type}`] = fn; } });
  const nodes = { code: el('code'), reveal: el('reveal') };
  vm.runInNewContext(page.body.match(/<script>([\s\S]*?)<\/script>/)[1], { document: { getElementById: (id) => nodes[id] } });
  const { code, reveal } = nodes;
  assert.equal(reveal.hidden, false);
  listeners['reveal:click']();
  assert.deepEqual([code.type, reveal.textContent, code.focused], ['text', 'Hide code', 1]);
  listeners['reveal:click']();
  assert.deepEqual([code.type, reveal.textContent], ['password', 'Show code']);
  code.value = ' kodNOQ-eGd_DHSF\n';
  listeners['code:input']();
  assert.equal(code.value, 'kodNOQ-eGd_DHSF');
});

test('relay target: the dashboard port on the names that reach 127.0.0.1, guidance on other loopback, nothing elsewhere', () => {
  const loc = (href) => new URL(href);
  assert.deepEqual(relayTarget(loc('http://127.0.0.1:1725/')), { port: '1725', attached: true });
  assert.deepEqual(relayTarget(loc('http://localhost:49152/index.html')), { port: '49152', attached: true });
  assert.deepEqual(relayTarget(loc('http://LOCALHOST:3000/')), { port: '3000', attached: true });
  assert.deepEqual(relayTarget(loc('http://scranton.localhost:1725/')), { port: '1725', attached: true });
  assert.deepEqual(relayTarget(loc('http://localhost/')), { port: '80', attached: true }, 'the default port is still a port');
  assert.deepEqual(relayTarget(loc('http://[::1]:1725/')), { port: '1725', attached: false });
  assert.deepEqual(relayTarget(loc('http://127.0.0.2:1725/')), { port: '1725', attached: false });
  for (const href of ['https://127.0.0.1:1725/', 'https://scranton.example.test/', 'http://192.168.1.20:1725/', 'http://localhost.evil.test:1725/',
    'http://evil-localhost:1725/', 'file:///C:/scranton/visualizer/public/index.html']) {
    assert.equal(relayTarget(loc(href)), null, href);
  }
  assert.equal(relayTarget(undefined), null);

  assert.deepEqual(relayCommands('1725'), {
    checkout: 'node bin/scranton.js relay --origin https://YOUR-PRIVATE-HOST --target-port 1725',
    windows: '.\\scranton-node.exe .\\app\\bin\\scranton.js relay --origin https://YOUR-PRIVATE-HOST --target-port 1725',
  });
  assert.equal(mayBeRelay(loc('https://scranton.example.test/')), true);
  assert.equal(mayBeRelay(loc('http://127.0.0.1:1725/')), false);
});

test('paired: only a same-origin 200 with paired true is proof', async () => {
  const seen = [];
  const answer = (make) => async (url, init) => { seen.push([url, init]); return make(); };
  const json = (status, doc) => () => new Response(JSON.stringify(doc), { status, headers: { 'Content-Type': 'application/json' } });
  assert.equal(await relayPaired(answer(json(200, { paired: true }))), true);
  const [url, init] = seen[0];
  assert.equal(url, '/_relay/session');
  assert.deepEqual([init.credentials, init.cache, init.redirect, init.method], ['same-origin', 'no-store', 'error', undefined]);
  assert.ok(init.signal instanceof AbortSignal);
  for (const [name, make] of [
    ['paired false', json(200, { paired: false })], ['a string', json(200, { paired: 'true' })], ['null', json(200, null)],
    ['401', json(401, { paired: true })], ['404', json(404, { error: 'Not found' })],
    ['html', () => new Response('<!doctype html><title>Pair</title>', { status: 200 })],
    ['network', () => { throw new TypeError('Failed to fetch'); }], ['nothing', () => undefined],
  ]) {
    assert.equal(await relayPaired(answer(make)), false, name);
  }
});

// a page made of the ids Settings looks up; each starts hidden exactly when index.html says so
function fakePage(href, { controls = true, fetch } = {}) {
  const nodes = new Map();
  const startsHidden = (id) => new RegExp(`<[a-z]+\\s[^>]*\\bid="${id}"[^>]*\\shidden(?=[\\s>])`).test(html);
  const element = (id) => {
    const listeners = {};
    return {
      id, hidden: id === 'run-actions' ? !controls : startsHidden(id), textContent: '', value: '', checked: false, disabled: false, open: false, dataset: {},
      attrs: {}, listeners,
      getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
      querySelectorAll: () => [], querySelector: () => element('inner'), focus() {}, click() { for (const fn of listeners.click ?? []) fn({ target: this }); },
      showModal() { this.open = true; }, close() { this.open = false; },
    };
  };
  const calls = [];
  globalThis.location = new URL(href);
  globalThis.document = {
    documentElement: { dataset: {} }, activeElement: null,
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); },
  };
  globalThis.fetch = async (...args) => { calls.push(args); return fetch ? fetch(...args) : new Response('', { status: 404 }); };
  createSettings();
  const $ = (id) => document.getElementById(id);
  return { $, calls, open: async () => { $('bar-settings').click(); await new Promise((r) => setTimeout(r, 0)); } };
}

test('Settings: the local dashboard gets the relay command for its own port, and never asks the relay', async (t) => {
  const saved = [globalThis.location, globalThis.document, globalThis.fetch];
  t.after(() => { [globalThis.location, globalThis.document, globalThis.fetch] = saved; });

  for (const [href, port] of [['http://127.0.0.1:1725/', '1725'], ['http://localhost:49231/', '49231'], ['http://localhost/', '80']]) {
    const page = fakePage(href);
    await page.open();
    const { $ } = page;
    assert.deepEqual([$('prefs-relay').hidden, $('prefs-relay-local').hidden, $('prefs-relay-commands').hidden, $('prefs-relay-phone').hidden], [false, false, false, true], href);
    assert.equal($('prefs-relay-port').textContent, port);
    assert.equal($('prefs-relay-checkout').textContent, `node bin/scranton.js relay --origin https://YOUR-PRIVATE-HOST --target-port ${port}`);
    assert.equal($('prefs-relay-windows').textContent, `.\\scranton-node.exe .\\app\\bin\\scranton.js relay --origin https://YOUR-PRIVATE-HOST --target-port ${port}`);
    assert.deepEqual([$('prefs-relay-loopback').hidden, $('prefs-relay-control').hidden], [true, true]);
    assert.equal(page.calls.length, 0, `${href}: no probe on loopback HTTP`);
  }

  const readOnly = fakePage('http://127.0.0.1:1725/', { controls: false });
  await readOnly.open();
  assert.equal(readOnly.$('prefs-relay-control').hidden, false, 'a read-only dashboard says the relay needs controls');

  const v6 = fakePage('http://[::1]:1725/');
  await v6.open();
  assert.deepEqual([v6.$('prefs-relay').hidden, v6.$('prefs-relay-commands').hidden, v6.$('prefs-relay-loopback').hidden, v6.$('prefs-relay-control').hidden], [false, true, false, true],
    'no command that would miss the dashboard, the reason instead');
});

test('Settings: a paired phone gets the disconnect form; a demo, another host or a failed probe shows nothing', async (t) => {
  const saved = [globalThis.location, globalThis.document, globalThis.fetch];
  t.after(() => { [globalThis.location, globalThis.document, globalThis.fetch] = saved; });

  const phone = fakePage('https://scranton.example.test/', { fetch: () => Response.json({ paired: true }) });
  assert.equal(phone.calls.length, 0, 'nothing is asked before Settings opens');
  assert.equal(phone.$('prefs-relay').hidden, true);
  await phone.open();
  assert.equal(phone.calls.length, 1);
  assert.equal(phone.calls[0][0], '/_relay/session');
  assert.deepEqual([phone.$('prefs-relay').hidden, phone.$('prefs-relay-phone').hidden, phone.$('prefs-relay-local').hidden], [false, false, true]);
  await phone.open();
  assert.equal(phone.calls.length, 1, 'once proven, it is not asked again');

  for (const [href, fetch] of [
    ['https://scranton.example.test/', () => Response.json({ error: 'Pair with Scranton to continue' }, { status: 401 })],
    ['https://static-demo.example.test/', () => new Response('<!doctype html>', { status: 200 })],
    ['https://scranton.example.test/', () => { throw new TypeError('Failed to fetch'); }],
    ['http://192.168.1.20:1725/', () => Response.json({ paired: true })],
    ['file:///C:/scranton/visualizer/public/index.html', () => Response.json({ paired: true })],
  ]) {
    const page = fakePage(href, { fetch });
    await page.open();
    assert.deepEqual([page.$('prefs-relay').hidden, page.$('prefs-relay-phone').hidden], [true, true], href);
    if (!href.startsWith('https:')) assert.equal(page.calls.length, 0, `${href}: never asked`);
  }
});

test('Settings markup: hidden until proven, and the disconnect is a plain form the relay answers', () => {
  const box = html.match(/<fieldset class="exec" id="prefs-relay" hidden>[\s\S]*?<\/fieldset>/)?.[0];
  assert.ok(box, 'the relay group starts hidden');
  assert.match(box, /<legend>Phone relay<\/legend>/);
  assert.match(box, /<div class="field" id="prefs-relay-local" hidden>/);
  const phone = box.match(/<div class="field" id="prefs-relay-phone" hidden>[\s\S]*?<\/form>[\s\S]*?<\/div>/)?.[0];
  assert.ok(phone, 'the phone part starts hidden');
  assert.match(phone, /<form class="relay-logout" method="post" action="\/_relay\/logout">\s*<button type="submit" class="btn" aria-describedby="prefs-relay-logout-hint">Disconnect this phone<\/button>\s*<\/form>/);
  assert.match(phone, /id="prefs-relay-logout-hint">[^<]+<\/span>/);
  assert.match(box, /From a Scranton checkout/);
  assert.match(box, /Windows desktop app, in PowerShell from its install folder/);
  assert.match(readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8'), /\.relay-cmd \{[^}]*white-space: pre-wrap; overflow-wrap: anywhere;/);
});

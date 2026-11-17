// The dashboard runs under a strict CSP (script-src 'self'; style-src 'self') in the browser and the desktop shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUBLIC = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const js = Object.fromEntries(readdirSync(path.join(PUBLIC, 'js')).map((f) => [f, readFileSync(path.join(PUBLIC, 'js', f), 'utf8')]));

test('index.html has no inline script, style or event handler', () => {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\bsrc=/, 'every script is an external file');
    assert.equal(m[2].trim(), '', 'no inline script body');
  }
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('modules that render messages and lanes never parse HTML', () => {
  assert.ok(Object.keys(js).length > 15, 'the scan reads every module in js/');
  const parses = /\.(innerHTML|outerHTML)\s*\+?=(?!=)|insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|createContextualFragment|DOMParser|document\.write/;
  for (const sink of ['a.innerHTML = s', 'a.innerHTML += s', 'a.outerHTML=s', 'a.outerHTML += s', "a.insertAdjacentHTML('beforeend', s)",
    'a.setHTMLUnsafe(s)', 'Document.parseHTMLUnsafe(s)', 'range.createContextualFragment(s)', 'new DOMParser()', 'document.write(s)', 'document.writeln(s)']) {
    assert.match(sink, parses, `the scan catches ${sink}`);
  }
  assert.doesNotMatch('if (a.innerHTML === s) {}', parses, 'a comparison is no parse');
  for (const [f, text] of Object.entries(js)) assert.doesNotMatch(text, parses, f);
  for (const [f, text] of Object.entries(js)) assert.doesNotMatch(text, /\beval\(|new Function\(/, f);

  // the HTML properties may not appear in code at all, so no spelling of the assignment gets past the scan
  const names = /\b(innerHTML|outerHTML|srcdoc)\b/;
  for (const sink of ['Object.assign(el, { innerHTML })', "Object.assign(el, { innerHTML: s })", "el['innerHTML'] = s", 'el["outerHTML"]=s',
    'frame.srcdoc = s', "frame.setAttribute('srcdoc', s)", 'const { innerHTML } = el', 'Reflect.set(el, `innerHTML`, s)']) {
    assert.match(sink, names, `the scan catches ${sink}`);
  }
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  assert.equal(code('a(); // innerHTML\n/* srcdoc */ b();'), 'a(); \n b();', 'comments are stripped');
  assert.equal(code("fetch('http://x/y')"), "fetch('http://x/y')", 'a URL is no comment');
  for (const [f, text] of Object.entries(js)) assert.doesNotMatch(code(text), names, f);
});

test('every element id the scripts look up exists exactly once in index.html', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, []);
  const wanted = new Set();
  for (const text of Object.values(js)) for (const m of text.matchAll(/\$\('([a-z0-9-]+)'\)/g)) wanted.add(m[1]);
  assert.ok(wanted.size > 40, `only ${wanted.size} lookups found - is the scan still reading the modules?`);
  const missing = [...wanted].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, []);
});

test('the message composer and run form keep their bounds and labels', () => {
  assert.match(html, /<textarea id="chat-text"[^>]*maxlength="16000"/);
  assert.match(html, /<label class="chat-to-label" for="chat-to">/);
  assert.match(html, /<label class="sr-only" for="chat-text">/);
  assert.match(html, /id="chat-status" role="status" aria-live="polite"/);
  for (const [docker, host] of [['f-sandbox-docker', 'f-sandbox-host'], ['pf-docker', 'pf-host']]) {
    assert.match(html, new RegExp(`<input type="radio" name="[a-z-]+" value="host" id="${host}" checked>`), `${host}: the trusted host is the default`);
    assert.match(html, new RegExp(`<input type="radio" name="[a-z-]+" value="docker" id="${docker}">`), `${docker}: Docker is not preselected`);
  }
  // the acknowledgement of the default host is shown, and never given in the page: a chat that already ran on the
  // host has it ticked by the drawer (trust.js), a new one does not
  assert.match(html, /<label class="check trust team-only" id="f-trust-row"><input type="checkbox" id="f-trusted" name="trustedHost"><span>/);
  assert.match(html, /<label class="check trust" id="pf-trust-row"><input type="checkbox" id="pf-trust"><span>I accept that the checks run model-written code on this computer without OS isolation/);
});

test('sign-in controls start hidden, keep their bounds and announce progress', () => {
  assert.match(html, /<button type="button" class="btn" id="accounts-open"[^>]*hidden>/, 'the Accounts button waits for /api/auth');
  assert.match(html, /<div class="run-actions" id="run-actions" hidden>[\s\S]*id="accounts-open"[\s\S]*<\/div>\s*<\/div>\s*<\/header>/, 'it lives with the run controls');
  assert.match(html, /id="model-fields" hidden/);
  assert.match(html, /<input id="login-code-input"[^>]*maxlength="4096"[^>]*autocomplete="off"/);
  assert.match(html, /id="login-progress" role="status" aria-live="polite"/);
  assert.match(html, /<dialog class="drawer" id="accounts-dialog" aria-labelledby="accounts-title">/);
  for (const role of ['michael', 'dwight', 'angela']) assert.match(html, new RegExp(`<label for="f-model-${role}">`));
  // the page shows the sign-in address but never opens or links it
  assert.doesNotMatch(js['accounts-panel.js'], /window\.open|location\.(href|assign)|\.href\s*=|createElement\('a'\)/);
});

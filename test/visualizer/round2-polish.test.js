// The buffered drawer surfaces: spacing and wrapping without changing their height, actions or form contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector) => {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === selector);
  assert.ok(found, selector);
  return found[2];
};

test('buffered drawers: token insets, wrapped prose, one scrolling body and persistent head/foot', () => {
  assert.match(rule('.drawer-body'), /padding: var\(--s4\);/);
  for (const property of ['min-width: 0', 'min-height: 0', 'overflow: auto', 'overscroll-behavior: contain']) assert.ok(rule('.drawer-body').includes(property), property);
  assert.match(rule('.drawer-body :is(p, .hint, .form-help)'), /line-height: 1\.6; overflow-wrap: anywhere;/);
  assert.match(rule('.drawer-body :is(p, .hint, .form-help)'), /max-width: 72ch;/);
  assert.match(rule('.drawer form#run-form, .drawer-frame'), /height: 100%; overflow: hidden;/);
  assert.match(rule('.drawer-head'), /position: sticky;\s*top: 0;/);
  assert.match(rule('.drawer-head'), /height: var\(--topbar-h\);/);
  assert.match(rule('.drawer-foot'), /position: sticky; bottom: 0;/);
  assert.match(rule('.drawer-foot'), /flex-wrap: wrap;/);
  assert.match(rule('.confirm p'), /white-space: pre-wrap; overflow-wrap: anywhere;/);
  assert.match(rule('.account'), /padding: var\(--s4\);/);
  assert.match(rule('.account-detail'), /line-height: 1\.6; white-space: pre-wrap;/);
  assert.match(rule('.login-url-text'), /padding: var\(--s3\) var\(--s4\);/);
  assert.match(rule('.login-url-text'), /white-space: pre-wrap;\s*overflow-wrap: anywhere;/);
  assert.doesNotMatch(rule('.login-url-text'), /break-all/);
  assert.match(rule('.provider-model-list'), /overscroll-behavior: contain;/);
  assert.match(rule('.nav-status'), /padding: var\(--s3\) var\(--s4\);[^}]*line-height: 1\.6;/);
  assert.match(rule('.nav-foot'), /overflow-wrap: anywhere;/);
  assert.match(rule('.chat-none'), /padding: var\(--s3\) var\(--s4\);/);
  // Navigation labels may still be compact: their titles are attached by nav.js.
  assert.match(rule('.project-name, .chat-title'), /text-overflow: ellipsis;/);
});

test('Accounts discloses only provider guidance, not stored-credential security information or live controls', () => {
  const html = read('index.html');
  const accounts = html.slice(html.indexOf('<dialog class="drawer" id="accounts-dialog"'), html.indexOf('<dialog class="drawer" id="agents-dialog"'));
  const help = accounts.match(/<details class="form-help">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(help, 'secondary introduction uses a native disclosure');
  assert.match(help, /<summary>Supported accounts and providers<\/summary>/);
  assert.match(help, /Claude Pro\/Max|OpenAI- or Anthropic-compatible/);
  assert.doesNotMatch(help, /<(?:input|select|textarea|button)\b|role="(?:status|alert)"/);
  const visible = accounts.replace(/<details\b[\s\S]*?<\/details>/g, '');
  assert.match(visible, /Everything is stored with Scranton's credentials on this computer; this page never shows a stored sign-in or key\./);
  for (const id of ['accounts-error', 'accounts-status', 'accounts-list', 'login-panel', 'login-code-input', 'key-input', 'provider-panel']) assert.ok(visible.includes(`id="${id}"`), id);
  assert.match(html, /id="f-request"[^>]*rows="5"/);
  assert.match(rule('#run-dialog #f-request'), /min-height: 6\.5rem;/);
});

test('pipeline badge shares the status rules, with the old loud-pill override kept off badges', () => {
  assert.match(read('index.html'), /<span class="pill badge" id="pv-status" data-status="idle" data-tone="quiet">/);
  assert.ok(rule('.pill:not(.badge)[data-loud="true"]'));
  assert.doesNotMatch(css, /(?:^|\n)\.pill\[data-loud="true"\]/);
});

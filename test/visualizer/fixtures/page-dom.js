// The page itself as a tree-dom tree: index.html read into TreeEl nodes, with the few globals main.js asks a
// browser for. For tests that need the modules wired the way the page wires them.
import { readFileSync } from 'node:fs';
import { installTree, TreeEl, all } from './tree-dom.js';

const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'col', 'source']);
const FLAGS = ['hidden', 'checked', 'disabled', 'open'];
const dataKey = (name) => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function element(tag, attrs) {
  const node = new TreeEl(tag);
  for (const m of attrs.matchAll(/([^\s"=/]+)(?:="([^"]*)")?/g)) {
    const [, name, value = ''] = m;
    if (name === 'class') node.className = value;
    else if (name.startsWith('data-')) node.dataset[dataKey(name)] = value;
    else if (FLAGS.includes(name)) node[name] = true;
    else {
      if (name === 'id' || name === 'value' || name === 'title') node[name] = value;
      node.setAttribute(name, value);
    }
  }
  return node;
}

// -> the body element of the document in file
function parse(html) {
  const root = new TreeEl('html');
  const stack = [root];
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/i, '');
  for (const m of text.matchAll(/<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:"[^"]*"|[^>"])*)>|([^<]+)/gi)) {
    const top = stack.at(-1);
    if (m[1]) {
      const at = stack.findLastIndex((n) => n.tagName === m[1].toUpperCase());
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const node = element(m[2], m[3].replace(/\/\s*$/, ''));
      top.append(node);
      if (!VOID.has(m[2].toLowerCase()) && !/\/\s*$/.test(m[3])) stack.push(node);
    } else if (m[4].trim()) {
      top.append(m[4]);
    }
  }
  return root.querySelector('body');
}

// a copy that is a tree node again: tree-dom's own cloneNode answers with a bare fake
function clone(node, deep) {
  if (node.nodeType !== 1) return document.createTextNode(node.textContent);
  const copy = Object.assign(new TreeEl(node.tagName), { className: node.className, hidden: node.hidden, dataset: { ...node.dataset } });
  for (const [k, v] of node.attrs) copy.setAttribute(k, v);
  if (deep) copy.append(...node.childNodes.map((n) => clone(n, true)));
  return copy;
}

// hash: where the page starts. fetch: the server. -> { $, body }
// The page's timers (its polls, its clock) never hold the process: a test waits with timers it took before.
export function installPage({ hash = '', search = '?live', fetch } = {}) {
  installTree();
  for (const name of ['setTimeout', 'setInterval']) {
    const real = globalThis[name];
    globalThis[name] = (...args) => real(...args).unref();
  }
  for (const proto of [TreeEl.prototype, Object.getPrototypeOf(document.createTextNode(''))]) {
    proto.cloneNode = function cloneNode(deep = false) { return clone(this, deep); };
  }
  const body = parse(readFileSync(new URL('../../../visualizer/public/index.html', import.meta.url), 'utf8'));
  const byId = new Map(all(body).filter((n) => n.id).map((n) => [n.id, n]));
  const store = new Map();
  Object.assign(document, {
    body, activeElement: body, documentElement: new TreeEl('html'), hidden: false,
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    createDocumentFragment: () => new TreeEl('fragment'),
    addEventListener() {},
  });
  Object.assign(globalThis, {
    window: globalThis, fetch,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    location: { search, hash, pathname: '/' },
    history: { replaceState(state, title, to) { if (String(to).startsWith('#')) location.hash = to; }, pushState(state, title, to) { location.hash = to; } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getSelection: () => '',
    CSS: { escape: (s) => s },
  });
  return { $: (id) => document.getElementById(id), body };
}

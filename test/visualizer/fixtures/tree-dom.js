// A fake DOM with a real tree, for modules that build and rearrange nodes: parents, text nodes, simple
// selectors, bubbling events, and a focus that is lost when the focused node leaves the document, as in a browser.
import { FakeEl } from './fake-dom.js';

class Text {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.parentNode = null;
  }
}

const dataKey = (attr) => attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// one compound selector: tag, .class, [attr], [attr="value"]
function parse(selector) {
  return {
    tag: /^[a-z][a-z0-9]*/i.exec(selector)?.[0].toUpperCase() ?? null,
    classes: [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    attrs: [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((m) => [m[1], m[2]]),
  };
}

export class TreeEl extends FakeEl {
  constructor(tag = 'div') {
    super();
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.className = '';
    this.parentNode = null;
  }
  get textContent() { return (this.childNodes ?? []).map((n) => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(...(v === '' || v === null || v === undefined ? [] : [new Text(v)])); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] ?? null; }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  // a focused node that leaves the document hands the focus to the page
  remove() {
    const doc = globalThis.document;
    if (doc && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this);
    this.parentNode = null;
  }
  insertBefore(node, ref) {
    const n = typeof node === 'string' ? new Text(node) : node;
    if (n.parentNode) n.nodeType === 1 ? n.remove() : (n.parentNode.childNodes = n.parentNode.childNodes.filter((x) => x !== n));
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(n);
    else this.childNodes.splice(at, 0, n);
    n.parentNode = this;
    return n;
  }
  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }
  replaceChildren(...nodes) {
    for (const n of [...(this.childNodes ?? [])]) {
      if (n.nodeType === 1) n.remove();
      else n.parentNode = null;
    }
    this.childNodes = [];
    this.append(...nodes);
  }

  attr(name) {
    if (name.startsWith('data-') && Object.hasOwn(this.dataset, dataKey(name))) return String(this.dataset[dataKey(name)]);
    return this.attrs.get(name) ?? null;
  }
  matches(selector) {
    const s = parse(selector);
    if (s.tag && s.tag !== this.tagName) return false;
    if (!s.classes.every((c) => ` ${this.className} `.includes(` ${c} `))) return false;
    return s.attrs.every(([name, value]) => (value === undefined ? this.attr(name) !== null : this.attr(name) === value));
  }
  closest(selector) {
    for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && n.matches(selector)) return n;
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((c) => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  // like a real event: the listeners of the node, then of every ancestor
  dispatch(type, fields = {}) {
    const ev = { type, target: this, preventDefault() {}, ...fields };
    const calls = [];
    for (let n = this; n; n = n.parentNode) calls.push(...(n.listeners.get(type) ?? []).map((fn) => fn(ev)));
    return Promise.all(calls);
  }
  // a click on a button focuses it first
  click() {
    this.focus();
    return this.dispatch('click');
  }
}

// -> $(id), the same element for the same id; elements made by the page are TreeEl too
export function installTree() {
  const byId = new Map();
  const body = new TreeEl('body');
  globalThis.document = {
    title: '', activeElement: body, body,
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, Object.assign(new TreeEl('div'), { id }));
      return byId.get(id);
    },
    createElement: (tag) => new TreeEl(tag),
    // SVG built in code (usage-chart.js): the same node, its attributes read with getAttribute
    createElementNS: (ns, tag) => new TreeEl(tag),
    createTextNode: (text) => new Text(text),
  };
  return (id) => globalThis.document.getElementById(id);
}

// every element under a node, in document order
export const all = (node) => node.children.flatMap((c) => [c, ...all(c)]);

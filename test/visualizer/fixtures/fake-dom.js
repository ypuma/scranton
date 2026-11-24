// Just enough DOM to drive the dashboard panels in Node: every element is the same small fake.
export class FakeEl {
  constructor() {
    Object.assign(this, { hidden: false, textContent: '', title: '', value: '', checked: false, disabled: false, readOnly: false, open: false });
    Object.assign(this, { scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
    this.dataset = {};
    this.childNodes = [];
    this.selectedOptions = [];
    this.attrs = new Map();
    this.listeners = new Map();
    // custom properties set from code (a code line's indent)
    this.style = { setProperty(name, value) { this[name] = String(value); } };
    const classes = new Set();
    this.classList = { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }
  toggleAttribute(k, on) { if (on) this.attrs.set(k, ''); else this.attrs.delete(k); }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type, fields = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...fields };
    return Promise.all((this.listeners.get(type) ?? []).map((fn) => fn(ev)));
  }
  focus() { globalThis.document.activeElement = this; }
  contains() { return false; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  replaceChildren(...c) {
    this.childNodes = c;
    for (const x of c) if (x instanceof FakeEl) x.parentNode = this;
  }
  append(...c) {
    this.childNodes.push(...c);
    for (const x of c) if (x instanceof FakeEl) x.parentNode = this;
  }
  // like the real one: out of its parent's children
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((x) => x !== this);
    this.parentNode = null;
  }
  after() {}
  cloneNode() { return new FakeEl(); }
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.fire('close');
  }
  requestSubmit() { return this.fire('submit'); }
  scrollIntoView() {}
}

// -> $(id), the same fake element for the same id
export function installDom() {
  const byId = new Map();
  globalThis.document = {
    title: '', activeElement: null, body: new FakeEl(),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new FakeEl());
      return byId.get(id);
    },
    createElement: () => new FakeEl(),
    createElementNS: () => new FakeEl(),
  };
  return (id) => globalThis.document.getElementById(id);
}

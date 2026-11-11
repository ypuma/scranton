// A scroll box that behaves like a browser's, and the observers a tail-following panel listens to. Shared by the
// event log, the Messages transcript and the Chat view tests.
import { FakeEl } from './fake-dom.js';

export const ROW_PX = 20;
export const VIEW_PX = 100;

// scrollTop is clamped, and a hidden box (display:none) has no size and forgets its offset.
export class Scroller extends FakeEl {
  constructor(count) {
    super();
    this.count = count;
    this.shown = true;
    this.top = 0;
    this.view = VIEW_PX;
  }
  get clientHeight() { return this.shown ? this.view : 0; }
  set clientHeight(v) {}
  get scrollHeight() { return this.shown ? this.count() * ROW_PX : 0; }
  set scrollHeight(v) {}
  get scrollTop() { return this.top; }
  set scrollTop(v) { this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); }
  bottom() { return this.scrollHeight - this.clientHeight; }
}

// -> { show(el, on), resize(el, px, notify) }
export function installObservers() {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    // a browser reports the size once on observe(), so the first change seen is a real one
    observe(el) { this.el = el; this.cb([]); }
  };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
  globalThis.CSS = { escape: (s) => s };
  // the box gets (or loses) its size: what a tab switch or the dashboard appearing does
  const show = (el, on) => {
    el.shown = on;
    if (!on) el.top = 0;
    for (const o of observers) if (o.el === el) o.cb([]);
  };
  // the box changes height while shown (the composer grows on focus, the window is resized); a browser clamps
  // the offset and says so with a scroll event before the observer runs
  // notify false: a render that runs after the layout change but before the observer does
  const resize = (el, px, notify = true) => {
    el.view = px;
    const top = el.top;
    el.scrollTop = top;
    if (el.top !== top) el.fire('scroll');
    if (notify) for (const o of observers) if (o.el === el) o.cb([]);
  };
  return { show, resize };
}

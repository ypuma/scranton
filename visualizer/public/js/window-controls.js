// The window controls of the desktop app (.enma/titlebar-contract.md). Its window has no native title bar: the top
// bar carries Minimize, Maximize and Close and is what the window is dragged by. A browser gets none of it.
const $ = (id) => document.getElementById(id);
const INTERACTIVE = 'button, a, input, select, textarea, summary, label, [role="button"]';

export function createWindowControls() {
  const api = globalThis.__TAURI__?.window;
  if (typeof api?.getCurrentWindow !== 'function') return { desktop: false };
  const e = { bar: $('topbar'), box: $('window-controls'), minimize: $('win-minimize'), maximize: $('win-maximize'), close: $('win-close') };
  const controls = [[e.minimize, 'minimize'], [e.maximize, 'toggleMaximize'], [e.close, 'close']];
  // WKWebView says MacIntel; the page has no other hint of the OS, and Tauri's own drag script splits the same way
  const mac = /^Mac/.test(globalThis.navigator?.platform ?? '');
  let hot = null;
  let zoomAt = null;
  let reading = false;
  let stale = false;

  // -> the window's answer, or undefined when it refused or failed: none of that reaches the page
  async function call(method) {
    try {
      return await api.getCurrentWindow()[method]();
    } catch {
      return undefined;
    }
  }

  // One read at a time, and a request during a read asks once more, so the answer shown is never an older one.
  async function syncMaximized() {
    if (reading) {
      stale = true;
      return;
    }
    reading = true;
    do {
      stale = false;
      const max = await call('isMaximized');
      if (typeof max === 'boolean') {
        e.maximize.dataset.maximized = String(max);
        e.maximize.setAttribute('aria-label', max ? 'Restore' : 'Maximize');
      }
    } while (stale);
    reading = false;
  }

  async function run(method) {
    await call(method);
    if (method === 'toggleMaximize') await syncMaximized();
  }

  function inside(el, ev) {
    const r = el.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX < r.right && ev.clientY >= r.top && ev.clientY < r.bottom;
  }
  // By target, or by position: a modal dialog makes the bar inert and its backdrop takes the bar's pointer events.
  const controlAt = (ev) => controls.find(([b]) => b === ev.target || b.contains(ev.target) || inside(b, ev)) ?? null;
  const inBar = (ev) => e.bar.contains(ev.target) || (ev.clientY >= 0 && ev.clientY < e.box.getBoundingClientRect().bottom);

  // set here, not by :hover, which an inert bar never matches
  function setHot(b) {
    if (b === hot) return;
    if (hot) delete hot.dataset.hot;
    hot = b;
    if (b) b.dataset.hot = 'true';
  }

  function onDown(ev) {
    if (ev.button !== 0) return;
    zoomAt = null;
    const ctl = controlAt(ev);
    if (!ctl && (!inBar(ev) || ev.target.closest?.(INTERACTIVE))) return;
    // keeps the focus where it is, and the press away from a dialog whose backdrop it landed on
    ev.preventDefault();
    ev.stopPropagation();
    if (ctl) return;
    // The window swallows the release of a press that started a drag, so no dblclick follows: the second press of
    // a double click is the maximize, as in Tauri's own drag region script.
    if (ev.detail !== 2) return call('startDragging');
    // macOS zooms on the release, and not when the pointer moved in between (tauri#8306)
    if (mac) zoomAt = { x: ev.clientX, y: ev.clientY };
    else return run('toggleMaximize');
  }

  function onUp(ev) {
    const at = zoomAt;
    zoomAt = null;
    if (at && ev.button === 0 && ev.detail === 2 && ev.clientX === at.x && ev.clientY === at.y) return run('toggleMaximize');
  }

  function onClick(ev) {
    const ctl = controlAt(ev);
    if (ctl) {
      ev.stopPropagation();
      // a minimized or closing window reports no pointer leaving it
      setHot(null);
      return run(ctl[1]);
    }
    // the bar seen through a backdrop: the dialog would read this click as a dismissal
    if (ev.target.tagName === 'DIALOG' && inBar(ev)) ev.stopPropagation();
  }

  document.body.dataset.shell = 'desktop';
  e.box.hidden = false;
  // capture on the document: ahead of every dialog's own listeners
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('click', onClick, true);
  if (mac) document.addEventListener('mouseup', onUp, true);
  document.addEventListener('mousemove', (ev) => setHot(controlAt(ev)?.[0] ?? null), true);
  // no related target: the pointer left the window
  document.addEventListener('mouseout', (ev) => {
    if (!ev.relatedTarget) setHot(null);
  }, true);
  addEventListener('blur', () => setHot(null));
  // no window event is subscribed to; a maximize or restore always resizes the page
  addEventListener('resize', () => syncMaximized());
  syncMaximized();
  return { desktop: true };
}

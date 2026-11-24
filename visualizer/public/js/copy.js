// Copy to the clipboard: the one function every panel uses, and the small button that calls it and says for a
// moment whether it worked. What is copied is the text the caller hands over, never markup.
const SVG_NS = 'http://www.w3.org/2000/svg';
export const COPIED_MS = 1600;
// the sheet that is copied, the tick of a copy that worked and the cross of one that did not
const ICONS = [['copy-ico', 'M5.5 5.5h7v8h-7zM10.5 3.5v-1h-7v8h1'], ['copy-ok', 'M3.5 8.5l3 3 6-7'], ['copy-no', 'M4 4l8 8M12 4l-8 8']];

// Without the clipboard API (an insecure origin, an older web view) or when it refuses: a text area that is
// selected and copied by the document. Inside a modal dialog it has to live in the dialog, the rest is inert.
function copyBySelection(value, doc) {
  if (typeof doc?.execCommand !== 'function' || !doc.body) return false;
  const held = doc.activeElement;
  let selection = null;
  let ranges = [];
  try {
    selection = doc.getSelection?.();
    ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, i) => selection.getRangeAt(i).cloneRange());
  } catch {
    selection = null;
  }
  const area = doc.createElement('textarea');
  area.className = 'copy-sink';
  area.value = value;
  area.tabIndex = -1;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  (held?.closest?.('dialog') ?? doc.body).append(area);
  try {
    area.select();
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area.remove();
    try { held?.focus?.({ preventScroll: true }); } catch {}
    // Focus can change the selection too, so restore the saved ranges last.
    try {
      if (typeof selection?.removeAllRanges === 'function' && typeof selection?.addRange === 'function') {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch {}
  }
}

// -> Promise<boolean>: whether the text is on the clipboard. Never throws.
export async function copyText(text, { clipboard = globalThis.navigator?.clipboard, doc = globalThis.document } = {}) {
  const value = String(text ?? '');
  try {
    if (typeof clipboard?.writeText === 'function') {
      await clipboard.writeText(value);
      return true;
    }
  } catch {
    // refused (no permission, the page lost the focus): the other way below
  }
  try {
    return copyBySelection(value, doc);
  } catch {
    return false;
  }
}

// text: what is copied, or a function asked for it at the click. what: the end of the name ("Copy <what>").
// label: a visible word beside the icon. For COPIED_MS after a click the button says how it went.
export function copyButton({ text, what = 'text', label = '', timers = globalThis, copy = copyText } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy-btn';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, d] of ICONS) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', cls);
    path.setAttribute('d', d);
    svg.append(path);
  }
  b.append(svg);
  let word = null;
  if (label) {
    word = document.createElement('span');
    word.className = 'copy-btn-label';
    b.append(word);
  }
  let timer = 0;

  function show(state) {
    b.dataset.state = state;
    const name = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : `Copy ${what}`;
    b.setAttribute('aria-label', name);
    b.title = name;
    if (word) word.textContent = state === 'idle' ? label : name;
  }

  b.addEventListener('click', async (ev) => {
    // it sits in rows and summaries that react to a click themselves
    ev.stopPropagation();
    ev.preventDefault();
    let ok = false;
    try {
      ok = (await copy(typeof text === 'function' ? text() : text)) === true;
    } catch {
      ok = false;
    }
    timers.clearTimeout(timer);
    show(ok ? 'copied' : 'failed');
    timer = timers.setTimeout(() => show('idle'), COPIED_MS);
  });
  show('idle');
  return b;
}

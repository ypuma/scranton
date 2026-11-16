// Motion that CSS cannot say: a figure that counts up to its new value, and board cards that travel to their new
// place. Both are decoration over a page that is already right: with reduced motion, in a hidden tab or outside a
// browser nothing here runs, and the text and the layout are what the caller set.
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

// What Settings allows: 'off' | 'subtle' | 'lively' (prefs.js); the default is lively.
export function motionLevel() {
  const level = typeof document === 'undefined' ? null : document.documentElement?.dataset?.motion;
  return level === 'off' || level === 'subtle' ? level : 'lively';
}

// Count-ups and travelling cards belong to the lively level alone.
export function motionOK() {
  if (typeof matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') return false;
  if (typeof document === 'undefined' || document.hidden) return false;
  return motionLevel() === 'lively' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const counts = new WeakMap();

// The caller has written format(value) into el. From the second value on, the figure runs from the one before.
export function countUp(el, value, format, { duration = 600 } = {}) {
  const prev = counts.get(el);
  const from = prev?.value;
  if (prev) prev.stop = true;
  const job = { value, stop: false };
  counts.set(el, job);
  if (!Number.isFinite(from) || !Number.isFinite(value) || from === value || !motionOK()) return;
  const start = performance.now();
  el.textContent = format(from);
  const step = (now) => {
    if (job.stop) return;
    const k = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = format(k < 1 ? from + (value - from) * eased : value);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Where the given elements are now, by key; an element that is not laid out (a hidden board) has no place.
export function measure(items) {
  const rects = new Map();
  for (const [key, el] of items) {
    const r = el.getBoundingClientRect?.();
    if (r && (r.width || r.height)) rects.set(key, r);
  }
  return rects;
}

// First-last-invert-play: before holds the places from measure(), items the elements after the change. An element
// that moved travels from its old place; one that is new rises in, a little after the one before it.
export function flip(before, items) {
  if (!motionOK()) return;
  let fresh = 0;
  for (const [key, el] of items) {
    if (typeof el.animate !== 'function') return;
    const now = el.getBoundingClientRect();
    if (!now.width && !now.height) continue;
    const was = before.get(key);
    if (!was) {
      el.animate([{ opacity: 0, transform: 'translateY(0.5rem) scale(0.98)' }, { opacity: 1, transform: 'none' }],
        { duration: 280, delay: Math.min(fresh, 8) * 40, easing: EASE, fill: 'backwards' });
      fresh += 1;
      continue;
    }
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 1 }, { transform: 'none', zIndex: 1 }], { duration: 420, easing: EASE });
  }
}

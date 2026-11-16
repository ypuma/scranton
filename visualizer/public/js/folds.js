// The sections of the Dashboard fold: a section the human closed stays closed across chats and reloads, so the
// first sight is what they chose to keep open. The chevron button is the control; a press on the rest of the
// header is a shortcut for it.
import { store } from './control-panel.js';

export const FOLD_KEY = 'scranton.folds';

// The stored choices, as { name: boolean }; anything else is no choice.
export function parseFolds(raw) {
  try {
    const v = JSON.parse(raw ?? '');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, open]) => typeof open === 'boolean'));
  } catch {
    return {};
  }
}

export function createFolds(root) {
  const saved = parseFolds(store.get(FOLD_KEY));
  for (const section of root.querySelectorAll('[data-fold]')) {
    const name = section.dataset.fold;
    const toggle = section.querySelector('.fold-toggle');
    if (!toggle) continue;
    const set = (open) => {
      section.dataset.open = String(open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    if (Object.hasOwn(saved, name)) set(saved[name]);
    const flip = () => {
      const open = section.dataset.open !== 'true';
      set(open);
      saved[name] = open;
      store.set(FOLD_KEY, JSON.stringify(saved));
    };
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      flip();
    });
    // the header is a larger target for the same button; a control inside it keeps its own press
    toggle.parentNode.addEventListener('click', (event) => {
      if (event.target.closest?.('button, a, input, select, summary')) return;
      flip();
    });
  }
}

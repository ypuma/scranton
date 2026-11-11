// The Chat | Dashboard switch of a chat (.enma/chat-view-contract.md section 7): two views of the same run, the
// conversation or the monitor. A pipeline chat calls its monitor Details (the pipeline view). The choice lasts
// across chats and reloads.
import { store } from './control-panel.js';

export const VIEW_KEY = 'scranton.view_mode';
export const VIEW_MODES = ['chat', 'dashboard'];

// Anything but a stored 'dashboard' is the default.
export function parseViewMode(v) {
  return v === 'dashboard' ? 'dashboard' : 'chat';
}

const $ = (id) => document.getElementById(id);

// onChange(mode): the human picked the other view.
export function createViewMode({ onChange } = {}) {
  const e = { toggle: $('view-mode-toggle'), chat: $('view-mode-chat'), dash: $('view-mode-dash'), view: $('chat-view'), board: $('dash') };
  let mode = parseViewMode(store.get(VIEW_KEY));
  // a chat whose engine has no Chat view keeps its own layout, without the switch
  let offered = true;
  const get = () => (offered ? mode : 'dashboard');

  function apply() {
    const chat = get() === 'chat';
    e.toggle.hidden = !offered;
    e.chat.setAttribute('aria-pressed', String(mode === 'chat'));
    e.dash.setAttribute('aria-pressed', String(mode === 'dashboard'));
    e.view.hidden = !chat;
    e.board.hidden = chat;
    document.body.dataset.view = get();
  }

  // remember false: the page moved the human to the other view (a question that is answered there), which is
  // no choice to keep for the next chat or reload
  function set(next, { remember = true } = {}) {
    if (!VIEW_MODES.includes(next) || next === mode) return;
    mode = next;
    if (remember) store.set(VIEW_KEY, mode);
    apply();
    onChange?.(get());
  }

  e.chat.addEventListener('click', () => set('chat'));
  e.dash.addEventListener('click', () => set('dashboard'));
  apply();

  return {
    get,
    set,
    offer(on) {
      if (offered === Boolean(on)) return;
      offered = Boolean(on);
      apply();
    },
    // what the second view is called for the chat on screen
    name(label) {
      if (e.dash.textContent !== label) e.dash.textContent = label;
    },
  };
}

// Two composers share the place under the transcript: the one that starts runs and the one that messages a
// running agent. composers: [{ form, field }]. fallback: what takes the focus when no composer is left.
export function createDock(composers, fallback = null) {
  return {
    // Before a render that may swap the composers. The returned function hands the focus on afterwards, so it
    // never falls back to the page because the form that held it was hidden.
    hold() {
      const from = composers.find((c) => !c.form.hidden && c.form.contains(document.activeElement));
      return () => {
        if (!from || !from.form.hidden) return;
        const next = composers.find((c) => c !== from && !c.form.hidden && !c.field.disabled);
        (next?.field ?? fallback)?.focus();
      };
    },
  };
}

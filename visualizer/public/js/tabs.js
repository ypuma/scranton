// The tabs of the activity panel (WAI-ARIA tabs pattern): one tab stop, arrow keys move between tabs,
// and an inactive panel is hidden, not removed, so its module keeps rendering into it.
export function createTabs(list, { onSelect } = {}) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  let current = tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab ?? tabs[0]?.dataset.tab;

  function select(name, { focus = false } = {}) {
    if (!tabs.some((t) => t.dataset.tab === name)) return;
    const changed = name !== current;
    current = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.focus();
    }
    if (changed) onSelect?.(name);
  }

  list.addEventListener('click', (ev) => {
    const t = ev.target.closest('[role="tab"]');
    if (t) select(t.dataset.tab);
  });
  list.addEventListener('keydown', (ev) => {
    const i = tabs.indexOf(document.activeElement);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
    if (i < 0 || to === undefined) return;
    ev.preventDefault();
    select(tabs[(to + tabs.length) % tabs.length].dataset.tab, { focus: true });
  });

  return { select, current: () => current };
}

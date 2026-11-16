// The plan as nodes: the list the Plan side panel and the planner's message in the Chat view both show.
function el(tag, cls, content) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (content !== undefined) e.textContent = content;
  return e;
}

// The plan in a message of the Chat view: how many milestones, and their titles. The Plan panel holds the rest.
// unit: what an item is called ('milestone', 'step').
export function renderPlanBrief(items, { unit = 'milestone' } = {}) {
  const box = el('div', 'plan-brief');
  const ol = el('ol', 'plan-brief-list');
  ol.append(...items.map((m) => {
    const li = el('li', 'plan-brief-item');
    li.append(el('span', 'plan-id', m.id), el('span', 'plan-brief-title', m.title));
    return li;
  }));
  box.append(el('p', 'plan-brief-head', `Plan \u00b7 ${items.length} ${unit}${items.length === 1 ? '' : 's'}`), ol);
  return box;
}

// heading: the tag of a milestone's title ('h3' in a panel of its own, 'p' inside a message).
export function renderPlan(items, { heading = 'h3' } = {}) {
  const ol = el('ol', 'plan');
  ol.append(...items.map((m) => {
    const li = el('li', 'plan-item');
    if (m.column) li.dataset.column = m.column;
    const head = el('div', 'plan-head');
    head.append(el('span', 'plan-id', m.id), el(heading, 'plan-title', m.title));
    if (m.state) head.append(el('span', 'plan-state', m.state));
    li.append(head);
    if (m.description) li.append(el('p', 'plan-desc', m.description));
    if (m.criteria.length) {
      const ul = el('ul', 'plan-criteria');
      ul.setAttribute('aria-label', 'Acceptance criteria');
      ul.append(...m.criteria.map((c) => el('li', '', c)));
      li.append(el('p', 'plan-sub', 'Acceptance criteria'), ul);
    }
    const after = m.dependsOn?.length ? `After ${m.dependsOn.join(', ')}` : m.note ?? '';
    if (after) li.append(el('p', 'plan-note', after));
    return li;
  }));
  return ol;
}

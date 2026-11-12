// What stands under an agent's line in the run rail and in an instance lane: the tail of what its model is
// producing (reasoning, else its answer), clamped to the newest lines, and the files it last touched. Model text
// only ever becomes text nodes, and the box is no live region: it changes many times a second.
export const TAIL_LINES = 3;
export const TAIL_CHARS = 220;
const FILE_WORD = { read: 'read', write: 'wrote', edit: 'edited' };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// more than the clamp shows: the box offers to open
export function tailIsLong(t) {
  return Boolean(t) && (t.cut === true || t.body.length > TAIL_CHARS || t.body.split('\n').length > TAIL_LINES);
}

// open: the ids whose text is shown in full; the owner keeps it, so a row that is drawn again stays as it was.
// -> { el, update(agent) }; agent: an entry of a run view's agents (activity-model.js)
export function createLiveBlock(open) {
  const root = el('div', 'live');
  const label = el('span', 'live-label');
  const text = el('span', 'live-text');
  const body = el('p', 'live-body mono');
  body.setAttribute('aria-live', 'off');
  body.append(text);
  const more = el('button', 'msg-more live-more');
  more.type = 'button';
  const note = el('p', 'live-note');
  const files = el('ul', 'live-files');
  root.append(label, body, more, note, files);
  let id = null;
  let filesKey = '';

  function update(a) {
    id = a.id;
    const t = a.text;
    label.hidden = body.hidden = !t;
    if (t) {
      if (label.textContent !== t.label) label.textContent = t.label;
      // the head was dropped on the way: said by an ellipsis, never by cutting a word in the page
      const shown = `${t.cut ? '... ' : ''}${t.body}`;
      if (text.textContent !== shown) text.textContent = shown;
      root.dataset.kind = t.kind;
    }
    const long = tailIsLong(t);
    const isOpen = long && open.has(a.id);
    more.hidden = !long;
    root.toggleAttribute('data-open', isOpen);
    if (long) {
      const word = isOpen ? 'Show less' : `Show all of the ${t.label.toLowerCase()}`;
      if (more.textContent !== word) more.textContent = word;
      more.setAttribute('aria-expanded', String(isOpen));
    }
    note.hidden = !a.note;
    if (note.textContent !== a.note) note.textContent = a.note;
    const key = JSON.stringify(a.files);
    if (key !== filesKey) {
      filesKey = key;
      files.replaceChildren(...a.files.map((f) => {
        const li = el('li');
        const path = el('span', 'live-path mono', f.path);
        path.title = f.path;
        li.append(el('span', 'live-kind', FILE_WORD[f.kind] ?? f.kind), path);
        return li;
      }));
    }
    files.hidden = !a.files.length;
    if (a.files.length) files.setAttribute('aria-label', `Recent files of ${a.name}`);
    root.hidden = !t && !a.note && !a.files.length;
  }

  more.addEventListener('click', () => {
    if (id === null) return;
    if (open.has(id)) open.delete(id);
    else open.add(id);
    const isOpen = open.has(id);
    root.toggleAttribute('data-open', isOpen);
    more.setAttribute('aria-expanded', String(isOpen));
    more.textContent = isOpen ? 'Show less' : `Show all of the ${label.textContent.toLowerCase()}`;
  });

  return { el: root, update };
}

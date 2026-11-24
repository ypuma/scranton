// Long text made readable, for every panel that shows what a model or a tool wrote: how many lines a text takes
// and whether it is worth folding, the control that folds it, text that is a payload (JSON, fenced code) set as a
// code block whose wrapped lines keep their indent, and a file path that wraps between its folders. The first
// half is pure, so Node can test it; the builders make elements and text nodes and never parse HTML.
import { parseMarkdown, buildMarkdown } from './chat-markdown.js';
import { copyButton } from './copy.js';

// a folded text shows about this many lines
export const FOLD_LINES = 12;
// a text only a few lines longer is shown whole: folding it would hide less than its button takes
export const FOLD_SLACK = 4;
// what a line of the reading column holds, for counting the lines a paragraph wraps to
export const WRAP_CHARS = 68;
const TAB_COLUMNS = 2;
// a deeper indent still hangs, but only this far: the text needs the rest of the line
const INDENT_MAX = 24;

// The lines the text takes in a reading column: its own, and the ones a long line wraps to.
export function countLines(text, wrap = WRAP_CHARS) {
  return String(text ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / wrap)), 0);
}

export function isFoldable(lines, limit = FOLD_LINES) {
  return lines > limit + FOLD_SLACK;
}

export function foldWord(open, lines) {
  return open ? 'Show less' : `Show all (${lines} lines)`;
}

// Text that is one JSON object or array (a plan, a tool result) -> the text to set as code, else null. Only what
// JSON itself would write back the same is laid out again, so no number or key of the model is ever altered.
export function jsonPayload(text) {
  const t = String(text ?? '').trim();
  if (!/^[[{][\s\S]*[\]}]$/.test(t)) return null;
  try {
    const value = JSON.parse(t);
    return JSON.stringify(value) === t ? JSON.stringify(value, null, 2) : t;
  } catch {
    return null;
  }
}

// A text still being written that starts like a payload: set in the code face before it can be parsed.
export function looksStructured(text) {
  return /^\s*(?:```|[[{]\s*(?:$|["\n[{\]}]))/.test(String(text ?? ''));
}

// The blocks of a text: the Markdown subset, or one code block for a text that is JSON as a whole.
export function richBlocks(text) {
  const json = jsonPayload(text);
  return json === null ? parseMarkdown(text) : [{ type: 'code', lang: 'json', text: json }];
}

// The lines of a code block, each with the columns of its indent. -> [{ indent, text }]
export function codeLines(text) {
  return String(text ?? '').split('\n').map((line) => {
    const lead = /^[ \t]*/.exec(line)[0];
    const columns = [...lead].reduce((n, c) => n + (c === '\t' ? TAB_COLUMNS : 1), 0);
    return { indent: Math.min(columns, INDENT_MAX), text: line };
  });
}

// The folders and the name of a path, each ending in its separator: where the path may wrap.
export function pathParts(path) {
  return String(path ?? '').match(/[^\\/]*[\\/]+|[^\\/]+/g) ?? [''];
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// A code block: one element per line, so a line that wraps continues under its own indent instead of at the
// left edge. Its text is the text it was given, line breaks and all. copy: the name of what its button copies
// ('' for none); source: what is copied when that is not the text shown (the message before it was laid out).
export function codeBlock(text, { lang = '', copy = 'code', source = text } = {}) {
  const pre = el('pre', copy ? 'code-block copy-host' : 'code-block');
  if (lang) pre.dataset.lang = lang;
  const code = el('code');
  const lines = codeLines(text);
  code.append(...lines.map((l, i) => {
    const line = el('span', 'code-line', i < lines.length - 1 ? `${l.text}\n` : l.text);
    if (l.indent) line.style.setProperty('--indent', String(l.indent));
    return line;
  }));
  pre.append(code);
  if (copy) pre.append(copyButton({ text: source, what: copy }));
  return pre;
}

// What a model wrote, as elements: the Markdown subset, its code blocks and a whole-text payload as code blocks.
export function richText(text) {
  const json = jsonPayload(text);
  if (json !== null) return [codeBlock(json, { lang: 'json', copy: 'JSON', source: text })];
  return parseMarkdown(text).map((b) => (b.type === 'code' ? codeBlock(b.text, { lang: b.lang }) : buildMarkdown([b])[0]));
}

// The path as text that wraps after a separator and is said whole by its title.
export function pathNode(path, cls = 'path mono') {
  const node = el('span', cls);
  node.title = path;
  pathParts(path).forEach((part, i) => {
    if (i) node.append(el('wbr'));
    node.append(part);
  });
  return node;
}

// The control of a text that shows about `limit` lines until it is opened. box is what is cut (data-clamp:
// closed | open, absent while the text is short or pinned open); more is the button that goes under it.
// set({ lines, open, pinned }): pinned is a text that may not be folded now (it is still being written).
// onBeforeToggle(): capture a reading anchor before layout changes; its returned function restores it afterwards.
// onToggle(open): the human pressed the button. The owner keeps who is open.
export function createFold(box, { limit = FOLD_LINES, onBeforeToggle = null, onToggle = null } = {}) {
  const more = el('button', 'msg-more clamp-more');
  more.type = 'button';
  const state = { lines: 0, open: false, pinned: false };

  function show() {
    const long = isFoldable(state.lines, limit);
    if (long && !state.pinned) box.dataset.clamp = state.open ? 'open' : 'closed';
    else delete box.dataset.clamp;
    more.hidden = !long || state.pinned;
    const word = foldWord(state.open, state.lines);
    if (more.textContent !== word) more.textContent = word;
    more.setAttribute('aria-expanded', String(state.open));
  }

  more.addEventListener('click', () => {
    const restore = onBeforeToggle?.();
    state.open = !state.open;
    show();
    onToggle?.(state.open);
    restore?.();
  });
  show();
  return {
    more,
    set(next) {
      Object.assign(state, next);
      show();
    },
    long: () => isFoldable(state.lines, limit),
    open: () => state.open,
  };
}

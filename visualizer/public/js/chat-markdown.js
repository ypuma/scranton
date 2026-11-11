// The Markdown subset of the Chat view (.enma/chat-view-contract.md sections 7 and 13.9): paragraphs, three
// heading levels, lists, fenced and inline code, bold and a rule. Everything else stays the text it is: links,
// images, tables and raw HTML are never turned into elements. The tokenizer is pure; the builder only calls
// createElement and createTextNode on the document it is given and never parses HTML.

const FENCE = /^ {0,3}(`{3,})([^`]*)$/;
const RULE = /^ {0,3}-{3,}\s*$/;
const HEADING = /^ {0,3}(#{1,3})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const ITEM = /^(\s*)([-*]|\d{1,9}\.)[ \t]+(.*)$/;
const LIST_DEPTH = 4;

// -> [{ type: 'text' | 'code', text } | { type: 'strong', spans }]
export function parseInline(text, { strong = true } = {}) {
  const src = String(text ?? '');
  const out = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ type: 'text', text: plain });
    plain = '';
  };
  let i = 0;
  while (i < src.length) {
    if (src[i] === '`') {
      const ticks = /^`+/.exec(src.slice(i))[0];
      // closed by the next run of the same length
      let end = -1;
      for (const m of src.slice(i + ticks.length).matchAll(/`+/g)) {
        if (m[0].length !== ticks.length) continue;
        end = i + ticks.length + m.index;
        break;
      }
      if (end > i + ticks.length) {
        flush();
        out.push({ type: 'code', text: src.slice(i + ticks.length, end).replace(/^ (.*) $/s, '$1') });
        i = end + ticks.length;
        continue;
      }
      plain += ticks;
      i += ticks.length;
      continue;
    }
    if (strong && src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      const inner = end === -1 ? '' : src.slice(i + 2, end);
      if (inner && !/^\s|\s$/.test(inner)) {
        flush();
        out.push({ type: 'strong', spans: parseInline(inner, { strong: false }) });
        i = end + 2;
        continue;
      }
      plain += '**';
      i += 2;
      continue;
    }
    plain += src[i];
    i += 1;
  }
  flush();
  return out;
}

// lines[from..] that belong to one list -> { block, next }. A deeper indent opens a list under the last item.
function parseList(lines, from) {
  const flat = [];
  let i = from;
  for (; i < lines.length; i += 1) {
    const m = ITEM.exec(lines[i]);
    if (m && !RULE.test(lines[i])) {
      flat.push({ indent: m[1].length, ordered: /\d/.test(m[2]), start: Number.parseInt(m[2], 10) || 1, text: m[3] });
      continue;
    }
    // one blank line between two items keeps them in one list
    if (!lines[i].trim() && ITEM.test(lines[i + 1] ?? '') && !RULE.test(lines[i + 1])) continue;
    // an indented line continues the item above it
    if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && flat.length) {
      flat.at(-1).text += `\n${lines[i].trim()}`;
      continue;
    }
    break;
  }
  let at = 0;
  const build = (indent, depth) => {
    const first = flat[at];
    const list = { type: first.ordered ? 'ol' : 'ul', start: first.start, items: [] };
    while (at < flat.length) {
      const it = flat[at];
      if (it.indent < indent - 1) break;
      if (it.indent >= indent + 2 && list.items.length && depth < LIST_DEPTH) {
        list.items.at(-1).lists.push(build(it.indent, depth + 1));
        continue;
      }
      // another kind of marker at this level is the next list
      if (it.ordered !== first.ordered && it.indent < indent + 2) break;
      list.items.push({ spans: parseInline(it.text), lists: [] });
      at += 1;
    }
    return list;
  };
  const blocks = [];
  while (at < flat.length) blocks.push(build(flat[at].indent, 1));
  return { blocks, next: i };
}

// -> [{ type: 'p', spans } | { type: 'h', level: 1 | 2 | 3, spans } | { type: 'ul' | 'ol', start, items: [{ spans, lists }] }
//     | { type: 'code', lang, text } | { type: 'rule' }]
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const startsBlock = (line) => FENCE.test(line) || RULE.test(line) || HEADING.test(line) || ITEM.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}\`{${fence[1].length},}\\s*$`);
      const body = [];
      i += 1;
      // a fence nobody closed runs to the end, as in a message that is still being written
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', lang: (/^[\w+#.-]{1,40}/.exec(fence[2].trim()) ?? [''])[0], text: body.join('\n') });
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'h', level: heading[1].length, spans: parseInline(heading[2]) });
      i += 1;
      continue;
    }
    if (ITEM.test(line)) {
      const list = parseList(lines, i);
      blocks.push(...list.blocks);
      i = list.next;
      continue;
    }
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'p', spans: parseInline(para.join('\n')) });
  }
  return blocks;
}

function inline(spans, doc) {
  return spans.map((s) => {
    if (s.type === 'text') return doc.createTextNode(s.text);
    const e = doc.createElement(s.type === 'code' ? 'code' : 'strong');
    if (s.type === 'code') e.textContent = s.text;
    else e.append(...inline(s.spans, doc));
    return e;
  });
}

function list(block, doc) {
  const e = doc.createElement(block.type);
  if (block.type === 'ol' && block.start !== 1) e.start = block.start;
  for (const it of block.items) {
    const li = doc.createElement('li');
    li.append(...inline(it.spans, doc), ...it.lists.map((l) => list(l, doc)));
    e.append(li);
  }
  return e;
}

// blocks of parseMarkdown -> elements
export function buildMarkdown(blocks, doc = globalThis.document) {
  return blocks.map((b) => {
    if (b.type === 'ul' || b.type === 'ol') return list(b, doc);
    if (b.type === 'rule') return doc.createElement('hr');
    if (b.type === 'code') {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = b.text;
      if (b.lang) pre.dataset.lang = b.lang;
      pre.append(code);
      return pre;
    }
    // the page's own headings are h1 and h2, so a message starts at h3
    const e = doc.createElement(b.type === 'h' ? `h${b.level + 2}` : 'p');
    e.append(...inline(b.spans, doc));
    return e;
  });
}

export function renderMarkdown(text, doc = globalThis.document) {
  return buildMarkdown(parseMarkdown(text), doc);
}

// Text measurement and styling for the terminal dashboard. A line is built as an
// array of segments [text, style] and only turned into an ANSI string at the very end,
// so truncation always works on visible text and never cuts an escape sequence.

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const ZERO_WIDTH = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x061c, 0x061c], [0x064b, 0x065f],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xe0100, 0xe01ef],
];

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x18aff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function inRanges(cp, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

export function charWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** Visible cell width of plain text (no escape sequences). */
export function textWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += charWidth(ch.codePointAt(0));
  return width;
}

/** Visible cell width of a string that may contain ANSI escape sequences. */
export function visibleWidth(text) {
  return textWidth(stripAnsi(text));
}

/** Untrusted text (requests, summaries, commands) becomes a single safe line. */
export function sanitize(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(ANSI_RE, '')
    // Bidi controls could reorder the rest of the terminal line.
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\ufe0e\ufe0f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(text, max) {
  let out = '';
  let width = 0;
  for (const ch of String(text)) {
    const w = charWidth(ch.codePointAt(0));
    if (width + w > max) break;
    out += ch;
    width += w;
  }
  return out;
}

export function truncate(text, max, ellipsis = '…') {
  text = String(text);
  if (max <= 0) return '';
  if (textWidth(text) <= max) return text;
  const ellWidth = textWidth(ellipsis);
  if (max <= ellWidth) return cut(text, max);
  return cut(text, max - ellWidth).trimEnd() + ellipsis;
}

/** Keeps the end of the text, for paths: "…\Project_Scranton\hive". */
export function truncateStart(text, max, ellipsis = '…') {
  const chars = Array.from(String(text));
  if (max <= 0) return '';
  if (textWidth(text) <= max) return String(text);
  const budget = max - textWidth(ellipsis);
  if (budget <= 0) return cut(text, max);
  let out = '';
  let width = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = charWidth(chars[i].codePointAt(0));
    if (width + w > budget) break;
    out = chars[i] + out;
    width += w;
  }
  return ellipsis + out;
}

export function segWidth(segs) {
  let width = 0;
  for (const [text] of segs) width += textWidth(text);
  return width;
}

/** Cuts a segment line to max cells, ending in an ellipsis styled like the cut segment. */
export function fitSegments(segs, max, ellipsis = '…') {
  if (segWidth(segs) <= max) return segs;
  const ellWidth = textWidth(ellipsis);
  const withEllipsis = max > ellWidth;
  let budget = withEllipsis ? max - ellWidth : Math.max(0, max);
  const out = [];
  for (const [text, style] of segs) {
    const w = textWidth(text);
    if (w <= budget) {
      out.push([text, style]);
      budget -= w;
      continue;
    }
    out.push([cut(text, budget).trimEnd() + (withEllipsis ? ellipsis : ''), style]);
    break;
  }
  return out;
}

export function padSegments(segs, width, style = null) {
  const missing = width - segWidth(segs);
  return missing > 0 ? [...segs, [' '.repeat(missing), style]] : segs;
}

/** Left and right parts on one line, right part flush with the right edge, at least gap apart. */
export function spread(left, right, width, ellipsis = '…', gap = 2) {
  const rightWidth = segWidth(right);
  if (!right.length || rightWidth + gap > width) return fitSegments(left, width, ellipsis);
  const fitted = fitSegments(left, width - rightWidth - gap, ellipsis);
  return [...fitted, [' '.repeat(width - segWidth(fitted) - rightWidth), null], ...right];
}

// Grayscale only: attributes plus the 256-colour gray ramp as fg:N / bg:N (N in 232-255).
const SGR = { bold: '1', dim: '2', italic: '3', underline: '4', inverse: '7' };

function sgr(name) {
  if (SGR[name]) return SGR[name];
  const m = /^(fg|bg):(\d+)$/.exec(name);
  if (!m || Number(m[2]) < 232 || Number(m[2]) > 255) return null;
  return `${m[1] === 'fg' ? 38 : 48};5;${m[2]}`;
}

export function makePainter(color) {
  const cache = new Map();
  return (text, style) => {
    if (!color || !style || text === '') return text;
    let open = cache.get(style);
    if (open === undefined) {
      const codes = style.split(/\s+/).map(sgr).filter(Boolean);
      open = codes.length ? `\x1b[${codes.join(';')}m` : '';
      cache.set(style, open);
    }
    return open ? `${open}${text}\x1b[0m` : text;
  };
}

export function renderSegments(segs, paint) {
  let out = '';
  for (const [text, style] of segs) out += paint(text, style);
  return out;
}

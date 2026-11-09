import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUBLIC = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const CHROMATIC_NAMES = /\b(red|green|blue|yellow|orange|purple|violet|magenta|fuchsia|cyan|aqua|teal|lime|olive|navy|maroon|pink|brown|gold|indigo|crimson|coral|salmon|tomato|orchid|khaki|beige|tan|turquoise|chartreuse|plum|lavender|slategr[ae]y|steelblue|ivory|azure|aliceblue|ghostwhite|honeydew|mintcream|seashell|snow|linen|wheat)\b/gi;

function sources() {
  const files = ['styles.css', 'index.html', ...readdirSync(path.join(PUBLIC, 'js')).map((f) => `js/${f}`)];
  return files.map((f) => {
    const text = readFileSync(path.join(PUBLIC, f), 'utf8');
    // comments may mention anything; only code counts
    return { file: f, text: text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '') };
  });
}

function hexChannels(hex) {
  const h = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
}

// Every colour literal: [file, literal, channels | null (null = a colour form this test cannot check)]
function colours() {
  const out = [];
  for (const { file, text } of sources()) {
    for (const m of text.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
      if ([3, 4, 6, 8].includes(m[1].length)) out.push([file, m[0], hexChannels(m[1])]);
    }
    for (const m of text.matchAll(/\brgba?\(([^)]*)\)/gi)) {
      const nums = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((v) => (v.endsWith('%') ? Math.round(parseFloat(v) * 2.55) : Number(v)));
      out.push([file, m[0], nums.length === 3 && nums.every(Number.isFinite) ? nums : null]);
    }
    for (const m of text.matchAll(/\bhsla?\(([^)]*)\)/gi)) {
      const sat = parseFloat(m[1].split(/[\s,/]+/).filter(Boolean)[1]);
      out.push([file, m[0], sat === 0 ? [0, 0, 0] : null]);
    }
    for (const m of text.matchAll(/\b(hwb|lab|lch|oklab|oklch|color|color-mix)\(/gi)) out.push([file, m[0], null]);
    if (file.endsWith('.css') || file.endsWith('.html')) {
      for (const m of text.matchAll(CHROMATIC_NAMES)) out.push([file, m[0], null]);
    }
  }
  return out;
}

test('every colour in the web dashboard is a neutral gray (R = G = B)', () => {
  const found = colours();
  assert.ok(found.length >= 10, `only ${found.length} colours found - is the scan still reading styles.css?`);
  const tinted = found.filter(([, , ch]) => !ch || ch[0] !== ch[1] || ch[1] !== ch[2]).map(([f, lit]) => `${f}: ${lit}`);
  assert.deepEqual(tinted, []);
});

test('the scan itself catches tinted colours', () => {
  const tinted = (lit) => {
    const m = /^#([0-9a-f]+)$/i.exec(lit);
    const ch = hexChannels(m[1]);
    return ch[0] !== ch[1] || ch[1] !== ch[2];
  };
  assert.equal(tinted('#3a3a40'), true);
  assert.equal(tinted('#18181b'), true);
  assert.equal(tinted('#3c3c3c'), false);
  assert.equal(tinted('#eee'), false);
});

function luminance(hex) {
  const [r, g, b] = hexChannels(hex.slice(1)).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('the smallest text tone keeps 4.5:1 on panels after the neutral shift', () => {
  const css = readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  const v = (name) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)[1];
  for (const bg of ['bg', 'panel', 'panel-2']) {
    const [a, b] = [luminance(v('text-3')), luminance(v(bg))].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    assert.ok(ratio >= 4.5, `--text-3 on --${bg}: ${ratio.toFixed(2)}:1`);
  }
});

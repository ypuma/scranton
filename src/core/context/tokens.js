const weight = (point) => point <= 0x7f || point === 0x2026 ? 1 : point <= 0x2e7f ? 2 : 4;
export function units(text) {
  if (typeof text !== 'string') return 0;
  let total = 0;
  for (const char of text) total += weight(char.codePointAt(0));
  return total;
}
export const tokens = (text) => Math.ceil(units(text) / 4);
export function clipUnits(text, max) {
  if (typeof text !== 'string' || max <= 0) return '';
  let total = 0, end = 0;
  for (const char of text) { total += weight(char.codePointAt(0)); if (total > max) break; end += char.length; }
  return text.slice(0, end);
}
export function cutUnits(text, max) {
  if (typeof text !== 'string' || max <= 0) return '';
  return units(text) <= max ? text : clipUnits(text, max - 1) + '…';
}
export function pct(n, d) {
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return '0';
  const value = n * 100 / d;
  const rounded = Math.round(value * 10) / 10;
  return value < 0.1 ? '<0.1' : rounded < 10 ? rounded.toFixed(1) : String(Math.round(value));
}

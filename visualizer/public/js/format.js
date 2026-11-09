// Pure display formatters (no DOM), shared by the dashboard and the tests.
// Number, cost, duration and clock rules are the same as in the terminal dashboard.

// Bidi embeddings/overrides/isolates and marks in model output could reorder what is shown.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

export function stripBidi(text) {
  return String(text ?? '').replace(BIDI_CONTROLS, '');
}

// Decide the unit after rounding, so 999.6 reads 1.0k and 999 960 reads 1.0M.
export function formatTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (Math.round(v) < 1000) return String(Math.round(v));
  const k = Math.round(v / 100) / 10;
  if (k < 1000) return `${k.toFixed(1)}k`;
  return `${(Math.round(v / 1e5) / 10).toFixed(1)}M`;
}

export function formatCost(n) {
  const v = Math.max(0, Number(n) || 0);
  return `$${v.toFixed(v > 0 && Math.round(v * 1000) < 1000 ? 3 : 2)}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// Local HH:MM:SS of an ISO timestamp, the same clock the terminal dashboard shows.
export function formatClock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

// formatClock for today; with the local date (YYYY-MM-DD HH:MM) for another day, so a time from yesterday never
// reads as today's.
export function formatWhen(ts, now = Date.now()) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return formatClock(ts);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Elapsed run time. While a run is still active in live mode the clock keeps ticking.
export function runElapsed(state, { now = Date.now(), ticking = false } = {}) {
  const start = Date.parse(state?.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = Date.parse(state.finishedAt ?? '');
  if (Number.isFinite(end)) return end - start;
  const last = Date.parse(state.updatedAt ?? '') || start;
  return Math.max(0, (ticking ? Math.max(now, last) : last) - start);
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

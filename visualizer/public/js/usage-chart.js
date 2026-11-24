// Cost and usage of a run (.enma/live-activity-contract.md section 2): the figures, and one diagram of the
// cumulative cost or tokens over time, stacked by agent. chartModel is the geometry (no DOM, so Node can test it);
// createUsage draws it as SVG built in code and keeps the nodes it made.
import { formatTokens, formatCost } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const METRICS = ['cost', 'tokens'];
// more agents than tones: the smallest share one band
export const BANDS_MAX = 5;
export const TABLE_ROWS_MAX = 12;
const PAD = { l: 46, r: 10, t: 8, b: 20 };
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400];

const round = (v) => Math.round(v * 10) / 10;

// The smallest 1-2-5 step that covers max in at most `ticks` steps.
export function niceStep(max, ticks = 3) {
  if (!(max > 0)) return 1;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw * (1 - 1e-9));
}

// Elapsed time as a tick or a readout says it: 45s, 2m, 1m 30s, 1h 5m.
export function shortTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const formatOf = (metric) => (metric === 'cost' ? formatCost : (v) => formatTokens(v));

// usage: the usage of a run view (activity-model.js). end: where the time axis ends (now, for a run that is going).
// -> { empty: true, metric } | { metric, width, height, yTicks, xTicks, bands, total, points, summary, rows }
// A cumulative value holds until the next call, so every line is a step.
export function chartModel(usage, { metric = 'cost', width = 320, height = 150, end = null } = {}) {
  const pick = (v) => (metric === 'cost' ? v?.cost : v?.tokens);
  const pts = (usage?.series ?? []).filter((p) => typeof pick(p) === 'number');
  if (!pts.length) return { empty: true, metric };
  const fmt = formatOf(metric);
  const t0 = Math.min(usage.startedAt ?? pts[0].at, pts[0].at);
  const t1 = Math.max(end ?? 0, pts.at(-1).at, t0 + 1000);
  const last = pts.at(-1);

  const final = (id) => pick(last.by?.[id]) ?? 0;
  const ids = usage.agents.map((a) => a.id).filter((id) => final(id) > 0);
  const name = (id) => usage.agents.find((a) => a.id === id)?.name ?? id;
  let groups = ids.map((id) => ({ id, name: name(id), of: [id] }));
  if (groups.length > BANDS_MAX) {
    const keep = new Set([...ids].sort((a, b) => final(b) - final(a)).slice(0, BANDS_MAX - 1));
    groups = [...groups.filter((g) => keep.has(g.id)), { id: 'other', name: 'Other', of: ids.filter((id) => !keep.has(id)) }];
  }
  const part = (p, g) => g.of.reduce((n, id) => n + (pick(p.by?.[id]) ?? 0), 0);

  const top = Math.max(...pts.map(pick));
  const step = niceStep(top);
  const yMax = Math.max(step, Math.ceil(top / step - 1e-9) * step);
  const w = width - PAD.l - PAD.r;
  const h = height - PAD.t - PAD.b;
  const x = (t) => round(PAD.l + ((t - t0) / (t1 - t0)) * w);
  const y = (v) => round(PAD.t + (1 - v / yMax) * h);
  const xEnd = x(t1);

  // the corners of a step line through the points, left to right
  const corners = (value) => {
    const out = [[x(t0), y(0)]];
    let prev = 0;
    for (const p of pts) {
      const v = value(p);
      out.push([x(p.at), y(prev)], [x(p.at), y(v)]);
      prev = v;
    }
    out.push([xEnd, y(prev)]);
    return out;
  };
  const path = (list) => list.map(([px, py], i) => `${i ? 'L' : 'M'}${px} ${py}`).join('');

  const bands = groups.map((g, i) => {
    const below = (p) => groups.slice(0, i).reduce((n, b) => n + part(p, b), 0);
    return {
      id: g.id, name: g.name, tone: i, value: part(last, g), label: fmt(part(last, g)),
      d: `${path(corners((p) => below(p) + part(p, g)))}${path(corners(below).reverse()).replace(/^M/, 'L')}Z`,
    };
  });

  const yTicks = [];
  for (let v = 0; v <= yMax + step / 2; v += step) yTicks.push({ y: y(v), label: fmt(v) });
  const span = (t1 - t0) / 1000;
  const tStep = TIME_STEPS.find((s) => span / s <= 4) ?? TIME_STEPS.at(-1);
  const xTicks = [];
  for (let s = 0; s <= span + 1e-9; s += tStep) xTicks.push({ x: x(t0 + s * 1000), label: shortTime(s * 1000) });

  const points = pts.map((p) => ({
    x: x(p.at), y: y(pick(p)), elapsed: p.at - t0, total: pick(p),
    text: [shortTime(p.at - t0), `${fmt(pick(p))} total`, ...groups.filter((g) => part(p, g) > 0).map((g) => `${g.name} ${fmt(part(p, g))}`)].join(' · '),
  }));
  // the table a reader gets instead of the picture: at most TABLE_ROWS_MAX points, the newest always among them
  const every = Math.ceil(pts.length / TABLE_ROWS_MAX);
  const rows = pts.map((p, i) => ({ p, i })).filter(({ i }) => i === pts.length - 1 || i % every === 0)
    .map(({ p }) => ({ time: shortTime(p.at - t0), total: fmt(pick(p)), parts: groups.map((g) => fmt(part(p, g))) }));
  return {
    metric, width, height, plot: { left: PAD.l, right: width - PAD.r, top: PAD.t, bottom: height - PAD.b },
    yTicks, xTicks, bands, points, rows, columns: groups.map((g) => g.name),
    total: { d: path(corners(pick)), value: pick(last), label: fmt(pick(last)) },
    latest: `${fmt(pick(last))} after ${shortTime(last.at - t0)}`,
    summary: `Cumulative ${metric} over ${shortTime(t1 - t0)}: ${fmt(pick(last))}${bands.length ? ` (${bands.map((b) => `${b.name} ${b.label}`).join(', ')})` : ''}`,
  };
}

// The run's and the chat's figures as text. -> { cost, tokens, sub, estimated, chat }
export function usageFigures(usage) {
  const r = usage?.run ?? { cost: 0, tokens: 0, input: 0, output: 0, calls: 0, estimated: false };
  const money = (v, est) => (v === null || v === undefined ? 'not reported' : `${est ? '~' : ''}${formatCost(v)}`);
  const c = usage?.chat && usage.chat.of > 1 ? usage.chat : null;
  return {
    cost: money(r.cost, r.estimated), tokens: `${formatTokens(r.tokens)} tokens`, estimated: r.estimated && r.cost !== null,
    sub: `in ${formatTokens(r.input)} · out ${formatTokens(r.output)} · ${r.calls} model call${r.calls === 1 ? '' : 's'}`,
    chat: c ? {
      cost: money(c.cost, c.estimated), tokens: `${formatTokens(c.tokens)} tokens`,
      sub: c.runs < c.of ? `${c.runs} of ${c.of} runs report it` : `${c.of} runs`,
    } : null,
  };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// a text node is only written when it says something else
function say(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// table: also list every agent (calls, tokens, cost, share); without it a legend names the bands.
// id: a prefix for the ids the labels need. -> { el, render(usage, { live, now }) }
export function createUsage({ table = false, height = 150, id = 'usage' } = {}) {
  const root = el('div', 'usage');
  const figs = el('dl', 'usage-figs');
  const fig = (label) => {
    const box = el('div', 'usage-fig');
    const value = el('span', 'usage-value mono');
    const tokens = el('span', 'usage-tokens mono');
    const note = el('span', 'usage-est', 'estimated');
    note.title = 'Priced from a table of model prices, not billed figures';
    const sub = el('span', 'usage-sub');
    const dd = el('dd');
    dd.append(value, ' ', note, ' ', tokens, sub);
    box.append(el('dt', '', label), dd);
    return { box, value, tokens, note, sub };
  };
  const run = fig('This run');
  const chat = fig('This chat');
  figs.append(run.box, chat.box);

  const tools = el('div', 'segmented usage-metric');
  tools.setAttribute('role', 'group');
  tools.setAttribute('aria-label', 'The diagram shows');
  const pick = Object.fromEntries(METRICS.map((m) => {
    const b = el('button', 'seg', m === 'cost' ? 'Cost' : 'Tokens');
    b.type = 'button';
    b.dataset.metric = m;
    tools.append(b);
    return [m, b];
  }));

  const readout = el('p', 'chart-readout mono');
  readout.id = `${id}-readout`;
  // the diagram redraws as the run goes: it is no live region, only a point read with the keys is said
  readout.setAttribute('aria-live', 'off');
  const spoken = el('p', 'sr-only');
  spoken.setAttribute('role', 'status');
  spoken.setAttribute('aria-live', 'polite');
  const chart = el('div', 'chart');
  chart.tabIndex = 0;
  chart.setAttribute('role', 'group');
  chart.setAttribute('aria-describedby', readout.id);
  const picture = svg('svg', { class: 'chart-svg', 'aria-hidden': 'true', focusable: 'false' });
  const empty = el('p', 'chart-empty');
  chart.append(picture, empty);

  const legend = el(table ? 'table' : 'ul', table ? 'usage-table' : 'chart-legend');
  const data = el('details', 'chart-data');
  const dataTable = el('table', 'usage-table chart-points');
  data.append(el('summary', '', 'Diagram as a table'), dataTable);
  root.append(figs, tools, chart, readout, spoken, legend, data);

  // null: follow what the run reports; a pick by the human stays
  let chosen = null;
  let usage = null;
  let opts = {};
  let model = { empty: true, metric: 'cost' };
  let key = '';
  let legendKey = '';
  // the point under the pointer or reached with the keys; null reads the newest
  let at = null;
  let width = 320;
  let cursor = null;

  const metric = () => chosen ?? (usage?.costSeries || !usage?.series.length ? 'cost' : 'tokens');

  function drawCursor() {
    cursor?.remove();
    cursor = null;
    const p = model.empty || at === null ? null : model.points[at];
    say(readout, model.empty ? '' : p ? p.text : `Latest: ${model.latest}`);
    if (!p) return;
    cursor = svg('g', { class: 'chart-cursor' });
    cursor.append(svg('line', { x1: p.x, x2: p.x, y1: model.plot.top, y2: model.plot.bottom }), svg('circle', { cx: p.x, cy: p.y, r: 3 }));
    picture.append(cursor);
  }

  function draw() {
    const m = metric();
    for (const k of METRICS) pick[k].setAttribute('aria-pressed', String(k === m));
    // a run that is going extends the time axis to now, a few seconds at a time
    const end = opts.live ? Math.ceil((opts.now ?? Date.now()) / 5000) * 5000 : null;
    const next = JSON.stringify([m, width, height, end, usage?.series.length, usage?.series.at(-1), usage?.startedAt, usage?.agents.map((a) => a.name)]);
    if (next === key) return;
    key = next;
    model = chartModel(usage, { metric: m, width, height, end });
    if (at !== null && (model.empty || at >= model.points.length)) at = null;
    empty.hidden = !model.empty;
    picture.setAttribute('viewBox', `0 0 ${width} ${height}`);
    picture.setAttribute('height', String(height));
    chart.dataset.empty = String(Boolean(model.empty));
    cursor = null;
    if (model.empty) {
      picture.replaceChildren();
      say(empty, !usage?.series.length ? 'No usage yet. The diagram starts with the first model call.'
        : m === 'cost' ? 'This run reports no cost per call. Tokens can be shown instead.' : 'No tokens reported yet.');
      chart.setAttribute('aria-label', `Usage diagram, ${m}: nothing to show yet`);
    } else {
      const grid = svg('g', { class: 'chart-grid' });
      for (const t of model.yTicks) {
        const label = svg('text', { x: model.plot.left - 6, y: t.y + 3, 'text-anchor': 'end' });
        label.textContent = t.label;
        grid.append(svg('line', { x1: model.plot.left, x2: model.plot.right, y1: t.y, y2: t.y }), label);
      }
      model.xTicks.forEach((t, i) => {
        const label = svg('text', { x: t.x, y: height - 6, 'text-anchor': i === 0 ? 'start' : t.x > model.plot.right - 16 ? 'end' : 'middle' });
        label.textContent = t.label;
        grid.append(label);
      });
      const bands = model.bands.map((b) => svg('path', { class: 'chart-band', 'data-tone': b.tone, 'data-band': b.id, d: b.d }));
      picture.replaceChildren(grid, ...bands, svg('path', { class: 'chart-total', d: model.total.d }));
      chart.setAttribute('aria-label', `${model.summary}. Arrow keys read the points.`);
    }
    drawCursor();
    drawLegend();
    dataTable.replaceChildren();
    data.hidden = Boolean(model.empty);
    if (!model.empty) {
      const head = el('tr');
      head.append(...['Elapsed', 'Total', ...model.columns].map((t) => Object.assign(el('th', '', t), { scope: 'col' })));
      const thead = el('thead');
      thead.append(head);
      const body = el('tbody');
      body.append(...model.rows.map((r) => {
        const tr = el('tr');
        tr.append(Object.assign(el('th', 'mono', r.time), { scope: 'row' }), ...[r.total, ...r.parts].map((t) => el('td', 'mono', t)));
        return tr;
      }));
      const caption = el('caption', 'sr-only', `Cumulative ${model.metric} by agent`);
      dataTable.append(caption, thead, body);
    }
  }

  const swatch = (tone) => {
    const s = el('span', 'chart-swatch');
    if (tone !== null) s.dataset.tone = String(tone);
    s.setAttribute('aria-hidden', 'true');
    return s;
  };

  // the bands by name; with `table`, every agent of the run with its calls, tokens, cost and share
  function drawLegend() {
    const tone = (id) => (model.empty ? null : model.bands.find((b) => b.id === id)?.tone ?? model.bands.find((b) => b.id === 'other')?.tone ?? null);
    const next = JSON.stringify([usage?.agents, model.empty ? null : model.bands.map((b) => [b.id, b.label]), usage?.hasCost, usage?.shareMetric]);
    if (next === legendKey) return;
    legendKey = next;
    const agents = usage?.agents ?? [];
    legend.hidden = !agents.length;
    if (!table) {
      legend.replaceChildren(...(model.empty ? [] : model.bands).map((b) => {
        const li = el('li');
        li.append(swatch(b.tone), el('span', 'chart-name', b.name), el('span', 'mono', b.label));
        return li;
      }));
      legend.hidden = model.empty || !model.bands.length;
      return;
    }
    const head = el('tr');
    head.append(...['Agent', 'Calls', 'Tokens', 'Cost', usage?.shareMetric === 'tokens' ? 'Token share' : 'Cost share'].map((t) => Object.assign(el('th', '', t), { scope: 'col' })));
    const thead = el('thead');
    thead.append(head);
    const body = el('tbody');
    body.append(...agents.map((a) => {
      const tr = el('tr');
      const who = Object.assign(el('th'), { scope: 'row' });
      who.append(swatch(tone(a.id)), a.name);
      // the column says the name short
      if (a.full && a.full !== a.name) who.title = a.full;
      tr.append(who, el('td', 'mono', String(a.calls)), el('td', 'mono', formatTokens(a.tokens)),
        el('td', 'mono', a.cost === null ? '-' : formatCost(a.cost)), el('td', 'mono', `${Math.round(a.share * 100)}%`));
      return tr;
    }));
    legend.replaceChildren(el('caption', 'sr-only', 'Usage by agent'), thead, body);
  }

  function render(next, o = {}) {
    usage = next;
    opts = o;
    const f = usageFigures(usage);
    say(run.value, f.cost);
    say(run.tokens, f.tokens);
    say(run.sub, f.sub);
    run.note.hidden = !f.estimated;
    chat.box.hidden = !f.chat;
    if (f.chat) {
      say(chat.value, f.chat.cost);
      say(chat.tokens, f.chat.tokens);
      say(chat.sub, f.chat.sub);
      chat.note.hidden = !usage.chat.estimated || usage.chat.cost === null;
    }
    draw();
  }

  function move(next, speak) {
    at = next;
    drawCursor();
    if (speak) spoken.textContent = at === null || model.empty ? '' : model.points[at].text;
  }

  tools.addEventListener('click', (ev) => {
    const b = ev.target.closest?.('button[data-metric]');
    if (!b) return;
    chosen = b.dataset.metric;
    at = null;
    draw();
  });
  chart.addEventListener('pointermove', (ev) => {
    if (model.empty) return;
    const box = picture.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / (box.width || width)) * width;
    // the value under the pointer is that of the last call before it
    let i = model.points.findLastIndex((p) => p.x <= px);
    if (i < 0) i = 0;
    if (i !== at) move(i, false);
  });
  chart.addEventListener('pointerleave', () => move(null, false));
  chart.addEventListener('keydown', (ev) => {
    if (model.empty) return;
    const n = model.points.length - 1;
    const from = at ?? n;
    const to = { ArrowLeft: Math.max(0, from - 1), ArrowRight: Math.min(n, from + 1), Home: 0, End: n }[ev.key];
    if (to === undefined) {
      if (ev.key === 'Escape' && at !== null) move(null, true);
      return;
    }
    ev.preventDefault();
    move(to, true);
  });
  chart.addEventListener('blur', () => move(null, false));
  if (globalThis.ResizeObserver) {
    new ResizeObserver(() => {
      const w = Math.round(chart.clientWidth);
      if (w > 0 && w !== width) {
        width = w;
        draw();
      }
    }).observe(chart);
  }

  return { el: root, render };
}

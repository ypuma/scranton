import { redact as defaultRedact } from '../dreaming/reflection.js';
import { LIMITS as L, scaledLimits } from './limits.js';
import { units, tokens, clipUnits, cutUnits } from './tokens.js';
import { clip, relativeFile } from './turns.js';
import { maskHistoricalText } from './shared.js';

const titles = Object.freeze({ notes: 'Project notes (standing preferences; current request wins)', memory: 'Project memory (advisory historical data)', 'other-chats': 'Other chats (same project; this chat takes precedence)', earlier: 'This chat - earlier turns', recent: 'This chat - recent turns' });
export function safeText(value, redact = defaultRedact) {
  return maskHistoricalText(redact(typeof value === 'string' ? value : '').toWellFormed().replace(/\r\n?/g, '\n').replace(/<\s*\/?\s*(earlier-runs|conversation-context)\s*>/gi, '[$1]'));
}
const one = (s, redact) => safeText(s, redact).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
const cut = cutUnits;
export function condensedTurn(turn, { maxChars = L.condensed, redact = defaultRedact } = {}) {
  const files = (turn.files ?? []).map(relativeFile).filter(Boolean), shown = files.slice(0, L.condensedFiles);
  const suffix = shown.length ? `; files: ${shown.map((f) => one(f, redact)).join(', ')}${files.length > shown.length ? ` (+${files.length - shown.length} more)` : ''}` : '';
  const outcome = cut(one(turn.outcome, redact), L.condensedOutcome);
  return cut(`#${turn.index} [${one(turn.status, redact)}] ${cut(one(turn.request, redact), L.condensedRequest)}${outcome ? ` -> ${outcome}` : ''}${suffix}`.trim(), maxChars).trimEnd();
}
export function detailedTurn(turn, { latest = false, maxChars = L.team, redact = defaultRedact, limits: caps = L } = {}) {
  let request = cut(safeText(turn.request, redact), latest ? caps.latestRequest : caps.olderRequest);
  const heading = `### #${turn.index} [${cut(one(turn.status, redact), 80)}] ${one(turn.startedAt, redact) || 'date unknown'}`;
  const outcome = cut(one(turn.outcome, redact), caps.outcome);
  const plan = (turn.plan ?? []).slice(0, caps.planLines).map((p) => `- ${cut(one(p.title, redact), caps.planLine)} [${cut(one(p.status, redact), 80)}]`).join('\n');
  const files = (turn.files ?? []).slice(0, caps.files).map(relativeFile).filter(Boolean).map((p) => one(p, redact)).join(', ');
  const parts = [files ? cut('Files touched (not delivery proof): ' + files, latest ? caps.latestFiles : caps.olderFiles) : '',
    plan ? cut('Plan (historical):\n' + plan, latest ? caps.latestPlan : caps.olderPlan) : '',
    turn.reply?.text ? `Reply (${one(turn.reply.kind, redact)}):\n${cut(safeText(turn.reply.text, redact), latest ? caps.latestReply : caps.olderReply)}` : ''];
  const render = () => [heading, `Request: ${request}`, `Outcome: ${outcome}`, parts[1], parts[0], parts[2]].filter(Boolean).join('\n').trimEnd();
  for (let i = 0; i < parts.length && units(render()) > maxChars; i++) {
    const room = units(parts[i]) - (units(render()) - maxChars);
    parts[i] = room > 1 ? cut(parts[i], room) : '';
  }
  if (units(render()) > maxChars) request = cut(request, Math.max(Math.min(units(request), caps.minRequest), units(request) - (units(render()) - maxChars)));
  return units(render()) <= maxChars ? render() : condensedTurn(turn, { redact });
}

const section = (id, body, exact = true) => { const text = `## ${titles[id]}\n${body}`; return { id, title: titles[id], chars: text.length, tokens: tokens(text), text, exact }; };
const joined = (sections) => sections.map((s) => s.text).join('\n\n');
export function buildTeamPack({ turns = [], total = turns.length, unread = 0, notes = '', memory = '', otherChats = [], truncated = false, degraded = false, redact = defaultRedact, units: U = L.team, developerUnits: Udev = L.developer } = {}) {
  const caps = scaledLimits(U, Udev);
  notes = clip(safeText(notes, redact), L.notes); if (!notes.trim()) notes = '';
  const originalNotes = notes, notesLimit = Math.floor(U / 2), notesCut = units(notes) > notesLimit;
  if (notesCut) {
    const mark = '[project notes cut to fit the context budget]';
    const prefix = clipUnits(notes, notesLimit - units(mark) - 1), line = prefix.lastIndexOf('\n');
    notes = (line >= 0 ? prefix.slice(0, line) : prefix) + '\n' + mark;
  }
  memory = cut(safeText(memory, redact), caps.memory).trim();
  const layers = new Map(), costs = new Map(), detailed = new Set(), condensed = new Set();
  let layerUnits = 0;
  const heading = (id) => units('## ' + titles[id] + '\n');
  const set = (id, body) => { layerUnits -= costs.get(id) ?? 0; layers.set(id, body); const n = heading(id) + units(body); costs.set(id, n); layerUnits += n; };
  const drop = (id) => { layerUnits -= costs.get(id) ?? 0; costs.delete(id); layers.delete(id); };
  const used = () => layerUnits + Math.max(0, layers.size - 1) * 2;
  const render = () => ['notes', 'memory', 'other-chats', 'earlier', 'recent'].filter((id) => layers.has(id)).map((id) => section(id, layers.get(id)));
  const marker = (n) => '... ' + n + ' earlier turns omitted ...';
  if (notes) set('notes', notes + '\n[End project notes]');
  if (turns.length) {
    // Reserve the omission marker before allocating detail so every visible turn remains accounted for.
    const reserve = turns.length + unread > 1 ? heading('earlier') + units(marker(turns.length + unread - 1)) + 2 : 0;
    const room = U - used() - (layers.size ? 2 : 0) - heading('recent') - reserve;
    const latest = turns.at(-1), detail = detailedTurn(latest, { latest: true, maxChars: room, redact, limits: caps });
    set('recent', cut(detail, room));
    if (detail.startsWith('### ')) detailed.add(latest.id); else condensed.add(latest.id);
    for (const turn of turns.slice(-caps.recent, -1).reverse()) {
      const previous = layers.get('recent'), detail = detailedTurn(turn, { redact, maxChars: U - used() - reserve - 2, limits: caps });
      if (!detail.startsWith('### ')) continue;
      set('recent', detail + '\n\n' + previous);
      if (used() + reserve > U) { set('recent', previous); continue; }
      detailed.add(turn.id);
    }
    const earlier = turns.filter((t) => !detailed.has(t.id) && !condensed.has(t.id));
    const lines = new Map(); let lineUnits = 0;
    const count = earlier.length + unread;
    const bodyUnits = () => lineUnits + Math.max(0, lines.size - 1) + (count > lines.size ? (lines.size ? 1 : 0) + units(marker(count - lines.size)) : 0);
    const body = () => [...earlier.filter((t) => lines.has(t.id)).map((t) => lines.get(t.id)), ...(count > lines.size ? [marker(count - lines.size)] : [])].join('\n');
    if (count) {
      set('earlier', body());
      for (const turn of (earlier.length ? [earlier[0], ...earlier.slice(1).reverse()] : [])) {
        const line = condensedTurn(turn, { redact }), n = units(line);
        lines.set(turn.id, line); lineUnits += n;
        const cost = heading('earlier') + bodyUnits();
        if (cost > caps.earlier || used() - costs.get('earlier') + cost > U) { lines.delete(turn.id); lineUnits -= n; }
        else { layerUnits += cost - costs.get('earlier'); costs.set('earlier', cost); condensed.add(turn.id); }
      }
      layers.set('earlier', body());
    }
  }
  if (!turns.length && unread) set('earlier', marker(unread));
  const other = [];
  for (const chat of otherChats.slice(0, L.otherChats)) {
    const block = '### ' + cut(one(chat.title, redact), 120) + ' [' + chat.engine + ']\n' + chat.turns.slice(-L.otherTurns).map((t) => condensedTurn(t, { redact })).join('\n');
    if (!chat.turns.length) continue;
    other.push({ block, count: Math.min(chat.turns.length, L.otherTurns) }); set('other-chats', other.map((o) => o.block).join('\n\n'));
    if (costs.get('other-chats') > caps.other || used() > U) { other.pop(); if (other.length) set('other-chats', other.map((o) => o.block).join('\n\n')); else drop('other-chats'); }
  }
  if (memory) { set('memory', memory); if (used() > U) drop('memory'); }
  const sections = render(), text = joined(sections);
  const brief = [];
  if (originalNotes) brief.push('Project notes (current task wins):\n' + cut(originalNotes, caps.developerNotes));
  if (turns.length) brief.push('Earlier turns (context only):\n' + turns.slice(-caps.developerTurns).map((t) => condensedTurn(t, { redact })).join('\n'));
  const developer = cut(brief.join('\n\n').trim(), Udev).trimEnd(), omitted = turns.length + unread - detailed.size - condensed.size;
  return { text, developer, sections, meta: { turns: { total, visible: turns.length + unread, detailed: detailed.size, condensed: condensed.size, omitted },
    otherChats: { chats: other.length, turns: other.reduce((n, o) => n + o.count, 0) }, notes: { chars: notes.length, tokens: tokens(notes), cut: notesCut }, memory: { chars: layers.get('memory')?.length ?? 0, tokens: tokens(layers.get('memory')) },
    budget: { tokens: Math.ceil(U / 4), used: tokens(text) }, developer: { tokens: Math.ceil(Udev / 4), used: tokens(developer) },
    truncated: Boolean(truncated || omitted || turns.some((t) => t.reply?.truncated || units(t.reply?.text) > caps.olderReply || units(t.request) > caps.olderRequest)), degraded } };
}
export function buildPipelineContext({ turns = [], notes = '', otherChats = [], redact = defaultRedact } = {}) {
  return { notes: safeText(notes, redact).trim(), lines: turns.map((t) => ({ run_id: safeText(t.id, redact), line: condensedTurn(t, { maxChars: L.pipelineLine, redact }) })),
    other_chats: otherChats.slice(0, L.otherChats).filter((c) => c.turns.length).map((c) => ({ title: safeText(c.title, redact), engine: safeText(c.engine, redact),
      turns: c.turns.slice(-L.otherTurns).map((t) => condensedTurn(t, { maxChars: L.pipelineLine, redact })) })) };
}

function pipelineRecent(run) {
  const parse = (value) => { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; } };
  const readable = (value, max = 1000) => cut((typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'unknown').replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' '), max);
  const plan = parse(run.plan), outcome = parse(run.outcome);
  const plans = plan ? [readable(plan.summary), ...(Array.isArray(plan.steps) ? plan.steps : []).slice(0, 32).filter((s) => typeof s?.title === 'string').map((s) => '- ' + readable(s.title, 240))].join('\n') : readable(run.plan);
  const facts = outcome ? [
    outcome.failure ? `Failure: ${readable(outcome.failure.code, 120)}: ${readable(outcome.failure.message)}` : '',
    `Verified steps: ${readable(outcome.verified_step_count, 80)}`,
    `Delivery applied: ${readable(outcome.delivery_applied, 80)}`,
    ...(Array.isArray(outcome.final_checks) ? outcome.final_checks : []).slice(0, 12).map((c) => `Check ${readable(c?.id, 120)}: ${readable(c?.status, 80)}`),
    typeof outcome.assistant_reply === 'string' && outcome.assistant_reply !== 'unavailable' ? `Reply: ${readable(outcome.assistant_reply, 1500)}` : ''
  ].filter(Boolean).join('\n') : readable(run.outcome);
  return `Run ${readable(run.run_id, 128)} [${readable(run.status, 80)}]\nTask: ${readable(run.task, 4000)}\nPlan: ${plans || 'unavailable'}\nOutcome: ${facts || 'unavailable'}`;
}

export function pipelineSections(wire) {
  const c = wire?.context ?? {}, sections = [];
  for (const [id, body] of [['notes', c.notes], ['memory', wire?.project_memory?.map((m) => m.text).join('\n')], ['other-chats', c.other_chats?.map((o) => `${o.title} [${o.engine}]\n${o.turns.join('\n')}`).join('\n\n')],
    ['earlier', [...(c.earlier ?? []), ...(c.omitted ? [`... ${c.omitted} earlier turns omitted ...`] : [])].join('\n')],
    ['recent', wire?.runs?.map(pipelineRecent).join('\n\n')]]) if (body) sections.push(section(id, body, false));
  return sections;
}

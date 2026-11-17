import { redact as defaultRedact } from '../dreaming/reflection.js';
import { LIMITS as L } from './limits.js';
import { clip, relativeFile } from './turns.js';
import { maskHistoricalText } from './shared.js';

const titles = Object.freeze({ notes: 'Project notes (standing preferences; current request wins)', memory: 'Project memory (advisory historical data)', 'other-chats': 'Other chats (same project; this chat takes precedence)', earlier: 'This chat - earlier turns', recent: 'This chat - recent turns' });
export function safeText(value, redact = defaultRedact) {
  return maskHistoricalText(redact(typeof value === 'string' ? value : '').toWellFormed().replace(/\r\n?/g, '\n').replace(/<\s*\/?\s*(earlier-runs|conversation-context)\s*>/gi, '[$1]'));
}
const one = (s, redact) => safeText(s, redact).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
const cut = (s, n) => s.length > n ? clip(s, Math.max(0, n - 1)) + '…' : s;
export function condensedTurn(turn, { maxChars = L.condensed, redact = defaultRedact } = {}) {
  const files = (turn.files ?? []).map(relativeFile).filter(Boolean), shown = files.slice(0, L.condensedFiles);
  const suffix = shown.length ? `; files: ${shown.map((f) => one(f, redact)).join(', ')}${files.length > shown.length ? ` (+${files.length - shown.length} more)` : ''}` : '';
  const outcome = cut(one(turn.outcome, redact), L.condensedOutcome);
  return cut(`#${turn.index} [${one(turn.status, redact)}] ${cut(one(turn.request, redact), L.condensedRequest)}${outcome ? ` -> ${outcome}` : ''}${suffix}`.trim(), maxChars).trimEnd();
}
export function detailedTurn(turn, { latest = false, maxChars = L.team, redact = defaultRedact } = {}) {
  let request = cut(safeText(turn.request, redact), latest ? L.latestRequest : L.olderRequest);
  const heading = `### #${turn.index} [${cut(one(turn.status, redact), 80)}] ${one(turn.startedAt, redact) || 'date unknown'}`;
  const outcome = cut(one(turn.outcome, redact), L.outcome);
  const plan = (turn.plan ?? []).slice(0, L.planLines).map((p) => `- ${cut(one(p.title, redact), L.planLine)} [${cut(one(p.status, redact), 80)}]`).join('\n');
  const files = (turn.files ?? []).slice(0, L.files).map(relativeFile).filter(Boolean).map((p) => one(p, redact)).join(', ');
  const parts = [files ? cut('Files touched (not delivery proof): ' + files, latest ? L.latestFiles : L.olderFiles) : '',
    plan ? cut('Plan (historical):\n' + plan, latest ? L.latestPlan : L.olderPlan) : '',
    turn.reply?.text ? `Reply (${one(turn.reply.kind, redact)}):\n${cut(safeText(turn.reply.text, redact), latest ? L.latestReply : L.olderReply)}` : ''];
  const render = () => [heading, `Request: ${request}`, `Outcome: ${outcome}`, parts[1], parts[0], parts[2]].filter(Boolean).join('\n').trimEnd();
  for (let i = 0; i < parts.length && render().length > maxChars; i++) {
    const room = parts[i].length - (render().length - maxChars);
    parts[i] = room > 1 ? cut(parts[i], room) : '';
  }
  if (render().length > maxChars) request = cut(request, Math.max(Math.min(request.length, L.minRequest), request.length - (render().length - maxChars)));
  return render().length <= maxChars ? render() : condensedTurn(turn, { redact });
}

const section = (id, body, exact = true) => ({ id, title: titles[id], chars: (`## ${titles[id]}\n${body}`).length, text: `## ${titles[id]}\n${body}`, exact });
const joined = (sections) => sections.map((s) => s.text).join('\n\n');
export function buildTeamPack({ turns = [], total = turns.length, unread = 0, notes = '', memory = '', otherChats = [], truncated = false, degraded = false, redact = defaultRedact } = {}) {
  notes = clip(safeText(notes, redact), L.notes); if (!notes.trim()) notes = ''; memory = cut(safeText(memory, redact), L.memory).trim();
  const layers = new Map(), detailed = new Set(), condensed = new Set();
  const render = () => ['notes', 'memory', 'other-chats', 'earlier', 'recent'].filter((id) => layers.has(id)).map((id) => section(id, layers.get(id)));
  const used = () => joined(render()).length;
  const marker = (n) => `... ${n} earlier turns omitted ...`;
  if (notes) layers.set('notes', notes + '\n[End project notes]');
  if (turns.length) {
    // Reserve the omission marker before allocating detail so every visible turn remains accounted for.
    const reserve = turns.length + unread > 1 ? section('earlier', marker(turns.length + unread - 1)).text.length + 2 : 0;
    const room = L.team - used() - (layers.size ? 2 : 0) - section('recent', '').text.length - reserve;
    layers.set('recent', detailedTurn(turns.at(-1), { latest: true, maxChars: room, redact })); detailed.add(turns.at(-1).id);
    for (const turn of turns.slice(-L.recent, -1).reverse()) {
      const previous = layers.get('recent'), detail = detailedTurn(turn, { redact, maxChars: L.team - used() - reserve - 2 });
      if (!detail.startsWith('### ')) continue;
      layers.set('recent', detail + '\n\n' + previous);
      if (used() + reserve > L.team) { layers.set('recent', previous); continue; }
      detailed.add(turn.id);
    }
    const earlier = turns.filter((t) => !detailed.has(t.id));
    const lines = new Map();
    const body = () => [...earlier.filter((t) => lines.has(t.id)).map((t) => lines.get(t.id)), ...(earlier.length + unread > lines.size ? [marker(earlier.length + unread - lines.size)] : [])].join('\n');
    if (earlier.length || unread) {
      layers.set('earlier', body());
      for (const turn of (earlier.length ? [earlier[0], ...earlier.slice(1).reverse()] : [])) {
        lines.set(turn.id, condensedTurn(turn, { redact })); layers.set('earlier', body());
        if (section('earlier', layers.get('earlier')).chars > L.earlier || used() > L.team) { lines.delete(turn.id); layers.set('earlier', body()); }
        else condensed.add(turn.id);
      }
    }
  }
  if (!turns.length && unread) layers.set('earlier', marker(unread));
  const other = [];
  for (const chat of otherChats.slice(0, L.otherChats)) {
    const block = `### ${cut(one(chat.title, redact), 120)} [${chat.engine}]\n` + chat.turns.slice(-L.otherTurns).map((t) => condensedTurn(t, { redact })).join('\n');
    if (!chat.turns.length) continue;
    other.push({ block, count: Math.min(chat.turns.length, L.otherTurns) }); layers.set('other-chats', other.map((o) => o.block).join('\n\n'));
    if (section('other-chats', layers.get('other-chats')).chars > L.other || used() > L.team) { other.pop(); if (other.length) layers.set('other-chats', other.map((o) => o.block).join('\n\n')); else layers.delete('other-chats'); }
  }
  if (memory) { layers.set('memory', memory); if (used() > L.team) layers.delete('memory'); }
  const sections = render(), text = joined(sections);
  const brief = [];
  if (notes) brief.push('Project notes (current task wins):\n' + cut(notes, L.developerNotes));
  if (turns.length) brief.push('Earlier turns (context only):\n' + turns.slice(-L.developerTurns).map((t) => condensedTurn(t, { redact })).join('\n'));
  const developer = cut(brief.join('\n\n').trim(), L.developer), omitted = turns.length + unread - detailed.size - condensed.size;
  return { text, developer, sections, meta: { turns: { total, visible: turns.length + unread, detailed: detailed.size, condensed: condensed.size, omitted },
    otherChats: { chats: other.length, turns: other.reduce((n, o) => n + o.count, 0) }, notes: { chars: notes.length }, memory: { chars: layers.get('memory')?.length ?? 0 },
    budget: { limit: L.teamAccepted, used: text.length }, truncated: Boolean(truncated || omitted || turns.some((t) => t.reply?.truncated || t.reply?.text.length > L.olderReply || t.request.length > L.olderRequest)), degraded } };
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

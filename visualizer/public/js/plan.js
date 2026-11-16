// The plan of a run, as something to read: every milestone (or pipeline step) in order, with its description and
// its acceptance criteria in full. The board says where the work stands; this says what the work is.
const NATURAL = new Intl.Collator('en', { numeric: true });

const text = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

// The plan the planner wrote as its message: JSON ({ milestones: [...] }), usually in a fenced block and followed
// by its keyword. null: the text is something else, and is shown as it is. No DOM here: the adapters use it.
export function parsePlanText(raw) {
  const body = text(raw).trim().replace(/\n?\[[A-Z][A-Z_]*\]$/, '').trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (!body.startsWith('{')) return null;
  let doc;
  try { doc = JSON.parse(body); } catch { return null; }
  const items = Array.isArray(doc?.milestones) ? doc.milestones : null;
  if (!items?.length || !items.every((m) => m && typeof m === 'object' && text(m.id) && text(m.title))) return null;
  return items.map((m) => ({
    id: m.id, title: m.title, description: text(m.description), criteria: list(m.acceptanceCriteria),
    dependsOn: list(m.dependsOn), state: '', column: '',
  }));
}

// The plan of the run on screen, from the cards of its board (activity-model.js), in the order of their ids.
export function planOf(board) {
  const cards = (board?.columns ?? []).flatMap((c) => c.cards.map((card) => ({ ...card, column: c.id })));
  return cards.sort((a, b) => NATURAL.compare(a.id, b.id)).map((c) => ({
    id: c.id, title: c.title, description: text(c.description), criteria: list(c.criteria),
    dependsOn: [], note: text(c.note), state: text(c.state), column: c.column,
  }));
}

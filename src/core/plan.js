import { oneLine } from './util.js';

export const MAX_MILESTONES = 7;

const FENCE = /```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;

/**
 * Parse the Planner's answer: the LAST json fence that holds a valid `{ milestones: [...] }` wins.
 * Returns `{ milestones }` with ids normalised to m1..mN, or `{ error }`.
 */
export function parsePlan(text) {
  let lastError = 'no ```json block with a "milestones" array found';
  let plan = null;
  for (const match of String(text ?? '').matchAll(FENCE)) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch (err) {
      lastError = `invalid JSON in plan block: ${err.message}`;
      continue;
    }
    const result = validatePlan(data);
    if (result.error) lastError = result.error;
    else plan = result;
  }
  return plan ?? { error: lastError };
}

export function validatePlan(data) {
  const list = Array.isArray(data) ? data : data?.milestones;
  if (!Array.isArray(list) || list.length === 0) return { error: 'plan has no milestones' };
  if (list.length > MAX_MILESTONES) return { error: `plan has ${list.length} milestones (max ${MAX_MILESTONES})` };
  const milestones = [];
  for (const [i, raw] of list.entries()) {
    const title = oneLine(raw?.title);
    if (!title) return { error: `milestone ${i + 1} has no title` };
    const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : title;
    const criteria = Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria.map((c) => oneLine(c)).filter(Boolean)
      : [];
    const dependsOn = raw.dependsOn === undefined ? (i ? [`m${i}`] : []) : raw.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string') || new Set(dependsOn).size !== dependsOn.length) return { error: `milestone ${i + 1} has invalid dependsOn` };
    milestones.push({ id: `m${i + 1}`, title: title.slice(0, 120), description, acceptanceCriteria: criteria, dependsOn });
  }
  const visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error('plan has cyclic dependencies');
    if (visited.has(id)) return;
    const m = milestones.find((m) => m.id === id);
    if (!m) throw new Error(`unknown prerequisite ${id}`);
    visiting.add(id);
    for (const dep of m.dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  try { for (const m of milestones) visit(m.id); } catch (err) { return { error: err.message }; }
  return { milestones };
}

/** One milestone covering the whole request (used for --no-plan and when planning fails). */
export function fallbackPlan(request) {
  const text = String(request).trim();
  return {
    milestones: [
      {
        id: 'm1',
        dependsOn: [],
        title: oneLine(text).slice(0, 80) || 'Complete the request',
        description: text,
        acceptanceCriteria: ['The request is fully implemented and works as described.', 'Automated tests exist and pass.']
      }
    ]
  };
}

export function planToMarkdown(request, plan) {
  const lines = ['# Plan', '', `Request: ${oneLine(request)}`, ''];
  for (const m of plan.milestones) {
    lines.push(`## ${m.id}: ${m.title}`, '', m.description, '', `Depends on: ${(m.dependsOn ?? []).join(', ') || '(independent)'}`, '');
    if (m.acceptanceCriteria.length) {
      lines.push('Acceptance criteria:', ...m.acceptanceCriteria.map((c) => `- ${c}`), '');
    }
  }
  return lines.join('\n');
}

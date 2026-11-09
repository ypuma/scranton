// Pure logic of the Agents drawer (.enma/roles-contract.md section 4, .enma/custom-agents-contract.md sections 2
// and 6): the roles document, what a row says, the prompt, settings and new-agent requests and their checks.
// No DOM, so Node can test it. Prompt text only ever lives in the open editor and the request body.
import { stripBidi } from './format.js';
import { AGENT_IDS, GATE_ROLES, ROLE_TITLES, ROLE_ID_RE, displayName } from './state.js';
import { modelKey, parseModelKey } from './accounts.js';

export const AGENTS_URL = '/api/agents';
// the server's limit, in UTF-8 bytes of the text as sent
export const PROMPT_MAX_BYTES = 32768;
export const PROMPT_SOURCES = ['builtin', 'custom', 'config'];
export const SOURCE_LABEL = { builtin: 'Built-in', custom: 'Custom', config: 'Set by config' };
// A probe without a definitive answer (network error, 5xx) is asked again, doubling up to the cap.
export const PROBE_RETRY_MS = 2000;
export const PROBE_RETRY_MAX_MS = 30000;

// custom gate agents (custom-agents contract section 2)
export const TOOLS = ['read', 'grep', 'find', 'ls', 'bash'];
// src/core/config.js THINKING_LEVELS, for a server that does not report its own list
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const CUSTOM_MAX = 12;
export const NAME_MAX = 40;
export const TITLE_MAX = 60;
export const INSTRUCTION_MAX = 1000;
export const RESERVED_IDS = [
  'human', 'runs', 'sessions', 'prompts', 'isolation', 'control', 'events', 'state', 'plan', 'run', 'orchestrator', 'system', 'default',
  'agents', 'models', 'auth', 'providers', 'hitl', 'chat', 'michael', 'dwight', 'oscar', 'hank', 'angela',
];
// src/core/agents-config.js refuses these for every id: Windows cannot name a file after them
export const DEVICE_ID_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
export const BUILTIN_KEYWORDS = [
  'PLAN_READY', 'TASK_COMPLETE', 'REVIEW_APPROVED', 'CHANGES_REQUESTED', 'SECURITY_PASSED', 'SECURITY_ISSUES', 'TEST_PASSED', 'TEST_FAILED',
];
export const KIND_LABEL = { planner: 'Planner', developer: 'Developer', gate: 'Gate' };
// where a model or thinking level comes from, as a row says it
export const SETTING_SOURCE_LABEL = { settings: 'set here', config: 'scranton.config.json', env: 'environment' };
const SETTING_SOURCES = ['settings', 'config', 'env', 'none'];
const KEYWORD_NEW_RE = /^[A-Z][A-Z0-9_]{2,39}$/;

export function probeDelay(attempt) {
  return Math.min(PROBE_RETRY_MAX_MS, PROBE_RETRY_MS * 2 ** Math.max(0, Math.min(attempt, 20)));
}

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const KEYWORD_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const str = (v) => (typeof v === 'string' ? stripBidi(v) : '');
// the prompt is edited as it is stored: bidi controls in it are the author's, not something to hide
const raw = (v) => (typeof v === 'string' ? v : '');
const whose = (role) => (role?.name ? `${role.name}'s prompt` : 'This prompt');
const list = (v, re) => [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && re.test(x)))];
// a textarea turns CRLF into LF, so line endings alone are no change
const lines = (t) => raw(t).replace(/\r\n?/g, '\n');

// { value, source, pinned } of a model or thinking level; config and env always pin
function setting(v, value) {
  const o = v && typeof v === 'object' ? v : {};
  const source = SETTING_SOURCES.includes(o.source) ? o.source : 'none';
  return { value: value(o.value), source, pinned: o.pinned === true || source === 'config' || source === 'env' };
}
const modelValue = (v) => (v && typeof v.provider === 'string' && v.provider && typeof v.model === 'string' && v.model ? { provider: v.provider, model: v.model } : null);
const thinkingValue = (v) => (typeof v === 'string' && /^[a-z]{1,16}$/.test(v) ? v : null);

function parseRole(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const p = r.prompt && typeof r.prompt === 'object' ? r.prompt : {};
  const source = PROMPT_SOURCES.includes(p.source) ? p.source : 'builtin';
  const builtin = typeof r.builtin === 'boolean' ? r.builtin : AGENT_IDS.includes(r.id);
  const gate = r.gate === true;
  return {
    id: r.id,
    name: str(r.name) || displayName(r.id),
    title: str(r.title) || ROLE_TITLES[r.id] || '',
    kind: Object.hasOwn(KIND_LABEL, r.kind) ? r.kind : gate ? 'gate' : r.id === 'michael' ? 'planner' : r.id === 'dwight' ? 'developer' : null,
    builtin,
    keywords: list(r.keywords, KEYWORD_RE),
    passKeyword: KEYWORD_RE.test(raw(r.passKeyword)) ? r.passKeyword : null,
    failKeyword: KEYWORD_RE.test(raw(r.failKeyword)) ? r.failKeyword : null,
    tools: list(r.tools, /^[a-z][a-z0-9_-]{0,31}$/),
    gate,
    instruction: raw(r.instruction),
    defaultInstruction: typeof r.defaultInstruction === 'string' ? r.defaultInstruction : null,
    model: setting(r.model, modelValue),
    thinking: setting(r.thinking, thinkingValue),
    prompt: {
      source,
      text: raw(p.text),
      // a pinned prompt is never offered for editing, whatever the flag says
      editable: source !== 'config' && p.editable !== false,
      builtinText: raw(p.builtinText),
      missingKeywords: list(p.missingKeywords, KEYWORD_RE),
    },
  };
}

// GET /api/agents -> { roles (built-ins in contract order, then the custom agents as the server lists them),
// defaultGates, warnings, thinkingLevels (null when not reported) } or null when it is not a roles document
export function parseAgents(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.roles)) return null;
  const seen = new Set();
  const roles = doc.roles.map(parseRole).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
  const rank = (id) => (AGENT_IDS.includes(id) ? AGENT_IDS.indexOf(id) : AGENT_IDS.length);
  roles.sort((a, b) => rank(a.id) - rank(b.id));
  const d = doc.workflow?.default;
  const defaultGates = Array.isArray(d) && d.every((s) => Array.isArray(s) && s.every((x) => typeof x === 'string')) ? d.map((s) => [...s]) : null;
  const warnings = (Array.isArray(doc.warnings) ? doc.warnings : []).filter((w) => typeof w === 'string' && w.trim()).slice(0, 20).map((w) => stripBidi(w).trim());
  const levels = list(doc.thinkingLevels, /^[a-z]{1,16}$/);
  return { roles, defaultGates, warnings, thinkingLevels: levels.length ? levels : null };
}

export function promptUrl(id) {
  return ID_RE.test(id ?? '') ? `${AGENTS_URL}/${encodeURIComponent(id)}/prompt` : null;
}

export function agentUrl(id) {
  return ID_RE.test(id ?? '') ? `${AGENTS_URL}/${encodeURIComponent(id)}` : null;
}

export function utf8Bytes(text) {
  return new TextEncoder().encode(raw(text)).length;
}

// The bracketed keywords a prompt never mentions. The handoff needs them; a prompt without one is allowed
// (the server only warns too), so this is advice.
export function missingKeywords(text, keywords) {
  const t = raw(text);
  return (keywords ?? []).filter((k) => !t.includes(`[${k}]`));
}

export function missingNote(missing) {
  if (!missing?.length) return '';
  const names = missing.map((k) => `[${k}]`);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `This prompt never mentions ${joined}. The agent's final answer needs ${missing.length > 1 ? 'these keywords' : 'this keyword'} for the handoff, so the run may stall without ${missing.length > 1 ? 'them' : 'it'}.`;
}

// "openai/gpt-a (set here) · thinking high", or "pi default"
export function modelSummary(r) {
  const m = r.model.value;
  const src = SETTING_SOURCE_LABEL[r.model.source];
  const model = m ? `${stripBidi(m.provider)}/${stripBidi(m.model)}${src ? ` (${src})` : ''}` : 'pi default';
  const t = r.thinking.value;
  return t ? `${model} · thinking ${t}` : model;
}

// What one row says. -> { source, sourceTone, kind, model, tools, action, note }
export function roleView(r) {
  const pinned = r.prompt.source === 'config';
  // a custom agent without a prompt file of its own runs on the starter made from its definition
  const starter = !r.builtin && r.prompt.source === 'builtin';
  return {
    source: starter ? 'Starter' : SOURCE_LABEL[r.prompt.source],
    sourceTone: r.prompt.source === 'custom' ? 'on' : 'quiet',
    // the kind once: a title that already says it ("Planner") needs no second word for it
    kind: [r.title.toLowerCase() === KIND_LABEL[r.kind]?.toLowerCase() ? null : KIND_LABEL[r.kind], r.builtin === false && 'custom'].filter(Boolean).join(' · '),
    model: modelSummary(r),
    tools: r.tools.join(' · '),
    action: r.prompt.editable ? 'Edit prompt' : 'View prompt',
    note: pinned
      ? `Set by agents.${r.id}.skill in scranton.config.json, so it is read only here. Change or remove that entry to edit it.`
      : r.prompt.editable ? '' : 'The server does not allow changes to this prompt.',
  };
}

// PUT /api/agents/:id/prompt -> { body } or { error }
export function buildPrompt(text, role) {
  if (!role?.prompt.editable) return { error: `${whose(role)} is read only here.` };
  const t = raw(text);
  if (!t.trim()) return { error: 'The prompt is empty. Write one, or reset it to the built-in prompt.' };
  const bytes = utf8Bytes(t);
  if (bytes > PROMPT_MAX_BYTES) return { error: `The prompt is ${bytes} bytes; the limit is ${PROMPT_MAX_BYTES}.` };
  return { body: { text: t } };
}

// The editor holds something the server does not have.
export function isDirty(role, draft) {
  return Boolean(role) && role.prompt.editable && lines(draft) !== lines(role.prompt.text);
}

export function resetConfirm(role) {
  const starter = role.builtin === false;
  return {
    title: `Reset ${role.name}'s prompt?`,
    detail: `Deletes the custom prompt on this computer, so runs started from now on use the ${starter ? 'starter' : 'built-in'} prompt for ${role.name}. A run in progress keeps the prompt it started with.`,
    ok: starter ? 'Reset to starter' : 'Reset to built-in',
  };
}

export function discardConfirm(role) {
  return {
    title: `Discard changes to ${role.name}'s prompt?`,
    detail: 'The edits in the editor were not saved. Nothing on the server changes.',
    ok: 'Discard changes',
  };
}

export function discardSettingsConfirm(role) {
  return {
    title: role ? `Discard changes to ${role.name}'s settings?` : 'Discard the new agent?',
    detail: role ? 'The changes in the form were not saved. Nothing on the server changes.' : 'The agent was not created. Nothing on the server changes.',
    ok: 'Discard changes',
  };
}

export function deleteConfirm(role) {
  return {
    title: `Delete ${role.name}?`,
    detail: `Removes ${role.name} and its prompt from this computer. A run in progress keeps using it until it ends; a workflow that names ${role.id} can no longer start.`,
    ok: 'Delete agent',
  };
}

// Error text for a failed prompt request.
export function promptError(status, message, role) {
  if (status === 409) return `${whose(role)} is set by scranton.config.json and cannot be changed here.`;
  if (status === 413) return `The prompt is larger than the server accepts (${PROMPT_MAX_BYTES} bytes).`;
  return message || `The prompt could not be saved (HTTP ${status}).`;
}

// ------------------------------------------------------------ custom agents

export const customCount = (roles) => (roles ?? []).filter((r) => !r.builtin).length;

// The keywords a new agent gets when none are typed: SECLINT_PASSED / SECLINT_FAILED.
export function defaultKeywords(id) {
  const u = ROLE_ID_RE.test(raw(id).trim()) ? raw(id).trim().toUpperCase() : '<ID>';
  return { pass: `${u}_PASSED`, fail: `${u}_FAILED` };
}

// What is wrong with an id typed for a new agent, or '' (roles: the agents there are).
export function idProblem(id, roles = []) {
  const v = raw(id).trim();
  if (!v) return 'Give the agent an id.';
  if (!ROLE_ID_RE.test(v)) return 'The id is 2-20 characters: a lowercase letter, then lowercase letters or digits (no dashes).';
  if (DEVICE_ID_RE.test(v)) return `${v} is a Windows device name. Pick another id.`;
  if (RESERVED_IDS.includes(v)) return `${v} is reserved. Pick another id.`;
  if (roles.some((r) => r.id === v)) return `There is an agent with the id ${v} already.`;
  return '';
}

// pass/fail: the keywords the agent will have (typed or default). -> { error, field } or null
export function keywordProblem(pass, fail, { roles = [], self = null } = {}) {
  const taken = new Set(roles.filter((r) => r.id !== self).flatMap((r) => [...r.keywords, r.passKeyword, r.failKeyword]).filter(Boolean));
  for (const [field, k, what] of [['passKeyword', pass, 'pass'], ['failKeyword', fail, 'fail']]) {
    if (!KEYWORD_NEW_RE.test(k)) {
      return { error: `The ${what} keyword is 3-40 characters: an uppercase letter, then uppercase letters, digits or underscores.`, field };
    }
    if (k === 'BLOCKED') return { error: `BLOCKED is the answer of every gate, so it cannot be the ${what} keyword.`, field };
    if (BUILTIN_KEYWORDS.includes(k)) return { error: `${k} belongs to a built-in agent. Pick another ${what} keyword.`, field };
    if (taken.has(k)) return { error: `${k} is used by another agent. Pick another ${what} keyword.`, field };
  }
  if (pass === fail) return { error: 'The pass and fail keywords must differ.', field: 'failKeyword' };
  return null;
}

function textField(v, field, what, max) {
  const t = raw(v).trim();
  if (!t) return { error: `Give the agent a ${what}.`, field };
  if (t.length > max) return { error: `The ${what} has at most ${max} characters.`, field };
  return { value: t };
}

function instructionField(v) {
  const t = lines(v).trim();
  if (!t) return { error: 'Write the handoff instruction: what this agent checks in Dwight\'s work.', field: 'instruction' };
  if (t.length > INSTRUCTION_MAX) return { error: `The handoff instruction is ${t.length} characters; the limit is ${INSTRUCTION_MAX}.`, field: 'instruction' };
  return { value: t };
}

// The tool boxes of a custom agent. On Windows without bash the server reports bash as powershell (section 11.7);
// it is the bash box here, and only ever sent as bash.
export function formTools(r) {
  return TOOLS.filter((t) => r.tools.includes(t) || (t === 'bash' && r.tools.includes('powershell')));
}

function toolsField(v) {
  const tools = TOOLS.filter((t) => (v ?? []).includes(t));
  return tools.length ? { value: tools } : { error: 'Give the agent at least one tool.', field: 'tools' };
}

// The new-agent form -> POST /api/agents { body } or { error, field }.
// f = { id, name, title, passKeyword, failKeyword, instruction, tools: [names], model: select value, thinking }
export function buildNewAgent(f = {}, roles = [], levels = THINKING_LEVELS) {
  if (customCount(roles) >= CUSTOM_MAX) return { error: `There are ${CUSTOM_MAX} custom agents, the most there can be. Delete one to add another.`, field: null };
  const id = raw(f.id).trim();
  const bad = idProblem(id, roles);
  if (bad) return { error: bad, field: 'id' };
  const name = textField(f.name, 'name', 'name', NAME_MAX);
  if (name.error) return name;
  const title = textField(f.title, 'title', 'title', TITLE_MAX);
  if (title.error) return title;
  const typedPass = raw(f.passKeyword).trim();
  const typedFail = raw(f.failKeyword).trim();
  const def = defaultKeywords(id);
  const kw = keywordProblem(typedPass || def.pass, typedFail || def.fail, { roles });
  if (kw) return kw;
  const instruction = instructionField(f.instruction);
  if (instruction.error) return instruction;
  const tools = toolsField(f.tools);
  if (tools.error) return tools;
  const body = { id, name: name.value, title: title.value, instruction: instruction.value, tools: tools.value };
  if (typedPass) body.passKeyword = typedPass;
  if (typedFail) body.failKeyword = typedFail;
  const model = parseModelKey(f.model);
  if (model) body.model = model;
  if (f.thinking && levels.includes(f.thinking)) body.thinking = f.thinking;
  return { body };
}

// The select value of a role's model ('' = pi default).
export function modelValueKey(r) {
  const m = r?.model.value;
  return m ? modelKey(m.provider, m.model) : '';
}

// The instruction a gate's form starts with: its own, or the default it runs with.
export function instructionText(r) {
  return r.instruction || r.defaultInstruction || '';
}

// A built-in gate's instruction can go back to its default once the draft differs from it.
export function canResetInstruction(r, draft) {
  return Boolean(r?.builtin && GATE_ROLES.includes(r.id) && r.defaultInstruction !== null && lines(draft).trim() !== lines(r.defaultInstruction).trim());
}

// The settings form -> PATCH /api/agents/:id { body } (only what changed; empty when nothing did) or { error, field }.
// f = { model, thinking, instruction, name, title, passKeyword, failKeyword, tools } as the form holds them.
// A field pinned by scranton.config.json or the environment is never sent.
export function buildAgentPatch(f = {}, r, roles = [], levels = THINKING_LEVELS) {
  const body = {};
  if (!r.builtin) {
    const name = textField(f.name, 'name', 'name', NAME_MAX);
    if (name.error) return name;
    if (name.value !== r.name) body.name = name.value;
    const title = textField(f.title, 'title', 'title', TITLE_MAX);
    if (title.error) return title;
    if (title.value !== r.title) body.title = title.value;
    const def = defaultKeywords(r.id);
    const pass = raw(f.passKeyword).trim() || r.passKeyword || def.pass;
    const fail = raw(f.failKeyword).trim() || r.failKeyword || def.fail;
    if (pass !== r.passKeyword || fail !== r.failKeyword) {
      const kw = keywordProblem(pass, fail, { roles, self: r.id });
      if (kw) return kw;
      if (pass !== r.passKeyword) body.passKeyword = pass;
      if (fail !== r.failKeyword) body.failKeyword = fail;
    }
    const tools = toolsField(f.tools);
    if (tools.error) return tools;
    if (tools.value.join() !== formTools(r).join()) body.tools = tools.value;
  }
  if (!r.model.pinned && raw(f.model) !== modelValueKey(r)) {
    const m = parseModelKey(f.model);
    if (f.model && !m) return { error: 'That model cannot be picked. Pick another one or pi default.', field: 'model' };
    body.model = m;
  }
  if (!r.thinking.pinned && raw(f.thinking) !== (r.thinking.value ?? '')) {
    if (f.thinking && !levels.includes(f.thinking)) return { error: `The thinking level is one of ${levels.join(', ')}.`, field: 'thinking' };
    body.thinking = f.thinking || null;
  }
  if (r.gate && lines(f.instruction).trim() !== lines(instructionText(r)).trim()) {
    const builtinGate = r.builtin && r.defaultInstruction !== null;
    if (builtinGate && lines(f.instruction).trim() === lines(r.defaultInstruction).trim()) {
      body.instruction = null;
    } else {
      const ins = instructionField(f.instruction);
      if (ins.error) return builtinGate ? { ...ins, error: `${ins.error} Or reset it to the default.` } : ins;
      body.instruction = ins.value;
    }
  }
  return { body };
}

const FIELD_WORDS = [
  ['passKeyword', /\bpass ?keyword\b/i], ['failKeyword', /\bfail ?keyword\b/i], ['instruction', /\binstruction\b/i], ['tools', /\btools?\b/i],
  ['thinking', /\bthinking\b/i], ['model', /\bmodel\b/i], ['title', /\btitle\b/i], ['name', /\bname\b/i], ['id', /\bid\b/i],
];

// Which form field a server message is about ("passKeyword collides with ..." -> 'passKeyword'), or null.
// fields: the fields the form has.
export function agentErrorField(message, fields) {
  const t = typeof message === 'string' ? message : '';
  return FIELD_WORDS.find(([f, re]) => fields.includes(f) && re.test(t))?.[0] ?? null;
}

// Error text for a failed settings, create or delete request.
export function agentError(status, message, role = null) {
  if (status === 404) return `${role ? role.name : 'This agent'} is no longer on the server. Close and open the drawer to see the agents there are.`;
  if (status === 409 && !message) return role ? 'That setting is set by scranton.config.json or the environment, so it cannot be changed here.' : `There is an agent with that id already, or there are ${CUSTOM_MAX} custom agents.`;
  return message || `The request failed (HTTP ${status}).`;
}

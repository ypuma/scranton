import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AGENT_IDS } from './state.js';
import { KEYWORDS } from './keywords.js';
import { THINKING_LEVELS } from './config.js';
import { writeFileAtomicSync } from './util.js';
import { ROLE_NAMES, ROLE_TITLES, roleInSentence } from './workflow.js';

const reports = `${roleInSentence('dwight', ROLE_NAMES.dwight, true)} reports the milestone as complete.`;
export const GATE_INSTRUCTIONS = {
  oscar: `${reports} Review the changes for correctness, edge cases, error handling, regressions, maintainability, and test coverage; do not create or modify files in the project.`,
  hank: `${reports} Audit the changes for security vulnerabilities, including input validation, authorization, secret exposure, injection, and unsafe file or process operations; do not create or modify files in the project.`,
  angela: `${reports} Verify every acceptance criterion independently; do not create or modify files in the project.`
};
export const BUILTIN_ROLES = AGENT_IDS.map((id, i) => ({ id, name: ROLE_NAMES[id], title: ROLE_TITLES[id], kind: i === 0 ? 'planner' : i === 1 ? 'developer' : 'gate', builtin: true, keywords: KEYWORDS[id], ...(i > 1 ? { passKeyword: KEYWORDS[id][0], failKeyword: KEYWORDS[id][1], instruction: GATE_INSTRUCTIONS[id] } : {}) }));
const reserved = new Set([...AGENT_IDS, ...'human runs sessions prompts isolation control events state plan run orchestrator system default agents models auth providers hitl chat'.split(' ')]);
const device = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export function validateAgentId(id, custom = false) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9]{1,19}$/.test(id) || device.test(id) || (custom && reserved.has(id))) fail(400, 'Invalid or reserved agent ID');
  return id;
}
function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) fail(400, `Invalid ${label}`);
  const clean = (label === 'instruction' ? value.replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, '') : value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '')).trim();
  if (!clean) fail(400, `Invalid ${label}`);
  return clean;
}
function validateEntry(id, input, entries) {
  validateAgentId(id, !AGENT_IDS.includes(id));
  if (!object(input)) fail(400, 'Expected agent object');
  if (Object.hasOwn(input, 'extraArgs')) fail(400, `agents.${id}.extraArgs is no longer supported; remove Pi CLI arguments and configure tools/provider/model directly.`);
  const builtin = AGENT_IDS.includes(id);
  const allowed = builtin ? ['model', 'thinking', ...(GATE_INSTRUCTIONS[id] ? ['instruction'] : [])] : ['id', 'name', 'title', 'passKeyword', 'failKeyword', 'tools', 'instruction', 'model', 'thinking'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail(400, 'Unexpected or immutable agent field');
  const out = {};
  if (!builtin) {
    if (input.id !== undefined && input.id !== id) fail(400, 'Agent ID mismatch');
    out.id = id;
    out.name = text(input.name, 40, 'name'); out.title = text(input.title, 60, 'title');
    const used = new Set(['BLOCKED', ...Object.values(KEYWORDS).flat(), ...Object.entries(entries).filter(([key]) => key !== id).flatMap(([, a]) => [a.passKeyword, a.failKeyword])]);
    for (const [field, suffix] of [['passKeyword', 'PASSED'], ['failKeyword', 'FAILED']]) {
      const keyword = input[field] ?? `${id.toUpperCase()}_${suffix}`;
      if (typeof keyword !== 'string' || !/^[A-Z][A-Z0-9_]{2,39}$/.test(keyword) || used.has(keyword)) fail(400, `Invalid or colliding ${field}`);
      out[field] = keyword; used.add(keyword);
    }
    const tools = input.tools ?? ['read', 'grep', 'find', 'ls', 'bash'];
    if (!Array.isArray(tools) || !tools.length || tools.some((t) => !['read', 'grep', 'find', 'ls', 'bash'].includes(t))) fail(400, 'Invalid read-only tools');
    out.tools = [...new Set(tools)];
  }
  if (input.instruction != null) out.instruction = text(input.instruction, 1000, 'instruction');
  else if (!builtin) fail(400, 'Custom agents require an instruction');
  if (input.model != null) {
    if (!object(input.model) || Object.keys(input.model).some((k) => !['provider', 'model'].includes(k))) fail(400, 'Invalid model');
    out.model = { provider: text(input.model.provider, 256, 'provider'), model: text(input.model.model, 256, 'model') };
    if (/\s/.test(out.model.provider + out.model.model)) fail(400, 'Invalid model identifiers');
  } else out.model = null;
  if (input.thinking != null && !THINKING_LEVELS.includes(input.thinking)) fail(400, 'Invalid thinking level');
  out.thinking = input.thinking ?? null;
  return out;
}
export function loadAgentsConfig(settingsDir) {
  const file = path.join(settingsDir, 'agents.json'), agents = {}, warnings = [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') warnings.push('agents.json could not be read or parsed; no settings loaded'); return { v: 1, agents, warnings }; }
  if (!object(data) || data.v !== 1 || !object(data.agents)) return { v: 1, agents, warnings: ['agents.json has an invalid schema; no settings loaded'] };
  let customCount = 0;
  for (const [id, value] of Object.entries(data.agents)) {
    try {
      if (!AGENT_IDS.includes(id) && customCount >= 12) fail(409, 'At most 12 custom agents are allowed');
      const entry = validateEntry(id, value, agents);
      Object.defineProperty(agents, id, { value: entry, enumerable: true, configurable: true, writable: true });
      if (!AGENT_IDS.includes(id)) customCount++;
    } catch (err) { warnings.push(`agents.json: skipped ${JSON.stringify(id)}: ${err.message}`); }
  }
  return { v: 1, agents, warnings };
}
export function saveAgent(config, id, patch, { create = false } = {}) {
  validateAgentId(id, create);
  const store = loadAgentsConfig(config.settingsDir), builtin = AGENT_IDS.includes(id);
  if (create && (builtin || Object.hasOwn(store.agents, id))) fail(409, 'Agent already exists');
  if (!create && !builtin && !Object.hasOwn(store.agents, id)) fail(404, 'Unknown agent');
  if (!object(patch)) fail(400, 'Expected agent object');
  if (!create && Object.hasOwn(patch, 'id')) fail(400, 'Agent ID is immutable');
  const candidate = { ...(store.agents[id] ?? {}), ...patch };
  const entry = validateEntry(id, candidate, store.agents);
  if (create && Object.keys(store.agents).filter((key) => !AGENT_IDS.includes(key)).length >= 12) fail(409, 'At most 12 custom agents are allowed');
  for (const field of ['model', 'thinking']) if (Object.hasOwn(patch, field) && config.agents[id]?.[`${field}Setting`]?.pinned) fail(409, `${field} is pinned by configuration`);
  store.agents[id] = entry;
  writeFileAtomicSync(path.join(config.settingsDir, 'agents.json'), JSON.stringify({ v: 1, agents: store.agents }, null, 2) + '\n');
  return entry;
}
export function deleteAgent(config, id) {
  validateAgentId(id);
  if (AGENT_IDS.includes(id)) fail(400, 'Built-in agents cannot be deleted');
  const store = loadAgentsConfig(config.settingsDir);
  if (!Object.hasOwn(store.agents, id)) fail(404, 'Unknown agent');
  delete store.agents[id];
  writeFileAtomicSync(path.join(config.settingsDir, 'agents.json'), JSON.stringify({ v: 1, agents: store.agents }, null, 2) + '\n');
  fs.rmSync(path.join(config.promptsDir, `${id}.md`), { force: true });
}
export function roleDefinitions(store) {
  return [...BUILTIN_ROLES.map((r) => ({ ...r, ...(store.agents[r.id]?.instruction ? { instruction: store.agents[r.id].instruction } : {}) })), ...Object.entries(store.agents).filter(([id]) => !AGENT_IDS.includes(id)).map(([id, a]) => ({ id, name: a.name, title: a.title, kind: 'gate', builtin: false, passKeyword: a.passKeyword, failKeyword: a.failKeyword, keywords: [a.passKeyword, a.failKeyword, 'BLOCKED'], instruction: a.instruction, tools: a.tools }))];
}
export function auditRole(role) {
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  const { instruction, tools, ...publicRole } = role;
  return { ...publicRole, definitionHash: createHash('sha256').update(JSON.stringify(canonical(role))).digest('hex') };
}

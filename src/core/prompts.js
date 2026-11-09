import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigError } from './config.js';
import { AGENT_IDS } from './state.js';
import { BUILTIN_ROLES, GATE_INSTRUCTIONS, validateAgentId } from './agents-config.js';
import { ROLE_NAMES, GATE_ROLES } from './workflow.js';
import { writeFileAtomicSync } from './util.js';
const clean = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
export function resolvePrompt(config, id) {
  validateAgentId(id);
  const agent = config.agents[id];
  if (!agent) throw Object.assign(Error(`Unknown agent: ${id}`), { status: 404 });
  const role = (config.roles ?? BUILTIN_ROLES).find((r) => r.id === id);
  const custom = path.join(config.promptsDir ?? path.join(config.hiveDir, 'prompts'), `${id}.md`);
  const builtinText = role.builtin ? clean(fs.readFileSync(new URL(`../../agents/${id}/SKILL.md`, import.meta.url), 'utf8')) : starterPrompt(role);
  const pinned = agent.skillSource === 'config';
  const source = pinned ? 'config' : fs.existsSync(custom) ? 'custom' : 'builtin';
  const file = source === 'custom' ? custom : agent.skill;
  let text;
  try { text = !role.builtin && source === 'builtin' ? builtinText : clean(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new ConfigError(`Cannot read ${id} prompt at ${file}: ${error.message}`); }
  return { source, text, editable: !pinned, builtinText, missingKeywords: role.keywords.filter((k) => !text.includes(`[${k}]`)) };
}
export function promptAudit(config, snapshot = null) {
  return Object.fromEntries((snapshot ? Object.keys(snapshot) : Object.keys(config.agents)).map((id) => { const { source, text } = snapshot?.[id] ?? resolvePrompt(config, id); return [id, { source, sha256: createHash('sha256').update(text).digest('hex') }]; }));
}
export function stagePrompt(config, hive, id, instanceId = id, prompt = null) {
  const file = path.join(hive.dir, instanceId, 'system.md');
  writeFileAtomicSync(file, (prompt ?? resolvePrompt(config, id)).text + '\n');
  return file;
}
export function starterPrompt(role) {
  return [`# ${role.name} — ${role.title}`, '',
    'You are a read-only verification gate. Follow current handoff instructions over change-discovery guidance here.',
    'Never create, edit or delete project files. Commands may inspect and test; do not use them to modify project files.',
    `Allowed tools: ${role.tools.join(', ')}.`, '', role.instruction, '',
    `Use [${role.passKeyword}] only when every required check is evidenced, [${role.failKeyword}] for findings, or [BLOCKED] when verification cannot be completed.`,
    'Missing evidence is not approval. Independently verify the work.', '',
    '## Required report', '', '### Scope', '<what you inspected>', '', '### Evidence', '<commands and observed results>', '',
    '### Findings', '<blocking and non-blocking findings with locations>', '', '### Verdict', '<reason for verdict>', '',
    'End with exactly one applicable keyword in brackets alone on the last line. The skeleton intentionally contains no verdict.'
  ].join('\n');
}
export function agentCatalog(config) {
  return { roles: (config.roles ?? BUILTIN_ROLES).map((role) => ({ ...role, gate: role.kind === 'gate', tools: config.agents[role.id].tools, instruction: role.instruction ?? null, ...(GATE_INSTRUCTIONS[role.id] ? { defaultInstruction: GATE_INSTRUCTIONS[role.id] } : {}), model: config.agents[role.id].modelSetting, thinking: config.agents[role.id].thinkingSetting, prompt: resolvePrompt(config, role.id) })), workflow: { default: [['oscar', 'hank'], ['angela']] }, warnings: config.agentWarnings ?? [] };
}

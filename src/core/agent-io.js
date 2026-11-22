import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './config.js';
import { clip, oneLine, writeFileAtomicSync } from './util.js';

/** Write the role prompt (SKILL.md without its frontmatter) for the agent runtime. */
export function writeSystemPrompt(hive, agentId, skillFile) {
  let raw;
  try {
    raw = fs.readFileSync(skillFile, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read the ${agentId} skill file ${skillFile}: ${err.message}`);
  }
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const file = path.join(hive.dir, agentId, 'system.md');
  writeFileAtomicSync(file, `${body}\n`);
  return file;
}

const firstString = (args, keys) => keys.map((k) => args?.[k]).find((v) => typeof v === 'string' && v) ?? '';

/** Human-readable `{ activity, detail }` for a tool call. */
export function describeTool(tool, args, workspace) {
  const rel = (p) => {
    if (workspace && path.isAbsolute(p)) {
      const r = path.relative(workspace, p);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
    }
    return p;
  };
  const file = rel(firstString(args, ['path', 'file_path', 'filePath', 'file']));
  const command = oneLine(firstString(args, ['command', 'cmd', 'script']));
  const pattern = oneLine(firstString(args, ['pattern', 'query', 'glob', 'regex']));
  switch (tool) {
    case 'write':
      return { activity: `Writing ${file || 'a file'}`, detail: file, targetFile: file || null, command: null };
    case 'edit':
      return { activity: `Editing ${file || 'a file'}`, detail: file, targetFile: file || null, command: null };
    case 'read':
      return { activity: `Reading ${file || 'a file'}`, detail: file, targetFile: file || null, command: null };
    case 'bash':
    case 'powershell':
      return { activity: `Running ${clip(command, 60) || 'a command'}`, detail: command, targetFile: null, command: command || null };
    case 'grep':
      return { activity: pattern ? `Searching for ${clip(pattern, 40)}` : 'Searching...', detail: pattern || file };
    case 'find':
      return { activity: pattern ? `Finding ${clip(pattern, 40)}` : 'Finding files...', detail: pattern || file };
    case 'ls':
      return { activity: `Listing ${file || '.'}`, detail: file || '.' };
    default:
      return { activity: `Using ${tool}`, detail: file || command || pattern };
  }
}


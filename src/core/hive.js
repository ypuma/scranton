import fs from 'node:fs';
import path from 'node:path';
import { AGENT_IDS } from './state.js';
import { nowIso, toPosix, withFsRetry, writeFileAtomicSync } from './util.js';

const MAILBOXES = [...AGENT_IDS, 'human'];

export function formatMessage(header, body) {
  const lines = Object.entries(header)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).trim()}\n`;
}

/** Parse the front-matter header of a Hive message; tolerant of a missing header. */
export function parseMessage(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { header: {}, body: text.trim() };
  const header = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) header[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { header, body: text.slice(match[0].length).trim() };
}

/** The file-based mailbox system: <agent>/inbox.md, outbox.md, plan files and session dirs. */
export class Hive {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  init() {
    for (const name of MAILBOXES) fs.mkdirSync(path.join(this.dir, name), { recursive: true });
    for (const id of AGENT_IDS) fs.mkdirSync(this.sessionDir(id), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'runs'), { recursive: true });
  }

  file(rel) {
    return path.join(this.dir, ...rel.split('/'));
  }

  inboxPath(agent) {
    return path.join(this.dir, agent, 'inbox.md');
  }

  sessionDir(agent) {
    return path.join(this.dir, 'sessions', agent);
  }

  /** Write `<to>/inbox.md`, moving the previous inbox into `<to>/archive/`. Returns the hive-relative path. */
  deliver({ to, from, kind, runId, milestone = null, cycle = null, body }) {
    const rel = `${to}/inbox.md`;
    const file = this.file(rel);
    this.#archive(to, file);
    writeFileAtomicSync(file, formatMessage({ from, to, kind, runId, milestone, cycle, date: nowIso() }, body));
    return rel;
  }

  /** Store an agent's latest final report. */
  writeOutbox({ agent, to = null, runId, milestone = null, cycle = null, keyword = null, body }) {
    const rel = `${agent}/outbox.md`;
    writeFileAtomicSync(
      this.file(rel),
      formatMessage({ from: agent, to, kind: 'report', runId, milestone, cycle, keyword, date: nowIso() }, body)
    );
    return rel;
  }

  writePlan({ runId, request, plan, markdown }) {
    writeFileAtomicSync(this.file('michael/plan.json'), `${JSON.stringify({ runId, request, ...plan }, null, 2)}\n`);
    writeFileAtomicSync(this.file('michael/plan.md'), `${markdown}\n`);
  }

  /** Relative path (forward slashes) of an absolute path inside the hive. */
  relative(abs) {
    return toPosix(path.relative(this.dir, abs));
  }

  #archive(agent, file) {
    if (!fs.existsSync(file)) return;
    const dir = path.join(this.dir, agent, 'archive');
    fs.mkdirSync(dir, { recursive: true });
    let header = {};
    try {
      header = parseMessage(fs.readFileSync(file, 'utf8')).header;
    } catch {
      // archive it under a generic name
    }
    const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    const n = String(fs.readdirSync(dir).length + 1).padStart(3, '0');
    const name = `${stamp}-${n}-${header.from ?? 'unknown'}-${header.kind ?? 'message'}.md`;
    withFsRetry(() => fs.renameSync(file, path.join(dir, name)));
  }
}

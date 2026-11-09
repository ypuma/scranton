import fs from 'node:fs';
import path from 'node:path';
import { initialState, reduce } from './state.js';
import { clip, nowIso, withFsRetry, writeFileAtomicSync } from './util.js';

export function newRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  return `run-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

/**
 * Appends contract events to hive/events.jsonl and keeps hive/state.json (the fold of those events) in sync.
 * Synchronous on purpose: strict ordering, and the file is always complete after emit() returns.
 */
export class EventRecorder {
  #seq = 0;
  #state = initialState();
  #listeners = new Set();
  #warned = false;

  constructor({ hiveDir, runId = newRunId() }) {
    this.hiveDir = hiveDir;
    this.runId = runId;
    this.eventsFile = path.join(hiveDir, 'events.jsonl');
    this.stateFile = path.join(hiveDir, 'state.json');
  }

  get state() {
    return this.#state;
  }

  get seq() {
    return this.#seq;
  }

  /** Move the previous run's files to hive/runs/<id>/ and start an empty events file. */
  start() {
    fs.mkdirSync(this.hiveDir, { recursive: true });
    archivePreviousRun(this.hiveDir);
    withFsRetry(() => fs.writeFileSync(this.eventsFile, ''));
  }

  /** Reopen an interrupted journal without starting or archiving another run. */
  resume() {
    fs.mkdirSync(this.hiveDir, { recursive: true });
    let text = '';
    try { text = withFsRetry(() => fs.readFileSync(this.eventsFile, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    const events = complete.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    if (!events.some((event) => event?.runId === this.runId)) {
      this.start();
      return this;
    }
    for (const event of events) {
      if (event.runId !== this.runId || !Number.isSafeInteger(event.seq) || event.seq <= this.#seq) throw Error('Interrupted journal identity or sequence does not match');
      this.#seq = event.seq;
      this.#state = reduce(this.#state, event);
    }
    // A crash can leave a partial final line; never concatenate a new event to it.
    if (complete !== text) withFsRetry(() => fs.writeFileSync(this.eventsFile, complete));
    return this;
  }

  persist() {
    writeFileAtomicSync(this.stateFile, `${JSON.stringify(this.#state, null, 2)}\n`);
  }

  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  emit(type, fields = {}) {
    if (type === 'hive_write') fields = { ...fields, summary: clip(fields.summary, 140) };
    if (type === 'agent_tool') fields = { ...fields, detail: clip(fields.detail, 140) };
    const event = { v: 1, seq: ++this.#seq, ts: nowIso(), runId: this.runId, type, ...fields };
    const line = JSON.stringify(event).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    withFsRetry(() => fs.appendFileSync(this.eventsFile, `${line}\n`));
    this.#state = reduce(this.#state, event);
    this.#writeState();
    for (const fn of this.#listeners) {
      try {
        fn(event, this.#state);
      } catch {
        // a broken listener must never break the run
      }
    }
    return event;
  }

  #writeState() {
    try {
      writeFileAtomicSync(this.stateFile, `${JSON.stringify(this.#state, null, 2)}\n`);
    } catch (err) {
      if (!this.#warned) {
        this.#warned = true;
        process.stderr.write(`scranton: could not write state.json (${err.code ?? err.message}); continuing\n`);
      }
    }
  }
}

function previousRunId(hiveDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(hiveDir, 'state.json'), 'utf8'));
    if (state?.runId) return String(state.runId);
  } catch {
    // fall through to the events file
  }
  try {
    const first = fs.readFileSync(path.join(hiveDir, 'events.jsonl'), 'utf8').split('\n', 1)[0];
    const id = JSON.parse(first)?.runId;
    if (id) return String(id);
  } catch {
    // unknown
  }
  return null;
}

function archivePreviousRun(hiveDir) {
  const files = ['events.jsonl', 'state.json'].map((f) => path.join(hiveDir, f)).filter((f) => fs.existsSync(f));
  if (files.length === 0) return;
  const hasContent = files.some((f) => fs.statSync(f).size > 0);
  if (!hasContent) return;
  const id = previousRunId(hiveDir) ?? `unknown-${Date.now()}`;
  let dest = path.join(hiveDir, 'runs', id);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(hiveDir, 'runs', `${id}-${n}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of files) {
    const target = path.join(dest, path.basename(file));
    try {
      withFsRetry(() => fs.renameSync(file, target));
    } catch {
      // a reader holds the file: copy it and truncate in place instead
      fs.copyFileSync(file, target);
      fs.writeFileSync(file, '');
    }
  }
}

import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encode, decode, pause, terminal, errorData, revive, retryOptions, timeoutMS, offsetValue, guardedStep, removeStepMarker, removeWorkflowMarkers, retentionOptions } from './shared.js';

export class SQLiteClient {
  constructor(config) {
    if (!config.databasePath) throw new Error('databasePath is required');
    mkdirSync(dirname(config.databasePath), { recursive: true });
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, args BLOB NOT NULL, executor TEXT NOT NULL,
        version TEXT NOT NULL, status TEXT NOT NULL, output BLOB, error BLOB);
      CREATE TABLE IF NOT EXISTS operations (
        workflow TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
        output BLOB, error BLOB, PRIMARY KEY(workflow, position));
      CREATE TABLE IF NOT EXISTS events (workflow TEXT, key TEXT, value BLOB, PRIMARY KEY(workflow,key));
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workflow TEXT, topic TEXT, value BLOB,
        dedupe TEXT, consumed INTEGER DEFAULT 0, UNIQUE(workflow,dedupe));
      CREATE TABLE IF NOT EXISTS streams (
        workflow TEXT, key TEXT, offset INTEGER, value BLOB, closed INTEGER DEFAULT 0,
        PRIMARY KEY(workflow,key,offset));`);
    if (!this.db.prepare('PRAGMA table_info(workflows)').all().some(row => row.name === 'completed_at')) {
      this.db.exec('ALTER TABLE workflows ADD COLUMN completed_at INTEGER');
      this.db.prepare("UPDATE workflows SET completed_at=? WHERE status IN ('SUCCESS','ERROR','CANCELLED')").run(Date.now());
    }
    this.markerDir = config.markerDir;
    this.closed = false;
  }
  row(id) { return this.db.prepare('SELECT * FROM workflows WHERE id=?').get(id); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async launch() { if (this.closed) throw new Error('Durable client is shut down'); }
  async shutdown() { this.closed = true; this.db.close(); }
  async wait() { await pause(10); if (this.closed) throw new Error('Durable client is shut down'); }
  retrieveWorkflow(workflowId) {
    return {
      workflowId,
      getStatus: async () => {
        const row = this.row(workflowId);
        return row ? { workflowId, name: row.name, status: row.status, executorId: row.executor, appVersion: row.version } : null;
      },
      getResult: async () => {
        for (;;) {
          const row = this.row(workflowId);
          if (!row) throw new Error(`Unknown workflow: ${workflowId}`);
          if (row.status === 'SUCCESS') return decode(row.output);
          if (row.status === 'ERROR') throw revive(decode(row.error));
          if (row.status === 'CANCELLED') throw new Error(`Workflow cancelled: ${workflowId}`);
          await this.wait();
        }
      },
    };
  }
  async listWorkflows({ status, executorId, appVersion } = {}) {
    const rows = this.db.prepare('SELECT id FROM workflows ORDER BY rowid').all();
    const results = await Promise.all(rows.map(row => this.retrieveWorkflow(row.id).getStatus()));
    return results.filter(row => (!status || row.status === status) && (!executorId || row.executorId === executorId) && (appVersion === undefined || row.appVersion === appVersion));
  }
  cleanupMarkers(id) {
    const positions = this.db.prepare('SELECT position FROM operations WHERE workflow=?').all(id).map(row => row.position);
    removeWorkflowMarkers(this.markerDir, id, positions);
  }
  async prune(options) {
    const { cutoff, keepLastWorkflows } = retentionOptions(options);
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT id,completed_at FROM workflows WHERE status IN ('SUCCESS','ERROR','CANCELLED') ORDER BY completed_at DESC, rowid DESC").all();
      const candidates = rows.slice(keepLastWorkflows).filter(row => row.completed_at !== null && row.completed_at <= cutoff);
      for (const row of candidates) {
        this.cleanupMarkers(row.id);
        for (const table of ['operations', 'events', 'messages', 'streams']) this.db.prepare(`DELETE FROM ${table} WHERE workflow=?`).run(row.id);
        this.db.prepare('DELETE FROM workflows WHERE id=?').run(row.id);
      }
      return { deletedWorkflows: candidates.length };
    });
  }
  async send(id, message, topic = '', idempotencyKey) {
    if (!this.row(id)) throw new Error(`Unknown workflow: ${id}`);
    this.db.prepare('INSERT OR IGNORE INTO messages(workflow,topic,value,dedupe) VALUES(?,?,?,?)')
      .run(id, topic, encode(message), idempotencyKey ?? null);
  }
  async getEvent(id, key, options) {
    const deadline = Date.now() + timeoutMS(options);
    for (;;) {
      const row = this.db.prepare('SELECT value FROM events WHERE workflow=? AND key=?').get(id, key);
      if (row) return decode(row.value);
      if (Date.now() >= deadline) return null;
      await this.wait();
    }
  }
  async *readStream(id, key, options) {
    let offset = offsetValue(options);
    const pageSize = options?.pageSize ?? 256;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('Invalid pageSize');
    let finalRead = false;
    for (;;) {
      const rows = this.db.prepare('SELECT * FROM streams WHERE workflow=? AND key=? AND offset>=? ORDER BY offset LIMIT ?').all(id, key, offset, pageSize);
      for (const row of rows) {
        if (row.closed) return;
        yield { offset: row.offset, value: decode(row.value) };
        offset = row.offset + 1;
      }
      if (rows.length === pageSize) continue;
      if (finalRead && rows.length === 0) return;
      if (terminal(this.row(id)?.status)) {
        // Writes may have committed after the SELECT or while a yield was paused.
        finalRead = true;
        continue;
      }
      await this.wait();
    }
  }
  async cancelWorkflow(id) {
    this.db.prepare("UPDATE workflows SET status='CANCELLED',completed_at=? WHERE id=? AND status='PENDING'").run(Date.now(), id);
    if (terminal(this.row(id)?.status)) this.cleanupMarkers(id);
  }
}

export class SQLiteRuntime extends SQLiteClient {
  constructor(config) {
    super(config);
    this.config = { executorId: 'local', appVersion: '', ...config };
    this.workflows = new Map();
    this.running = new Map();
    this.stepScope = new AsyncLocalStorage();
    this.launched = false;
  }
  registerWorkflow(name, fn) {
    if (this.launched || this.workflows.has(name)) throw new Error(`Cannot register workflow: ${name}`);
    this.workflows.set(name, fn);
  }
  async launch() {
    await super.launch();
    this.launched = true;
    for (const row of this.db.prepare("SELECT id FROM workflows WHERE status IN ('SUCCESS','ERROR','CANCELLED')").all()) this.cleanupMarkers(row.id);
    for (const row of this.db.prepare("SELECT * FROM workflows WHERE status='PENDING' AND executor=? AND version=?").all(this.config.executorId, this.config.appVersion)) {
      if (!this.workflows.has(row.name)) throw new Error(`Unregistered workflow: ${row.name}`);
      this.execute(row);
    }
  }
  async startWorkflow(name, { workflowId = randomUUID() } = {}, ...args) {
    if (!this.launched || this.closed) throw new Error('Runtime is not launched');
    const existing = this.row(workflowId);
    if (existing) return this.retrieveWorkflow(workflowId);
    if (!this.workflows.has(name)) throw new Error(`Unregistered workflow: ${name}`);
    this.db.prepare("INSERT INTO workflows(id,name,args,executor,version,status) VALUES(?,?,?,?,?,'PENDING')")
      .run(workflowId, name, encode(args), this.config.executorId, this.config.appVersion);
    this.execute(this.row(workflowId));
    return this.retrieveWorkflow(workflowId);
  }
  check(id) {
    if (this.closed) throw new Error('Runtime is shut down');
    const row = this.row(id);
    if (!row) throw new Error(`Unknown workflow: ${id}`);
    if (row.status === 'CANCELLED') throw new Error(`Workflow cancelled: ${id}`);
  }
  execute(row) {
    if (this.running.has(row.id)) return;
    const task = Promise.resolve().then(async () => {
      try {
        const value = await this.workflows.get(row.name)(this.context(row.id), ...decode(row.args));
        this.check(row.id);
        this.db.prepare("UPDATE workflows SET status='SUCCESS',output=?,completed_at=? WHERE id=? AND status='PENDING'").run(encode(value), Date.now(), row.id);
      } catch (error) {
        if (!this.closed) this.db.prepare("UPDATE workflows SET status='ERROR',error=?,completed_at=? WHERE id=? AND status='PENDING'").run(encode(errorData(error)), Date.now(), row.id);
      }
      finally {
        if (!this.closed && (!this.row(row.id) || terminal(this.row(row.id).status))) this.cleanupMarkers(row.id);
      }
    }).finally(() => this.running.delete(row.id));
    this.running.set(row.id, task);
  }
  context(id) {
    let position = 0;
    const load = (index, name) => {
      this.check(id);
      const row = this.db.prepare('SELECT * FROM operations WHERE workflow=? AND position=?').get(id, index);
      if (row && row.name !== name) throw new Error(`Non-determinism at ${index}: recorded ${row.name}, received ${name}`);
      return row;
    };
    const unpack = row => { if (row.error) throw revive(decode(row.error)); return decode(row.output); };
    const save = (index, name, value, error) => {
      this.check(id);
      this.db.prepare('INSERT INTO operations(workflow,position,name,output,error) VALUES(?,?,?,?,?)')
        .run(id, index, name, error ? null : encode(value), error ? encode(errorData(error)) : null);
      return value;
    };
    const operation = async (name, body) => {
      if (this.stepScope.getStore()) throw new Error('Workflow operations cannot run inside a step');
      const index = position++;
      const row = load(index, name);
      if (row) return unpack(row);
      return this.transaction(() => save(index, name, body()));
    };
    const append = (key, value, closed = 0) => {
      this.check(id);
      if (this.db.prepare('SELECT 1 FROM streams WHERE workflow=? AND key=? AND closed=1').get(id, key)) throw new Error('Stream is closed');
      this.db.prepare('INSERT INTO streams(workflow,key,offset,value,closed) SELECT ?,?,COALESCE(MAX(offset),-1)+1,?,? FROM streams WHERE workflow=? AND key=?')
        .run(id, key, encode(value), closed, id, key);
    };
    return {
      workflowId: id,
      runStep: async (fn, options = {}) => {
        if (this.stepScope.getStore()) throw new Error('Nested steps are not supported');
        const name = options.name || fn.name;
        if (!name) throw new Error('Step name is required');
        const retries = retryOptions(options.retries);
        const index = position++;
        const row = load(index, name);
        if (row) {
          if (options.atMostOnce) removeStepMarker(this.markerDir, id, index);
          return unpack(row);
        }
        const body = async () => {
          for (let attempt = 1; ; attempt++) {
            this.check(id);
            try { return await this.stepScope.run(true, () => fn(attempt)); }
            catch (error) {
              if (attempt >= retries.maxAttempts || (retries.shouldRetry && !await retries.shouldRetry(error))) throw error;
              const deadline = Date.now() + retries.intervalSeconds * 1000 * retries.backoffRate ** (attempt - 1);
              while (Date.now() < deadline) { this.check(id); await this.wait(); }
            }
          }
        };
        let value;
        try {
          value = options.atMostOnce
            ? await guardedStep(this.config.markerDir, id, index, name, () => this.stepScope.run(true, () => fn(1)))
            : await body();
        } catch (error) {
          save(index, name, undefined, error);
          if (options.atMostOnce) removeStepMarker(this.markerDir, id, index);
          throw error;
        }
        save(index, name, value);
        if (options.atMostOnce) removeStepMarker(this.markerDir, id, index);
        return value;
      },
      now: () => operation('now', Date.now),
      randomUUID: () => operation('randomUUID', randomUUID),
      sleep: async seconds => {
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid sleep seconds');
        const deadline = await operation('sleep', () => Date.now() + seconds * 1000);
        while (Date.now() < deadline) { this.check(id); await this.wait(); }
        this.check(id);
      },
      setEvent: (key, value) => operation('setEvent', () => {
        this.db.prepare('INSERT INTO events(workflow,key,value) VALUES(?,?,?) ON CONFLICT(workflow,key) DO UPDATE SET value=excluded.value').run(id, key, encode(value));
      }),
      recv: async (topic = '', options) => {
        if (this.stepScope.getStore()) throw new Error('recv cannot run inside a step');
        const duration = timeoutMS(options);
        const index = position++;
        const row = load(index, 'recv');
        // Reserve the deadline position on replay as well as first execution.
        const deadline = await operation(`recv-deadline:${index}`, () => Date.now() + duration);
        if (row) return unpack(row);
        for (;;) {
          this.check(id);
          const result = this.transaction(() => {
            const message = this.db.prepare('SELECT * FROM messages WHERE workflow=? AND topic=? AND consumed=0 ORDER BY id LIMIT 1').get(id, topic);
            if (message) {
              this.db.prepare('UPDATE messages SET consumed=1 WHERE id=?').run(message.id);
              return { value: save(index, 'recv', decode(message.value)) };
            }
            if (Date.now() >= deadline) return { value: save(index, 'recv', null) };
          });
          if (result) return result.value;
          await this.wait();
        }
      },
      writeStream: (key, value) => this.stepScope.getStore()
        ? Promise.resolve(this.transaction(() => append(key, value)))
        : operation('writeStream', () => append(key, value)),
      closeStream: key => operation('closeStream', () => append(key, undefined, 1)),
    };
  }
  async shutdown() {
    this.closed = true;
    await Promise.all(this.running.values());
    this.db.close();
  }
}

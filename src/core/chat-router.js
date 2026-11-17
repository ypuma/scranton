import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ChatRouter {
  constructor({ hiveDir, runId, emit, maxMessages = 500, maxText = 16000 }) {
    Object.assign(this, { hiveDir, runId, emit, maxMessages, maxText });
    this.instances = new Map();
    this.counts = new Map();
    this.count = 0;
    this.attempts = 0;
    this.pending = new Set();
    this.ids = new Set();
    this.spool = path.join(hiveDir, 'control', 'chat');
    this.journal = path.join(hiveDir, 'chat', `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(this.journal), { recursive: true });
    fs.mkdirSync(this.spool, { recursive: true });
  }

  register(id) { if (!this.instances.has(id)) this.instances.set(id, { queue: [], runner: null, terminal: false }); }

  record(type, fields) {
    fs.appendFileSync(this.journal, `${JSON.stringify({ type, runId: this.runId, ...fields })}\n`);
    this.emit(type, fields);
  }

  send(from, { to, text }) {
    return this.#send(from, { to, text }, randomUUID());
  }

  async #send(from, { to, text }, id) {
    this.ids.add(id);
    const target = this.instances.get(to);
    let reason;
    if (++this.attempts > this.maxMessages * 2) reason = 'Chat attempt limit reached';
    else if (from !== 'human' && !this.instances.has(from)) reason = 'Unknown sender';
    else if (typeof to !== 'string' || !target) reason = 'Unknown recipient: use an exact instance ID';
    else if (target.terminal) reason = 'Recipient has completed';
    else if (typeof text !== 'string' || !text.trim() || text.length > this.maxText) reason = `Text must contain 1-${this.maxText} characters`;
    else if (this.count >= this.maxMessages || (this.counts.get(from) ?? 0) >= 100) reason = 'Message limit reached';
    const message = { id, from, to: typeof to === 'string' ? to : '', text: typeof text === 'string' ? text.slice(0, this.maxText) : '', delivery: reason ? 'rejected' : 'queued', ...(reason ? { reason } : {}) };
    this.record('chat_message', message);
    if (reason) return { ok: false, id, delivery: 'rejected', reason, error: reason };
    this.count++; this.counts.set(from, (this.counts.get(from) ?? 0) + 1);
    target.queue.push(message);
    if (target.runner) await this.flush(to);
    return { ok: ['queued', 'delivered'].includes(message.delivery), id, delivery: message.delivery, ...(message.reason ? { reason: message.reason, error: message.reason } : {}) };
  }

  async attach(id, runner) {
    this.instances.get(id).runner = runner;
    await this.flush(id);
  }

  detach(id) { const target = this.instances.get(id); if (target) target.runner = null; }

  flush(id) {
    const target = this.instances.get(id);
    if (target.flushing) return target.flushing;
    const job = (async () => {
      while (target.runner && target.queue.length) {
        const message = target.queue.shift();
        target.inFlight = message;
        let ack;
        try {
          ack = await target.runner.sendMessage(`[Message from ${message.from}; id ${message.id}]\n${message.text}`);
        } catch (error) {
          ack = { ok: false, delivery: 'unknown', error: error?.message ?? 'Steer acknowledgement failed' };
        }
        if (target.inFlight !== message) break;
        target.inFlight = null;
        message.delivery = ack?.delivery === 'unknown' || typeof ack?.ok !== 'boolean' ? 'unknown' : ack.ok ? 'delivered' : 'rejected';
        if (message.delivery !== 'delivered') message.reason = ack?.error ?? (message.delivery === 'unknown' ? 'Steer not acknowledged; delivery unknown. Do not resend automatically.' : 'Steer rejected');
        this.record('chat_delivery', { id: message.id, delivery: message.delivery, ...(message.reason ? { reason: message.reason } : {}) });
      }
    })();
    target.flushing = job;
    this.pending.add(job);
    return job.finally(() => { target.flushing = null; this.pending.delete(job); });
  }

  finish(id) {
    const target = this.instances.get(id);
    if (!target) return;
    target.terminal = true; target.runner = null;
    if (target.inFlight) {
      const message = target.inFlight;
      target.inFlight = null;
      message.delivery = 'unknown';
      message.reason = 'Recipient completed before acknowledgement; delivery unknown. Do not resend automatically.';
      this.record('chat_delivery', { id: message.id, delivery: message.delivery, reason: message.reason });
    }
    for (const message of target.queue.splice(0)) {
      message.delivery = 'rejected';
      message.reason = 'Recipient completed before sending';
      this.record('chat_delivery', { id: message.id, delivery: message.delivery, reason: message.reason });
    }
  }

  async consume() {
    if (this.consuming) return;
    this.consuming = true;
    try {
      for (const name of fs.readdirSync(this.spool).filter((n) => /^[\w-]+\.json$/.test(n))) {
        const file = path.join(this.spool, name);
        try {
          if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 131072) throw new Error('Invalid chat command');
          const command = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Invalid chat command');
          if (command.runId !== this.runId) throw new Error('Stale chat command');
          if (typeof command.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.id)) throw new Error('Invalid chat command');
          if (this.ids.has(command.id)) throw new Error('Duplicate chat command');
          await this.#send('human', command, command.id);
        } catch (err) {
          const reason = ['Stale chat command', 'Duplicate chat command'].includes(err.message) ? err.message : 'Invalid chat command';
          // Untrusted run IDs, IDs and payloads never enter the current chat transcript.
          this.record('chat_command_rejected', { delivery: 'rejected', reason });
        }
        fs.rmSync(file, { force: true });
      }
    } finally { this.consuming = false; }
  }

  async close() {
    await Promise.allSettled(this.pending);
    for (const id of this.instances.keys()) this.finish(id);
  }
}

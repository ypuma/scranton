import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDurableClient } from '../core/durable/index.js';
import { agentHiveScopePrefix } from '../core/agent/identity.js';
import { approveToolCall } from '../core/agent/index.js';
import { errorRecord } from '../core/agent/redaction.js';
import { readRunLease, runOwnerStatus } from '../core/run-lease.js';
import { json, readBody } from './control.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const terminal = status => ['SUCCESS', 'ERROR', 'CANCELLED'].includes(status);
function identity(record) {
  if (record.name !== 'scranton.agent.v1' || !record.workflowId.startsWith('scr:')) return null;
  try {
    const parts = record.workflowId.slice(4).split('/').map(decodeURIComponent);
    return parts.length === 5 ? { projectId: parts[0], chatId: parts[1], runId: parts[2], instanceId: parts[3] } : null;
  } catch { return null; }
}
function runInterrupted(hive, runId) {
  const lease = readRunLease(hive);
  if (lease?.runId === runId && runOwnerStatus(hive, lease) === 'gone') return true;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(hive, 'state.json'), 'utf8'));
    return state.runId !== runId || ['finished', 'aborted', 'failed'].includes(state.status);
  } catch { return false; }
}
function runActive(hive, runId) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(hive, 'state.json'), 'utf8'));
    return state.runId === runId && !['finished', 'aborted', 'failed'].includes(state.status);
  } catch { return false; }
}

export function createAgentRoutes({ createClient = createDurableClient } = {}) {
  const streams = new Set();
  async function open(hive) {
    if (createClient === createDurableClient && !process.env.DBOS_SYSTEM_DATABASE_URL && !process.env.DBOS_DATABASE_URL && !fs.existsSync(path.join(hive, 'dbos.sqlite'))) return null;
    return createClient({ hiveDir: hive });
  }
  async function workflows(client, hive, scope) {
    if (!client) return [];
    const prefix = agentHiveScopePrefix(hive);
    return (await client.listWorkflows()).flatMap(record => {
      const ids = identity(record);
      const matches = record.workflowId.startsWith(prefix) || scope && ids?.projectId === scope.projectId && ids?.chatId === scope.chatId;
      return ids && matches ? [{ ...record, ...ids }] : [];
    });
  }
  async function pending(client, record) {
    if (terminal(record.status)) return null;
    const state = await client.getEvent(record.workflowId, 'agent_state', { timeoutSeconds: 0 });
    if (state?.phase !== 'waiting_approval') return null;
    const detail = state.detail;
    if (!detail || detail.workflowId !== record.workflowId || typeof detail.callId !== 'string' || typeof detail.step !== 'string') return null;
    const timeoutSeconds = detail.timeoutSeconds ?? 600;
    const deadline = detail.deadline ?? null;
    return { workflowId: record.workflowId, runId: record.runId, instanceId: record.instanceId,
      agent: record.instanceId.replace(/-m\d+$/, ''), callId: detail.callId, tool: detail.tool, args: detail.args,
      timeoutSeconds, deadline, step: detail.step };
  }
  return {
    async approvals(req, res, hive, scope) {
      if (!['GET', 'POST'].includes(req.method)) throw fail(404, 'Not found');
      const body = req.method === 'POST' ? await readBody(req) : null;
      if (body && (Object.keys(body).some(key => !['workflowId', 'callId', 'approved'].includes(key)) ||
          typeof body.workflowId !== 'string' || typeof body.callId !== 'string' || !body.callId || typeof body.approved !== 'boolean')) throw fail(400, 'Invalid approval');
      const client = await open(hive);
      try {
        const records = await workflows(client, hive, scope);
        if (!body) {
          const approvals = [];
          for (const record of records) {
            const item = await pending(client, record);
            if (item && (!item.deadline || Date.parse(item.deadline) > Date.now())) {
              approvals.push(item);
            }
          }
          return json(res, 200, { approvals });
        }
        const record = records.find(record => record.workflowId === body.workflowId);
        const item = record && await pending(client, record);
        if (!item || item.callId !== body.callId) throw fail(404, 'Approval is not pending');
        if (item.deadline && Date.parse(item.deadline) <= Date.now()) throw fail(409, 'Approval has expired');
        await approveToolCall(client, item.workflowId, item, body.approved, 'human-ui');
        return json(res, 202, { ok: true });
      } finally { await client?.shutdown(); }
    },
    async stream(req, res, hive, runId, instanceId, scope) {
      try { runId = decodeURIComponent(runId); instanceId = decodeURIComponent(instanceId); }
      catch { throw fail(400, 'Invalid stream identity'); }
      const query = new URL(req.url, 'http://localhost').searchParams;
      const last = req.headers['last-event-id'];
      const raw = last ?? query.get('fromOffset') ?? '0';
      if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || query.getAll('fromOffset').length > 1) throw fail(400, 'Invalid stream offset');
      // Durable offsets are inclusive; Last-Event-ID names the last delivered value.
      const fromOffset = Number(raw) + (last === undefined ? 0 : 1);
      const client = await open(hive);
      let ping, watchdog, shutdown;
      const closeClient = () => shutdown ??= client?.shutdown();
      const controller = new AbortController();
      const stop = () => { controller.abort(); void closeClient(); res.end(); };
      const signal = controller.signal;
      let interrupted = false, activeWorkflow;
      const write = async text => {
        if (signal.aborted || res.destroyed) return;
        if (!res.write(text)) await new Promise(resolve => {
          const done = () => { res.off('drain', done); signal.removeEventListener('abort', done); resolve(); };
          res.once('drain', done); signal.addEventListener('abort', done, { once: true });
        });
      };
      try {
        let records = (await workflows(client, hive, scope)).filter(record => record.runId === runId && record.instanceId === instanceId);
        if (!records.length) throw fail(404, 'Run or agent instance not found');
        streams.add(stop);
        res.once('close', stop);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        watchdog = setInterval(async () => {
          if (!activeWorkflow || signal.aborted || !runInterrupted(hive, runId)) return;
          try {
            const current = await client.retrieveWorkflow(activeWorkflow).getStatus();
            if (terminal(current?.status) || signal.aborted) return;
            interrupted = true;
            controller.abort();
            void closeClient();
          } catch { /* The main reader owns transport errors and shutdown. */ }
        }, 100);
        ping = setInterval(() => { if (!res.writableNeedDrain) res.write(': ping\n\n'); }, 15000);
        let base = 0, index = 0, status = 'SUCCESS';
        while (!signal.aborted) {
          for (; index < records.length && !signal.aborted; index++) {
            const record = records[index];
            activeWorkflow = record.workflowId;
            let length = 0;
            // A numeric cursor spans invocations in durable creation order, without buffering values.
            for await (const { offset, value } of client.readStream(record.workflowId, 'output', { fromOffset: 0 })) {
              if (signal.aborted) break;
              length = offset + 1;
              if (base + offset >= fromOffset) await write(`id: ${base + offset}\nevent: chunk\ndata: ${JSON.stringify(value.type === 'error' ? errorRecord(value, process.env) : value)}\n\n`);
            }
            base += length;
            if (signal.aborted) break;
            let current;
            do {
              current = await client.retrieveWorkflow(record.workflowId).getStatus();
              if (!terminal(current?.status)) await sleep(25, undefined, { signal });
            } while (!signal.aborted && !terminal(current?.status));
            if (current?.status !== 'SUCCESS') status = current?.status ?? 'ERROR';
          }
          if (signal.aborted) break;
          records = (await workflows(client, hive, scope)).filter(record => record.runId === runId && record.instanceId === instanceId);
          activeWorkflow = undefined;
          if (index < records.length) continue;
          if (!runActive(hive, runId)) { await write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`); break; }
          await sleep(100, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) {
          if (!res.headersSent) throw error;
          res.destroy();
        }
      } finally {
        clearInterval(ping);
        clearInterval(watchdog);
        if (interrupted && !res.destroyed) res.write('event: end\ndata: {"status":"interrupted"}\n\n');
        streams.delete(stop);
        res.off('close', stop);
        controller.abort();
        await closeClient();
        if (res.headersSent && !res.destroyed) res.end();
      }
    },
    close() { for (const stop of streams) stop(); }
  };
}

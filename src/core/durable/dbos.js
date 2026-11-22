import { guardedStep, retryOptions, offsetValue, timeoutMS, redact, errorData, revive, removeStepMarker, removeWorkflowMarkers, retentionOptions } from './shared.js';

let activeRuntime;
const status = row => row ? {
  workflowId: row.workflowID, name: row.workflowName, status: row.status,
  executorId: row.executorId, appVersion: row.applicationVersion,
} : null;
const safe = async fn => {
  try { return await fn(); }
  catch (error) { throw Object.assign(new Error(redact(error?.message || error)), { name: error?.name || 'Error' }); }
};
function logger(config) {
  return Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, message => {
    config.logger?.[level]?.(redact(message));
  }]));
}

export class DBOSClientAdapter {
  constructor(target, config) { this.target = target; this.config = config; }
  async launch() {}
  async shutdown() { await safe(() => this.target.destroy()); }
  retrieveWorkflow(workflowId) {
    const handle = this.target.retrieveWorkflow(workflowId);
    return {
      workflowId,
      getResult: () => safe(async () => {
        try { return await handle.getResult(); }
        finally {
          const row = await handle.getStatus();
          if (['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(row?.status)) removeWorkflowMarkers(this.config.markerDir, workflowId);
        }
      }),
      getStatus: () => safe(async () => {
        const row = await handle.getStatus();
        if (['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(row?.status)) removeWorkflowMarkers(this.config.markerDir, workflowId);
        return status(row);
      }),
    };
  }
  send(...args) { return safe(() => this.target.send(...args)); }
  getEvent(id, key, options) {
    timeoutMS(options);
    return safe(() => this.target.getEvent(id, key, options));
  }
  cancelWorkflow(id) { return safe(() => this.target.cancelWorkflow(id)); }
  async listWorkflows({ appVersion, executorId, status: filter } = {}) {
    return safe(async () => (await this.target.listWorkflows({ applicationVersion: appVersion, executorId, status: filter, applicationName: this.config.name || 'scranton' })).map(status));
  }
  async prune(options) {
    const { cutoff, keepLastWorkflows } = retentionOptions(options);
    return safe(async () => {
      const rows = (await this.target.listWorkflows({ applicationName: this.config.name || 'scranton' }))
        .filter(row => ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(row.status))
        .sort((a, b) => (b.completedAt ?? b.updatedAt ?? b.createdAt) - (a.completedAt ?? a.updatedAt ?? a.createdAt) || b.workflowID.localeCompare(a.workflowID));
      let deletedWorkflows = 0;
      for (const row of rows.slice(keepLastWorkflows)) {
        if ((row.completedAt ?? row.updatedAt ?? row.createdAt) > cutoff) continue;
        const current = await this.target.retrieveWorkflow(row.workflowID).getStatus();
        if (!current || current.status !== row.status) continue;
        await this.target.deleteWorkflow(row.workflowID, false);
        removeWorkflowMarkers(this.config.markerDir, row.workflowID);
        deletedWorkflows++;
      }
      return { deletedWorkflows };
    });
  }
  async *readStream(id, key, options) {
    let offset = offsetValue(options);
    try {
      for await (const value of this.target.readStream(id, key, { offset })) yield { offset: offset++, value };
    } catch (error) { throw new Error(redact(error?.message || error)); }
  }
}

export async function createDBOS(config, clientOnly) {
  const { DBOS, DBOSClient } = await import('@dbos-inc/dbos-sdk');
  if (clientOnly) return new DBOSClientAdapter(await safe(() => DBOSClient.create({
    systemDatabaseUrl: config.systemDatabaseUrl,
    applicationName: config.name || 'scranton', logger: logger(config),
  })), config);
  if (activeRuntime) throw new Error('Only one DBOS runtime is supported per process; use a client for readers');
  await safe(() => DBOS.setConfig({
    name: config.name || 'scranton', systemDatabaseUrl: config.systemDatabaseUrl,
    executorID: config.executorId || 'local', applicationVersion: config.appVersion ?? '',
    logger: logger(config),
  }));
  const runtime = new DBOSClientAdapter(DBOS, config);
  activeRuntime = runtime;
  const workflows = new Map();
  let launched = false;
  runtime.registerWorkflow = (name, fn) => {
    if (launched || workflows.has(name)) throw new Error(`Cannot register workflow: ${name}`);
    workflows.set(name, DBOS.registerWorkflow(async (...args) => {
      const context = {
        workflowId: DBOS.workflowID,
        runStep: async (body, options = {}) => {
          const name = options.name || body.name;
          if (!name) throw new Error('Step name is required');
          const retries = retryOptions(options.retries);
          const reservation = options.atMostOnce ? DBOS.reserveStep() : null;
          const markerPosition = reservation?.stepID;
          const run = reservation ? (fn, settings) => reservation.run(fn, settings) : (fn, settings) => DBOS.runStep(fn, settings);
          const workflowId = DBOS.workflowID;
          const result = await run(async () => {
            if (!options.atMostOnce) return body(DBOS.stepStatus?.currentAttempt ?? 1);
            // Return guarded errors as data so checkpoint failures never discard their markers.
            try { return { scrantonGuardedOutcome: true, value: await guardedStep(config.markerDir, workflowId, markerPosition, name, () => body(1)) }; }
            catch (error) { return { scrantonGuardedOutcome: true, error: errorData(error) }; }
          }, {
            name, retriesAllowed: !options.atMostOnce && retries.maxAttempts > 1,
            ...retries,
          });
          if (options.atMostOnce && markerPosition !== undefined) removeStepMarker(config.markerDir, workflowId, markerPosition);
          if (options.atMostOnce && result?.scrantonGuardedOutcome === true) {
            if (result.error) throw revive(result.error);
            return result.value;
          }
          return result;
        },
        now: () => DBOS.now(),
        randomUUID: () => DBOS.randomUUID(),
        sleep: seconds => {
          if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid sleep seconds');
          return DBOS.sleepSeconds(seconds);
        },
        setEvent: (key, value) => DBOS.setEvent(key, value),
        recv: (topic, options) => { timeoutMS(options); return DBOS.recv(topic, options); },
        writeStream: (key, value) => DBOS.writeStream(key, value),
        closeStream: key => DBOS.closeStream(key),
      };
      return fn(context, ...args);
    }, { name }));
  };
  runtime.launch = async () => {
    try {
      await safe(() => DBOS.launch()); launched = true;
      const rows = await runtime.listWorkflows();
      for (const row of rows) if (['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(row.status)) removeWorkflowMarkers(config.markerDir, row.workflowId);
    }
    catch (error) { await runtime.shutdown(); throw error; }
  };
  runtime.startWorkflow = async (name, { workflowId } = {}, ...args) => safe(async () => {
    if (!launched) throw new Error('Runtime is not launched');
    if (!workflows.has(name)) throw new Error(`Unregistered workflow: ${name}`);
    const handle = await DBOS.startWorkflow(workflows.get(name), { workflowID: workflowId })(...args);
    return runtime.retrieveWorkflow(handle.workflowID);
  });
  runtime.shutdown = async () => {
    try { await safe(() => DBOS.shutdown({ deregister: true, workflowCompletionTimeoutMS: 1000 })); }
    finally { activeRuntime = undefined; launched = false; }
  };
  return runtime;
}

import { join } from 'node:path';
export { interrupted } from './shared.js';

function configuration(options) {
  const env = options.env ?? process.env;
  const systemDatabaseUrl = options.systemDatabaseUrl ?? (env.DBOS_SYSTEM_DATABASE_URL || env.DBOS_DATABASE_URL);
  const executorId = options.executorId ?? 'local';
  const appVersion = options.appVersion ?? '1';
  if (typeof executorId !== 'string' || !executorId || typeof appVersion !== 'string' || !appVersion) {
    throw new Error('executorId and appVersion must be non-empty strings');
  }
  return {
    ...options, executorId, appVersion, systemDatabaseUrl,
    databasePath: options.databasePath ?? (options.hiveDir ? join(options.hiveDir, 'dbos.sqlite') : undefined),
  };
}

export async function createDurableRuntime(options = {}) {
  const config = configuration(options);
  if (config.systemDatabaseUrl) {
    const { createDBOS } = await import('./dbos.js');
    return createDBOS(config, false);
  }
  const { SQLiteRuntime } = await import('./sqlite.js');
  return new SQLiteRuntime(config);
}

export async function createDurableClient(options = {}) {
  const config = configuration(options);
  if (config.systemDatabaseUrl) {
    const { createDBOS } = await import('./dbos.js');
    return createDBOS(config, true);
  }
  const { SQLiteClient } = await import('./sqlite.js');
  return new SQLiteClient(config);
}

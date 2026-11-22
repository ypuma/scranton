# Durable execution

Storage and workflow backend for `src/core/agent/` and the orchestrator, with
read-only consumers and approval delivery through the server's durable client APIs.
Requires Node 24 with `node:sqlite` for local execution.

```js
import { createDurableRuntime, createDurableClient } from './index.js';

const config = {
  hiveDir: '/path/to/chat/hive', // or databasePath: '/path/to/dbos.sqlite'
  markerDir: '/path/to/chat/step-markers',
  executorId: 'run:123',
  appVersion: '1',
};
const runtime = await createDurableRuntime(config);
runtime.registerWorkflow('agent', async (wf, input) => {
  const response = await wf.runStep(async attempt => request(input, attempt), {
    name: 'llm',
    retries: { maxAttempts: 3, intervalSeconds: 1, backoffRate: 2, shouldRetry: error => error.retryable },
  });
  await wf.setEvent('response', response);
  return response;
});
await runtime.launch();
const handle = await runtime.startWorkflow('agent', { workflowId: 'agent:123' }, 'hello');
const result = await handle.getResult();
await runtime.shutdown();
```

## Selection and lifecycle

`DBOS_SYSTEM_DATABASE_URL`, then `DBOS_DATABASE_URL`, selects the dynamically
imported `@dbos-inc/dbos-sdk` 5.6.0 adapter. `DATABASE_URL` is ignored. An explicit
`systemDatabaseUrl` overrides environment selection; `env: {}` selects local
execution independently of the process environment. No URL selects SQLite at
`databasePath` or `<hiveDir>/dbos.sqlite` (one is required). Never share a SQLite
file between live executors: the caller must hold the run lease. DBOS is a
process singleton, so only one DBOS runtime may exist per process; clients are
independent. Register all workflows before launch. Launch recovers only pending
workflows for the configured executor and application version. Defaults are
`executorId: 'local'`, `appVersion: '1'` (both must be non-empty strings), DBOS application `name: 'scranton'`.
Use explicit stable versions, and unique executor IDs per writer.

`createDurableClient(config)` opens a connection without starting recovery or
registering code. Both runtime and client expose:

- `retrieveWorkflow(workflowId)` -> `{ workflowId, getResult(), getStatus() }`.
  Status is null for missing IDs, otherwise
  `{ workflowId, name, status, executorId, appVersion }`.
- `listWorkflows({ status, executorId, appVersion } = {})` -> status records.
- `send(workflowId, message, topic = '', idempotencyKey)` (deduplicated per destination).
- `getEvent(workflowId, key, { timeoutSeconds = 60 } = {})` -> value or null.
- `readStream(workflowId, key, { fromOffset = 0 } = {})` -> async iterator of
  `{ offset, value }`. Offsets are zero-based and inclusive. Closure or workflow
  termination ends the reader after all available values. SQLite accepts an optional
  `pageSize` (positive safe integer, default 256) in the same options object; both
  runtime and client readers buffer at most one page of rows, with no prefetch
  while the consumer is paused. This bounds row count, not bytes: individual values
  can still be large. Pages resume at the next exact offset; terminal readers
  re-read until empty so writes committed during a paused yield are drained.
- `cancelWorkflow(workflowId)`; cancellation is observed at checkpoints.
- `prune({ olderThanMs, keepLastWorkflows = 0 })` -> `{ deletedWorkflows }`.
  Explicit, irreversible retention; `olderThanMs` is a required non-negative finite
  age in milliseconds, not an epoch timestamp. Keep count is a non-negative safe
  integer. Protects the newest N terminal workflows, then deletes the others whose
  completion time is at or before `Date.now() - olderThanMs`, including every
  operation, event, message and stream row. PENDING and other nonterminal workflows
  are never candidates. Keep count covers terminal workflows only. Pruning is
  database-wide for SQLite, application-scoped for DBOS, not executor-scoped.
  Existing handles lose their result/history; pruned IDs can be started again.
  Stop history readers before pruning. Supply the runtime's same `markerDir` to
  retention clients if at-most-once steps are used; the database does not store its
  filesystem path. There is no automatic retention.
- `launch()` and `shutdown()` (clients need no launch).

Runtime additionally exposes `registerWorkflow(name, async (wf, ...args) => ...)`
and `startWorkflow(name, { workflowId }, ...args)`. Reusing an ID returns its
existing handle without replacing inputs or rerunning completed work.

## Workflow context

`wf.workflowId`, `runStep(fn, options)`, `now()`, `randomUUID()`, `sleep(seconds)`,
`setEvent(key, value)`, `recv(topic, { timeoutSeconds = 60 })`,
`writeStream(key, value)`, and `closeStream(key)` are available. All methods are
asynchronous. Step bodies receive a one-based attempt number. Default is one
attempt; retries must be explicit. Use named steps and deterministic operation
order. Do not call workflow operations inside step bodies, except `writeStream`.
Do not launch detached asynchronous work that outlives a step or workflow.

Every workflow operation is checkpointed in call order. A different step name
at a recorded position is an error. `now`, UUIDs, sleep deadlines, and receives
are replay-safe. Events are last-write-wins. Step stream writes are committed
immediately, survive failed attempts, and may repeat on retry/recovery. Consumers
must handle those at-least-once chunks. Outside steps, stream writes are replayed
without duplicating data.

`runStep(fn, { name, atMostOnce: true })` requires `markerDir`, a durable directory
shared by restarts of that workflow. A marker is flushed before running the
body. After a crash the body is never rerun: an unfinished marker returns
`{ status: 'interrupted' }`; a completed marker replays its result/error. This
mode disables retries, including retries after ordinary errors. The adapter deletes
both marker files only after the result/error is checkpointed; crash recovery then
uses the database. Uncheckpointed markers must remain while recovery is possible.
Terminal workflow cleanup also removes markers (including leftovers found on launch
or retention). The interrupted result means
**unknown external outcome**, not that the external operation failed. Marker
storage must be shared across DBOS hosts if recovery moves between machines.
Do not reuse a marker directory across independent database namespaces with
colliding workflow IDs. New marker names include a hashed workflow prefix for
terminal cleanup; old unprefixed markers are still read and cleaned by step position.
For legacy DBOS markers, retain the marker directory until old workflows finish;
unprefixed orphan files cannot be associated with a workflow during bulk cleanup.

## SQLite schema

WAL, `synchronous=FULL`, and a 5000 ms busy timeout are enabled. Values use Node's
V8 serialization (including undefined). Five tables are created:

| Table | Key | Contents |
| --- | --- | --- |
| workflows | id | name, serialized args, executor, version, status, output/error, completed_at |
| operations | workflow, position | operation name, serialized output/error |
| events | workflow, key | latest serialized value |
| messages | autoincrement id; unique workflow/dedupe | topic, value, consumed flag |
| streams | workflow, key, offset | serialized value, closure flag |

Receive consumption and its checkpoint commit atomically. Workflow-level event
and stream mutations commit with their checkpoint. Receive deadlines use a
second internal checkpoint, so replay reserves both positions. Stream closure
occupies a final offset but is not yielded. Existing databases gain `completed_at`
on open; old terminal rows are conservatively dated at migration time. Success,
error and cancellation set completion time. Pruning deletes all related rows in
one SQLite transaction. Freed pages are reused by SQLite; it does not VACUUM or
promise to reduce the database file's on-disk high-water size. Retain the database
and uncheckpointed markers together.

## Backend differences and limits

- SQLite uses 10 ms polling; DBOS uses its native PostgreSQL notifications and
  polling. SQLite clients initialize the schema but never recover workflows.
- DBOS stream reads delegate directly to SDK 5.6.0. Both `DBOS.readStream` and
  `DBOSClient.readStream` use `readStreamCore` (`dist/src/streams.js`), which calls
  `readStreamValue` for one exact offset at a time. The latter queries the workflow
  status with a primary-key stream lookup (`dist/src/system_database.js`), not all
  remaining rows. The SDK therefore buffers one value, not a multi-row page; our
  adapter adds no buffer and does not forward SQLite's `pageSize` option.
- DBOS retention uses SDK 5.6.0 `deleteWorkflow(id, false)` to delete associated
  data without recursively deleting children (which could still be pending).
  Age uses SDK completedAt, then updatedAt/createdAt for older records. Status is
  rechecked immediately before deletion. Run retention without concurrent SDK
  resume/restart/fork/delete operations: SDK deletion has no atomic terminal-only
  condition. Scranton exposes no resume-in-place API. DBOS guarded step errors
  are checkpointed as internal outcome data and rethrown outside the SDK step;
  checkpoint failures retain the marker. `reserveStep()` fixes the same SDK step
  position before execution/replay so a checkpoint replay can also remove a
  leftover marker without invoking the body. A replay returns the saved outcome.
- DBOS owns its schema and checkpoint layout; internal function IDs need not
  match SQLite. Databases are not interchangeable or portable between backends.
- SQLite uses V8 serialization; DBOS uses its native SDK serializer. Use plain
  serializable data across the public interface for portable workflows.
- Error classes and retry-exhaustion messages are backend-specific. SQLite
  revives errors as Error objects with the original name and redacted message;
  DBOS supplies its SDK error types, with redacted public error messages.
- SQLite shutdown waits for active bodies, interrupts internal polling and
  leaves unfinished workflows pending. A body that never settles prevents
  graceful shutdown. DBOS shutdown uses a 1000 ms workflow completion grace.
  Neither backend can forcibly undo an external side effect.
- Optional `logger` receives DBOS log messages with PostgreSQL URL credentials
  masked. Raw SDK error objects/metadata are deliberately not forwarded.

Run `node --test "test/core/durable/*.test.js"`. SQLite always runs; the shared
DBOS contract runs only with `SCRANTON_TEST_DBOS_URL` pointing at a disposable
PostgreSQL database. No server or container is installed by the tests.

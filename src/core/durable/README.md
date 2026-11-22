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
Use explicit stable versions, and unique executor IDs per writer. SDK 5.6.0
requires application-version names to be unique across application names sharing
one database; namespace versions when using a custom application name.

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

## Optional DBOS verification

SQLite always runs; the shared DBOS contract runs only with
`SCRANTON_TEST_DBOS_URL` pointing at a **disposable** PostgreSQL database. The
contract writes workflow records and owns its test executor. No server or container
is installed by the tests. From the project root in cmd.exe:

```cmd
set "SCRANTON_TEST_DBOS_URL=postgresql://USER:PASSWORD@HOST:PORT/DISPOSABLE_DB"
node --test --test-concurrency=1 "test/core/durable/*.test.js" test/core/agent/dbos-backend.test.js
set "SCRANTON_TEST_DBOS_URL="
node --test "test/core/durable/*.test.js"
```

The optional agent test isolates the SDK process singleton in a child process. It
injects a scripted provider (no credentials or real model requests), executes a
write tool, checks the final keyword, terminal status, agent state, history and
output through a separate durable client, then reattaches without another model
call. Its fixtures and credential paths are project-local. Without the URL it
skips explicitly; with a URL, connection/execution errors fail rather than skip.

### Remote PostgreSQL through SSH

Provision a separate disposable test database, not the application's production
database. Bind remote PostgreSQL to loopback only. In a separate terminal, keep
this tunnel open (replace the SSH alias and ports as appropriate):

```cmd
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 55432:127.0.0.1:55432 SSH_ALIAS
```

Use the commands above with `HOST=127.0.0.1`, `PORT=55432` and the disposable
database name. Obtain credentials securely at runtime; do not commit them, print
the URL, or put passwords in shell history. A programmatic runner should capture
and mask subprocess output, pass the URL only in the child environment, and close
the tunnel in `finally`. Reset only the disposable database, with all test clients
stopped. Keep test files serial to isolate their workflow/recovery fixtures.
Concurrent first launches by Scranton processes against one fresh or missing
PostgreSQL database are coordinated: the adapter holds a session advisory lock on
`/postgres`, the SDK's provisioning database, keyed by the target database name.
It uses the SDK's direct `pg` dependency resolved from the SDK entry point (no
additional dependency). All application names, versions and executors targeting
the same database use the same key. Acquisition polls `pg_try_advisory_lock` with
100–249 ms jitter and a 120-second wait bound, including a per-query `query_timeout`
set to the remaining time. A blocking advisory-lock query can pin a snapshot and
stall SDK `CREATE INDEX CONCURRENTLY` migrations. Connection setup honours the
URL's `connect_timeout` in seconds, with the SDK's 10-second default. The dedicated
session closes in `finally`, releasing the lock on success or failure; PostgreSQL
also releases it on process disconnect.

If the admin connection is unavailable or the lock is not permitted, the adapter
tries the target database instead. If neither connection/permission allows locking
(including a missing target), it delegates startup without a lock, preserving SDK
provisioning and error behaviour. Other lock-query errors, lock timeouts and launch
errors fail and pass through durable redaction; a failed SDK launch is never retried.
Fallback locking cannot coordinate database creation or processes using the admin
lock, so concurrent startup requires access to `/postgres` for full protection.
This coordinates Scranton launches, not raw SDK launches or external migration
runners that do not take the same lock. The lock covers launch, not normal workflow
execution, and is taken on warm launches too.

`dbos-cold.test.js` checks a single launch against a missing database, and
synchronizes four independent child processes at a launch barrier against both
fresh and missing databases, then verifies every child executes a workflow.
It runs only with `SCRANTON_TEST_DBOS_URL`; a URL user without CREATE DATABASE
privilege gets an explicit skip. Other connection/SQL failures fail the test.
Its uniquely named `scranton_dbos_race_*` database is force-dropped after children
exit. On real PostgreSQL 16 / SDK 5.6.0 the regression failed before the fix with
SQLSTATE `23505` (`duplicate key value violates unique constraint
"dbos_migrations_pkey"`; also catalog namespace/type uniqueness errors) and
`42P07` (`relation "dbos_migrations" already exists`). With the advisory-lock
adapter, all four cold launches and workflows succeeded.

The optional process contract tests crash and relaunch a writer with the same
executor/version, verify checkpoint replay and at-most-once interruption, read a
live stream and send approval from a second process, and exercise retention age,
keep count, pending protection and workflow-ID reuse. The agent test also runs two
hives with identical run/instance/invocation keys on one database and checks their
independent results and histories. DBOS-specific deadlines allow SSH latency;
SQLite deadlines and assertions are unchanged.

### PGlite compatibility probe (2026-11-22)

Attempted SDK **5.6.0** against **PGlite 0.5.17** and **pglite-socket 0.2.20**, not
a real PostgreSQL server. Scratch-only setup, commands and an independent
reproducer are in `.scratch/dbos-pglite/README.md` (gitignored, not a shipped
PostgreSQL substitute). No project dependencies or production configuration changed.

System-schema migration and SDK launch succeeded, but **DBOS workflow execution
could not be verified**. Two PGlite limitations block this configuration:

- The SDK's LISTEN/NOTIFY self-test does not receive its notification and falls
  back to polling. Socket multiplexing does not provide independent PostgreSQL
  sessions; native cross-session notifications remain unverified.
- Even with `maxConnections: 64`, the socket `QueryQueueManager.processQueue`
  dispatches only the transaction owner's messages while PGlite is in a
  transaction. SDK `SystemDatabase.lockedBackgroundJob` holds a transaction-scoped
  advisory lock while `runBackgroundJobs` executes jobs through other pool
  connections. Those queries cannot run until the lock transaction ends. An
  independent two-client probe confirms that even `SELECT 42` on the second
  connection waits for the first connection's `ROLLBACK`. The advisory-lock SQL
  itself succeeds. A single-connection SDK pool with notifications disabled also
  stalls; it is not a viable workaround.

No SDK operations, locks or query results were replaced to make tests pass, and no
Scranton adapter defect was demonstrated by these blocked runs. A timed-out or
failed PGlite run is **not** a passing DBOS contract. Restart the scratch server
with a fresh data directory after a killed client, since its transaction/queue may
otherwise prevent even a subsequent connection from completing.

PGlite remains unsuitable for these tests. Use real PostgreSQL for the optional
contracts above; SQLite coverage and mocked SDK tests alone do not establish
PostgreSQL execution, cross-process recovery or retention.

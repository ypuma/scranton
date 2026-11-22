# Durable agent HTTP routes

The binding wire contracts are `.enma/run-options-contract.md` and
`.enma/agent-stream-contract.md`. These routes use the Registry router's local
peer/Host/client-header/Origin guards, including in single-hive mode. They never
copy durable reasoning into the Contract-v1 event journal.

## Streaming

- `GET /api/runs/:runId/agents/:instanceId/stream`
- `GET /api/projects/:p/chats/:c/runs/:runId/agents/:instanceId/stream`

Success is `200 text/event-stream`. Every output value (including attempt markers)
is sent unchanged as `id: N`, `event: chunk`, `data: <JSON>`. The final event is
`event: end`, `data: {"status":"SUCCESS"}` (or ERROR/CANCELLED). Unknown run or
instance is 404; invalid cursors are 400. A `: ping` comment is sent every 15 s.

`?fromOffset=N` is inclusive. `Last-Event-ID: N` resumes after N and takes
precedence over the query. Numeric cursors span invocations in durable creation
order: each invocation follows the previous one's yielded output values. SSE does
not expose stream-close marker offsets. During an active recorded run the route
waits for subsequent invocations; when the run is no longer active it sends end.
Without a run snapshot, it ends after all matching recorded workflows settle.
A nonterminal workflow whose run snapshot is no longer active, or whose matching
lease heartbeat owner is confirmed gone, ends with `{"status":"interrupted"}`.
This does not cancel or modify the durable workflow; recovery remains explicit.

Each request owns one non-executing durable client. Writes wait for HTTP drain;
keepalives skip a backpressured response. Disconnect and server close shut down
the reader/client. SQLite reads are paged by the durable module (256 rows).

## Approvals

- `GET|POST /api/approvals`
- `GET|POST /api/projects/:p/chats/:c/approvals`

GET returns `{approvals:[{workflowId,runId,instanceId,agent,step,callId,tool,args,
timeoutSeconds,deadline}]}`. Only nonterminal `waiting_approval` checkpoints with
unexpired deadlines are shown. Legacy checkpoints without timeout metadata use
600 seconds and `deadline:null` (no invented countdown).

POST accepts exactly `{workflowId,callId,approved:boolean}` with JSON and the
usual control headers. It looks up the current checkpoint's durable tool step,
then calls `approveToolCall(...,'human-ui')`. Responses: 202 `{ok:true}`, 404 when
not pending/foreign, 409 when the waiting checkpoint is expired, 400 invalid body,
403 authorization/Origin, 413 oversized body, 415 wrong content type. Verdicts
retain the transport's first-write-wins idempotency key. Disabled single-hive
control refuses POST with 404.

## Run options

Both run POST routes use the same controller:

| Request | CLI |
| --- | --- |
| `sandbox` = scranton/docker/host | `--sandbox VALUE` |
| `trustedHost:true` | `--trusted-host` |
| `sandboxNetwork` = allow/none | `--sandbox-network VALUE` |
| `sandboxNetwork:bridge` | `--sandbox-network allow` |
| `sandboxImage` (Docker only) | `--sandbox-image VALUE` |
| `approvals.tools` | `--approve comma,list` (empty list clears approvals) |
| `approvals.timeoutSeconds` | `--approval-timeout VALUE` |

Omission preserves config defaults (Scranton sandbox). Explicit host mode requires
trust; trust conflicts with another explicit sandbox mode. Docker no longer
requires explicit agent models, ignores neither model nor thinking overrides, and
uses the same signed-in catalogue validation as other modes. LLM calls stay on
the host. Demos pass `SCRANTON_FAKE_MODE=1`, scenario and delay to scripted agents.

## Shared database scoping

All listings, streams and approvals filter workflow IDs on both SQLite and DBOS.
The addressed hive's `agentHiveScopePrefix(hiveDir)` (from core/agent/identity.js)
is accepted, as is an explicit project/chat identity matching the exact registry
scope. Single-hive children therefore work with shared DBOS without receiving
registry IDs. Foreign hive prefixes and ambiguous legacy `single/hive` IDs are
always refused, including on SQLite. No backend-dependent permissive path exists.
See core/agent/README.md for canonical-path hashing and the pre-release legacy
reattachment decision. Moving a hive changes its implicit scope.

Isolation is tested using two hives and one shared SQLite database with identical
run/instance/invocation keys; no PostgreSQL server was used. Stable oldest-first
DBOS listing for multi-invocation cursors remains a separate durable-backend
requirement. The existing relay allowlist has not been widened.

# Run options contract: sandbox, network, approvals, live stream, approvals API

Binding own-runtime contract for orchestrator/config, CLI, server and UI.

## Config (scranton.config.json / loadConfig)
- `execution.sandbox.mode`: `'scranton'` (default, Scranton's own OS sandbox) | `'docker'` (optional tool-only executor) | `'host'` (trusted host; needs the same explicit trust acknowledgement as today).
- `execution.sandbox.network`: `'allow'` (default) | `'none'`. `'bridge'` is accepted as an alias of `'allow'`. With `'none'`, Windows low mode fails closed (only strict mode or Docker can block network).
- `execution.sandbox.image`: Docker image, used only in `docker` mode.
- `approvals`: `{ tools: string[] (subset of the role's tools), timeoutSeconds: integer from 1 to 86400 (default 600) }`. Default `{ tools: [] }` = no approvals.
- Old Pi settings are rejected with an error: any `pi` key, `agents.<id>.extraArgs`, env `SCRANTON_PI_COMMAND`.

## CLI (`scranton run` and follow-ups)
- `--sandbox scranton|docker|host` (default from config). `host` still requires `--trusted-host`.
- `--sandbox-network allow|none` (`bridge` = alias of `allow`), `--sandbox-image IMG` (docker only).
- `--approve TOOLS`: comma list, e.g. `bash,write,edit`. `--approval-timeout SECONDS`.
- `scranton approve <workflowId> <callId> --yes|--no [scope flags]`
- `scranton watch <workflowId> [scope flags]` prints the live stream until the workflow ends.
- Scope flags: the same as for `undo` / `recover` (`--data ... --project ... --chat ...` or `--hive ...`).

## HTTP run request body (POST run / follow-up)
- `sandbox: 'scranton'|'docker'|'host'`; `trustedHost: true` is required for `'host'`.
- `sandboxNetwork: 'allow'|'none'`, `sandboxImage` (docker only).
- `approvals: { tools: string[], timeoutSeconds?: integer from 1 to 86400 (default 600) }`.
- The server maps these 1:1 onto the CLI flags above.

## Live stream route
- Unscoped `GET /api/runs/:runId/agents/:instanceId/stream`; scoped `GET /api/projects/:p/chats/:c/runs/:runId/agents/:instanceId/stream`.
- Server-Sent Events. Resume with `Last-Event-ID` or `?fromOffset=N`. Each event: `id: <offset>`, `event: chunk`, `data: <stream value JSON>` (format in `.enma/agent-stream-contract.md`; consumers drop superseded attempts using the `attempt_start` markers). `event: end` with `{ status }` when the workflow is terminal. Keepalive comment every 15 s.
- The workflow id is derived on the server from project/chat/run/instance plus the invocation (agent-stream-contract). Several invocations of one instance in a run are streamed in order.

## Approvals API
- Unscoped `GET /api/approvals`, `POST /api/approvals`; scoped `GET|POST /api/projects/:p/chats/:c/approvals`.
- GET `{ approvals: [{ workflowId, runId, instanceId, agent, step, callId, tool, args, timeoutSeconds, deadline }] }`: the pending ones only, from `agent_state` = `waiting_approval`.
- POST body `{ workflowId, callId, approved: boolean }` with the usual control headers (`x-scranton-client: 1`, JSON, origin check) -> 202 `{ ok: true }`; 404 when not pending; 409 when expired.
- Server, CLI and UI all go through `approveToolCall` from src/core/agent (idempotent per approval key).

Terminal/run-owner and multi-invocation cursor details are pinned in `src/server/AGENT-ROUTES.md`: Last-Event-ID resumes after the given cursor and wins over inclusive fromOffset. Lost owner may yield interrupted without cancelling the workflow. Models use the same signed-in catalogue/default/Automatic rule in every sandbox mode; Docker is tool-only and receives no credentials.

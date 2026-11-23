# CLI reference

Use the Team CLI, inspect durable workflow streams, and recover interrupted ownership safely.

[Back to the README](../../README.md)

## Run options

Run `node bin/scranton.js --help` for the authoritative local command list. Examples below use `node bin/scranton.js`; substitute `scranton` if you linked the CLI.

| Option | Meaning |
| --- | --- |
| `--workspace DIR`, `--hive DIR`, `--config FILE` | Target folder, runtime data, configuration. Defaults: `./workspace` (`./demo-workspace` for demo), `./hive`, `./scranton.config.json`. |
| `--parallel N` | Maximum active milestone pipelines (default 3); parallel execution requires worktrees. |
| `--sandbox scranton\|docker\|host` | Default native OS sandbox, optional Docker, or explicitly trusted host. `--sandbox host` requires `--trusted-host`. No silent host fallback. |
| `--sandbox-image IMAGE` | Locally available Linux image (default `scranton-tools:24-r2`). |
| `--sandbox-network allow\|none` | `allow` permits tool networking (`bridge` is an alias); `none` requests blocking tool networking, not host LLM calls. Unsupported combinations fail closed. |
| `--trusted-host` | Explicitly choose or acknowledge host execution. Worktrees remain separate in Worktree mode. |
| `--no-plan` | Use one task without model planning. |
| `--request-file FILE` | Request from a bounded text or strict v1 envelope file. See below. |
| `--max-cycles N` | Failed-cycle safety cap per milestone since the last human decision (default 12; 1–50). |
| `--max-stalled N` | Consecutive stalled cycles before asking a human (default 2; 1–10). |
| `--milestone-tokens N` | Token budget per milestone since the last human decision (default 500000; `0` disables; server 0–20000000). |
| `--on-breaker ask\|abort\|skip\|hive` | Terminal decision (`ask`, default; aborts without a TTY), automatic decision, or file-based decision. |
| `--timeout-min N` | Per-agent time limit (default 20 minutes). |
| `--permissions ask\|auto\|bypass`, `--approve TOOLS`, `--approval-timeout S` | [Access policy and tool approval settings](sandbox-and-approvals.md). |
| `--gates STAGES`, `--conversation`, `--no-conversation` | [Team gate workflow and conversation mode](team-roles-gates.md). |
| `--data DIR`, `--project ID`, `--chat ID` | [Registry and thread scope](projects-chats-context.md). |

### Request files

```powershell
node bin/scranton.js run --request-file request.txt --workspace "C:\Projects\MyApp" --hive .scranton-hive
```

Files must be valid UTF-8 (optional BOM removed) or UTF-16 with an LE or BE BOM. If the first non-whitespace character is `{`, the content must be exactly the strict envelope `{"v":1,"request":"..."}` with no extra keys; malformed JSON is rejected. Otherwise the content is literal text, including JSON arrays or scalars, minus exactly one trailing LF, CRLF, or CR. Requests must be nonblank and at most 32768 JS string characters. File size is at most 262144 bytes. Missing files, directories, symlinks, hardlinks, oversize files, and invalid contents result in Exit 2 with `Invalid request file` and a short reason. The CLI never deletes user request files. A positional request cannot be used together with `--request-file`.

### Standalone agent and exit codes

`agent <michael|dwight|oscar|hank|angela> "Task"` starts exactly one audited instance with the same lease and isolation as a run. No extra QA pipeline runs, and default private-worktree changes are not integrated. Explicit Shared Host mode operates directly in the workspace.

General exit codes: 0 success; 1 partial, failed, or aborted; 2 invocation error; 130 Ctrl+C. Undo has [its own result meanings](restore-points.md#exit-status).

## Durable runtime and streams

- `src/core/tools/` contains deterministic tools with path containment, centralized truncation, and JSON schemas. File-tool checks are not shell or OS isolation.
- `src/core/llm/` and `src/core/credentials/` implement provider clients, Claude/ChatGPT/Antigravity OAuth, Gemini API keys, and compatible custom providers.
- `src/core/durable/` runs SQLite workflows per chat in `<hive>/dbos.sqlite`, with markers in `<hive>/agent-step-markers`. Only `DBOS_SYSTEM_DATABASE_URL` or `DBOS_DATABASE_URL` select real DBOS on Postgres; `DATABASE_URL` is intentionally ignored. The SDK is loaded only for that backend. Keep the database and uncheckpointed markers together.
- `src/core/agent/` runs the agent loop as a workflow. It exposes durable `output`/`history` streams and `agent_state` phases `thinking`, `tool_call`, `waiting_approval`, `compaction_failed`, and `done`. Terminal workflow status is authoritative; exactly-once external effects are not guaranteed.

Agent invocations checkpoint model and tool steps; they are not CLI/RPC processes. Cancellation signals in-flight requests and tools. Cleanup is awaited before the lease is released. Uncertain external effects are not presumed to have failed or blindly retried.

Session IDs identify instances but do not load Pi session files. Canonical model history is in the workflow `history` stream; `output` holds produced output. Each new invocation is a separate workflow; reusing an explicit invocation key attaches to the same workflow. Durable steps do not automatically resume a whole orchestrator run. The Hive and database contain sensitive tasks, replies, and reasoning; do not include them in releases.

HTTP: `GET /api/runs/:runId/agents/:instanceId/stream` (SSE) and `GET|POST /api/approvals`; Registry routes are under `/api/projects/:p/chats/:c`. Reconnect with `Last-Event-ID` or inclusive `?fromOffset=N`. POST approvals with `{workflowId,callId,approved:boolean}` and the control headers. See [Control API](../CONTROL.md#durable-agent-streams-and-tool-approvals) and [Agent routes](../../src/server/AGENT-ROUTES.md) for exact cursor, scope, and access rules. See [tool approval CLI examples](sandbox-and-approvals.md#tool-approvals) for `watch` and `approve`.

## Direct instance chat

`agent_chat({to,text})` addresses exact instance IDs. Humans use instance chat or `POST /api/chat`. `queued` does not mean sent; `delivered` means accepted by the durable steering queue, not consumed by the model. `rejected` is definitive, while `unknown` stays uncertain and is never resent automatically. There is no standalone `message` CLI command. See the [Control API](../CONTROL.md#6-parallel-execution-direct-chat-and-durable-ownership-additive).

## Run ownership and recovery

A durable run lease prevents two writers on one Hive. After an interruption, the next CLI run automatically recovers only if the recorded process is provably absent on this host, the recorded host is this host or absent (legacy), the matching heartbeat is older than 30 seconds, and cleanup is verified. A recovered run is marked aborted and follows normal archiving when the next run starts. Otherwise the CLI reports the process state, heartbeat age, and host. Wait and retry, or confirm recovery only after checking that the former processes and containers really stopped. The same stricter rules apply to CLI recovery without confirmation; automatic server recovery uses its own rules. Neither resumes an old agent process.

```powershell
node bin/scranton.js recover --hive .scranton-hive
node bin/scranton.js recover --data .scranton-data --project PROJECT-ID --chat CHAT-ID
# Only after verifying that all earlier processes and containers have stopped:
node bin/scranton.js recover --hive .scranton-hive --confirm-stopped
```

A live owner is never released. Unknown ownership or unverified container cleanup keeps the lease without `--confirm-stopped`; confirmed recovery can still return cleanup warnings. Do not blindly delete lease files or terminate stored PIDs. See [recovery details](../CONTROL.md#6-parallel-execution-direct-chat-and-durable-ownership-additive).

# Agent workflow contract v1

Entry point: `src/core/agent/index.js`. Orchestrator defaults to startAgent; CLI/server consume its durable streams and approvals. No Pi process or RPC transport is used.

## Runner and lifecycle

`startAgent(options)` synchronously returns `{ workflowId, sessionId, done, sendMessage(text), abort(), kill(reason) }`. `done` always resolves with `{ ok, text, keyword, usage, exitCode, durationMs, failure, sessionId, cleanupComplete }`. Usage is `{input,output,cost}`; cost is USD. Keyword extraction uses the existing last-known-bracketed-keyword rule. Agent/model failure is an outcome with `ok:false`, not necessarily an ERROR workflow status.

Options retain `instanceId`, `sessionId`, `agentId`, `agentConfig`, `cwd`, `hive`, `runId`, `systemPromptFile`, `timeoutMs`, and consumer callbacks. `message` overrides the Hive inbox. `messages` supplies canonical initial history. Extra injection points: `runtime`, `llm`, `scripted` (test/demo-only; see agent README), `credentials`, full `model` descriptor, `spawn` or `sandbox: {spawn}`, `onLog`, `systemPrompt`, `approvals`, `maxTurns` (default 100), `compactTokenLimit`, `retrySeconds` (default 2). `agentConfig` provides tools/provider/model/thinking/keywords and optional approvals. The model descriptor and prompt/inbox/history are snapshotted in immutable workflow inputs, never reread during replay. Credential values, callbacks, and environments are not stored in workflow inputs.

With a fresh injected runtime, startAgent registers the workflow and launches the runtime. For explicit recovery setup, call `registerAgentWorkflow(runtime, defaults)` **before** `runtime.launch()`, then launch it yourself. Defaults may include an injected LLM, credentials and callbacks, including a spawn adapter. Register every workflow before launch. A later startAgent on that registered runtime assumes the owner has launched it. An existing workflow ID is attached, not restarted with new input. Recovery without a runner uses the registered defaults and the original saved inputs. To recover test/scripted requests, inject the provider at registration or bind startAgent before automatic launch.

Without injection, runtimes are cached per absolute Hive directory in the process. Storage is `<hive>/dbos.sqlite`, markers are `<hive>/agent-step-markers`, executor is `run:<runId>` (fallback `run:single`). The caller must hold the run lease; do not share a SQLite file between live processes. `shutdownAgentRuntimes()` closes owned runtimes; injected runtimes remain caller-owned. The backend follows durable module selection: only DBOS-specific database URL variables select Postgres; DATABASE_URL is ignored. `agentAppVersion()` is package version plus a SHA-256 fingerprint of sorted agent JavaScript sources. Changing code intentionally prevents old-version recovery; migrating workflows is not implemented.

Workflow name: `scranton.agent.v1`. `agentWorkflowId({projectId,chatId,runId,instanceId,invocationKey})` returns `scr:<projectId>/<chatId>/<runId>/<instanceId>/<invocationKey>` with each component URI-encoded. With hiveDir (or hive.dir), the default prefix is agentHiveScopePrefix: scr:single/hive-<SHA-256 of canonical absolute hive>/. Explicit projectId and chatId together override it. Only the pure helper without a hive path retains single/hive defaults. Server scope checks reject ambiguous legacy IDs on both backends; see src/core/agent/README.md. `startAgent` accepts an explicit deterministic `invocationKey` (the orchestrator includes milestone/cycle/role/purpose/attempt). The same key attaches/replays that invocation; changed keys start new workflows even for the same instance. Without a key, startAgent assigns `auto:<n>` using a per-process counter per `(runId,instanceId)`; this is not a restart/recovery identifier. Explicit keys or `workflowId` are required for deliberate cross-process recovery. `workflowId` overrides generated identity. Session IDs do not restore Pi sessions. When omitted, a stable UUIDv8 is derived from workflow ID. First-launch calls on the same runtime share one launch promise; externally registered runtimes remain owner-launched.

Unless `message` or `messages` is supplied, the runner reads `hive.inboxPath(agentId)` (the role mailbox used by the current non-RPC orchestrator), prefixed with the existing instruction: "Your Hive inbox message is attached. Do the work it describes and end your final message with exactly one status keyword on its own line, as your role instructions require." The orchestrator supplies exact instance mailbox content through message.

Pi options, nonempty extraArgs, SCRANTON_PI_COMMAND and legacy Pi `execution` callbacks fail explicitly. The low-level startAgent API defaults to direct Node spawn (not an isolation guarantee); `options.spawn` takes precedence over `options.sandbox.spawn` (bound to its object); either is passed as tools `ctx.spawn`. An injected spawn must preserve the tools module's ChildProcess/stream/lifecycle contract. **The orchestrator prepares the configured native/Docker executor and injects its spawn; direct API callers must supply isolation themselves.** Tools enforce their documented path/allowlist/schema rules and remove secret/session environment names before subprocess launch. The executor supplies OS isolation; no claim is made that path checks confine shell command contents.

## Durable output stream

Read with `runtimeOrClient.readStream(workflowId, 'output', {fromOffset})`. Each yielded entry is `{offset,value}`, where offsets are durable transport cursors, not model sequence numbers.

Before every request attempt:

```json
{"type":"attempt_start","step":"llm:0","attempt":1}
```

Text/reasoning chunks:

```json
{"v":1,"step":"llm:0","attempt":1,"seq":0,"kind":"text","delta":"hello"}
```

`kind` is `text|thinking`. Deltas of the same kind are coalesced and flushed on incoming events about every 100 ms and at attempt end; a stalled stream may flush later. `seq` starts at zero per attempt. `step` is `llm:<turn>` or `compact:<turn>:<overflow-trim-index>`. Retries are at most five attempts with 2 s initial backoff and factor 2; only classified transient LLM failures retry. No tool retry policy is enabled.

On **every marker**, discard prior chunks for that step, even when the attempt number is unchanged: process recovery may restart an incomplete attempt with number 1. Only append chunks for the active step/attempt. Stored failed-attempt chunks remain in the stream. `readAgentOutput(client,id)` collects terminal output with superseded attempts dropped. Reasoning here is sensitive durable data, separate from the existing Contract-v1 event journal; consumers must not copy it into that journal.

On normal success or handled error, output and history streams are explicitly closed. **Terminal workflow status SUCCESS / ERROR / CANCELLED is authoritative and ends readers**, even without an explicit close marker. Cancellation can preempt finally checkpoints on both SQLite and DBOS; consumers must combine `agent_state` with `retrieveWorkflow(id).getStatus()`, not wait indefinitely for phase done. `agent_state` may retain its last nonterminal phase after cancellation. The in-process runner aborts its request/tool AbortController, sends cancellation, emits ephemeral `{type:'agent_settled',aborted:true}`, waits for its local body cleanup and resolves done with an aborted/timeout failure (`kill('user')` is `interrupted`; `abort()` is `aborted`). Already committed external effects cannot be undone. External client cancellation is observed at durable checkpoints; it does not directly signal an in-process fetch controller.

## Agent state and approvals

`getEvent(workflowId,'agent_state')` returns the latest checkpoint:

```json
{"phase":"thinking","detail":{"step":"llm:0"},"ts":"2026-11-21T00:00:00.000Z"}
```

Phases/details:
- `thinking`: `{step}` before an LLM/compaction step.
- `tool_call`: `{tool,callId}` before a tool step.
- `waiting_approval`: `{workflowId,step,tool,args,callId,timeoutSeconds,deadline}`; step is the durable tool position `tool:<turn>:<index>`. `timeoutSeconds` is the configured approval timeout; `deadline` is an ISO-8601 UTC string computed from checkpointed `now()` plus that timeout. The receive loop uses the same deadline; replay preserves it rather than restarting the countdown.
- `compaction_failed`: `{step,message}` before continuing with uncompacted history; also emits a best-effort checkpointed `onLog({level:"warn",message})` callback. Warning callback failures are ignored.
- `done`: null on success, or `{kind,message}` on handled failure.

Timestamps come from checkpointed `now()`. Event values are last-write-wins snapshots, not an event log. Approval is opt-in: `{tools:['write','powershell'],timeoutSeconds:60}`, default none. Only the matching workflowId + step + callId with a boolean verdict is accepted; stale/foreign replies are consumed and ignored without extending the checkpointed deadline. Timeout/denial becomes a model-visible error tool result, not an infrastructure failure.

`approveToolCall(runtimeOrClient,workflowId,{step,callId},approved,by)` sends to topic `tool_approval`:

```json
{"workflowId":"scr:...","step":"tool:0:0","callId":"model-tool-call-id","approved":true,"by":"human"}
```

The idempotency key is `JSON.stringify([workflowId,step,callId])`: the first verdict for that durable tool position wins. Provider call IDs may repeat across turns; an approval for an earlier position cannot authorize or deny a later one. Callers must use the step and callId from the waiting_approval checkpoint, never guess the current turn. Authorization and human identity checks belong to the server/CLI caller, not this transport helper. Arguments/model text are untrusted; render them as text, never executable HTML.

## Steering and history

`sendMessage(text)` sends `{text}` to the workflow's `steer` topic, with a new idempotency key. It returns `{ok:true,delivery:'delivered'}` only after durable queue acceptance, which is not proof of model consumption. Finished/aborted invocations reject; an uncertain transport failure returns delivery unknown and must not be automatically resent. Before each main LLM request, the workflow drains steer messages with zero-timeout receives and adds them as user messages. Messages accepted during the final LLM request may remain unconsumed when the agent finishes.

History is derived from checkpointed LLM/tool/receive results. The workflow writes a separate `history` stream with `{v:1,type:'replace',messages}` and `{v:1,type:'append',message}`. Workflow-level writes replay without duplicates. Compaction emits replace with the new model-visible history. `readAgentHistory(client,id)` folds this stream into canonical messages; while active it waits until terminal/closure. To incrementally display history, consume the stream directly. This is not a Pi session-file reader, and compacted history deliberately omits earlier assistant/tool turns.

## Consumer callbacks

- `onLive(record)`: ephemeral streaming records. LLM start -> message_start; block events -> message_update with `message` and `assistantMessageEvent` (`type`, `contentIndex`, `delta`/`content`); terminal -> message_end including usage. Tools emit tool_execution_start/end. Existing createLiveActivity can consume these unchanged. Recovered completed steps do not recreate live deltas; replay output through the durable stream instead.
- `onAssistantMessage(text,hasToolCalls)`: successful main assistant text, inside a checkpointed callback step after the LLM result. Compaction summaries are not surfaced as agent answers.
- `onUsage({model,usage})`: one successful request's delta using existing messageUsage, including compaction, inside the same callback step. Failed-attempt billing is not included; unlike Pi's per-message_end accounting, only successfully checkpointed requests contribute here. This is not a provider billing ledger.
- `onTool({tool,activity,detail,targetFile,command})`: inside the tool step before dispatch. Shapes follow describeTool. `onToolEnd({tool,isError})`: inside a separate checkpointed completion step, including recovered interrupted commands.
- `onMessage({to,text})`: agent_chat invokes it inside its at-most-once tool step. Valid boolean ACKs are preserved. Thrown, invalid or timed-out (10 s) ACKs return `{ok:false,delivery:'unknown',error}`. No automatic resend. An external callback already in flight may still settle after that timeout; its outcome remains unknown.

Completed steps skip callbacks on replay. **Exactly-once external journal callbacks cannot be guaranteed across a hard exit between callback side effects and checkpoint commit.** Downstream external journals still need stable dedupe keys or transactional integration to claim exactly-once writes. Shell/chat at-most-once markers prevent repeating unfinished external sends/commands and return a model-visible interrupted/unknown-outcome result. These tool names are classified from the tools README's documented table because tool metadata is currently available only after dispatch. File mutations retain the tools module's guarded metadata; a crash after a file mutation but before its step checkpoint can still cause a repeated write or an edit mismatch on recovery. No unimplemented atomic filesystem/database guarantee is claimed.

## Model and compaction policy

Explicit provider+model must both be set. Built-ins resolve through the catalogue; custom declarations come from credentials.store.read().providers (only projected model metadata enters workflow inputs). Auth is resolved per request through createCredentials().resolveAuth, never from Pi settings.

Automatic selects the first signed-in account in this fixed order, using explicit newest-per-provider markers in `llm/catalogue.js`:
1. anthropic / claude-opus-5-5
2. openai / gpt-6.2-sol (user choice for ChatGPT mode; direct OAuth and API keys use the API catalogue)
3. google / gemini-4-argon
4. google-antigravity / gemini-3.8-flash
5. google-vertex / gemini-4-argon

Markers require catalogue updates for new releases; selection is offline, not live entitlement discovery.

No supported signed-in account is an explicit error. There is no inference from catalogue sort order and no automatic custom-provider selection.

Compaction triggers after a response plus its tool results at min(90% of model window, positive SCRANTON_AUTO_COMPACT_TOKEN_LIMIT or explicit compactTokenLimit). It also runs post-final-response while preserving that final answer as the outcome. Summarization uses the Codex checkpoint prompt/prefix, retains newest real user messages within the 20000-token approximation (UTF-8 bytes / 4), middle-truncates the overflowing oldest retained user, and drops assistant/tool messages. Overflow removes the oldest paired history item and makes a new named durable request. Safe error classification CONTEXT_WINDOW_EXCEEDED (including provider-classified HTTP 400) or HTTP 413 supports this. Other compaction errors, including exhausted overflow trimming, are nonfatal: preserve uncompacted history and the valid final answer/keyword, emit a compaction_failed checkpoint and optional warning callback, and continue. No real-model acceptance is claimed.

## Verification

Focused gate: `node --test "test/core/agent/*.test.js"`. Fixtures and negative-control receipts stay under `.scratch/agent-tests/`. No real-provider calls in these focused tests. Recovery tests hard-exit after a completed write and during an unfinished shell step, then reattach using an explicit invocation key. Review regressions exercise repeat invocations/key replay, concurrent first launch, failed compaction after tool/final turns, repeated provider call IDs with stale/foreign approvals, interruption, role mailbox instructions, and bound sandbox spawning. Scripted tests cover scenarios, knobs, failure modes, actual write tool effects, generated-source tests, JSON prompt logs, and environment activation in a child process. Negative controls reverting each of seven review fixes fail their targeted tests; production sources are restored afterward. See the agent README for the environment mapping and final test count.

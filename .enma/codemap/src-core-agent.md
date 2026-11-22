# Code map: src/core/agent

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "src/core/agent/index.js"
symbol: "startAgent"
ordinal: 0
kind: "how"
text: "The runner seam (replaces Pi's startPi): `Orchestrator`'s constructor defaults `startRunner = startAgent` and calls it once per agent invocation. startAgent derives a deterministic `workflowId` via `agentWorkflowId` (explicit project/chat, else per-hive prefix) from runId/instanceId/invocationKey, binds callbacks (onLive, onUsage, ...) and the sandbox spawn to a durable workflow on the injected `runtime`, and returns `{ sessionId, workflowId, done, abort, kill(why), sendMessage(text) }`. `done` resolves `{ ok, text, keyword, usage, exitCode, durationMs, failure }`; failure messages pass through `errorText` with process.env + extraEnv. It always prefixes the first user message with AGENT_MESSAGE (status keyword instruction), rejects Pi options/extraArgs/SCRANTON_PI_COMMAND and `execution` overrides, and validates approvals `{tools, timeoutSeconds}`. Without an explicit invocationKey it falls back to a per-process `auto:N` counter, which is not replay-stable - the orchestrator always passes one."
see_also: "src/core/agent/README.md; .enma/agent-stream-contract.md; src/core/agent/workflow.js"
hash: "span:e68d4eb7b2c579be"
written: "2026-11-22"
commit: "709b8c5"
by: "core"
---

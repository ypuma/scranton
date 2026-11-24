# Durable agent runner

Entry point: `index.js`. `startAgent` is the orchestrator's default runner for CLI,
server and desktop runs; it uses Scranton's own LLM clients, tools and durable runtime.
The consumer and recovery protocol is documented in `.enma/agent-stream-contract.md`.

```js
const runner = startAgent({
  runtime, // optional; register/launch semantics are in the contract
  instanceId: 'dwight-m1', agentId: 'dwight', runId: 'run-1',
  invocationKey: 'm1/cycle-1/implement', // same key replays, new key invokes again
  sandbox, // optional object exposing Node-compatible spawn; or supply spawn directly
  cwd: workspace, hive, sessionId,
  agentConfig: { provider: 'openai', model: 'gpt-6.2-sol',
    tools: ['read', 'write', 'edit'], keywords: ['TASK_COMPLETE'] },
  systemPromptFile,
  onAssistantMessage, onLive, onTool, onToolEnd, onUsage, onMessage,
});
const outcome = await runner.done;
```

Exports: `startAgent`, `registerAgentWorkflow`, `agentWorkflowId`, `agentAppVersion`,
`approveToolCall`, `readAgentHistory`, `readAgentOutput`, `shutdownAgentRuntimes`,
`selectModel`, `AUTOMATIC_MODELS`, and `describeTool`.

Automatic uses the first signed-in account in Anthropic, OpenAI/ChatGPT, Gemini,
Antigravity, Vertex order. It selects the catalogue's explicit newest marker, not
lexical model ordering: Opus 5.5, GPT-6.2 Sol (user-pinned ChatGPT choice), Gemini 4
Argon, Gemini 3.8 Flash, Gemini 4 Argon respectively (2026-11-22). Selection is
offline; newer releases need a catalogue update and account access is not guaranteed.
ChatGPT OAuth uses a separate supported model snapshot; API keys retain the OpenAI
API catalogue. Custom providers still require explicit selection.

For deterministic tests inject `llm: createScriptedProvider(turns)` and a full `model`
descriptor. This avoids credential lookup. Inject credentials explicitly when testing
Automatic/custom-model selection. Injected runtimes and credentials remain caller-owned.

Register all workflows before launching a runtime. `registerAgentWorkflow(runtime, defaults)`
allows recovery without a live runner binding; defaults hold the LLM/spawn/callback adapters.
Workflow inputs retain only plain serializable data. Runtime databases and at-most-once
markers must be retained together. The default runtime pool is process-owned and can be
closed with `shutdownAgentRuntimes()`.

No OS sandbox is implemented here; default spawn is direct. `options.spawn` or a bound
`options.sandbox.spawn` supplies the tools `ctx.spawn` seam. Explicit spawn takes priority.
Pi options and `execution` adapters are rejected, including on completed-workflow reattachment.
The orchestrator prepares the configured native/Docker executor and supplies its sandbox;
explicit trusted-host mode uses direct spawn. Usage/assistant and tool-end callbacks are
checkpointed; live deltas remain attempt-scoped. Cancellation can leave
agent_state at its last phase; terminal workflow status is authoritative. `kill('user')`
reports `interrupted`; `abort()` reports `aborted`. Compaction failures are warnings, not
failed answers; history is retained and overflow trimming still retries.

## Workflow identity and hive scope

`agentHiveScopePrefix(hiveDir)` is the shared server/runner helper. It returns
`scr:single/hive-<SHA-256>/`, hashing the canonical absolute hive path (existing
ancestors resolved through realpath, including junctions). Windows paths are
lowercased before hashing. Missing path suffixes are resolved lexically, so creating
a hive later does not change its identity. Moving a hive, or retargeting a junction,
changes its scope; preserve its path for replay. The full digest avoids unnecessary
collision risk in a shared database.

`agentWorkflowId({hiveDir, ...})` appends URI-encoded run/instance/invocation
components to that prefix. `hive.dir` is also accepted. When **both** projectId and
chatId are supplied, their URI-encoded components take precedence, unchanged.
`startAgent` always supplies a hive path, falling back to `<cwd>/hive`.
The pure helper without a hive path retains its legacy `single/hive` defaults.
The same path and explicit invocation key attach to the same workflow/session on
SQLite or shared DBOS; storage backend never enters identity.

Compatibility decision (pre-release): no automatic lookup or migration of ambiguous
`scr:single/hive/...` records. Such IDs cannot be assigned safely to one hive in a
shared database. Existing records are not deleted: durable read APIs and explicit
`startAgent({workflowId: oldId, ...})` reattachment still work, subject to the existing
app-version recovery policy. HTTP routes intentionally hide unscoped old IDs on
**both** backends. No released own-runtime persisted-data migration is required;
operators with development records must use explicit IDs for old reattachment, not
expect an implicit invocation-key lookup to find them. Explicit project/chat IDs
remain visible only in that exact registry scope.

## Scripted test/demo runner

This is **test/demo-only**, not a provider selection or production fallback. It never activates
from the environment unless both `SCRANTON_FAKE_MODE=1` and a nonempty
`SCRANTON_FAKE_SCENARIO` are set. A scenario variable alone never selects a fake model. No `FAKE_PI_*` aliases are read.
In-process callers can use `startAgent({ ...options, scripted: 'happy' })` or an options object:

```js
scripted: { scenario: 'flaky', delayMs: 10, fail: 'stoperror', failRole: 'angela', log: logFile }
```

Scripted invocations need no credentials or model injection. They use per-invocation
`createScriptedProvider` turns through the normal durable agent loop, with fixed token usage
(800 input / 120 output per successful turn), streamed thinking/text, real allowlisted
`ls`/`read`/`write` tools and a simulated shell spawn returning passing test output. Explicit
caller spawn/sandbox adapters take precedence over the simulated spawn. No actual shell
commands are executed by the default scripted adapter. Generated Todo sources are executable;
tests independently run their real node:test suite. Tool allowlists are never widened.

| Old fake-pi variable | New variable | In-process option / behavior |
|---|---|---|
| `FAKE_PI_SCENARIO` | `SCRANTON_FAKE_SCENARIO` | `scenario`: happy, flaky, breaker, blocked, question (also changes_once/security_issues gates) |
| `FAKE_PI_DELAY_MS` | `SCRANTON_FAKE_DELAY_MS` | `delayMs`, delay before each provider turn |
| `FAKE_PI_<ROLE>_DELAY_MS` | `SCRANTON_FAKE_<ROLE>_DELAY_MS` | `<role>DelayMs`, overrides global delay |
| `FAKE_PI_LOG` | `SCRANTON_FAKE_LOG` | `log`, append JSONL invocation receipt |
| `FAKE_PI_FAIL` | `SCRANTON_FAKE_FAIL` | `fail`: exit1, hang, stoperror, nomessage |
| `FAKE_PI_FAIL_ROLE` | `SCRANTON_FAKE_FAIL_ROLE` | `failRole`, restrict failure to role |
| `FAKE_PI_PLAN` | `SCRANTON_FAKE_PLAN` | `plan: 'invalid'`, missing usable plan JSON |
| `FAKE_PI_KEYWORD` | `SCRANTON_FAKE_KEYWORD` | `keyword`, override final keyword only with matching `keywordRole` |
| `FAKE_PI_KEYWORD_ROLE` | `SCRANTON_FAKE_KEYWORD_ROLE` | `keywordRole`, restrict override to role |
| `FAKE_PI_MISSING_KEYWORD_ROLE` | `SCRANTON_FAKE_MISSING_KEYWORD_ROLE` | `missingKeywordRole`, omit final keyword |
| `FAKE_PI_LONG_TEXT` | `SCRANTON_FAKE_LONG_TEXT` | `longText: true` or env `1`, prepend 17000 characters |
| `FAKE_PI_REPORT_FAIL` | `SCRANTON_FAKE_REPORT_FAIL` | `reportFail`, failure mode or `missing`, only report_request |
| `FAKE_PI_EXPECT_PROMPT` | `SCRANTON_FAKE_EXPECT_PROMPT` | `expectPrompt`, assert resolved system prompt contains text |
| `FAKE_PI_DETERMINISTIC` | `SCRANTON_FAKE_DETERMINISTIC` | `deterministic`, accepted; scripted usage is always deterministic |

Scenario inputs come from the immutable inbox frontmatter (`kind`, `milestone`, `cycle`) with
runner metadata fallbacks. Flaky fails the QA Tester's (id `angela`) first m2 cycle; breaker keeps
failing m2 until human feedback; blocked stops the Developer (id `dwight`) at m2 until feedback;
question lets the Planner (id `michael`) answer directly in `SCRANTON_CONVERSATION=1` mode. Closing
reports and report-failure injection also require conversation mode; otherwise the Planner produces
a plan. Gates other than the QA Tester produce verdicts without tool calls. Code Reviewer, Security
Auditor and custom gate verdicts
use role keywords, including SCRANTON_PASS_KEYWORD / SCRANTON_FAIL_KEYWORD overrides.

Failures reproduce runner outcomes, not an obsolete Pi process/protocol: `exit1` -> `exit`,
`stoperror` -> `stop_reason`, `nomessage` -> `no_message`, `hang` waits for cancellation/timeout.
Injected failure kinds are encoded in a stable error name as well as `agentFailure`,
so durable error serialization (name/message only) preserves classification on replay.
RPC wire-malformation fixtures are not emulated; the own runner has no Pi RPC transport.
The JSONL log replaces argv inspection with `{role,cwd,milestone,cycle,kind,scenario,instanceId,
runId,agentConfig,message,messages,systemPrompt,systemPromptFile,scranton}`. Only non-secret
execution identity/role SCRANTON fields enter `scranton`, not the entire environment.

For child-process CLI/server tests, set both fake-mode environment variables on the child.
`test/core/helpers.js` provides `scriptedConfig`; `fakeConfig` delegates to it, and `runFake`
uses the own runtime. Scripted providers are not stored in workflow inputs:
recovery must register equivalent provider defaults before launch, as with injected LLMs.

## Consumer corrections

The runner adds the status-keyword instruction to supplied messages as well as
mailbox input, without duplicating it when already present. Canonical initial
history receives it in the first textual user message (or a prepended user turn).
Cancelled outcomes retain input/output/cost accumulated from completed LLM requests,
including replayed checkpoints and compaction, rather than returning null usage.
Incomplete/failed-attempt provider billing is still outside this accounting contract.

## Verification

Run `node --test "test/core/agent/*.test.js"`. Fixtures stay in `.scratch/agent-tests/`.

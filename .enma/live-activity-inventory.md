# Live Activity, Thinking, Kanban, Usage & Cost: Inventory and Additive Contract

_Status: Proposed Additive Specification_  
_Target Architecture: Project Scranton (Web Dashboard `visualizer/public/`, Node Server `src/`, Python Engine `engine/`)_  
_Scope: Four User Features: (1) Live Agent Thinking, (2) Current Activity & Target Files, (3) Kanban Board, (4) Cost & Usage Diagram_

---

## 1. Executive Summary

This inventory examines the existing data flows, event models, and state representations across Project Scranton's two execution engines:
1. **Team Engine** (`src/core/orchestrator.js` running `@earendil-works/pi-coding-agent` v1.5.0 in RPC/JSON mode).
2. **Pipeline Engine** (`engine/src/scranton_pipeline` running a 16-node LangGraph sync state graph in Python with Node supervisor `src/core/pipeline-supervisor.js`).

It maps what data is already present on the wire and in memory, identifies what is missing or discarded, and proposes a minimal, non-breaking, purely additive contract extension that delivers all four requested UI features.

---

## 2. Inventory by Domain

### A. Transport and State Architecture

#### 1. Transport Mechanisms
- **Team Chats**:
  - **Live Streaming**: Server-Sent Events (SSE). The browser connects to `GET /events` (single mode) or `GET /api/projects/:p/chats/:c/events` (registry mode). Scoped routes require header `X-Scranton-Client: visualizer`.
  - **Implementation**: `src/server/visualizer-server.js` (`handleEvents`, `EventTail`). On initial connect, `EventTail` begins reading from byte offset `0` of `hive/events.jsonl`, replaying all historical lines for the current run as SSE `data: <json>\n\n`, then polls and streams newly appended lines.
  - **Snapshots**: `GET /api/state` or `GET /api/projects/:p/chats/:c/state` returns `hive/state.json`.
  - **Archives**: `GET /api/projects/:p/chats/:c/runs` returns `runs: RunSummary[]`. `GET /api/projects/:p/chats/:c/runs/:runId/events` replays `runs/<runId>/events.jsonl`.
- **Pipeline Chats**:
  - **Polling**: No SSE feed exists for Pipeline chats (`visualizer/public/js/main.js` line 300: *"A team chat follows its event stream; a pipeline chat has no stream, its view polls the pipeline routes"*).
  - **Endpoint**: `visualizer/public/js/pipeline-view.js` and `pipeline-model.js` poll `GET /api/projects/:p/chats/:c/pipeline/runs/:runId?after=N`.
  - **Paging Bound**: `src/core/pipeline-supervisor.js` (`inspect()`) pages events from `<runDir>/events.jsonl`, capping each response to 500 events (`events.length < 500`).

#### 2. Retention Bounds
- **Terminal Dashboard Source** (`src/dashboard/source.js`):
  - Uses `createHiveSource(hiveDir, { tailBytes = 64 * 1024, headBytes = 16 * 1024, maxEvents = 500 })`.
  - Reads only the last 64 KB of `events.jsonl` plus the 16 KB head (`run_started`).
  - Maintains an in-memory sliding window `conversationEvents` capped at `maxEvents = 500`. Older events are discarded via `conversationEvents.shift()`.
  - Caches at most 119 `gate_result` entries (`gateResults.size > 119`).
- **Web Dashboard Feed** (`visualizer/public/js/main.js`):
  - In-memory event array `liveEvents` is capped at `CHAT_EVENTS_MAX = 5000` (line 30). When exceeded, events are trimmed with `liveEvents.splice(1, liveEvents.length - CHAT_EVENTS_MAX)`.
  - `state.chat` retains the last 200 chat messages (`src/core/state.js` line 89).

#### 3. State Object Shapes and Reducers
- **Server State (`hive/state.json`)**:
  - Produced by `src/core/state.js` (`reduce(state, event)`), serialized atomically to disk on every event.
  - Top-level schema:
    ```ts
    interface ServerState {
      v: 1;
      runId: string | null;
      status: "idle" | "planning" | "running" | "paused" | "finished" | "aborted" | "failed";
      request: string | null;
      workspace: string | null;
      updatedAt: string; // ISO-8601
      lastSeq: number;
      milestones: Array<{
        id: string;
        title: string;
        dependsOn: string[];
        status: "pending" | "active" | "passed" | "skipped" | "failed" | "aborted" | "blocked";
        cycle: number;
        failedCycles: number;
      }>;
      currentMilestoneId: string | null;
      activeMilestoneIds: string[];
      instances: Record<string, {
        id: string;
        agent: string;
        milestoneId: string | null;
        sessionId: string;
        worktree: string | null;
        sandbox: { mode: string; image: string; network: string } | null;
        status: "starting" | "thinking" | "working" | "waiting" | "blocked" | "error" | "done";
        activity: string;
        tool: string | null; // NOTE: String only on server! e.g. "read"
      }>;
      chat: Array<{ id: string; ts: string; from: string; to: string; text: string; delivery: string; reason?: string }>;
      execution: {
        maxParallel?: number;
        isolation?: string;
        sandbox?: object;
        persistentSessions?: boolean;
        conversation?: boolean;
        workflow?: { gates: string[][] };
      } | null;
      cycle: number;
      failedCycles: number;
      maxFailedCycles: number;
      breaker: "closed" | "tripped";
      agents: Record<string, {
        status: string;
        activity: string;
        lastKeyword: string | null;
        updatedAt: string;
        totals: { runs: number; input: number; output: number; cost: number };
      }>;
      reply?: { from: string; kind: string; text: string; truncated?: boolean };
      roles?: Array<{ id: string; name: string; title: string; kind: string; builtin: boolean }>;
    }
    ```
- **Client State (`visualizer/public/js/state.js`)**:
  - Produced in the browser by `createState()` and `reduce(state, rawEvent)`.
  - Diverges additively from server `state.json`:
    - `instances[id].tool` is an object: `{ tool: string, detail: string } | null`.
    - `instances[id].lastTool` is preserved: `{ tool: string, detail: string, ts: string | null } | null`.
    - `instances[id].totals`: `{ runs: 0, input: 0, output: 0, cost: 0, durationMs: 0 }`.
    - `agents[id].tool` and `agents[id].lastTool`: mirror active instance tools.
    - Adds `mailboxes`, `log`, `gates`, `milestoneIndex`, `milestoneTotal`, `cycleOpen`, `hitl`, `lastDecision`.
- **Client Consumer Modules**:
  - `visualizer/public/js/feed.js`: SSE/fetch stream ingestion and demo simulation.
  - `visualizer/public/js/dashboard.js`: Top header bar, run metadata, clock, breaker state.
  - `visualizer/public/js/lanes.js`: Parallel instance cards, instance activities, last tool rendering.
  - `visualizer/public/js/chat-view.js`: Unified transcript rendering container.
  - `visualizer/public/js/chat-adapter-team.js`: Adapts `{ events, state, runs }` into unified `Entry[]`.
  - `visualizer/public/js/chat-adapter-pipeline.js`: Adapts `{ run, events, list }` into unified `Entry[]`.
  - `visualizer/public/js/pipeline-model.js`: Normalizes polled pipeline `status.json`, `plan.json`, `review.json`.
  - `visualizer/public/js/pipeline-view.js`: Details panel for Pipeline runs (stepper, diffs, checks).

---

### B. Thinking / Reasoning Stream

#### 1. Real Pi Agent Capabilities
- As verified in `@earendil-works/pi-coding-agent` v1.5.0 (`node_modules/@earendil-works/pi-coding-agent/docs/json.md` and `docs/message-types.md`):
  - When invoked with a thinking-capable model and `--thinking <level>`:
  - **Streaming Events** (`message_update`):
    - `thinking_start`: `{ type: "message_update", usage: Usage, assistantMessageEvent: { type: "thinking_start", contentIndex: number } }`
    - `thinking_delta`: `{ type: "message_update", usage: Usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: number, delta: string } }`
    - `thinking_end`: `{ type: "message_update", usage: Usage, assistantMessageEvent: { type: "thinking_end", contentIndex: number, content: string } }`
  - **Turn Completion** (`message_end`):
    - Assistant message `content` array contains `ThinkingContent` blocks:
      `{ type: "thinking", thinking: string, thinkingSignature?: string, redacted?: boolean }` alongside `TextContent` (`{ type: "text", text: string }`) and `ToolCall` (`{ type: "toolCall", id, name, arguments }`).

#### 2. Current Scranton Handling
- **Completely Dropped**:
  - In `src/core/pi-runner.js` (`startPiJson` lines 117-148): The event dispatch loop switches on `session`, `message_end`, `tool_execution_start`, `tool_execution_end`, `agent_settled`, `auto_retry_end`. Event `message_update` is **not handled** and silently ignored.
  - In `src/core/pi-runner.js` (`assistantText` lines 61-68): Content blocks are filtered strictly by `block?.type === 'text'`. Thinking blocks (`type === 'thinking'`) are discarded.
  - In `src/core/pi-rpc-session.js` (lines 146-150): `message_update` is **not handled**. Content in `message_end` filters for `b.type === 'text'`.
  - In `docs/EVENTS.md` (line 183): The contract explicitly states: *"Text is untrusted assistant text, never thinking or tool arguments"*.

#### 3. Fake Fixtures
- `tools/fake-pi.js`:
  - Emits `message_update` for `toolcall_start` and `text_delta` (lines 132, 152).
  - Emits intermediate `message_end` in conversation mode before tool calls.
  - Does **not** emit `thinking_start`, `thinking_delta`, or `thinking_end`.
- `tools/fake-pi-rpc.js`:
  - Emits only terminal `message_end`.
  - Does **not** emit `message_update`, `text_delta`, or thinking events.

#### 4. Intermediate Assistant Text Deltas
- In streaming mode, `text_delta` events inside `message_update` are currently dropped by both `pi-runner.js` and `pi-rpc-session.js`.
- In conversation mode (`SCRANTON_CONVERSATION === '1'`), intermediate text is only received as a complete block when pi emits an intermediate `message_end` with stopReason `toolUse`. `orchestrator.js` buffers this and emits a single, atomic `agent_message { text, final: false }` right before `agent_tool`. No live streaming text deltas reach the UI.

---

### C. Current Activity & Tool Tracking

#### 1. Tool Events and Payloads
- **Start Event**: `agent_tool` (`docs/EVENTS.md` line 29, `src/core/orchestrator.js` line 569):
  ```json
  {
    "v": 1,
    "seq": 14,
    "ts": "2026-11-12T01:00:00.000Z",
    "runId": "run-xyz",
    "type": "agent_tool",
    "agent": "dwight",
    "instanceId": "dwight-m1",
    "tool": "read",
    "detail": "src/index.js"
  }
  ```
  - Emitted when pi outputs `tool_execution_start { toolCallId, toolName, args }`.
  - `tool`: The tool identifier (`read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, `ls`).
  - `detail`: Computed by `describeTool(tool, args, workspace)` in `src/core/pi-runner.js`:
    - `read`, `write`, `edit` -> relative file path (from args `path`, `file_path`, `filePath`, `file`).
    - `bash`, `powershell` -> command string (from args `command`, `cmd`, `script`).
    - `grep`, `find` -> pattern or file (from args `pattern`, `query`, `glob`, `regex`).
    - `ls` -> path or `'.'`.
    - Hard ceiling: `detail` is clipped to 140 characters in `src/core/events.js` (line 78).
- **End Event**: **None**.
  - There is no `agent_tool_end` event in `events.jsonl`.
  - Instead, when `tool_execution_end` arrives, `src/core/orchestrator.js` (line 572) calls:
    `this.setStatus(agentId, 'thinking', 'Thinking...', instanceId)`.
  - The status change to `'thinking'` causes the reducers to set `inst.tool = null`.

#### 2. Derivation of "Last tool"
- In `visualizer/public/js/state.js` (lines 549, 555):
  - On `agent_tool`: `inst.lastTool = { tool: e.tool ?? '', detail: e.detail ?? '', ts: e.ts ?? null }`.
  - On `agent_status` transition to `'thinking'`, `inst.tool` is cleared to `null`, but `inst.lastTool` remains unchanged.
  - In `visualizer/public/js/lanes.js` (lines 84-85):
    `const act = inst.tool ? `${inst.activity} · ${inst.tool.tool} ${inst.tool.detail}` : inst.activity;`

#### 3. Gap Analysis for Current Activity
- **Tool currently running**: Derivable in the browser today from `inst.tool !== null`.
- **Target file currently running**:
  - Only present in `inst.tool.detail` IF the tool happens to be `read`, `write`, or `edit`.
  - If the tool is `bash`, `detail` is the command line (e.g. `npm test`), not a target file.
  - In `state.json` written by `src/core/state.js`: `s.instances[instanceId].tool` is serialized as **only a string** (e.g. `"read"`). The `detail` is lost on initial page load from `state.json` until replayed from `events.jsonl`!
- **Recently touched files**: Completely absent. Neither server nor client tracks a list of recently modified/read files per instance.
- **Pipeline Engine**: Emits **zero tool events**. The implementer returns file edits in batch; they are applied directly in Python via Git.

---

### D. Usage and Cost

#### 1. Source and Granularity
- **Team Mode**:
  - **Source**: `r.message.usage` reported by pi at each assistant turn in `pi-runner.js` (lines 125-130) and `pi-rpc-session.js` (lines 149-150):
    `{ input: number, output: number, cost: { total: number } }`.
  - **Granularity**: Emitted in `agent_finished` as `usage: { input, output, cost }`. This happens **once per invocation** (when Michael plans/reports, Dwight finishes a coding cycle, or a gate completes).
  - **Timestamps**: Timestamped at the event's completion (`agent_finished.ts`).
  - **Missing**: Real-time token usage during an active turn (streaming `message_update.usage`) is discarded.
- **Pipeline Mode**:
  - **Source**: Recorded per LLM invocation by `UsageLedger` in `<run-dir>/usage.jsonl` (`engine/src/scranton_pipeline/observability.py`).
  - **Granularity**: Per LLM call. Emitted in `events.jsonl` as `llm_call { role, model, ok, input_tokens, output_tokens, duration_s, estimated }`.
  - **Cost**: Estimated using static model pricing tables in `engine/src/scranton_pipeline/report.py` (`usage_summary`). Summarized in `status.json` under `"usage"`.

#### 2. Totals in State
- **Per Agent**:
  - `state.agents[agentId].totals: { runs: number, input: number, output: number, cost: number }` exists in `state.json` and client `state.js`.
  - Cumulative within the current run only.
- **Per Run**:
  - **Missing in Team State**: There is no top-level `state.totals` or `state.cost` field. Clients must sum `Object.values(state.agents)`.
  - In Pipeline: `status.usage: { calls: number, input_tokens: number, output_tokens: number, estimated_cost: number | null }` exists.
- **Per Chat**:
  - **Completely Missing**: `chat.json` and `listRuns()` (`src/core/thread.js`) store no token or cost summaries across historical runs.

#### 3. Time Series Feasibility (Client vs Server)
- **Client Derivation Limitation**:
  - In theory, a client could fold `agent_finished` (Team) or `llm_call` (Pipeline) events into a cumulative step graph.
  - **Why it breaks**:
    1. Terminal dashboard drops older events past 500 events or 64 KB (`source.js`).
    2. Web client caps `liveEvents` at 5,000 events (`main.js`).
    3. Reconnection or page reload against `/api/state` receives `state.json`, which contains no historical timeline points.
    4. Granularity in Team mode is sparse (points occur only every few minutes when an agent settles).
- **Verdict**: A bounded time series (`timeSeries: Array<{ ts: string, input: number, output: number, cost: number, agent: string }>`) **must be maintained server-side** in the run state.

---

### E. Kanban Board Data Model

#### 1. Team Milestone Model
- **State Values in `state.milestones[i]`**:
  - `id`: `"m1"`, `"m2"`, etc.
  - `title`: string.
  - `dependsOn`: `string[]` (prerequisite milestone IDs).
  - `status`: `"pending"` | `"active"` | `"passed"` | `"skipped"` | `"failed"` | `"aborted"` | `"blocked"`.
  - `cycle`: 1-based cycle counter (incremented when Dwight starts work).
  - `failedCycles`: consecutive failures for this milestone.
- **Run & Circuit Breaker Context**:
  - `state.breaker`: `"closed"` | `"tripped"`.
  - `state.hitl`: `{ milestoneId, reason, options } | null`.
  - `state.instances`: maps active instance IDs (`dwight-m1`, `angela-m1`, `oscar-m1`, `hank-m1`).
  - `state.gates[agent]`: `{ milestoneId, cycle, stage, result: "passed"|"failed"|"blocked"|"error", keyword }`.
- **Kanban Column Mapping**:
  | Kanban Column | Team Engine Criteria |
  |---|---|
  | **To Do / Backlog** | `m.status === 'pending'` AND all `dependsOn` milestones are `'passed'`. |
  | **In Progress** | `m.status === 'active'` AND Dwight instance is active (`status === 'working' || status === 'thinking'`), or cycle failed and Dwight is preparing next attempt. |
  | **In Review** | `m.status === 'active'` AND any gate instance (`oscar`, `hank`, `angela`) is active, or Dwight finished and gates are evaluating. |
  | **Blocked / Human Needed** | `m.status === 'blocked'` OR (`m.status === 'active'` AND (`state.breaker === 'tripped'` OR `state.hitl?.milestoneId === m.id` OR active instance has `status === 'blocked'`)). |
  | **Done** | `m.status === 'passed'` (or `m.status === 'skipped'`). |

#### 2. Pipeline Plan-Step Model
- **State Values in `plan.steps[i]` & `status.progress`**:
  - `plan.steps`: `Array<{ id: string, title: string, description: string, files: FileIntent[], depends_on: string[] | null, criteria: string[] }>`.
  - `status.progress.steps_done`: count of completed steps.
  - `state.steps_done`: `Array<{ step_id: string, attempts: number, commit: string, changed_files: string[] }>`.
  - `status.phase`: `"prepare"` | `"plan"` | `"approve_plan"` | `"implement"` | `"review"` | `"deliver"` | `"done"`.
  - `status.progress.lanes`: active parallel execution lanes `[{ id: string, step_id: string, status: string }]`.
- **Kanban Column Mapping**:
  | Kanban Column | Pipeline Engine Criteria |
  |---|---|
  | **To Do** | Step `id` not in `steps_done`, not active in `lanes`, and phase is prior to or during `implement`. |
  | **In Progress** | Phase is `implement` AND step `id` is listed in `status.progress.lanes` or is current sequential step. |
  | **In Review** | All steps are implemented AND phase is `review` (Reviewer node) OR `approve_delivery` (human gate). |
  | **Blocked / Human Needed** | Phase is `awaiting_approval` (`approve_plan` or `approve_delivery`) OR `status === 'suspended'`. |
  | **Done** | Step `id` is present in `steps_done`. |

---

### F. Pipeline vs. Team Feature Comparison

| Feature | Team Engine (`src/core`) | Pipeline Engine (`engine/`) |
|---|---|---|
| **A. Transport** | SSE stream (`/events`) + atomic state snapshot (`/api/state`). Replays full run from offset 0. | Polling `GET .../pipeline/runs/:id?after=N`. No SSE. Paged in 500-event chunks. |
| **B. Live Thinking** | Supported by pi; dropped by Scranton runner. | Not supported. Gateway uses structured Pydantic extraction. No thinking tokens exposed. |
| **C. Current Tool & File** | Emits `agent_tool { tool, detail }` on start. Ends on status `'thinking'`. File in `detail` for read/write/edit. | No tool calls. Implementer outputs structured file edits applied by Git in Python. |
| **D. Usage & Cost** | Sparse: `agent_finished.usage` per turn. Agent totals in `state.agents`. No run total. | Detailed: `llm_call` per node, `usage.jsonl` ledger, `status.usage` estimated cost. |
| **Supervisor Mapping** | N/A (native Node engine). | `src/core/pipeline-supervisor.js` does **not** map Python events to Team dashboard events. Events served verbatim. |

---

### G. Test and Fixture Matrix

The following test suites pin the current contracts and behavior:
- **Core Tests** (`test/core/*.test.js`):
  - `pi-runner.test.js`: Validates `startPiJson`, `describeTool`, exit handling, usage extraction.
  - `pi-rpc.test.js`: Validates `startPiRpc`, RPC handshake, chat extension protocol.
  - `orchestrator.test.js`: Milestone DAG, cycles, breaker trips, gate ordering, tool event emission.
  - `conversation.test.js`: Conversation mode, `agent_message`, `run_reply`.
  - `pipeline-bridge.test.js` & `pipeline-supervisor.test.js`: Pipeline process execution and event paging.
- **Server Tests** (`test/server/*.test.js`):
  - `visualizer-server.test.js`: SSE streaming, event replay, offset handling, static routes.
  - `registry-router.test.js`: Scoped routes, project/chat resolution, pipeline proxying.
- **Dashboard Tests** (`test/dashboard/*.test.js`):
  - `source.test.js`: Verifies `createHiveSource` retention limits (64 KB tail, 500 events max).
  - `render.test.js`: Verifies terminal dashboard rendering of agents, tokens, cost, and breaker.
- **Visualizer Tests** (`test/visualizer/*.test.js`):
  - `state.test.js`: Pure reducer tests for `agent_tool`, `agent_status`, `gate_result`.
  - `lanes.test.js`: Parallel lane activity, tool display.
  - `chat-adapter.test.js` & `chat-adapter-pipeline.test.js`: Transcript entry synthesis.
  - `pipeline-model.test.js`: Pipeline status and stepper mapping.
- **Python Engine Tests** (`engine/tests/`):
  - `flow/test_conversation.py`: `agent_message` and direct answer verification.
  - `unit/test_observability_checks.py`: `UsageLedger`, `usage.jsonl`, event logging.

---

### H. Sanitisation and Safety Constraints

Any new field exposed to the frontend or written to events must adhere to existing project security boundaries:
1. **ANSI Control Sequences**: Must be stripped via `stripVTControlCharacters` (`node:util`) before logging or displaying (`src/core/log.js`).
2. **Bidi Override Controls**: Must strip Unicode bidirectional overrides (`/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g`) using `stripBidi` (`visualizer/public/js/format.js`). Model-generated thinking or tool parameters must not spoof layout.
3. **Control Characters**: Must strip ASCII/Unicode control characters (`/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g`, preserving `\n` and `\t`).
4. **Secret & Credential Redaction**:
   - `src/core/pipeline-supervisor.js` (line 124) and `worktree.js`:
     Redact patterns matching `\bBearer\s+\S+`, `\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}`, and `\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+`.
   - Worktree exclusions: `.env*`, `.git`, `.ssh`, `credentials.json`, `auth.json`, `*.pem`, `*.key`.
   - Real model credentials (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) must never appear in thinking text, tool arguments, or logs.
5. **Length Bounds & Throttling**:
   - Thinking text: Must be buffered and throttled (e.g. maximum 10 updates/sec or 500ms intervals).
   - In-memory thinking tail: Maximum 4,000 characters per agent instance.
   - Usage time series: Maximum 120 points per run.

---

## 3. Proposed Minimal Additive Contract

This proposal introduces **no breaking changes**, **no renames**, and **no deletions**. All additions are optional fields on existing objects or new distinct event types.

### 1. Feature 1 & 2: Live Activity & Thinking Contract

#### A. New Event: `agent_thinking`
Emitted by the orchestrator during streaming when pi emits `thinking_delta`:
```ts
interface AgentThinkingEvent {
  v: 1;
  seq: number;
  ts: string;
  runId: string;
  type: "agent_thinking";
  agent: string;
  instanceId: string;
  tail: string;        // Throttled rolling tail of thinking text (max 2,000 chars)
  isNewTurn?: boolean; // True when a new thinking block begins
}
```
*Emission policy*: Throttled to at most once every 350 ms per instance to prevent saturating SSE buffers.

#### B. Augmented `agent_tool` Event
Add optional structured fields to `agent_tool` while preserving existing `tool` and `detail`:
```ts
interface AgentToolEvent {
  v: 1;
  seq: number;
  ts: string;
  runId: string;
  type: "agent_tool";
  agent: string;
  instanceId: string;
  tool: string;              // existing: "read", "edit", "bash", etc.
  detail: string;            // existing: clipped 140-char string
  targetFile?: string | null;// NEW: Normalized relative target file path (if tool operates on a file)
  command?: string | null;   // NEW: Command line (if tool is bash/powershell)
}
```

#### C. New Event: `agent_tool_finished`
Explicitly signals the end of tool execution (replacing the heuristic `agent_status('thinking')`):
```ts
interface AgentToolFinishedEvent {
  v: 1;
  seq: number;
  ts: string;
  runId: string;
  type: "agent_tool_finished";
  agent: string;
  instanceId: string;
  tool: string;
  durationMs: number;
  isError: boolean;
}
```

#### D. Server State Additions (`state.json.instances[instanceId]`)
Augment the instance object in `src/core/state.js`:
```ts
interface InstanceState {
  // Existing fields: id, agent, milestoneId, sessionId, worktree, sandbox, status, activity, tool ...
  tool: {
    name: string;
    targetFile: string | null;
    command: string | null;
    startedAt: string;
  } | null;
  lastTool: {
    name: string;
    targetFile: string | null;
    command: string | null;
    ts: string;
  } | null;
  thinkingTail: string | null;  // Last 2,000 chars of active thinking, null when not thinking
  touchedFiles: string[];       // FIFO array of up to 10 recently accessed/modified relative paths
}
```

*Producer Symbol in Server*: `src/core/pi-runner.js` (`startPiJson` and `pi-rpc-session.js`) handles `message_update`, parses `thinking_delta`, and forwards throttled chunks to `orchestrator.js:onThinking`.

---

### 2. Feature 3: Kanban Board Contract

Both engines map cleanly into a 5-column Kanban model without requiring engine rewrites.

#### A. State Enrichment
Add `kanbanStage` to `state.milestones` in `src/core/state.js`:
```ts
interface MilestoneState {
  id: string;
  title: string;
  dependsOn: string[];
  status: "pending" | "active" | "passed" | "skipped" | "failed" | "aborted" | "blocked";
  cycle: number;
  failedCycles: number;
  kanbanStage: "todo" | "in_progress" | "in_review" | "blocked" | "done";
}
```

#### B. Calculation Rules in Reducer (`reduce`)
1. If `m.status === "passed" || m.status === "skipped"` -> `"done"`.
2. If `m.status === "blocked"` OR (`m.status === "active"` AND (`s.breaker === "tripped"` OR `s.hitl?.milestoneId === m.id`)) -> `"blocked"`.
3. If `m.status === "active"`:
   - If any gate instance (`oscar`, `hank`, `angela`) has `status === "working" || status === "thinking"` -> `"in_review"`.
   - Else if Dwight instance has `status === "working" || status === "thinking"` -> `"in_progress"`.
   - Else if `m.failedCycles > 0` and awaiting retry -> `"in_progress"`.
   - Else -> `"in_progress"`.
4. If `m.status === "pending"` -> `"todo"`.

#### C. Pipeline Kanban Support
In `visualizer/public/js/pipeline-model.js`, expose a helper `stepKanbanStage(step, status, plan)`:
- `"done"`: Step in `steps_done`.
- `"blocked"`: Run status is `"awaiting_approval"` or `"suspended"`.
- `"in_review"`: Implementation finished, phase is `"review"` or `"approve_delivery"`.
- `"in_progress"`: Phase is `"implement"` and step is active in `lanes` or `step_index`.
- `"todo"`: Remaining unexecuted steps.

---

### 3. Feature 4: Usage & Cost Time Series Contract

#### A. Run-Level Usage Object in `state.json`
Add top-level `usage` to `src/core/state.js` (`initialState` and `reduce`):
```ts
interface StateUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;       // In USD, e.g. 0.042
  byAgent: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    turns: number;
  }>;
  timeSeries: Array<{
    ts: string;            // ISO timestamp of measurement
    totalTokens: number;   // Cumulative tokens up to this point
    totalCost: number;     // Cumulative cost up to this point
    agent: string;         // Agent that produced the turn
  }>;                      // Bounded to max 120 points (sampled or pruned)
}
```

#### B. Chat-Level Summary in `RunSummary` (`src/core/thread.js`)
Augment `readRun()` and `listRuns()` so past runs report final usage:
```ts
interface RunSummary {
  runId: string;
  goal: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string;
  reply: object | null;
  // NEW ADDITION:
  usage?: {
    totalTokens: number;
    totalCost: number;
  };
}
```
This enables the frontend to compute chat-wide cumulative expenditure without re-reading archived `events.jsonl` files.

---

## 4. Feasibility and Complexity Summary

1. **Live Thinking (Team)**: High feasibility. `pi` already emits `thinking_start/delta/end` on stdout in both JSON and RPC modes. The only requirement is consuming `message_update` in `pi-runner.js` / `pi-rpc-session.js` and throttling SSE emissions.
2. **Live Thinking (Pipeline)**: Infeasible without engine changes. LangGraph gateway uses structured invocation; provider thinking streams are not exposed.
3. **Current Tool & Target File (Team)**: High feasibility. `describeTool` already extracts the file path for file operations. Storing `{ name, targetFile, command }` in `state.instances` and emitting `agent_tool_finished` is straightforward.
4. **Current Tool & Target File (Pipeline)**: Infeasible for tools (Pipeline does not run interactive tools), but file targets are known from `step.files` and `edits_applied`.
5. **Kanban Board**: Zero backend changes required for a basic implementation (can be calculated as a pure client-side view derivation). Adding `kanbanStage` to `state.json` provides official consistency across all dashboards.
6. **Usage Diagram & Time Series**: High feasibility. Server-side accumulation in `state.usage.timeSeries` circumvents all client retention bounds and provides a rock-solid data source for SVG/canvas rendering.

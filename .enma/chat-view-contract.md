# Chat View and Return Message Contract (Core, 2026-11-11)

Authoritative specification for three parallel implementation lanes: Backend, Web UI, and Terminal Dashboard.
Extends `docs/EVENTS.md`, `docs/CONTROL.md`, `.enma/multiproject-contract.md`, and `.enma/roles-contract.md`.
Default is `execution.conversation: false`: all existing tests, oracle runs, and recordings remain 100% byte-identical.

## 1. Engine Switch (`execution.conversation`)
- **Normalized structure**: `execution.conversation` (boolean). Engine and CLI default `false`.
- **Precedence**: Request body (`POST /api/runs` and scoped `POST P/runs` `conversation`) > CLI (`--conversation` / `--no-conversation`) > Env (`SCRANTON_CONVERSATION=1|0`) > Config (`execution.conversation`) > default `false`.
- Web UI and Desktop shell ALWAYS send `conversation: true` for every run they start (real, follow-up, and fake-pi demo).
- Recorded in `run_started.execution.conversation` (boolean). Injected into child process environment as `SCRANTON_CONVERSATION=1|0`.

## 2. Events & State Additions (Additive v1)
- **`agent_message`**:
  `{ v: 1, seq: <int>, ts: "<ISO>", runId: "<id>", type: "agent_message", agent: string, instanceId: string, milestoneId: string|null, cycle: number|null, text: string, final: boolean, truncated?: boolean }`
  - Emitted ONLY when `execution.conversation === true`.
  - `text`: Assistant text content only (never thinking blocks or tool arguments). Max 16,000 characters; text exceeding 16,000 chars is clipped to 16,000 and `truncated: true` is set. Empty/whitespace-only messages are suppressed.
  - `final: false`: Intermediate assistant messages emitted on assistant `message_end` before `tool_execution_start` (`agent_tool`).
  - `final: true`: Terminal assistant message ending the agent's turn. Emitted BEFORE `hive_write` (outbox.md) and BEFORE `agent_finished`.
- **`run_reply`**:
  `{ v: 1, seq: <int>, ts: "<ISO>", runId: "<id>", type: "run_reply", from: string, kind: "answer"|"report"|"summary", text: string, truncated?: boolean }`
  - Exactly one per conversation run, emitted directly BEFORE `run_finished`. Max 16,000 characters (clipped with `truncated: true`).
- **`state.json`**:
  - Adds `reply: { from: string, kind: "answer"|"report"|"summary", text: string, truncated?: boolean } | null` (starts `null` at `initialState()` and `run_started`).
  - Reducer: `reduce(state, event)` sets `s.reply = { from: event.from, kind: event.kind, text: event.text, ...(event.truncated ? { truncated: true } : {}) }` on `run_reply`. `agent_message` updates `lastSeq` and `updatedAt` without altering state fields.

## 3. Main Return Message Lifecycle, Prompts & Failure Paths
- **Direct Answer (`kind: 'answer'`)**:
  - In conversation mode, Michael's inbox task prompt (`planRequestBody`) includes a direct-answer section:
    "If the request is a question, inquiry about the codebase, or needs no file changes, inspect the workspace with your read tools, answer directly, and end with `[ANSWER_READY]` on its own last line. Do NOT output a milestones JSON block. If changes are needed, plan milestones as normal and end with `[PLAN_READY]`."
  - Keywords: In conversation runs only, Michael's keywords are `['PLAN_READY', 'ANSWER_READY']`.
  - On `ANSWER_READY`: Milestone execution is bypassed. `text` (excluding `[ANSWER_READY]`) is emitted as `run_reply { from: 'michael', kind: 'answer', text }`. Run settles with `run_finished { status: 'success', summary: 'Answered by Michael' }`.
  - No revert, ever: an answer run integrates nothing. In worktree isolation Michael's checkout is discarded exactly as after planning today, so the workspace is untouched. In shared isolation the orchestrator behaves as during planning today and never reverts or deletes files (the workspace may hold the user's own uncommitted work). See section 13.2.
- **Run Report (`kind: 'report'`)**:
  - If milestones ran (success, partial, or failed), Michael is invoked for a final report with dedicated timeout 120s (2 minutes).
  - Digest input: bounded to 8,000 chars: original request, milestone outcomes (id, title, status, cycles), last agent outbox report per milestone, and breaker/skip reasons. Ends with instruction to summarize the run and terminate with `[REPORT_READY]`.
  - Session resumption:
    - **RPC**: Spawns pi with `instanceId: 'michael'`, a fresh UUID `sessionId: randomUUID()` (clean context window; bounded self-contained digest in prompt/inbox), timeout 120s.
    - **JSON**: Spawns pi with `@michael/inbox.md` containing the digest, timeout 120s.
  - On `REPORT_READY`: Emits `run_reply { from: 'michael', kind: 'report', text }` directly before `run_finished`.
- **Deterministic Summary Fallback (`kind: 'summary'`)**:
  - Emitted when: Michael's report step times out, crashes, exits non-zero, or omits `[REPORT_READY]`; or when a run is stopped, aborted via HITL, or fails before planning. No model call is made.
  - Format: Composed deterministically by the orchestrator from run outcome, request, milestone statuses, and failure reason.
    Example: `Run finished with status "partial": 2 passed, 1 failed.\n- m1 Todo storage: passed (cycle 1)\n- m2 CLI: failed (cycle 3: Angela reported [TEST_FAILED])`.

## 4. History, API & Thread Context
- **`GET /api/projects/:p/chats/:c/runs` & `GET /api/runs`**:
  - Returns `runs: RunSummary[]`. Each run summary:
    `{ runId: string, goal: string, status: string, startedAt: string|null, endedAt: string|null, current: boolean, summary: string, reply: { kind: 'answer'|'report'|'summary', text: string, truncated?: boolean } | null }`.
  - `reply` is read from `state.json.reply` or the archived `run_reply` event. `reply.text` is bounded to 4,000 chars.
- **Thread Context (`src/core/thread.js` `formatThreadContext`)**:
  - Includes earlier run replies when present:
    `Run <id> | <status>\nGoal: <goal>\nReply (<kind>): <replyText>\nSummary: <summary>`.
  - Per-reply text bounded to 4,000 chars; total thread context retains 8,000 character limit (preferring newest runs).

## 5. Fake Pi Harness Extensions
- Recognizes `SCRANTON_CONVERSATION=1`. If not set, output remains 100% byte-identical to existing baseline.
- When `SCRANTON_CONVERSATION=1`:
  - Agents emit one intermediate assistant message before calling tools (e.g. `Checking workspace files.`).
  - Michael:
    - New scenario `FAKE_PI_SCENARIO=question`: Emits inspection tool call (`ls`), then answers directly with `[ANSWER_READY]`.
    - Report step: When inbox kind is `report_request`, emits concise report ending with `[REPORT_READY]`.
  - `tools/fake-pi-rpc.js`: Settle logic accepts `[ANSWER_READY]` and `[REPORT_READY]`.

## 6. CLI Additions
- `scranton run "<request>" [--conversation | --no-conversation]` and `scranton demo [--conversation | --no-conversation]`.
- Defaults to `--no-conversation`.
- With `--conversation`: Logs compact one-line agent messages as they settle, and prints the full return message (`run_reply.text`) with header `── Return message (<kind>) ──` before exiting.

## 7. Engine-Neutral Chat View (Web UI)
- **View Toggle**: Header control `#view-mode-toggle` with buttons `#view-mode-chat` (Chat) and `#view-mode-dash` (Dashboard).
  - Default: `'chat'`. Stored in `localStorage.getItem('scranton.view_mode')`.
  - When `'chat'`: hides `#dash`, displays `#chat-view`. When `'dashboard'`: displays `#dash`, hides `#chat-view`.
- **Engine-Neutral Entry Data Model**:
  ```ts
  type Entry = {
    id: string;                                                      // Unique entry id (e.g. req-<runId>, msg-<seq>, rep-<runId>)
    runId: string;                                                   // Run id
    kind: 'request' | 'agent' | 'activity' | 'human' | 'question' | 'reply';
    ts: string;                                                      // ISO timestamp
    who?: { id: string; name: string; title: string };               // Sender info
    context?: string;                                                // e.g. "m1: Todo storage (cycle 1)"
    text?: string;                                                   // Body text or summary
    final?: boolean;                                                 // For agent messages: true if outbox / turn-settled
    truncated?: boolean;                                             // True if text was clipped
    tone?: 'ok' | 'fail' | 'warn' | null;                            // Visual accent for activities and replies
    replyKind?: 'answer' | 'report' | 'summary' | 'result';          // For kind === 'reply'
  };
  ```
- **Adapter Interface**: `(source) -> Entry[]`.
  - Team Adapter module: `visualizer/public/js/chat-adapter-team.js` exporting `teamChatAdapter({ events, state, runs }) -> Entry[]`.
    - `run_started` -> `request` entry (`text: event.request`).
    - `agent_message` -> `agent` entry (`text`, `who`, `context`, `final`, `truncated`).
    - `agent_tool`, `milestone_started`, `milestone_finished`, `cycle_result`, `gate_result` -> quiet `activity` entries (one-line summary, `tone`).
    - `chat_message` (`from: 'human'`) -> `human` entry.
    - `hitl_request` -> `question` entry with the reason; `hitl_response` -> `human` entry ("You chose Retry", plus the feedback text). The answer controls are the existing `#hitl` panel, see section 13.7.
    - `run_reply` -> primary `reply` entry (`replyKind`, `text`, `tone: status === 'success' ? 'ok' : 'fail'`).
    - Legacy / Non-conversation fallback: If a run lacks `agent_message` events, maps `hive_write` outbox summaries to `agent` entries and `run_finished.summary` to `reply` entry with `replyKind: 'summary'`.
  - Pipeline Adapter module: `visualizer/public/js/chat-adapter-pipeline.js` (implements the same `Entry[]` interface for Pipeline runs).
- **DOM-Only Safe Markdown Subset** (No `innerHTML` or HTML parsing permitted):
  - Supported elements created via `document.createElement`:
    - Paragraphs: separated by `\n\n` -> `<p>`.
    - Headings: `# `, `## `, `### ` -> `<h3>`, `<h4>`, `<h5>`.
    - Lists: lines starting with `- `, `* `, or `1. ` -> `<ul>` / `<ol>` with `<li>`.
    - Fenced Code: ` ```[lang] ... ``` ` -> `<pre><code>` with `textContent`.
    - Inline Code: `` `code` `` -> `<code>`.
    - Bold: `**text**` -> `<strong>`.
    - URLs / Links: rendered as plain text nodes (`textContent`); clickable `<a>` tags are forbidden.
- **Scroll & Tail-Follow Invariants** (`#chat-view-scroll`):
  - Must follow the trap notes in `visualizer/public/js/chat-panel.js` and `log.js`: trust `follow` boolean over geometry when height is 0 or hidden.
  - Upward user scroll sets `follow = false`; scrolling to bottom or clicking Jump button (`#chat-view-jump`) resets `follow = true`.
  - `ResizeObserver` on `#chat-view-scroll` calls `toBottom()` whenever height changes while `follow === true`.
- **Multi-Run Conversation History & Lazy Loading**:
  - Past runs from `GET .../runs` render initially as collapsed cards displaying `request` and `reply` entries.
  - Expand button (`.chat-run-expand[data-run-id="..."]`) fetches `GET .../runs/:runId/events` on demand, caches the events, and expands the full detailed `Entry[]` transcript.
- **Composer**: see section 13.7 (the existing `#followup` composer starts runs; `#chat-view-to` + `#chat-view-input` + `#chat-view-send` message an agent while a run is live).

## 8. Terminal Dashboard
- Recognizes `agent_message` and `run_reply` in `src/dashboard/source.js` `EVENT_TYPES`.
- `agent_message`: Suppressed from rolling event log to prevent screen flooding.
- `run_reply`: Renders as a dedicated log line `[['reply [', 'bold'], [e.kind, MUTED], ['] ', 'bold'], [clip(sanitize(e.text), 80), null]]`.
- Finished-run alert box (`alertLines` in `render.js`): Displays the reply text or excerpt when `st.reply` or `run_reply` is present.
- When `conversation: false`: Dashboard renders 100% byte-identically to today.

## 9. File Ownership Matrix (Strict Single Ownership)
| Lane | Owned Files |
|---|---|
| **Backend** | `src/core/config.js`, `src/core/cli.js`, `src/core/events.js`, `src/core/state.js`, `src/core/orchestrator.js`, `src/core/messages.js`, `src/core/thread.js`, `src/core/pi-runner.js`, `src/core/pi-rpc-session.js`, `src/core/hive.js`, `src/core/chat-router.js`, `src/server/control.js`, `src/server/registry-router.js`, `src/server/visualizer-server.js`, `tools/fake-pi.js`, `tools/fake-pi-rpc.js`, `bin/scranton.js`, `docs/EVENTS.md`, `docs/CONTROL.md`, `README.md`, `test/core/**`, `test/server/**` |
| **Web UI** | `visualizer/public/js/chat-view.js` (new), `visualizer/public/js/chat-adapter-team.js` (new), `visualizer/public/index.html`, `visualizer/public/styles.css`, `visualizer/public/js/main.js`, `visualizer/public/js/thread.js`, `visualizer/public/js/scope.js`, `visualizer/public/js/state.js`, `test/visualizer/**` |
| **Terminal Dashboard** | `src/dashboard/source.js`, `src/dashboard/render.js`, `src/dashboard/index.js`, `test/dashboard/**` |

## 10. Existing Tests & Verification Gates
- **Existing Tests Preserved**: Default `conversation: false` ensures all existing tests in `test/core/*.test.js`, `test/server/*.test.js`, `test/dashboard/*.test.js`, and `test/visualizer/*.test.js` remain green without modification.
- **Cross-Lane Parity Tests**: Real-engine parity tests (`test/visualizer/real-run.test.js`, `test/dashboard/custom-agents-real-run.test.js`) are extended with explicit companion tests running with `{ execution: { conversation: true } }` asserting event ordering, state `reply`, and adapter outputs.
- **New Test Suites**:
  - Backend: `test/core/conversation.test.js` (unit testing `agent_message`, `run_reply`, direct answer, report step, fallback, and truncation) and `test/server/conversation.test.js` (`POST /api/runs` and `GET .../runs` reply payload).
  - Web UI: `test/visualizer/chat-view.test.js` (testing `teamChatAdapter`, DOM-only Markdown rendering, collapsed past runs, view switching, and tail-follow scrolling).
  - Terminal: `test/dashboard/conversation.test.js` (verifying `agent_message` suppression and `run_reply` alert rendering).

## 11. Security, Caps & Bounds
- **Untrusted Model Text**: Model outputs in `agent_message.text` and `run_reply.text` are treated as untrusted data. Rendered strictly using DOM properties (`textContent`, `createElement`).
- **Forbidden Operations**: `innerHTML`, `outerHTML`, and `insertAdjacentHTML` are strictly banned. Hyperlinks are rendered as plain text nodes to prevent arbitrary URI execution or open redirects.
- **Caps**: `agent_message.text` <= 16,000 chars; `run_reply.text` <= 16,000 chars; `RunSummary.reply.text` <= 4,000 chars; thread context <= 8,000 chars.
- **Keywords**: extraction is the existing `extractKeyword` (`src/core/keywords.js`), unchanged: the last known bracketed keyword in the FINAL assistant text of the turn. Intermediate messages never drive a transition. See section 13.3.

## 12. Risks & Mitigations
1. *Model Context Overflow during Report*: Michael's report step could fail if conversation history is excessively long. *Mitigation*: The report step uses a fresh session and a strictly bounded 8,000-character digest of milestone outcomes.
2. *Report Step Hang*: An unresponsive model during the report step could stall run finalization. *Mitigation*: Dedicated 120s timeout on the report runner; on expiration, the orchestrator immediately falls back to deterministic summary `run_reply`.
3. *DOM Performance with Large Transcripts*: Long multi-turn conversations could slow down DOM rendering. *Mitigation*: Earlier runs remain collapsed until explicitly opened; intermediate activity events are rendered as lightweight single-line elements.

## 13. Pinned cross-lane details (lead, 2026-11-11; these override anything above that conflicts)
1. **Ownership.** Backend owns ALL of `src/core/**`, `src/server/**`, `bin/**`, `tools/**`, `agents/**`, `docs/EVENTS.md`, `docs/CONTROL.md`, `README.md`, `test/core/**`, `test/server/**`. Web UI owns ALL of `visualizer/public/**` and `test/visualizer/**`. Terminal owns ALL of `src/dashboard/**` and `test/dashboard/**`. `docs/DESKTOP.md`, `src-tauri/**` and `engine/**` belong to other lanes.
2. **Answer runs change no files.** No revert and no deletion in any isolation mode. If it is cheap, the orchestrator logs one `warn` line when the workspace changed while Michael answered in shared isolation; it never acts on it.
3. **Keywords and text.**
   - `extractKeyword` is not changed. In conversation runs Michael's run-scoped keywords are `['PLAN_READY', 'ANSWER_READY', 'REPORT_READY']`; in every other run they stay `['PLAN_READY']`.
   - Planning turn: last keyword `ANSWER_READY` -> answer path. Anything else -> today's behaviour exactly (including the warning and the one-milestone fallback).
   - `agent_message.text` is the assistant text verbatim (capped). `run_reply.text` is the final text with the trailing keyword line removed and trimmed.
4. **Exactly one `final: true` per agent launch** that produced a result: the message whose text is the outbox body. Earlier assistant messages of that launch are `final: false`, also those that ended a sub-turn without a tool call. For the two turns that produce the reply (Michael's answer, Michael's report) the final message is published ONLY as `run_reply`, not also as an `agent_message`.
5. **Event order at the end of a conversation run:** the existing `agent_status` (done/idle) events for every role, then `run_reply`, then `run_finished`. Nothing sits between `run_reply` and `run_finished`.
6. **Report step.**
   - Runs only when Michael is an invoked role (not with `noPlan`) and at least one milestone ran. Otherwise the reply is the `summary` fallback with `from: 'system'`.
   - It runs before the orchestrator closes chat and worktrees, with `instanceId: 'michael'`, `milestoneId: null`, `cycle: null`, status activity "Writing the report...". The request tells Michael to write from the digest and not to inspect or change files.
   - Mailbox: request `hive_write { from: 'human', to: 'michael', kind: 'report_request' }`; Michael's outbox as usual.
   - A stop request, a timeout (120 s), a crash or a missing `[REPORT_READY]` during the report gives the `summary` fallback. The run's `status` and `summary` stay what the milestones produced; a stop during the report does not turn the run into `aborted`. No human question is ever raised by the report step.
   - Aborted and stopped runs, and runs that failed after `run_started` recorded `conversation: true`, get `run_reply { from: 'system', kind: 'summary' }`. If `run_started` could not record conversation mode, there is no `run_reply`.
7. **Web UI.**
   - `conversation: true` is sent by `buildRunRequest` / `buildFollowUp` for real runs and demos. Existing tests that assert exact request bodies may be updated for this field only; list each edit.
   - Chat mode shows: the thread head, `#runline`, the transcript (`#chat-view` with `#chat-view-scroll`), and docked at the bottom: `#hitl` (when a question is pending), then the composer. Dashboard mode is today's layout, unchanged. `#run-picker` belongs to Dashboard mode and is hidden in Chat mode; `#alert`, `#exit-panel`, `#recovery`, `#release-note` stay visible in both modes.
   - One set of answer controls: the existing `#hitl` panel. The transcript only shows the `question` entry and, after the answer, a `human` entry.
   - Run-starting composer = the existing `#followup` form and logic (same element ids, same Options button), docked at the bottom in Chat mode; placeholder "Ask a question or describe a task...". While a run is live, the Chat view shows the steering composer `#chat-view-to` + `#chat-view-input` + `#chat-view-send`, which must share its validation and delivery-state logic with `js/chat-panel.js` (one implementation, two mount points; do not fork it).
   - Agent entries: name, title and context ("m2 · cycle 1"); a trailing keyword line is stripped from the displayed text and shown as a quiet chip; non-final messages are visually lighter; messages longer than about 12 lines are collapsed behind "Show more".
   - Activity entries: consecutive `agent_tool` events of one instance between two messages collapse into ONE line (count plus the last tool); `milestone_started` / `milestone_finished`, `cycle_result` and `gate_result` are one line each. No boxes inside boxes.
   - The reply is the visually primary entry: who, the kind (Answer / Report / Summary / Result), the text, then one quiet line with the outcome and the totals the run line already has.
   - Earlier runs: request and reply are visible without a click; a quiet "Show agent messages" toggle loads that run's events on demand. Runs without a stored reply show their `summary` and status.
   - The Events tab shows `agent_message` and `run_reply` as compact one-line rows (first line, clipped).
   - Pure logic (adapter, Markdown tokenizer, entry grouping) lives in modules without DOM access so the Pipeline adapter can reuse it: `js/chat-adapter-team.js`, `js/chat-markdown.js`, `js/chat-view.js` (DOM). `chat-view.js` exports one factory that takes `{ getEntries }`-style inputs and never reads team events itself.
   - Thread context: per earlier reply at most 1500 characters (section 4 said 4000).
8. **Docker and env.** `SCRANTON_CONVERSATION` reaches agent children in host, RPC and Docker launches the same way `SCRANTON_PASS_KEYWORD` does. Real pi ignores it.
9. **Markdown subset.** As section 7, plus: a line of three or more `-` is a quiet rule; everything else, including tables, raw HTML and images, is literal text. Code blocks scroll horizontally inside themselves; the page never does.
10. **Terminal and CLI.** The CLI header for the reply is `-- Reply (<kind>) --` in ASCII mode and `── Reply (<kind>) ──` otherwise; the reply text passes through the same sanitising as other untrusted text.
11. **Off-mode bytes.** `run_started.execution.conversation` is present only when it is `true`; it is omitted otherwise. `reply` is ABSENT from `state.json` (and from the web reducer's state) until a `run_reply` is reduced, and `run_started` removes it again. Every reader treats a missing `reply` as null. An off-mode event log and `state.json` are therefore byte-identical to today. This replaces "starts `null`" in section 2.

## 14. Review round 1 pins (lead, 2026-11-11)
1. **System-prompt section, conversation runs only.** The orchestrator appends a short "Conversation mode" section to Michael's STAGED system prompt (built-in or custom; the prompt file itself is never changed, `agents/michael/SKILL.md` stays as it is). It says that the "Required answer" section of each request decides between a plan (`[PLAN_READY]`), a direct answer (`[ANSWER_READY]`) and a report (`[REPORT_READY]`), and that this overrides any earlier rule to always reply with a plan. `run_started.prompts.michael.sha256` hashes the text actually used. Off-mode prompts are byte-identical to today.
2. **Reply text.** The trailing keyword is removed from `run_reply.text` also when it is not on its own line (`Done. [ANSWER_READY]` becomes `Done.`).
3. **Nothing an agent said is lost.** The final message of a turn is suppressed as an `agent_message` only when it is actually published as the `run_reply`. If a report turn fails (no keyword, timeout with partial text, crash), whatever text arrived is published as a normal `agent_message`; the same holds for a failed launch that produced text.
4. **CLI output** of `agent_message` and `run_reply` strips the same character classes as the terminal dashboard (control characters, ANSI escapes, bidi and format characters).
5. **Off-mode responses.** `GET /api/control` `defaults.execution` has no `conversation` key unless it is `true`.
6. **Scripted agents.** `tools/fake-pi-rpc.js` follows the scenario like `tools/fake-pi.js` (Michael answers only in the `question` scenario). The `question` demo uses a question as its default request. Intermediate fake messages name what the agent is about to do instead of repeating one sentence.
7. **Terminal dashboard.** Large `agent_message` lines must not push the visible events out of the tail window that `src/dashboard/source.js` reads.

# Pipeline Chat View and Direct Answers Contract (2026-11-11)

Authoritative specification for adding Chat view transcript entries and direct answers to Pipeline chats (`engine/` package `scranton_pipeline`).
Extends `.enma/pipeline-contract.md`, `engine/docs/ARCHITECTURE.md`, `docs/PIPELINE.md`, and aligns with the shared Chat view model in `.enma/chat-view-contract.md`.
Default behavior preserves 100% byte-identical execution for all existing plan-and-edit runs.

## 1. What Exists Today
- **Stored and published texts**:
  - `Plan`: `summary` (`Text`, <=32 KB), `assumptions`, `risks`, `acceptance_criteria`, `steps` (`title`, `description`). Saved to `artifacts/plan.json` and `artifacts/plan-r<rev>.json` (`nodes/planner.py:89`).
  - `ImplementerTurn`: `summary` (`Text`), `edits`, `blocked_reason`. Held in memory (`state["pending_edits"]`, `nodes/workflow.py:192`); only git commits and `edits_applied` / `edits_rejected` event names persist. Turn summaries are not written to disk as messages.
  - `Review`: `verdict`, `summary` (`Text`), `criteria` assessments, `findings`. Saved to `artifacts/review-<round>.json` (`nodes/workflow.py:300`).
  - `CheckResult`: `id`, `kind`, `status`, `duration_s`, `output_tail`. In `state["checks"]`, `status.json`, logs (`nodes/workflow.py:232`).
  - Context & Grounding: read records in `state["plan_evidence"]` / `state["step_evidence"]`, `evidence.jsonl`, `grounding.jsonl`.
  - Gate decisions: recorded in `events.jsonl` (`gate_decided`) and state (`plan_approval`, `delivery_approval`).
  - Terminal report: `delivery/report.md` (rendered Markdown) and `delivery/report.json` (`report.py:99-111`).
- **UI ingestion**: `inspect()` in `src/core/pipeline-supervisor.js:327` serves `{ status, launchError, live, events, lastSeq, plan, review, stderrTail }` polled by `visualizer/public/js/pipeline-view.js`.
- **Missing**: Raw model completions are intentionally discarded (`gateway.py:102-113`). Intermediate implementer notes, rationale on context requests, output repair feedback, and conversational answers are not emitted as transcript messages.

## 2. Role Messages
- **Transcript mapping**: Every LLM role turn produces an `agent` message:
  - **Planner**:
    - On `plan`: `text` = `plan.summary`, `who` = `{ id: "planner", name: "Planner", title: "Planning & Architecture" }`, `context` = `Revision <rev>`.
    - On `need_context`: `text` = `turn.rationale` (or summary of `context_requests`), `context` = `<n> requests`.
    - On `output_invalid` repair: `text` = `feedback.message`, `tone` = `"warn"`.
  - **Implementer**:
    - On `edits`: `text` = `turn.summary` (fallback: `"Implemented step: <title>"`), `who` = `{ id: "implementer", name: "Implementer", title: "Code & Implementation" }`, `context` = `Step <id> (attempt <n>)`.
    - On `blocked`: `text` = `turn.blocked_reason`, `tone` = `"fail"`.
    - On `need_context`: `text` = `turn.summary` or request summary.
  - **Reviewer**:
    - `text` = `review.summary`, `who` = `{ id: "reviewer", name: "Reviewer", title: "Code & Quality Review" }`, `tone` = `review.verdict === "approve" ? "ok" : "warn"`, `context` = `Round <round>`.
- **Caps & Boundaries**: Each message text is bounded to 16,000 characters (matching Team contract). Over-length text is sliced to 16,000 and flagged `truncated: true`. Empty or whitespace-only messages are suppressed.
- **Durable Storage & Emission**:
  - Emitted to `events.jsonl`: `deps.events.emit("agent_message", role=role, text=redacted_text, context=context, final=final, truncated=truncated)`.
  - Appended durably to `<run-dir>/messages.jsonl` (schema: `{ seq, ts, role, text, context, final, truncated }`).
  - Reaches UI via existing event paging in `src/core/pipeline-supervisor.js:308-322`.

## 3. Direct Answers
- **Decision point**: `plan` node (`nodes/planner.py`). When the user's task is an informational question that requires no workspace modifications, the planner returns a direct answer instead of a step list.
- **Schema update** (`engine/src/scranton_pipeline/models.py`):
  ```python
  class Answer(LlmModel):
      text: Text
      citations: list[EvidenceId] = Field(default_factory=list, max_length=100)
      summary: Short = ""

  class PlannerTurn(LlmModel):
      kind: Literal["need_context", "plan", "answer"]
      rationale: Text = ""
      context_requests: list[ContextRequest] = Field(default_factory=list, max_length=50)
      plan: Plan | None = None
      answer: Answer | None = None
  ```
- **Context loop**: The planner may emit `need_context` turns before answering. Python executes read/search requests via `plan_context` under `PathPolicy`, storing evidence in `evidence.jsonl`. Once sufficient context is gathered, the planner emits `kind: "answer"`.
- **Routing** (`routing.py` & `graph.py`):
  - In `routing.after_plan(state)`: returns `"finalize"` when `state.get("answer")` is present.
  - Reason in `routing.decision(after_plan, state)`: `"direct_answer"`.
  - In `graph.py`: `"finalize"` is already an allowed conditional target of `plan` (`path_map=["plan_context", "plan", "approve_plan", "finalize"]`).
  - Terminal status: `succeeded`.
  - Skipped gates and nodes: `approve_plan`, `select_step`, `implement`, `verify`, `review`, `package`, `approve_delivery`, `apply_to_source` are completely bypassed.
- **Evidence grounding**:
  - `nodes/grounding.py` `evaluate()` validates `answer.citations` against `prompt.shown`.
  - Unknown citation ID (`ident not in shown`) emits violation `unknown_citation`.
  - In `grounding.mode: "enforce"`: unknown citations cause output rejection and spend an output repair attempt within `limits.max_output_repairs`. In `"observe"`: violation is recorded in `grounding.jsonl` without failing.
- **Engine switch & backward compatibility**:
  - Config flag: `cfg.planning.allow_direct_answers: bool = True` (default `True`). If `False`, `kind: "answer"` fails validation with `"Direct answers disabled"`, enforcing a plan.
  - Existing plan-producing tests and runs are unchanged and byte-identical.
- **Scripted & demo models**:
  - New demo scenario: `python -m scranton_pipeline demo --scenario answer`.
  - Fake/mock planner returns `kind: "answer"` with cited evidence for question tasks.

## 4. The Main Return Message (`reply`)
- **Storage & Artifacts**:
  - Saved to `<run-dir>/delivery/reply.json`.
  - Added to `<run-dir>/status.json` under `"reply"`.
  - Emitted to `<run-dir>/events.jsonl` as `run_reply` event directly before `run_finished`.
- **Payload shape**:
  `{ "from": "pipeline", "kind": "answer" | "result", "text": string, "citations": string[], "truncated": boolean }`
- **Reply composition**:
  - **Normal run (`replyKind: 'result'`)**: Deterministically composed by Python in `report.py:write_report` from final state: outcome status, step count, changed file count, check results, and review summary. No secondary LLM call is made. Tone is `"ok"` on `succeeded`, `"fail"` on `failed`/`rejected`.
  - **Direct answer (`replyKind: 'answer'`)**: `text` = `turn.answer.text`, `citations` = `turn.answer.citations`, tone is `"ok"`.
- **Thread context**:
  - Today: Pipeline engine runs operate as independent executions from the project root; no prior run history is passed into `python -m scranton_pipeline run`.
  - UI context: Follow-up runs in the same chat are aggregated chronologically by the UI adapter, presenting earlier tasks and replies in the unified chat thread.

## 5. Node and HTTP Surface
- **`src/core/pipeline-supervisor.js`**:
  - `artifactPaths`: add `'reply': 'delivery/reply.json'`.
  - `inspect(chat, id, after)`: includes `reply: readObject('delivery/reply.json')` in the returned object.
  - Event streaming: passes through `agent_message` and `run_reply` from `events.jsonl` without mutation.
  - `config(body)`: accepts optional `allowDirectAnswers` boolean passed to operator config.
- **`src/server/registry-router.js`**:
  - `GET .../pipeline/runs/:runId/artifacts/reply` routes through `pipeline.artifact(chat, id, 'reply')`.
  - Sidebar status mapping: `succeeded` -> `'done'`, `running` -> `'running'`, `awaiting_approval` -> `'interrupted'`, `failed` -> `'failed'`.

## 6. Pipeline Adapter and UI
- **Module**: `visualizer/public/js/chat-adapter-pipeline.js` exporting `pipelineChatAdapter({ run, events, list }) -> Entry[]`.
- **Mapping to `Entry` Vocabulary**:
  - Task -> `Entry { id: "${runId}:req", runId, kind: 'request', who: { id: 'user', name: 'User', title: 'Operator' }, text: status.task, ts }`.
  - Role messages -> `Entry { id: "${runId}:msg:${seq}", runId, kind: 'agent', who, text, context, final, truncated, tone, ts }`.
  - Phase & check updates -> `Entry { id: "${runId}:act:${node}:${seq}", runId, kind: 'activity', text: summary, tone, ts }`.
  - Gates awaiting approval -> `Entry { id: "${runId}:gate:${gate}", runId, kind: 'question', who: { id: 'pipeline', name: 'Pipeline', title: 'Gate' }, text: prompt, context: digest, ts }`.
  - Gate decisions -> `Entry { id: "${runId}:dec:${gate}", runId, kind: 'human', who: { id: 'human', name: 'Operator', title: 'Human in the Loop' }, text: decisionText, tone, ts }`.
  - Terminal reply -> `Entry { id: "${runId}:rep", runId, kind: 'reply', who: { id: 'pipeline', name: 'Pipeline', title: 'Assistant' }, replyKind: 'answer' | 'result', text, tone, final: true, ts }`.
- **View Switch (`Chat | Details`)**:
  - In Pipeline chats, view switch toggles between `#chat-view` (shared transcript component) and `#pipeline-view` (Details: current stepper, plan, checks, review, diff view).
  - Details view remains 100% functional and unchanged.
- **Composer**:
  - Entering a prompt in the chat view composer while idle submits `POST /api/projects/:p/chats/:c/pipeline/runs` with `{ task: text }`.
  - Disabled while an active run is in progress (`list.active !== null`).
- **Legacy Runs Fallback**:
  - Runs created before this change (lacking `messages.jsonl` or `reply.json`) synthesize:
    - `request` from `status.task`.
    - `agent` entries from `plan.summary` and `review.summary`.
    - `reply` entry from `report.json` or `status.status`.

## 7. File Ownership Matrix
| Lane | Owned Files (Strict Single Ownership) |
|---|---|
| **Engine** (`engine/**`) | `engine/src/scranton_pipeline/models.py`<br>`engine/src/scranton_pipeline/state.py`<br>`engine/src/scranton_pipeline/routing.py`<br>`engine/src/scranton_pipeline/graph.py`<br>`engine/src/scranton_pipeline/nodes/planner.py`<br>`engine/src/scranton_pipeline/nodes/workflow.py`<br>`engine/src/scranton_pipeline/nodes/grounding.py`<br>`engine/src/scranton_pipeline/report.py`<br>`engine/src/scranton_pipeline/observability.py`<br>`engine/src/scranton_pipeline/config.py`<br>`engine/src/scranton_pipeline/demo/runner.py`<br>`engine/tests/**` |
| **Node** | `src/core/pipeline-supervisor.js`<br>`test/core/pipeline-bridge.test.js`<br>`test/server/pipeline-bridge.test.js` |
| **Web UI** | `visualizer/public/js/chat-adapter-pipeline.js` (NEW)<br>`test/visualizer/chat-adapter-pipeline.test.js` (NEW) |

**Flagged Shared Files** (Coordinate with Team lane before editing):
- `src/server/registry-router.js` (shared route registration; Node lane adds `'reply'` artifact).
- `visualizer/public/index.html` (view switch container `#view-mode-toggle`).
- `visualizer/public/js/main.js` (mounting shared chat view and selecting engine adapter).
- `visualizer/public/styles.css` (chat view layout and monochrome styles).
- `docs/PIPELINE.md`, `engine/docs/ARCHITECTURE.md` (documentation).

## 8. Gates and Verification
- **Engine Verification Commands** (Windows cmd.exe, Python venv at `.scratch/pipeline/venv`):
  - Pytest: `.scratch\pipeline\venv\Scripts\python.exe -m pytest engine/tests/unit engine/tests/flow`
  - Linting: `.scratch\pipeline\venv\Scripts\python.exe -m ruff check engine/`
  - Type checking: `.scratch\pipeline\venv\Scripts\python.exe -m mypy --strict engine/src/scranton_pipeline`
  - Core Eval Pack: `.scratch\pipeline\venv\Scripts\python.exe -m scranton_pipeline eval --pack core`
- **Node & UI Verification Commands**:
  - `node --test test/core/pipeline-bridge.test.js`
  - `node --test test/server/pipeline-bridge.test.js`
  - `node --test test/visualizer/chat-adapter-pipeline.test.js`
  - Full suite: `npm.cmd test`
- **Test Invariants**:
  - Scripted/fake models only; zero real-model provider calls.
  - All existing 910+ pytest tests and the 9-task eval pack remain green without modification.
  - Eval score (`mean adjusted 0.6732`) remains identical.

## 9. Security and Bounds
- **Untrusted Model Text**: Model outputs in `agent_message` and `run_reply` are untrusted strings. Rendered strictly with `textContent` via the DOM-only safe subset (no `innerHTML`).
- **Text Caps**: Message body max 16,000 characters; citations max 100 IDs; summary max 1,024 characters.
- **Redaction**: All message texts and reply contents pass through `deps.redactor.redact()` prior to emission and serialization.
- **Direct Answer Safety**:
  - Direct answers cannot bypass workspace controls: the answer path completely skips `apply_to_source` and git writes.
  - Read access during planning is strictly constrained by `PathPolicy` (`is_protected()` blocks `.env`, git internals, and secrets).
  - An answer cannot apply unreviewed code changes to the user project.

## 10. Risks and Open Questions
1. **Citation Verification in Enforce Mode**: If a model answers without first requesting context via `need_context`, its citations will be empty or rejected. The planner system prompt must instruct the model to query context first if citations are required.
2. **File Overlap with Team Lane**: `visualizer/public/js/main.js`, `index.html`, and `registry-router.js` are touched by both contracts. Coordination order: land Team contract shared view component first, then mount Pipeline adapter.
3. **Engine Thread Context**: Multi-run conversation history is aggregated in the UI at present. Passing past run digests into the planner prompt can be added in a future iteration using `--history-digest`.

## 11. Pinned details (lead, 2026-11-11; these override anything above that conflicts)
1. **One switch, exactly like the Team engine: conversation mode, off by default in the engine.**
   - The engine lane adds one boolean to the engine config (it chooses the config path that fits the existing config model and names it in its report). Default `False`.
   - Off: no `agent_message`, no `run_reply`, no `delivery/reply.json`, no `status.json.reply`, a planner turn of kind `answer` is rejected, and the planner prompt and output schema are byte-identical to today. Every existing test, recorded fixture, eval score and run directory stays unchanged BY CONSTRUCTION. `allow_direct_answers` from section 3 is replaced by this switch.
   - On: role messages, direct answers and the reply.
   - The app turns it on: `POST .../pipeline/runs` gains the body field `conversation` (boolean), the web UI sends `true` for every Pipeline run it starts (real and demo), and the supervisor maps it into the engine config. Engine CLI and evals keep the default.
2. **No `messages.jsonl`.** Role messages exist only as `agent_message` events in `events.jsonl`: the usual envelope plus `{ role: 'planner'|'implementer'|'reviewer', text, context, final: true, truncated? }`. One message per role call that produced a valid turn.
3. **Engine feedback is not an agent message.** Output-repair feedback and grounding violations stay what they are today; the adapter may show them as `activity` lines from the existing events.
4. **Reply.** `run_reply` event directly before `run_finished`, plus `status.json.reply` and `delivery/reply.json`, all with `{ from: 'pipeline', kind: 'answer'|'result', text, citations: string[], truncated: boolean }`. Every terminal status gets one (for a failed, rejected or cancelled run: kind `result` with the reason). A suspended run has none until it reaches a terminal status.
5. **Node lane (phase B, starts after the engine lane and the Team backend lane have finished).** `src/core/pipeline-supervisor.js` and its tests: the `conversation` request field, `reply` in `inspect()`, and per run `task`, `status` and `reply { kind, text (at most 4000 characters), truncated } | null` in the run list. No new routes. If the run list or the request validation lives in another file, name that file in the report before editing it.
6. **UI (phase B, after the shared Chat view exists).** `visualizer/public/js/chat-adapter-pipeline.js` plus the mounting. An approval is a `question` entry with one button "Review and decide" that switches to Details and focuses the existing approval controls; there is no second set of approval controls. The run-starting composer in a Pipeline chat posts `{ task, conversation: true }` with the same defaults the existing Pipeline form uses; the existing form stays reachable through Options.
7. **Ownership for phase A.** Engine lane: `engine/**` and `docs/PIPELINE.md`. Nothing under `src/`, `visualizer/`, `tools/` or `.enma/`.
8. **Engine gates (verify against `engine/README.md` before relying on them).** Working directory `engine\`, interpreter `..\.scratch\pipeline\venv\Scripts\python.exe`, `TEMP`/`TMP`/`TMPDIR` pointing at `.scratch\pipeline\tmp`:
   - `python -m pytest tests -q -p no:cacheprovider --basetemp ../.scratch/pipeline/pytest-core` (last known: 949 passed, 12 skipped, about 16 minutes)
   - `python -m ruff check src tests` and `python -m mypy src` (strict, clean)
   - `python -m scranton_pipeline eval --pack core` (9/9, mean adjusted 0.6732, identical twice)

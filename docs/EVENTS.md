# Contract v1

The only interface between the orchestrator (`src/core`) and the UIs (`src/dashboard`, `src/server`, `visualizer/`).

Agent ids (canonical order): `michael` (planner), `dwight` (developer), `oscar` (code reviewer), `hank` (security auditor), `angela` (QA).
Participants (`hive_write` from/to): the five agent ids plus `human`.

## hive/events.jsonl

- UTF-8 JSON Lines: one JSON object per line, LF-terminated, append-only while a run is active.
- At the start of every run the orchestrator moves the previous `events.jsonl` (and `state.json`) into
  `hive/runs/<previousRunId>/` and starts a fresh file, so `hive/events.jsonl` only ever holds the current
  or most recent run.
- Consumers MUST reset their view when they see a `run_started` whose runId differs from the run they show;
  MUST ignore an event whose seq is <= the last seq they applied for the same runId (the server replays
  the whole file on every (re)connect); MUST tolerate the file shrinking or being replaced (read again from
  offset 0); MUST skip lines that are not valid JSON (e.g. a partially written last line); MUST ignore
  unknown event types and unknown fields.

Every event: `{ "v": 1, "seq": <int, starts at 1, strictly increasing within a run>, "ts": "<ISO-8601 UTC>", "runId": "<string>", "type": "<type>" }` plus:

| type | fields |
|---|---|
| run_started | request: string, workspace: string (absolute), maxFailedCycles: number |
| plan_ready | milestones: [{ id: string, title: string, description: string, acceptanceCriteria: string[] }] |
| milestone_started | milestoneId: string, index: number (0-based), total: number, title: string |
| hive_write | from: participant, to: participant, file: string (relative to hive dir, forward slashes, e.g. "angela/inbox.md"), kind: "plan_request" \| "task" \| "handoff" \| "bug_report" \| "feedback" \| "hitl", summary: string (max 140 chars) |
| agent_status | agent: agentId, status: "idle" \| "thinking" \| "working" \| "waiting" \| "blocked" \| "error" \| "done", activity: string (normally <=80 chars; error/blocked retain the first diagnostic line up to 300 characters, including a trailing ... when truncated; log events retain full failure messages) |
| agent_tool | agent: agentId, tool: string (pi tool name: read, write, edit, bash, grep, find, ls, powershell, ...), detail: string (path or command, max 140 chars) |
| agent_finished | agent: agentId, milestoneId: string \| null, cycle: number \| null, keyword: string \| null (no brackets, e.g. "TASK_COMPLETE"), exitCode: number, durationMs: number, usage?: { input: number, output: number, cost: number } |
| cycle_result | milestoneId: string, cycle: number (1-based), result: "passed" \| "failed", failedCycles: number (consecutive failed cycles of this milestone after this result), reason: string |
| circuit_breaker | milestoneId: string, state: "tripped" \| "reset", failedCycles: number, maxFailedCycles: number |
| hitl_request | milestoneId: string \| null, reason: string, options: string[] |
| hitl_response | milestoneId: string \| null, decision: "feedback" \| "retry" \| "skip" \| "abort", feedback?: string |
| milestone_finished | milestoneId: string, status: "passed" \| "skipped" \| "failed" \| "aborted" |
| run_finished | status: "success" \| "partial" \| "aborted" \| "failed", summary: string |
| log | level: "info" \| "warn" \| "error", message: string |

agent_status meanings: thinking = its pi process runs and the model is generating; working = one of its
pi tool calls is executing (activity says what); waiting = waiting for another agent or a human;
blocked = circuit breaker tripped or the agent reported [BLOCKED]; done = finished for this run;
error = its pi process failed; idle = nothing to do.

Keywords in agent output (with brackets): Michael `[PLAN_READY]`; Dwight `[TASK_COMPLETE]` or `[BLOCKED]`;
Angela `[TEST_PASSED]`, `[TEST_FAILED]` or `[BLOCKED]`. In events they appear without brackets.

Typical run: run_started -> agent_status(michael thinking "Planning milestones...") -> hive_write(human->michael,
plan_request, "michael/inbox.md") -> agent_tool... -> agent_finished(michael, PLAN_READY) -> plan_ready ->
milestone_started(m1) -> hive_write(michael->dwight, task) -> agent_status(dwight thinking/working...) -> agent_tool...
-> agent_finished(dwight, TASK_COMPLETE) -> hive_write(dwight->angela, handoff) -> agent_status(angela ...) -> agent_tool...
-> agent_finished(angela, TEST_FAILED) -> cycle_result(m1, 1, failed, failedCycles 1) -> hive_write(angela->dwight,
bug_report) -> ... -> cycle_result(passed) -> milestone_finished(m1, passed) -> milestone_started(m2) ... -> run_finished(success).
When failedCycles reaches maxFailedCycles (default 3): circuit_breaker(tripped) -> agent_status(michael blocked
"Needs a human!") -> hitl_request -> hitl_response -> "feedback": hive_write(human->dwight, feedback) +
circuit_breaker(reset); "retry": circuit_breaker(reset); "skip": circuit_breaker(reset) (only if the pause came from a breaker trip) + milestone_finished(skipped);
"abort": milestone_finished(aborted) -> run_finished(aborted).

## hive/state.json

Snapshot of the current run, rewritten atomically (temp file + rename) after every event. Missing file = nothing has run yet (show idle).

```
{
  "v": 1,
  "runId": string | null,
  "status": "idle" | "planning" | "running" | "paused" | "finished" | "aborted" | "failed",   // paused = waiting for a human
  "request": string | null,
  "workspace": string | null,
  "updatedAt": "<ISO-8601>",
  "lastSeq": number,
  "milestones": [ { "id": string, "title": string, "status": "pending" | "active" | "passed" | "skipped" | "failed" | "aborted" } ],
  "currentMilestoneId": string | null,
  "cycle": number,          // current cycle of the current milestone, 1-based; 0 before the first
  "failedCycles": number,   // consecutive failed cycles of the current milestone
  "maxFailedCycles": number,
  "breaker": "closed" | "tripped",
  "agents": {               // all five agent ids are always present
    "<agentId>": { "status": <agent_status status>, "activity": string, "lastKeyword": string | null, "updatedAt": "<ISO-8601>",
                   "totals": { "runs": number, "input": number, "output": number, "cost": number } }
  }
}
```

## Hive mailbox files (relative to the hive dir, default ./hive)

- `<agent>/inbox.md` - the message that agent works on next: Markdown with a front-matter header (from, to, kind, runId, milestone, cycle, date). The previous inbox is moved into `<agent>/archive/` first.
- `<agent>/outbox.md` - that agent's latest final report (its final assistant text), same header style.
- `michael/plan.json`, `michael/plan.md` - the milestone plan of the current run.
- `sessions/<agent>/` - pi session JSONL files. `runs/<runId>/` - archived events.jsonl / state.json of earlier runs.

## Visualizer HTTP server (default http://127.0.0.1:1725 - "1725 Slough Avenue")

- `GET /` -> visualizer/public/index.html; `GET /<path>` -> static file from visualizer/public/ (no directory traversal; 404 otherwise)
- `GET /events` -> Server-Sent Events. On connect: replays every complete line currently in hive/events.jsonl, then streams new lines as they are appended. Each event is sent as `id: <seq>\ndata: <the JSON line>\n\n` (default "message" event). `: ping` comment every 15 s. When the file is truncated or replaced (new run) it continues from offset 0, so the new run's events follow, starting with run_started.
- `GET /api/state` -> hive/state.json as application/json; `{"v":1,"status":"idle"}` if the file does not exist.

Opt-in control routes, file-based human answers and stop requests extend this read-only contract: see [CONTROL.md](CONTROL.md).

## Projekte und Threads (additive v1)

Multi-Projekt-/Thread-Unterstützung ändert weder das v1-Ereignisformat noch das Format von `state.json`; Projekt-/Chat-IDs werden nicht als neue Eventfelder eingeführt. Jeder Thread besitzt einen eigenen Hive mit eigenen Run-IDs und Sequenzen. Der bisherige Archivpfad `runs/<runId>/events.jsonl` und `state.json` bleibt unverändert; `thread.js` liest diese Dateien und vorhandene Plan-/Meilensteinereignisse, ohne ein neues Runformat zu schreiben.

Registry-Dateien liegen außerhalb des Eventvertrags: `<data>/projects.json` enthält `{v:1,projects:[{id,name,workspace,createdAt}]}`; `<data>/projects/<projectId>/chats/<chatId>/chat.json` enthält `{id,projectId,title,hiveDir,createdAt,updatedAt}`. Standard-Hive ist der dortige Unterordner `hive/`; Legacy-Chats dürfen einen externen Hive referenzieren. Entfernen eines Chats löscht nur `chat.json`, nicht die Hive-Dateien.

Vor einem servergestarteten Registry-Run entsteht `<hive>/control/thread-context.json` als `{v:1,text:string}`. `--thread-context <file>` übergibt höchstens 8000 Zeichen früherer Ziele/Ergebnisse an die Planung; bei Kürzung werden neuere Runs bevorzugt. Dies ist Planungskontext, kein neuer Eventtyp und keine automatische Wiederaufnahme alter Pi-Prozesse. Die direkte Registry-CLI berechnet denselben Kontext ohne notwendige Kontextdatei.

Scoped Live-SSE und archiviertes JSON-Replay verwenden die unveränderten Ereignisse. Beim Chat- oder Runwechsel müssen Clients ihre Ansicht nach Scope/Run trennen; Replay ist schreibgeschützt. Routen, Zugriffsschutz und vollständige API-Formen stehen in [CONTROL.md](CONTROL.md), Abschnitt 8.

## Module interfaces (exact)

- `src/server/visualizer-server.js`: `export async function startVisualizerServer({ hiveDir, publicDir, port = 1725, host = '127.0.0.1', control, dataDir, maxConcurrentRuns = 4, projectsRoot, legacyWorkspace })` -> resolves `{ url, port, close }` once listening; `close()` returns a Promise and ends open SSE streams; `port: 0` picks a free port.
- `src/dashboard/index.js`: `export async function runDashboard({ hiveDir, once = false, ascii = false, refreshMs = 250, stdout = process.stdout, stdin = process.stdin })` -> with `once` renders one frame and resolves; otherwise runs until q / Ctrl+C (restoring the terminal) and resolves. Also `export function renderDashboard(state, events, { width, height, color = true, ascii = false, now = Date.now() })` -> string (pure).
- `bin/scranton.js` wires `scranton dashboard [--once] [--ascii]` -> `runDashboard({ hiveDir, ... })` and `scranton visualize [--port N] [--host H]` -> `startVisualizerServer({ hiveDir, publicDir: <repo>/visualizer/public, ... })`, prints the URL and runs until Ctrl+C.

## Clarifications (no changes to the contract)


- `agent_finished.usage` is omitted when pi reported no usage.
- Pi infrastructure failures (spawn error, non-zero exit, no assistant message, stopReason error/aborted, timeout) emit `agent_status(error)`, then a `log` (error), then the HITL sequence (`agent_status(michael blocked)`, `hitl_request`); they do NOT emit `cycle_result` and do not count towards `failedCycles`.
- `run_finished.status`: `success` = every milestone passed; `partial` = finished with at least one skipped/failed milestone; `aborted` = human abort or Ctrl+C; `failed` = the run could not proceed (e.g. unusable workspace).
- state.json: milestone_finished and run_finished close the breaker (breaker "closed", failedCycles 0); the event log keeps the history.
- Orphan recovery reopens the matching run journal through the event recorder and emits the existing `run_finished` with `status:"aborted"`; no new event/state shape. The summary is `Interrupted: the run's process ended without finishing` (automatic) or `Released by the user` (explicit release), with any Docker-unreachable warning appended on a new line. Aborted reduction clears pending human state. The recovered run is archived by the normal next-run start path. An incomplete trailing event line is discarded before appending. If no events belong to the orphan, the previous journal is archived through the normal start path; recovery emits `run_started` from the lease request/workspace with `roles:[]`, then `run_finished`. Mixed matching-run journals or invalid sequences fail recovery with ownership retained. Automatic recovery requires verified cleanup; manual release may return cleanup warnings even when an existing finish is preserved. See CONTROL.md §6.

## Parallel execution extension (additive v1)

Real runs default to RPC transport, private shadow-repository worktrees and Docker (`scranton-sandbox:1.5.0-r2`, bridge network); no automatic engine installation, image pull or host fallback. `--trusted-host` explicitly disables the OS container boundary while retaining worktrees. Demo uses fake RPC and explicitly reports simulated trusted-host execution.

- `run_started.execution`: `{maxParallel,isolation,sandbox:{mode,image,network},persistentSessions,maxReplans,simulated?}`. `simulated:true` is set only by the explicit fake-pi demo command; real trusted-host runs do not set it. The slot limit counts complete developer → QA → integration pipelines, not individual role processes.
- `plan_ready.milestones[].dependsOn: string[]`. IDs are `m1` through `m7`. Omission means the previous milestone; explicit `[]` means independent. Unknown, duplicate and cyclic prerequisites are rejected. Only successful integration satisfies an edge. Skipped/rejected prerequisites yield `milestone_finished {status:"blocked",reason}` for dependents, without launching them.
- `instance_started {instanceId,agent,milestoneId,sessionId,worktree,sandbox}` announces each invocation. Planner ID is `michael`; milestone IDs are `dwight-m1`, `angela-m1`, etc. Session IDs are UUIDs and remain stable across retries of the same instance within a run. Invocation processes may close after settling; conversations persist in their session directory.
- `agent_status`, `agent_tool`, `agent_finished` add `instanceId`; `hive_write` adds `instanceId`, `milestoneId`, `cycle`. Existing `agent`, `from`, `to` role fields remain role aggregates. In RPC mode the mailbox `file` names the exact instance (`dwight-m1/inbox.md`), never a concurrent role alias.
- `milestone_integrated {milestoneId}` is emitted only after developer snapshot integration succeeds. QA runs in a separate checkout of that exact snapshot; QA mutations are never integrated. Conflict resolution pauses for a human and does not release dependent work.
- `chat_message {id,from,to,text,delivery,reason?}` and `chat_delivery {id,delivery,reason?}` use delivery `queued|delivered|rejected|unknown`. Sender identity is authenticated by the runner closure (or the trusted human spool); recipients are exact instance IDs. Unknown/terminal recipients are rejected. `queued` means never sent; `delivered` means a positive live RPC steer ACK, not semantic acceptance or reading by a model. Definitive negative ACKs are rejected. Timeout/cancellation after a possible send, thrown/invalid ACKs, or completion while awaiting ACK produce `unknown`, with a reason and `ok:false`/error to the caller. Attempted uncertain sends are never automatically replayed on reattachment or later invocations. Terminal completion rejects only never-sent queues. ACK budgets are 5 s for RPC commands, 10 s for broker replies and 15 s for the extension. Commands sent before the first valid command ACK after each process spawn keep the shared 60 s startup deadline measured from spawn (including Docker/Pi startup and prompt preflight) until their own ACKs arrive. Pi may ACK commands out of order; another command's ACK never shortens the first prompt's deadline. Commands sent after that first ACK receive the normal 5 s ACK window measured from sending; overrides can only shorten these budgets. No first-prompt answer reports `pi did not start within 60 s (no answer to the first prompt)`. Timeout/kill completion awaits named container removal and verification, including startup failures.
- Chat has 4,000-character text, 100 accepted messages per sender, 500 accepted messages per run limits. A separate append-only `hive/chat/<runId>.jsonl` journal retains message/delivery transitions. Incoming server commands are consumed from `hive/control/chat/*.json` and require the matching run ID. Queues are retained across invocation retries, not replayed automatically after a process crash/recovery.

State adds `activeMilestoneIds: string[]`, `instances: {[instanceId]: {id,agent,milestoneId,status,tool,sessionId,worktree,sandbox}}`, `execution`, and bounded `chat` (last 200 messages). Milestones add `dependsOn`, `cycle`, `failedCycles` and `blocked` status. Legacy role totals remain cumulative; active sibling instances take precedence over an idle role update. `currentMilestoneId` is the first active milestone or null. Legacy scalar cycle/failure fields represent latest aggregate progress; per-milestone counters are authoritative for parallel runs.

Human questions are serialized: only the head emits `hitl_request` and owns the response file. Other pipelines keep running. Abort cancels queued human questions and kills every active runner; run completion waits for runner/container cleanup. CLI writers acquire `hive/control/owner.json`; guarded desktop children validate and reuse the parent's lease. Failed container cleanup retains ownership for explicit recovery. Standalone `agent` commands use the same lease, isolated workspace and audit events, but retain their unreviewed changes privately rather than integrating them.

Replanning is not implemented: the validated published DAG is immutable for the duration of the run. Effective `maxReplans` is always 0; a nonzero configured value is ignored with a warning. There is no standalone `message` CLI command; use the controlled server chat route.

### Chat command correlation and planner completion

Validated same-run human spool commands retain the server-generated UUID v4 `command.id` in `chat_message`, journal records, RPC steer labels and subsequent `chat_delivery` ACKs. Agent messages always get broker-generated IDs and authenticated runner senders; payload `id`/`from` fields are ignored. Duplicate command IDs are never replayed or allowed to reject an existing message.

Matching-run commands with valid IDs but invalid recipients/text emit `chat_message` with that ID and `delivery:"rejected"`. Unparseable, oversized, symlinked, invalid-ID, duplicate or stale-run commands emit `chat_command_rejected {delivery:"rejected",reason}` without an ID, sender, recipient, payload, or supplied run ID. This diagnostic belongs to the consuming run, not the submitted message; it never adds to `state.chat` or updates an optimistic message. Stale commands must not be correlated with current-run messages. All consumed spool files are removed. Frontends may display the diagnostic separately; only authenticated same-run IDs correlate transcript transitions.

Legacy `execution.isolation:"shared"` is supported only with one pipeline and explicit host mode; shared+Docker fails configuration/preparation rather than running unsandboxed while claiming Docker. Shared `instance_started.worktree` is `null`, not the workspace path. `state.chat` retains the original message event's trusted `ts`; delivery transitions do not overwrite it.

After planning ends, `agent_status {agent:"michael",instanceId:"michael",status:"done"}` closes the planner chat target. Later role-only Michael oversight/HITL updates do not reopen this instance. Dwight/Angela invocation completion stays idle (reusable) until milestone/run completion.

## Multi-stage gates and prompt audit (additive v1)

`run_started.execution.workflow` is `{gates: string[][]}`. Engine default and fallback for older recordings: `[["angela"]]`. Stages run sequentially; roles within a stage run concurrently against separate checkouts of the same immutable developer snapshot. Results are evaluated in listed order, not completion order. A failed stage produces one combined report and increments failedCycles once; later stages do not run. Infrastructure errors and BLOCKED pause after every gate of the stage has finished; Retry repeats only that stage. Only the developer snapshot is integrated after all stages pass.

`gate_result` fields: `{milestoneId:string,cycle:number,stage:number,agent:"oscar"|"hank"|"angela",instanceId:string,result:"passed"|"failed"|"blocked"|"error",keyword:string|null}` plus the normal event envelope. Stage is zero-based; emitted as each runner settles. The legacy default `[["angela"]]` omits this event to preserve its exact existing event order.

Oscar uses `[REVIEW_APPROVED]`, `[CHANGES_REQUESTED]`, `[BLOCKED]`; Hank uses `[SECURITY_PASSED]`, `[SECURITY_ISSUES]`, `[BLOCKED]`. All gate outboxes target Dwight. Missing keywords fail a stage. Combined report sections follow configured role order. Nonlegacy cycle reasons are `All gates passed: <Name> [<KEYWORD>], ...`, `<Name> reported [<KEYWORD>]: <summary>`, or `Stage <1-based index> failed: <Name> [<KEYWORD>], ...`.

Gate handoff bodies name their purpose: Oscar reviews changes (correctness, edge cases, error handling, regressions, maintainability and test coverage), Hank audits security vulnerabilities, and Angela independently verifies acceptance criteria. Oscar/Hank see acceptance criteria as context only, not their verdict basis. All handoffs forbid creating or modifying project files. Where worktree snapshots exist, Oscar/Hank receive paths changed relative to the milestone base (control characters removed, at most 200 paths plus `and N more`); shared trusted-host mode omits this section. Angela's legacy handoff bytes and event sequence remain unchanged. Nonlegacy gate bug reports, including retries after human intervention, use the neutral `Gate verification failed for your previous work...` intro with role-labeled report sections; human feedback keeps the human-feedback intro. Only legacy Angela-only bug reports retain `Angela's QA failed...`.

`run_started.prompts` maps only the roles used by the run (Michael unless noPlan, Dwight, and every configured gate; standalone agent commands include only that role) to `{source:"builtin"|"custom"|"config",sha256:string}`. SHA-256 covers resolved, frontmatter-stripped, trimmed UTF-8 text. Prompts are resolved once before any agent starts; every invocation uses that run snapshot. Edits during a run apply to the next run. A resolution failure emits run_started with roles:[] and without prompt hashes and ends with run_finished(failed), without launching agents. Prompt text is never included in events. All five keys remain present in state.agents, including inactive roles.

## Custom gate definitions (additive v1)

`run_started.roles` contains ONLY invoked roles in order: Michael unless noPlan, Dwight, then gates stage by stage in listed order (standalone commands include only that role). Each role is `{id,name,title,kind:"planner"|"developer"|"gate",builtin,keywords,passKeyword?,failKeyword?,definitionHash}`. The hash is SHA-256 of recursively key-sorted EFFECTIVE definition JSON for every role, built-ins included: id, name, title, kind, builtin, keywords, passKeyword/failKeyword when present, effective tools after config overrides and the Windows fallback, and instruction when present; text and tools are not published. Definitions and prompts are snapshotted before execution. Mid-run edits/deletion affect only later runs.

`run_started.prompts` has exactly the invoked role IDs. Custom agents without a saved prompt use a deterministic starter from their current definition, reported as source `builtin`; its hash follows the same resolved-text rule above. `run_started.roles` is always present (`[]` on startup failure); reducers replace missing lists with `[]`. `state.roles` copies the latest run's roles and is absent before any run. `state.agents` ALWAYS starts with the five built-ins in canonical order, followed by custom roles invoked in that run in run order. Unused registered custom roles are absent.

Gate tools (including built-in `agents.oscar.tools`, `agents.hank.tools`, `agents.angela.tools`) are validated at every config load, including `visualize`: nonempty read-only allowlist only (read, grep, find, ls, bash; Windows powershell fallback). Invalid overrides produce a ConfigError naming `agents.<id>.tools`. Shell tools are not a filesystem security boundary. Gate extraArgs cannot change tools or load resources; MCP and extension discovery are disabled even with `pi.minimalContext:false`. Only the managed RPC chat extension is explicitly loaded, and the final exact tool allowlist does not enable extra extension tools. See CONTROL.md §10.

`gate_result.agent` also accepts registered custom IDs; instance IDs remain `<id>-<milestoneId>`. A custom gate accepts ONLY its own pass/fail keywords plus BLOCKED; another gate's keyword is not approval. Combined failing reports retain listed gate order with `## <Name>'s <Title> report` for custom agents. Custom handoffs include the same bounded Changed files and mode-specific How to see the changes guidance as Oscar/Hank. Built-in gate instructions may be overridden; Angela's default handoff remains unchanged.

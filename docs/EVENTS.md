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
| agent_tool | agent: agentId, tool: string (Scranton tool name: read, write, edit, bash, grep, find, ls, powershell, agent_chat), detail: string (path or command, max 140 chars) |
| agent_finished | agent: agentId, milestoneId: string \| null, cycle: number \| null, keyword: string \| null (no brackets, e.g. "TASK_COMPLETE"), exitCode: number, durationMs: number, usage?: { input: number, output: number, cost: number } |
| cycle_result | milestoneId: string, cycle: number (1-based), result: "passed" \| "failed", failedCycles: number (consecutive failed cycles of this milestone after this result), reason: string |
| circuit_breaker | milestoneId: string, state: "tripped" \| "reset", failedCycles: number, maxFailedCycles: number |
| hitl_request | milestoneId: string \| null, reason: string, options: string[] |
| hitl_response | milestoneId: string \| null, decision: "feedback" \| "retry" \| "skip" \| "abort", feedback?: string |
| milestone_finished | milestoneId: string, status: "passed" \| "skipped" \| "failed" \| "aborted" |
| run_finished | status: "success" \| "partial" \| "aborted" \| "failed", summary: string |
| log | level: "info" \| "warn" \| "error", message: string |

agent_status meanings: thinking = its agent workflow runs and the model is generating; working = one of its
tool calls is executing (activity says what); waiting = waiting for another agent or a human;
blocked = circuit breaker tripped or the agent reported [BLOCKED]; done = finished for this run;
error = its agent invocation failed; idle = nothing to do.

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

## Repository instructions (additive v1)

`run_started` optionally adds `instructions`, never instruction content:

- `{ file: 'AGENTS.md', bytes, sha256, truncated: boolean, nested: number }` when the root file is used. `bytes` and lowercase-hex `sha256` cover the inlined root text after BOM removal and the 32 KiB cut, excluding the truncation notice. `nested` is the total count of nested files (not just the listed paths).
- `{ file: null, nested: n }` when only nested files exist.
- `null` when disabled or absent. Older journals may omit the field.

Instructions are read once per run from the initial workspace state (the shared shadow snapshot in Team runs), so every role sees the same instructions. The root inline cap is **32 KiB (32768 bytes)**, cut at a UTF-8 code point boundary, preferably a line break, followed by `[AGENTS.md truncated at 32 KiB; read the file for the rest]`. Files over **1 MiB** are not read in full; only the first 32 KiB are read. Nested files are listed, not inlined: sorted relative POSIX paths, at most **50**, then `(+N more)`; snapshot exclusions apply.

Only regular files whose real paths remain inside the workspace qualify. UTF-8 is required, with an optional leading BOM removed. A skipped unsafe/unreadable file emits `log` at `level:'warn'` with reason `escape`, `not_regular`, `binary` (NUL), `invalid_utf8` or `read_error`. These use the existing log event, not a new event type. Disable reading/injection with `agentsMd:false` or `SCRANTON_AGENTS_MD=0` (default true).

Repository instructions are mandatory system-prompt instructions below Scranton's role/tool/sandbox/approval rules, not advisory context; context budgets never count or cut them. Context inspection, `scranton context show` and HTTP context status add a separate `instructions: { file, bytes, tokens, truncated, nested: [paths, max 50], nestedCount } | null` summary of the current project workspace; `nestedCount` is the total nested-file count; `tokens` estimates the full rendered instruction block with the context estimator. Pipeline run status and events carry the instruction summary too; see [PIPELINE.md](PIPELINE.md). Contract version remains 1; consumers must tolerate absent/unknown fields.

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
- `human/request.json` - while `--on-breaker hive` waits, `{v:1,runId,requestSeq,milestoneId,title,reason,options,ts}`; copy runId/requestSeq into the response described in CONTROL.md §1. Removed after the wait or successful orphan recovery.
- `restore-points/<runId>/` - bounded pre-run backups for Team worktree integration only; not an event/replay source. CLI undo and Registry routes: CONTROL.md §12.
- `dbos.sqlite` - own per-chat SQLite workflow storage (or Postgres selected through DBOS-specific URL variables). `agent-step-markers/` - at-most-once markers; retain with the database. `output`/`history` streams replace Pi session JSONL. Session IDs are identities, not transcript filenames. `runs/<runId>/` retains archived events/state.

## Visualizer HTTP server (default http://127.0.0.1:1725 - "1725 Slough Avenue")

- `GET /` -> visualizer/public/index.html; `GET /<path>` -> static file from visualizer/public/ (no directory traversal; 404 otherwise)
- `GET /events` -> Server-Sent Events. On connect: replays every complete line currently in hive/events.jsonl, then streams new lines as they are appended. Each event is sent as `id: <seq>\ndata: <the JSON line>\n\n` (default "message" event). `: ping` comment every 15 s. When the file is truncated or replaced (new run) it continues from offset 0, so the new run's events follow, starting with run_started.
- `GET /api/state` -> hive/state.json as application/json; `{"v":1,"status":"idle"}` if the file does not exist.

Opt-in control routes, file-based human answers and stop requests extend this read-only contract: see [CONTROL.md](CONTROL.md).

## Projekte und Threads (additive v1)

Multi-Projekt-/Thread-Unterstützung ändert weder das v1-Ereignisformat noch das Format von `state.json`; Projekt-/Chat-IDs werden nicht als neue Eventfelder eingeführt. Jeder Thread besitzt einen eigenen Hive mit eigenen Run-IDs und Sequenzen. Der bisherige Archivpfad `runs/<runId>/events.jsonl` und `state.json` bleibt unverändert; `thread.js` liest diese Dateien und vorhandene Plan-/Meilensteinereignisse, ohne ein neues Runformat zu schreiben.

Registry-Dateien liegen außerhalb des Eventvertrags: `<data>/projects.json` enthält `{v:1,projects:[{id,name,workspace,createdAt}]}`; `<data>/projects/<projectId>/chats/<chatId>/chat.json` enthält `{id,projectId,title,hiveDir,createdAt,updatedAt}`. Standard-Hive ist der dortige Unterordner `hive/`; Legacy-Chats dürfen einen externen Hive referenzieren. Entfernen eines Chats löscht nur `chat.json`, nicht die Hive-Dateien.

Vor einem vom Server gestarteten Registry-Team-Run schreibt der Server unmittelbar vor dem Start des Kindprozesses `<hive>/control/thread-context.json` für das Kontextsystem (context system); Demo-Runs sind ausgenommen. Mit Kontextdienst lautet das Format `{ "v": 3, "text": string <= 800000 chars, "developer": string <= 8000 chars }` (`developer` optional, Datei höchstens 8388608 bytes). `--thread-context <file>` akzeptiert weiterhin v1 `{ "v": 1, "text": string <= 8000 chars }` und v2 `{ "v": 2, "text": string <= 24000 chars, "developer": string <= 4000 chars }` (`developer` optional, Legacy-Dateien jeweils höchstens 262144 bytes). Ohne Kontextdienst schreibt der Server im Fallback v1. Für Anfragen mit mehr als 4000 Zeichen schreibt er daneben `<hive>/control/request.json` als `{ "v": 1, "request": string }` (nicht leer, höchstens 32768 Zeichen und 262144 bytes) und übergibt `--request-file`; kürzere Anfragen bleiben in argv. Die Anfragedatei entfernt der Server beim Ende des Kindprozesses oder bei fehlgeschlagenem Prozessstart sowie vor einem Run mit argv-Anfrage. Die CLI akzeptiert für `--request-file` zusätzlich normalen UTF-8-Text (optionale BOM wird entfernt) und UTF-16 mit LE-/BE-BOM; ungültige Kodierung wird abgewiesen. Das erste Nicht-Leerzeichen `{` verlangt das strikte v1-Envelope, auch kaputtes JSON wird dann abgewiesen; sonst bleibt der Inhalt wörtlicher Text (entfernt genau ein abschließendes LF/CRLF/CR; nicht leer/blank, höchstens 32768 JS-Zeichen und 262144 Bytes). Dateifehler liefern Exit 2 mit `Invalid request file` plus Grund. Nutzerdateien werden von der CLI nicht gelöscht. Die CLI liest beide Steuerdateien als größenbegrenzte reguläre Dateien; die Datei selbst darf kein Link sein, ein Datenverzeichnis über Junction oder verlinktes Verzeichnis ist zulässig. Dies ist Planungs-/Eingabetransport, kein neuer Ereignistyp und keine automatische Wiederaufnahme alter Pi-Prozesse. Die direkte Registry-CLI baut denselben Kontext ohne erforderliche Kontextdatei. Details: [CONTROL.md](CONTROL.md), section 12.

Scoped Live-SSE und archiviertes JSON-Replay verwenden die unveränderten Ereignisse. Beim Chat- oder Runwechsel müssen Clients ihre Ansicht nach Scope/Run trennen; Replay ist schreibgeschützt. Routen, Zugriffsschutz und vollständige API-Formen stehen in [CONTROL.md](CONTROL.md), Abschnitt 8.

## Module interfaces (exact)

- `src/server/visualizer-server.js`: `export async function startVisualizerServer({ hiveDir, publicDir, port = 1725, host = '127.0.0.1', control, dataDir, maxConcurrentRuns = 4, projectsRoot, legacyWorkspace })` -> resolves `{ url, port, close }` once listening; `close()` returns a Promise and ends open SSE streams; `port: 0` picks a free port.
- `src/dashboard/index.js`: `export async function runDashboard({ hiveDir, once = false, ascii = false, refreshMs = 250, stdout = process.stdout, stdin = process.stdin })` -> with `once` renders one frame and resolves; otherwise runs until q / Ctrl+C (restoring the terminal) and resolves. Also `export function renderDashboard(state, events, { width, height, color = true, ascii = false, now = Date.now() })` -> string (pure).
- `bin/scranton.js` wires `scranton dashboard [--once] [--ascii]` -> `runDashboard({ hiveDir, ... })` and `scranton visualize [--port N] [--host H]` -> `startVisualizerServer({ hiveDir, publicDir: <repo>/visualizer/public, ... })`, prints the URL and runs until Ctrl+C.

## Clarifications (no changes to the contract)


- `agent_finished.usage` is omitted when the runner reported no usage.
- Agent infrastructure failures (initialization, request/tool infrastructure error, no assistant message, error/aborted stop, timeout) emit agent_status(error), log(error), then HITL; they do not emit cycle_result or count towards failedCycles.
- `run_finished.status`: `success` = every milestone passed; `partial` = finished with at least one skipped/failed milestone; `aborted` = human abort or Ctrl+C; `failed` = the run could not proceed (e.g. unusable workspace).
- state.json: milestone_finished and run_finished close the breaker (breaker "closed", failedCycles 0); the event log keeps the history.
- Orphan recovery reopens the matching run journal through the event recorder and emits the existing `run_finished` with `status:"aborted"`; no new event/state shape. The summary is `Interrupted: the run's process ended without finishing` (automatic) or `Released by the user` (explicit release), with any Docker-unreachable warning appended on a new line. Aborted reduction clears pending human state. The recovered run is archived by the normal next-run start path. An incomplete trailing event line is discarded before appending. If no events belong to the orphan, the previous journal is archived through the normal start path; recovery emits `run_started` from the lease request/workspace with `roles:[]`, then `run_finished`. Mixed matching-run journals or invalid sequences fail recovery with ownership retained. Automatic recovery requires verified cleanup; manual release may return cleanup warnings even when an existing finish is preserved. See CONTROL.md §6.

## Parallel execution extension (additive v1)

Real runs default to own agent workflows, private shadow worktrees and the Scranton OS sandbox. Explicit Docker (`scranton-tools:24-r2`) is tool-only; host requires explicit trust. No automatic installation/pull/build or silent host fallback. Demo uses the scripted provider and labels simulated host execution.

- `run_started.execution`: `{maxParallel,isolation,sandbox:{mode,image,network},persistentSessions,maxReplans,simulated?}`. `simulated:true` is set only by the explicit scripted demo command; real trusted-host runs do not set it. The slot limit counts complete developer → QA → integration pipelines, not individual role invocations.
- `plan_ready.milestones[].dependsOn: string[]`. IDs are `m1` through `m7`. Omission means the previous milestone; explicit `[]` means independent. Unknown, duplicate and cyclic prerequisites are rejected. Only successful integration satisfies an edge. Skipped/rejected prerequisites yield `milestone_finished {status:"blocked",reason}` for dependents, without launching them.
- `instance_started {instanceId,agent,milestoneId,sessionId,worktree,sandbox}` announces each invocation. Planner ID is `michael`; milestone IDs are `dwight-m1`, `angela-m1`, etc. Session IDs are UUIDs and remain stable across retries of the same instance within a run. Each invocation is a workflow; canonical history persists in its durable history stream, not automatically across new invocations.
- `agent_status`, `agent_tool`, `agent_finished` add `instanceId`; `hive_write` adds `instanceId`, `milestoneId`, `cycle`. Existing `agent`, `from`, `to` role fields remain role aggregates. The mailbox `file` names the exact instance (`dwight-m1/inbox.md`), never a concurrent role alias.
- `milestone_integrated {milestoneId}` is emitted only after developer snapshot integration succeeds. QA runs in a separate checkout of that exact snapshot; QA mutations are never integrated. Conflict resolution pauses for a human and does not release dependent work.
- `chat_message {id,from,to,text,delivery,reason?}` and `chat_delivery {id,delivery,reason?}` use queued|delivered|rejected|unknown. Sender identity comes from the runner/human spool, recipients are exact instance IDs. delivered confirms durable steering acceptance, never model consumption. Uncertain sends are unknown, return ok:false and are never automatically replayed. Terminal completion rejects only never-sent queues. agent_chat callback deadline is 10 s; no Pi RPC startup/ACK deadlines remain.
- Chat has 16,000-character text, 100 accepted messages per sender, 500 accepted messages per run limits. A separate append-only `hive/chat/<runId>.jsonl` journal retains message/delivery transitions. Incoming server commands are consumed from `hive/control/chat/*.json` and require the matching run ID. Queues are retained across invocation retries, not replayed automatically after a process crash/recovery.

State adds `activeMilestoneIds: string[]`, `instances: {[instanceId]: {id,agent,milestoneId,status,tool,sessionId,worktree,sandbox}}`, `execution`, and bounded `chat` (last 200 messages). Milestones add `dependsOn`, `cycle`, `failedCycles` and `blocked` status. Legacy role totals remain cumulative; active sibling instances take precedence over an idle role update. `currentMilestoneId` is the first active milestone or null. Legacy scalar cycle/failure fields represent latest aggregate progress; per-milestone counters are authoritative for parallel runs.

Human questions are serialized: only the head emits `hitl_request` and owns the response file. Other pipelines keep running. Abort cancels queued human questions and kills every active runner; run completion waits for runner/container cleanup. CLI writers acquire `hive/control/owner.json`; guarded desktop children validate and reuse the parent's lease. Failed container cleanup retains ownership for explicit recovery. Standalone `agent` commands use the same lease, isolated workspace and audit events, but retain their unreviewed changes privately rather than integrating them.

Replanning is not implemented: the validated published DAG is immutable for the duration of the run. Effective `maxReplans` is always 0; a nonzero configured value is ignored with a warning. There is no standalone `message` CLI command; use the controlled server chat route.

### Chat command correlation and planner completion

Validated same-run human spool commands retain the server-generated UUID v4 `command.id` in `chat_message`, journal records, steering correlation and subsequent `chat_delivery` ACKs. Agent messages always get broker-generated IDs and authenticated runner senders; payload `id`/`from` fields are ignored. Duplicate command IDs are never replayed or allowed to reject an existing message.

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

Gate tools are validated on every config load: nonempty read-only file allowlist (read, grep, find, ls) plus shell (bash or powershell). Shell is not a filesystem security boundary. All pi.* settings, SCRANTON_PI_COMMAND and agents.<id>.extraArgs are rejected. No extension discovery or managed Pi extension is involved; agent_chat is an own tool.

`gate_result.agent` also accepts registered custom IDs; instance IDs remain `<id>-<milestoneId>`. A custom gate accepts ONLY its own pass/fail keywords plus BLOCKED; another gate's keyword is not approval. Combined failing reports retain listed gate order with `## <Name>'s <Title> report` for custom agents. Custom handoffs include the same bounded Changed files and mode-specific How to see the changes guidance as Oscar/Hank. Built-in gate instructions may be overridden; Angela's default handoff remains unchanged.

## Conversation mode (additive v1)

`execution.conversation` defaults to false (CLI `--conversation` / `--no-conversation`, environment `SCRANTON_CONVERSATION=1|0`). Only enabled runs record `run_started.execution.conversation:true`; disabled runs omit it and emit neither new event. Michael's run-scoped keywords become PLAN_READY, ANSWER_READY and REPORT_READY; existing keyword extraction still uses only the last known bracketed keyword in the final assistant text.

| type | fields |
|---|---|
| agent_message | agent:string, instanceId:string, milestoneId:string\|null, cycle:number\|null, text:string, final:boolean, truncated?:boolean |
| run_reply | from:string, kind:"answer"\|"report"\|"summary", text:string, truncated?:boolean |

Both events carry the normal v/seq/ts/runId envelope. Text is untrusted assistant text, never thinking or tool arguments, capped at 16000 characters with `truncated:true` when clipped. Empty assistant messages are suppressed. Intermediate messages (`final:false`) precede their tool event; exactly one final message per invocation that produced text matches its outbox body and precedes `agent_finished`. Michael's answer/report final is suppressed as an agent message only when actually published as the reply. Failed reports (including missing keyword, partial timeout/crash text and stop) retain their final text as a normal agent message before agent_finished; pending assistant text also survives a failed launch with an empty result. Intermediate messages never drive handoff keywords.

ANSWER_READY bypasses plan/milestones and finishes with success / `Answered by Michael`. No workspace revert or deletion occurs. After milestones (unless noPlan), Michael writes a closing report from a self-contained digest <=8000 characters, with a fresh invocation and 120-second deadline, before chat/worktree cleanup. The report request is `hive_write {from:"human",to:"michael",kind:"report_request",milestoneId:null,cycle:null}`. It must end in REPORT_READY. Failure, missing keyword, timeout or stop during reporting uses a deterministic system summary without HITL or changing the milestone-produced status/summary. Aborted/stopped/startup-failed conversation runs also get a system summary; if run_started could not record conversation mode there is no reply.

Ending order: the existing final done/idle `agent_status` events for every active role, then exactly one `run_reply`, immediately followed by `run_finished`. Reply text removes the trailing ANSWER_READY/REPORT_READY token (including inline `Done. [ANSWER_READY]`) and trims whitespace. The reducer stores `reply:{from,kind,text,truncated?}`; it is absent before a reply and removed at run_started. `agent_message` changes only lastSeq/updatedAt, not other state. History/API and earlier-run context caps are documented in CONTROL.md.

In conversation mode only, Michael's staged system prompt appends a short override: each request's Required answer section chooses PLAN_READY, ANSWER_READY or REPORT_READY rather than always requiring a plan. Built-in and custom source prompts remain unchanged; the run's prompt audit hashes the actual staged text. CLI assistant/reply output strips ANSI, controls, bidi formatting and variation selectors like the terminal dashboard. The terminal source retains a bounded visible-event tail independent of large suppressed agent_message bodies; disabled runs retain the original byte-tail selection. Scripted intermediate messages describe the next tool; the question scenario answers directly.

## Live activity and usage (additive v1)

`agent_tool` adds `targetFile:string|null` (workspace-relative forward-slash path when possible) and
`command:string|null` (shell command); both are sanitised/redacted and capped at 240 characters.
Older journals lack these fields; consumers fall back to `detail`. Instance `tool`/`lastTool` retain
these fields and `startedAt`/`ts`; `touchedFiles` is newest-first, unique by path, capped at eight
`{path,kind:"read"|"write"|"edit",ts}` entries.

`agent_usage {agent,instanceId,model:string|null,usage:{input,output,cost,cacheRead?,cacheWrite?}}`
carries one successful request's usage delta, with the normal v/seq/ts/runId envelope.
The own workflow emits usage only for successfully checkpointed requests, including compaction; failed-attempt billing is outside this accounting contract. Streaming snapshots are not counted.
`agent_finished.usage` remains the invocation total. Usage events are not Activity or conversation rows.

`state.usage` is `{input,output,cost,tokens,calls,startedAt,byAgent,series}`. Tokens mean input + output.
`byAgent[agent]` contains `{input,output,cost,tokens,calls}`. Each cumulative series point is
`{ts,tokens,cost,byAgent:{[agent]:{tokens,cost}}}`. Above 120 points, odd-index points are removed
except the last. Per-instance `usagePending` sums reported deltas; finish folds only nonnegative
component-wise differences and clears pending. Legacy finishes with no deltas still contribute.
Run totals equal the sum of `agents[*].totals` throughout the fold.

Reasoning is NEVER written to this journal or state.json. A separate atomic `hive/live.json` holds
`{v:1,runId,updatedAt,instances:{[instanceId]:{agent,phase,thinking,thinkingCut,text,textCut,updatedAt}}}`.
Phase is `thinking|text|tool|idle`; each sanitised tail is at most 2000 characters, null if unseen,
reset at the next assistant message. Writes are trailing-edge throttled to 400 ms; terminal clearing
is immediate. Finished instances are removed; success, failure and abort clear the file to
`{v:1,runId:null,updatedAt:null,instances:{}}`. Missing, stale or terminal live data reads as that empty
object. This channel is ephemeral display data, not a replay or recovery source. Redaction is best effort.

## Own durable agent channels (outside Contract-v1 journal)

`agent_state` is a durable last-write-wins workflow checkpoint, not a new events.jsonl event: phases thinking, tool_call, waiting_approval, compaction_failed and done. Terminal workflow status overrides a stale phase after cancellation. The output stream contains attempt_start markers and text/thinking chunks; discard superseded step attempts on every marker. The history stream records canonical replace/append messages. Reasoning stays out of this journal/state; durable streams are sensitive local data.

HTTP SSE and approval routes, offset resume semantics and guards: [CONTROL.md](CONTROL.md) and [AGENT-ROUTES.md](../src/server/AGENT-ROUTES.md). Tool approvals default off, timeout 600 s, first matching workflow/step/call verdict wins. Denial/timeout returns a tool error to the model. These are not circuit-breaker HITL or Pipeline plan/delivery gates. SQLite at <hive>/dbos.sqlite is default; only DBOS_SYSTEM_DATABASE_URL / DBOS_DATABASE_URL select Postgres, never DATABASE_URL. Replay does not guarantee exactly-once external journal/filesystem side effects or automatic whole-run resume.

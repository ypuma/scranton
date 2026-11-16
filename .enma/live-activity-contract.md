# Live activity contract (v1.1, 2026-11-12)

v1.1: section 4 amended after a frontend finding - the Pipeline tails live under `liveText` (the key `live`
already exists there as a boolean), plus `stepsDone` and a `usage` on the run-list rows.
v1.2: `stepsDoneExact` added, because the engine persists the exact done-step ids only at the end of a run.

Frozen for the parallel backend / UI work. Background and the exact existing shapes are in
`.enma/live-activity-inventory.md`; its section 3 (proposal) is SUPERSEDED by this file wherever they differ.
Everything here is additive: nothing existing is renamed or removed.

Why this shape: for Team chats the browser does not read `state.json`. It reduces the SSE replay of
`hive/events.jsonl` (`visualizer/public/js/state.js`), and the server reduces the same journal
(`src/core/state.js`). So durable facts travel as journal events and are folded by BOTH reducers.
Streamed reasoning is too bulky for the journal (it would evict real events from every bounded window),
so it travels on a separate, non-durable channel.

## 1. Tool target (journal, Team)

`agent_tool` keeps `tool` and `detail` and gains:

- `targetFile: string | null` - the file a read / write / edit call targets. Workspace-relative with forward
  slashes when it can be made relative, otherwise as given. Max 240 chars.
- `command: string | null` - the command line of a shell call. Max 240 chars.

Both are sanitised like `detail`. Old journals lack them: consumers fall back to `detail`.

Reducers derive per instance (client `state.js`; the server reducer may mirror it):

- the `tool` / `lastTool` objects additionally carry `targetFile`, `command` and `startedAt` / `ts`
- `touchedFiles: Array<{ path, kind: "read" | "write" | "edit", ts }>` - newest first, unique by path, max 8

There is no tool-finished event: a tool ends the way it does today.

## 2. Usage (journal, Team)

New event, one per assistant message (model call) that reports usage, in RPC and in JSON mode:

    { v, seq, ts, runId, type: "agent_usage", agent, instanceId, model: string | null,
      usage: { input, output, cost, cacheRead?, cacheWrite? } }

The values are the DELTA of that one call, with the same definitions `agent_finished.usage` uses today.
`agent_finished` is unchanged.

Both reducers fold `state.usage`:

    { input, output, cost, tokens, calls, startedAt,
      byAgent: { [agent]: { input, output, cost, tokens, calls } },
      series: Point[] }

- `tokens` = `input` + `output` (the definition behind the existing per-agent totals).
- `Point` = `{ ts, tokens, cost, byAgent: { [agent]: { tokens, cost } } }` - CUMULATIVE run values at `ts`.
  One point is appended per folded delta.
- Bound: when `series.length > 120`, drop every odd-index point except the last one.
- Reconciliation, so that old journals and any path without per-call usage still add up: keep a per-instance
  pending sum of the `agent_usage` deltas. On `agent_finished` with `usage`, fold `finished - pending`
  (each component clamped at >= 0) as one more delta if any component is > 0, then clear the pending sum.
- Invariant: the totals of `state.usage` equal the sum over agents of the existing `agents[id].totals`
  (`input`, `output`, `cost`).
- `agent_usage` must not flood or evict anything: it is not a row in the Activity log and not a
  conversation event (web client and `src/dashboard/source.js`).

Run list: `RunSummary` (`src/core/thread.js`, `listRuns`) gains `usage: { tokens, cost } | null`, taken from
the archived state's `usage` or, for older runs, from the sum of `agents[*].totals`.

## 3. Live reasoning and text (NOT journaled)

The run process keeps, per instance, the tail of what the model is producing right now and writes it,
throttled and atomically, to `hive/live.json`.

Routes, with the same guards as the neighbouring state routes:
`GET /api/live` and `GET /api/projects/:p/chats/:c/live`. Answer 200:

    { v: 1, runId: string | null, updatedAt: string | null,
      instances: { [instanceId]: { agent, phase: "thinking" | "text" | "tool" | "idle",
                                   thinking: string | null, thinkingCut: boolean,
                                   text: string | null, textCut: boolean, updatedAt } } }

- `thinking` / `text`: the tail (max 2,000 chars each) of the reasoning / the visible text of the assistant
  message being produced. Both reset when the next assistant message starts. `*Cut` is true when the head
  was dropped. `null` means none was seen (the model exposes no reasoning, or thinking is off).
- An instance entry is removed when its agent finishes. The file is emptied when the run ends, is aborted
  or fails. No file or no run: `{ v: 1, runId: null, updatedAt: null, instances: {} }`.
- Writes: at most one per 400 ms per run, trailing edge so the last state lands.
- Sanitised and redacted like journal text. Never journaled, never in `state.json`.
- Client: polls once a second, only while the shown run is live and the page is visible. It shows a tail
  only when `runId` matches the shown run and the instance is active in reducer state. A 404 or an error
  means the feature is quietly off. Rendered with `textContent` only.

## 3a. Saved thinking (v1.3)

A block of reasoning or visible text that is done is also kept with the run, so a finished or reopened run can
show what its models thought. Still not journaled: it has a file of its own, `hive/thoughts.jsonl`, archived to
`hive/runs/<runId>/thoughts.jsonl` together with the journal. One line per block:

    { v: 1, n, ts, runId, instanceId, agent, kind: "reasoning" | "answer", text, cut }

- `n` counts from 1 per run. `text` is the block's first 20,000 chars, sanitised and redacted like the tails;
  `cut` is true when it was shortened or when the block never ended (the agent stopped mid-block: what was
  seen of it, at most its last 4,000 chars, is kept).
- A run keeps at most 8 MiB; blocks after that are dropped. A failed write never stops a run.
- Route: `GET /api/projects/:p/chats/:c/runs/:runId/thoughts?after=<n>` (single mode: project and chat
  `default`). 200: `{ v: 1, runId, thoughts: [...], next }` with the blocks of `n > after`; 404: the run kept
  none (an older run, or a pipeline chat).
- `live.json` instances gain `open: "thinking" | "text" | null`: the kind of block still being written. A
  client that shows the saved blocks shows the live tail only for that kind, so a block is never shown twice.
- Tool calls are not repeated here: the journal's `agent_tool` events carry them, and a client orders both by `ts`.
- Pipeline runs save no thinking.

## 4. Pipeline

Pipeline has no tool calls and no SSE; its view polls `.../pipeline/runs/:runId`.

- That response gains `usage` in the SAME shape as section 2 (`agent` = role), aggregated on the Node side
  (`src/core/pipeline-supervisor.js`, `inspect`) from the run's usage ledger / `llm_call` events. Where no
  per-call cost exists, `cost` is `null` in the points and the run total comes from `status.usage`. An
  estimated cost is marked with `estimated: true` on the usage object.
- Optional `liveText` in the same response (NOT `live`: that key already exists as the boolean liveness
  flag and keeps its meaning), in the shape of section 3 - only if the Node bridge can tee the
  reasoning without a change to the Python engine. Otherwise it is absent and the UI shows the role's
  latest message and the current step instead.
- The response gains `stepsDone: string[]` - the ids of the implemented steps, in completion order, read on
  the Node side: from the terminal `delivery/report.json` when it exists, otherwise derived conservatively
  from the events. `stepsDoneExact: boolean` says which: true from the report or when the derived count
  equals `status.progress.steps_done`, false otherwise (absent = exact). When it is false the board shows
  one quiet board-level note that step states are approximate. When `stepsDone` is absent (older server)
  the browser derives the done steps from the events.
- Each row of the Pipeline run list (`GET .../pipeline`) gains `usage: { tokens, cost, estimated? } | null`,
  so a chat total can be shown. Absent means no total.
- Live activity and the board are derived in the browser from `status`, `plan`, `stepsDone`, the
  lanes and the events.

## 5. Board (derived in the browser, no server field)

Columns: `todo`, `in_progress`, `in_review`, `blocked`, `done`. A card only ever moves backwards when the
work really is redone.

Team milestone, first match wins:

1. `passed` or `skipped` -> `done` (skipped is marked as such)
2. `blocked`, `failed`, `aborted`, or `active` while the breaker is tripped, `hitl.milestoneId` is this
   milestone, or one of its instances is blocked -> `blocked`, carrying the precise word
3. `active` with a gate instance (not the developer) running, or with gate results pending after the
   developer finished the cycle -> `in_review`
4. any other `active` -> `in_progress`
5. `pending` -> `todo` (unmet `dependsOn` is noted on the card)

Pipeline step, first match wins:

1. in `stepsDone` and the phase is `deliver` or `done` -> `done`
2. in `stepsDone` otherwise (implemented, not yet reviewed and delivered) -> `in_review`
3. in a lane, or the current step during `implement`: `blocked` if the run is suspended, failed, cancelled or rejected,
   else `in_progress`
4. else `todo`

Waiting for plan approval is a board-level notice, not a column move.

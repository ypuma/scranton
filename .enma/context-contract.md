# Context system contract (v1, 2026-11-16)

User goal: "Add a context system for multiple turns and chats, so that it is not always a one shot."
A chat becomes a real multi-turn conversation, and chats of the same project share bounded context.

This contract is the single interface between the lanes. If it contradicts the code, STOP and report
the contradiction instead of improvising. Sections 2 and 12 are normative for every lane.

## 1. Vocabulary

- **Turn**: one run of a chat that is no longer running (Team or Pipeline): the user's request and what
  came of it. A run that is live right now is never context.
- **Context pack**: the bounded, advisory context built from disk for the NEXT turn of a chat.
- **Layers** (ids are fixed): `notes` (project notes written by the user), `memory` (the existing
  Dreaming advisory memory, source unchanged), `other-chats` (other chats of the same project),
  `earlier` (this chat, older turns condensed to one line each), `recent` (this chat, latest turns in detail).
- Registry mode only (`--data` / desktop). Single-hive mode keeps its current behaviour byte for byte.
  Projects never share anything with each other.

## 2. Authority rules (normative)

1. All pack content is historical and advisory. The current request wins; this chat outranks other chats;
   newer outranks older. Notes are standing preferences of the user and rank below the current request.
2. Nothing else carries over: no approvals, no completed steps or gates, no check success, no evidence ids,
   no checkpoints, no pi sessions, no workspace state. Every guarantee of `.enma/pipeline-contract.md` §26
   stays in force; §27 (added by the Python lane) only widens the wire object as described in section 7.
3. Packs are derived from files on disk at build time. Never from process memory or anything a client sends.
4. Text is credential-scrubbed (existing scrubbers, best effort) and delimiter-safe: content may never
   contain a live `<earlier-runs>`, `</earlier-runs>`, `<conversation-context>` or `</conversation-context>`
   tag (replace with `[earlier-runs]` / `[conversation-context]`). No absolute filesystem paths are emitted
   by the context module itself (run artifacts may carry relative paths only; absolute ones are dropped).
   Every emitted string is well-formed Unicode (lone surrogates are replaced), and redaction always happens
   before a string is cut.
5. Failure isolation: a missing, corrupt, oversized or linked artifact degrades that item only. Building a
   pack must never make a run fail to start: `forTeam` / `forPipeline` do not throw; on an unexpected error
   they return the pre-existing legacy result (section 5) and flag `degraded`.
6. Determinism: the same disk state yields the same pack bytes. No model calls, no network, no timers.
7. Empty stays empty: with no turns, no notes, no other chats and no memory the pack text is `''`, so every
   existing prompt is byte-identical to today (pinned by `test/core/orchestrator-thread.test.js` and
   `test/core/fixtures/conversation-baseline.json`).

## 3. Turn record (engine-neutral, derived, never stored)

```js
{ id,                 // run id
  engine,             // 'team' | 'pipeline'
  index,              // 1-based chronological position among ALL turns of the chat (stable under reset)
  startedAt, endedAt, // ISO strings or null
  status,             // team: success | partial | failed | aborted | interrupted ; pipeline: succeeded | failed | rejected | cancelled
  request,            // the user's request (bounded 4000)
  outcome,            // one line: what came of it (summary / failure / "answered")
  plan,               // [{ title, status }] at most 32 (team milestones; pipeline plan steps)
  files,              // relative paths, at most 30, in first-seen order; [] when unknown
  reply }             // { kind, text (bounded 16000), truncated } | null
```

- Team source: the hive (`events.jsonl`, `state.json`, `michael/plan.json`, `runs/<id>/`), through
  `src/core/thread.js`. The context reader rejects links: the hive root and every path component below it
  are checked with `lstat` and files are opened with `O_NOFOLLOW`; a linked file or directory degrades that
  run only (today's `boundedRead` follows links - `listRuns()` for existing callers stays as it is).
  A Team run without `run_finished` that is not live is `interrupted`. Live means: for `inspect` of the own
  chat the run named by `activeRunId`, or without it the hive-root run when it has no `run_finished` and
  `readRunLease(hiveDir)` (src/core/run-lease.js) is set; for sibling chats the hive-root run without
  `run_finished` while a lease is set. `forTeam` treats every run on disk as a turn: it is only called while
  a new run of that chat is being started, when the lease (if any) already belongs to the new run. `files` =
  `targetFile` of journaled `agent_tool` events with tool `write` or `edit` from developer instances
  (agent `dwight`), relative paths only. It is a pointer, not a delivery proof; label it "Files touched".
  `thread.js` may grow additively, but objects returned by `listRuns()` to existing callers keep their
  current fields and values (the `/runs` API payload is pinned by tests).
- Pipeline source: `<data>/projects/<p>/chats/<c>/pipeline/runs/<id>/` through the hardened readers of
  `src/core/pipeline-history.js` (terminal statuses only, as §26). `request` = `run.json` task (same
  fallbacks as today), `plan` = step titles of `artifacts/plan.json`, `files` = `delivery/report.json`
  `changed_files[].path`, `reply` = `delivery/reply.json`.
- Read bounds: run directories are taken newest first (directory mtime, then exact order by start time).
  Own chat: at most 500 runs. Sibling chats: the 12 most recently updated chats, the newest 4 runs each.
  One pack reads at most 64 MiB of artifacts in total, own chat first, siblings last, no file charged twice;
  reading stops at the first run that does not fit, and that run and everything older are counted as omitted
  with the pack marked `truncated`. The pre-existing §26 selection of Pipeline `runs` keeps its own bounds and
  is never limited by this budget. A run that cannot be read degrades alone (per-run guard).

## 4. Storage (registry mode)

| File | Content |
|---|---|
| `<data>/projects/<p>/context/settings.json` | `{ "v": 1, "crossChat": true }` |
| `<data>/projects/<p>/context/notes.md` | UTF-8 text, at most 4000 chars (JS string length) and 16384 bytes |
| `<data>/projects/<p>/chats/<c>/context/state.json` | `{ "v": 1, "resetAt": "<ISO>" \| null }` |

Use the storage pattern of `src/core/dreaming/storage.js`: reject links on every ancestor, `O_NOFOLLOW`,
single hard link, size caps, atomic write (temp file, fsync, rename), mode `0o600`. Missing or corrupt files
read as the defaults (`crossChat: true`, empty notes, `resetAt: null`). Ids are validated with the registry's
`validateId`. A chat that was removed is no longer listed by the registry and therefore contributes nothing,
whatever is left on disk.

- `crossChat: false`: chats of this project neither receive nor provide the `other-chats` layer.
- `resetAt`: turns of that chat that STARTED at or before this instant are hidden from every pack (its own
  and the `other-chats` digest of sibling chats). `index` values do not change. Restore sets it to `null`.
  Notes and Dreaming memory are project-level and are not affected by a chat reset.
- Notes: CRLF becomes LF; control characters other than `\n` and `\t` are removed; empty text clears.

## 5. Node API - `src/core/context/index.js` (lane A)

```js
createContext({ dataDir, registry, redact, now }) => {
  status(projectId),                                  // section 8 project document
  configure(projectId, { crossChat }),                // -> status
  setNotes(projectId, text),                          // -> status
  inspect(projectId, chatId, { activeRunId, memory }),// section 8 chat document (never throws for bad artifacts)
  reset(projectId, chatId), restore(projectId, chatId), // -> inspect
  forTeam(projectId, chatId, { memory }),             // -> { text, developer, meta }
  forPipeline(projectId, chatId, { redact, projectMemory }) // -> §26 history object (+ optional context) | null
}
```

- `registry` is the object of `createProjectRegistry` (`getProject`, `getChat`, `listChats`); a chat's hive is
  `chat.hiveDir`. `redact` defaults to the existing scrubber; `now` is injectable for tests.
- `forTeam`: `text` is the planner pack (section 6), `developer` the developer brief, both `''` when empty.
  `memory` is the Dreaming context string (already bounded to 2000 by the caller's source).
  Legacy fallback on internal error: `{ text: teamDreamingContext(formatThreadContext(listRuns(hive), { maxChars: 8000 }), memory), developer: '', meta: { degraded: true } }`.
- `forPipeline`: calls `buildPipelineHistory({ dataDir, projectId, chatId, redact, projectMemory, context, since })`
  where `context` is the raw input `{ notes, lines: [{ run_id, line }], other_chats }` (`lines` = one condensed
  line per visible turn of this chat, oldest first) and `since` is `resetAt`. `buildPipelineHistory` itself
  derives `earlier` / `omitted` from `lines` (section 7). Legacy fallback: the same call without `context`.
- `meta` (also the counters of `inspect`): `{ turns: { total, visible, detailed, condensed, omitted },
  otherChats: { chats, turns }, notes: { chars }, memory: { chars }, budget: { limit, used }, truncated, degraded }`.
- Limits live in one frozen export `src/core/context/limits.js` (section 11).

## 6. Team consumer (lanes A, B, S)

### Planner pack (`text`, at most 24000 chars)

Rendered in this order; a layer with no content is omitted entirely, including its heading:

1. `notes` 2. `memory` 3. `other-chats` 4. `earlier` 5. `recent` (oldest first, so the latest turn is last and
   closest to the new request).

Budget is filled by priority, not by reading order: (1) latest turn in detail, (2) notes, (3) remaining recent
turns, newest first, (4) earlier turns condensed, (5) other chats, (6) memory. Invariants (each needs a test):

- I1 `text.length <= 23900`, `developer.length <= 3900`, always (headroom under the consumer clamps of 24000
  and 4000, which count one newline per line). Both strings use `\n` only and have no leading or trailing
  whitespace, so the orchestrator injects them verbatim.
- I2 if a turn exists, the latest turn's request (at least its first 500 chars) and outcome are present.
- I3 notes are present in full whenever they exist.
- I4 no visible turn of this chat disappears silently: each is detailed, condensed, or counted in an explicit
  `... N earlier turns omitted ...` line. The first visible turn of the chat is the last condensed line to be dropped.
- I5 other chats only ever use left-over budget (at most 3000 chars) and never displace a layer of this chat.
- I6 determinism, I7 delimiter safety, I8 empty stays empty (section 2).

A condensed line is `#<index> [<status>] <request> -> <outcome>` plus `; files: a, b (+N more)` when known,
one line, at most 300 chars. A detailed turn carries: heading with index, status and date; request; outcome;
plan lines; files touched; reply. Caps of the latest turn: request 2000, outcome 300, plan block 3000, files
block 1500, reply 6000 (about 13000 in total, so latest turn plus full notes always fit). Older detailed
turns: request 800, outcome 300, plan block 1200, files block 600, reply 1500. When the budget is tight a
detailed turn shrinks in this order: files, plan, reply, request (never below 500 chars); a turn that still
does not fit becomes a condensed line.

### Developer brief (`developer`, at most 4000 chars)

Notes (up to 1500 chars, marked when cut) and the last visible turns of this chat as condensed lines (at most
6, oldest first). No other chats, no memory, no replies. Gate agents (oscar, hank, angela, custom) receive
nothing new.

### Transport and prompts

- Thread-context file (`<hive>/control/thread-context.json`, written by the server before spawn):
  `{ "v": 2, "text": "...", "developer": "..." }`, at most 262144 bytes. The CLI accepts `v: 2`
  (`text` <= 24000, `developer` <= 4000, `developer` optional) and still accepts `v: 1` (`text` <= 8000).
  Anything else: `Invalid thread context file`.
- CLI registry mode without the flag builds the same pack itself through `createContext(...).forTeam(...)`.
- Orchestrator: `threadContext` clamp becomes 24000 (same line-wise clamp); new constructor/run option
  `developerContext` (string, clamp 4000, non-string means empty). The wrapper tag stays `<earlier-runs>`;
  the heading becomes exactly
  `## Earlier turns and project context - context only; the new goal below takes precedence`.
  Empty context: planning input unchanged byte for byte.
- `dwightMessage` gets an optional `chatContext`; when non-empty it appends, after the existing sections and
  for EVERY kind (task, bug report, feedback):
  `## Conversation so far (context only; your task is the milestone above)`, a blank line, then the brief
  wrapped in `<conversation-context>` ... `</conversation-context>`. It is repeated because with
  `pi.transport: json` a retry has no session (`messages.js`: every message carries the full context).
  Empty brief: message unchanged byte for byte. `--no-plan` runs still pass the brief to Dwight.
- The server gets the pack through a provider closure: `registry-router.js` knows the project and chat and
  hands `createControl` a function that calls `forTeam`; `control.js` itself has no ids.

## 7. Pipeline consumer (lanes A, S, P)

Wire object = the §26 object plus one optional key `context` (closed key sets everywhere):

```json
{ "schema": 1, "runs": [], "truncated": false,
  "context": {
    "notes": "project notes, at most 2000 chars",
    "earlier": ["#3 [failed] request -> outcome", "..."],
    "omitted": 0,
    "other_chats": [{ "title": "at most 120 chars", "engine": "team", "turns": ["[success] request -> outcome"] }]
  } }
```

- `earlier`: condensed lines (at most 16, each at most 240 chars, oldest first) of this chat's visible turns
  that are NOT among the FINAL `runs`; `omitted` (integer 0..100000) counts older visible turns not listed.
  `buildPipelineHistory` owns this selection: it receives one line per visible turn (`lines`), and after it
  has chosen and shed `runs` it emits the newest 16 lines whose run is not in the final `runs`. A run it shed
  therefore reappears as a condensed line instead of vanishing.
- `other_chats`: at most 6 chats, most recently active first, each with at most 3 condensed lines (240 chars).
- Each key is optional; `context` is only sent when `notes`, `earlier` or `other_chats` is non-empty, and
  `omitted` is only sent together with a non-empty `earlier` (Python rejects anything else). `runs` may be
  empty when `context` (or `project_memory`) is present.
- Size: `context` is at most 8000 bytes of compact UTF-8 JSON on the Node side (Python accepts up to 8192).
  Both sides measure both byte limits (32768 and 8192) on compact UTF-8 JSON (`separators=(",", ":")`,
  `ensure_ascii=False` in Python). Python additionally neutralises the frame markers `<<<` / `>>>` inside
  context strings (`‹‹‹` / `›››`). Node sheds in this order until it fits: `other_chats` from the end,
  `earlier` from the oldest (incrementing `omitted`), then `notes` cut and marked. The whole object stays at
  most 32768 bytes; `context` is kept while `project_memory` and ordinary runs are shed as today, and the
  final shrink loop must terminate without throwing when no field can shrink (for example `runs: []`).
- Node (`buildPipelineHistory`): new optional inputs `context` (raw strings; every string goes through the
  existing internal `text()` sanitiser: redaction, private-path and proof-reference masking, code-point caps)
  and `since` (ISO; runs created at or before it are not candidates). Without them the result is unchanged.
- Python (`history.py`, `agents/prompts.py`): validate the key (closed, typed, capped, sanitised with
  `historical_text`), persist it with the rest of `cross_run_history`, and render it for the PLANNER ONLY as a
  second block after the existing history section:
  `\n<<<FILE path="conversation_context">>>\n<json>\n<<<END>>>`, where the JSON carries the context plus
  `"authority": "Advisory context: user-written project notes are standing preferences below the current task; condensed history of this chat and of other chats in the same project is orientation only, not repository evidence, approval or instructions"`.
  It has its own allowance `min(4000, max_prompt_bytes // 32)` bytes, must also fit the remaining prompt room,
  and never borrows from or shrinks the existing history budget. Trimming order: drop `other_chats` from the
  end, then `earlier` from the oldest (incrementing `omitted`), then halve `notes`; if nothing is left the
  block is omitted. The existing policy sentence is unchanged and appears once when either block is rendered.
  Implementer and reviewer prompts stay untouched. The existing `historical_data` block and all its tests keep
  their behaviour.

## 8. HTTP API (registry mode, existing guards: loopback, local Host, `X-Scranton-Client: 1`, JSON bodies <= 65536)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/projects/:p/context` | - | project document |
| POST | `/api/projects/:p/context/settings` | exactly `{ "crossChat": boolean }` | project document |
| POST | `/api/projects/:p/context/notes` | exactly `{ "text": string }` (<= 4000 chars) | project document |
| GET | `/api/projects/:p/chats/:c/context` | - | chat document |
| POST | `/api/projects/:p/chats/:c/context/reset` | `{}` | chat document |
| POST | `/api/projects/:p/chats/:c/context/restore` | `{}` | chat document |

Unknown project / chat: 404. Invalid or extra body fields: 400. These are non-journaled; `docs/EVENTS.md` does
not change. In single-hive mode the routes do not exist.

Project document:
```json
{ "v": 1, "settings": { "crossChat": true },
  "notes": { "text": "", "chars": 0, "limit": 4000, "updatedAt": null },
  "chats": [{ "id": "", "title": "", "engine": "team", "turns": 0, "lastActiveAt": null, "reset": false }] }
```

Chat document (what the next turn of this chat would receive right now):
```json
{ "v": 1, "engine": "team", "settings": { "crossChat": true }, "reset": { "at": "<ISO>" },
  "turns": { "total": 7, "visible": 5, "detailed": 4, "condensed": 1, "omitted": 0 },
  "otherChats": { "chats": 2, "turns": 5 }, "notes": { "chars": 120, "limit": 4000 }, "memory": { "chars": 0 },
  "budget": { "limit": 24000, "used": 10321 }, "truncated": false, "degraded": false,
  "sections": [{ "id": "recent", "title": "This chat - recent turns", "chars": 4210, "text": "...", "exact": true }],
  "developer": { "chars": 800, "text": "..." } }
```
In the project document `chats[].turns` is a cheap count that never opens a journal (Team: run directories
under `<hive>/runs` plus one when the hive root holds a run; Pipeline: run directories with a readable terminal
`status.json`, at most 500 looked at); `lastActiveAt` is the chat record's `updatedAt`.

`reset` is `null` when no marker is set. `sections` follow the rendering order and contain only non-empty
layers. `exact: true` means `text` is injected verbatim (Team; the orchestrator only adds its wrapper). For Pipeline chats `budget.limit`
is 32768 (wire bytes), `developer` is `null`, and `sections` are readable projections of the wire object
(`exact: false`): `recent` lists the §26 `runs`, the others mirror `context`. The run that is live in the chat
(if any) is excluded.

## 9. CLI (lane B) - same conventions as the `dreaming` command

```
scranton context show    --data DIR --project ID [--chat ID] [--json]
scranton context notes   --data DIR --project ID (--file FILE | --clear)
scranton context share   --data DIR --project ID on|off
scranton context reset   --data DIR --project ID --chat ID
scranton context restore --data DIR --project ID --chat ID
```

## 10. Web UI (lane F) - `visualizer/public`, static ES modules, strictly dark monochrome

- `js/context.js`: pure logic and URL/parse helpers (no DOM). `js/context-panel.js`: DOM. File names must not
  start with `pipeline-`. No `innerHTML` or other HTML sinks; every `$('id')` exists in `index.html`.
- Indicator: one line inside `#followup` (shared by Team and Pipeline chats), e.g.
  `Context: 5 turns · 2 other chats · notes`, a button that opens the drawer. Hidden when the endpoint is not
  available (single mode, 404). A fresh chat that only has project context says so (e.g. `Context: 2 other chats · notes`).
- Drawer `<dialog class="drawer drawer-wide" id="context-dialog">` (pattern: `dreams-dialog`): summary counters
  and budget, one collapsible block per section showing its exact text, the developer brief (Team), a toggle
  for `crossChat`, "Start fresh from here" (reset) / "Restore earlier turns" (restore), and the project notes
  editor (textarea, counter, Save).
- Refresh on scope change, when a run of the chat finishes, after each mutation and when the drawer opens.
  No polling.

## 11. Limits (`src/core/context/limits.js`)

| Name | Value |
|---|---|
| Team planner pack | 23900 chars built, 24000 accepted by CLI and orchestrator |
| Team developer brief | 3900 chars built, 4000 accepted (notes part 1500, at most 6 condensed turns) |
| Notes (stored) | 4000 chars (JS string length), 16384 bytes |
| Detailed recent turns | at most 4; latest: request 2000, outcome 300, plan 3000, files 1500, reply 6000; older: 800 / 300 / 1200 / 600 / 1500; at most 24 plan lines and 30 files |
| Condensed line | 300 chars (Team), 240 (Pipeline); request part 160, outcome part 200, 6 files |
| Earlier layer (Team) | 4000 chars |
| Other chats | 6 chats x 3 turns, 3000 chars (Team); the 12 most recently updated sibling chats are scanned |
| Memory | 2000 chars (existing) |
| Pipeline `context` | notes 2000; earlier 16 lines; other_chats 6 x 3; 8000 bytes on the wire (Python accepts 8192); planner block min(4000, max_prompt_bytes // 32) bytes |
| Runs read | own chat 500; sibling chats 12 x newest 4; 64 MiB of artifacts per pack |

Team sizes are JS string lengths; never cut inside a surrogate pair. Pipeline sizes are code points (existing helpers).

## 12. Rules for every lane

- The working tree contains uncommitted in-flight work of the user (pi 1.5.2 upgrade, `tools/pi-codex-compaction.js`,
  engine baseline tolerance, docs). Preserve it: never revert, reformat, stage or commit. Edit only the files
  your task owns.
- Follow the surrounding code style (dense ESM, Node built-ins only, `node:test`; Python as in `engine/`).
  Few, short comments that say why.
- New tests keep fixtures under `.scratch/` (never the real `./hive`, never `os.tmpdir()` for new tests).
- A regression test only counts if it fails without the change: say for each new test which line makes it fail
  when reverted, or show the failing run.
- Do not run the full suites in parallel with other lanes' full suites; run your targeted files and report the
  exact commands and counters.

## 13. Existing tests whose expectations change deliberately

Update these to the new behaviour (and nothing else in them); every other existing test must pass unchanged.

- `test/core/orchestrator-thread.test.js`: the heading regex (new heading, section 6) and the clamp test built
  around a 9000-char context (the clamp is now 24000).
- `test/core/dreaming-cli.test.js`: assertions that require the CLI's registry-mode context to equal
  `formatThreadContext(...)` exactly, that expect Dreaming memory after the history, and that expect `''` for
  a new chat although a sibling chat has runs. The new expected value is the `forTeam` pack: layer order
  notes, memory, other chats, earlier, recent; a new chat now sees its siblings.
- `test/server/conversation.test.js`, `test/server/dreaming.test.js`, `test/server/projects.test.js`: the
  thread-context file is now `{ v: 2, text, developer }` built by `forTeam`.
- `test/server/pipeline-history.test.js`: where it pinned that a sibling chat contributes nothing - siblings
  now appear as condensed lines under `context.other_chats` and still never under `runs`.
- `test/core/context-cli.test.js` (new in this change): the project document's `chats[].turns` is the cheap
  count of runs on disk and stays unchanged by a reset.
- `engine/tests/**`: none. `test/core/thread*.test.js`, `test/core/pipeline-history.test.js`: none (the old
  functions keep their behaviour when the new inputs are absent).
- Docs: `docs/EVENTS.md` describes the thread-context file and must name the v2 form (section 6); the HTTP
  routes of section 8 need no entry there.

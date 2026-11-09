# Multi-project + chat threads contract (2026-11-08 19:40)

Research: `.scratch/multiproject-research/findings.md`. User choice: chats are threads with history (follow-ups continue a thread), several projects at once AND several runs in parallel within one project.

## Model
- **Project** `{ id, name, workspace, createdAt }`. id `^[a-z0-9][a-z0-9-]{0,39}$`, workspace = absolute real path of an existing folder (or created on request under the default projects root). One project per workspace (realpath, case-insensitive on Windows); not the data dir, not inside it, not a drive root / %WINDIR% / user profile root. Removing a project never touches workspace files.
- **Chat** (thread) `{ id, projectId, title, hiveDir, createdAt, updatedAt }`. Each chat is exactly ONE hive: one active run per chat (the existing hive lease), any number of chats running at once across projects. A follow-up in a chat is a new run in the same hive (`archivePreviousRun` keeps earlier runs in `hive/runs/<runId>/`). Title defaults to the first goal (60 chars), renameable.
- Storage: `<data>/projects.json` `{ v:1, projects:[...] }` and `<data>/projects/<projectId>/chats/<chatId>/chat.json` + `hive/`. A chat may reference an external `hiveDir` (legacy import). All writes atomic under a lock; corrupt files are never overwritten.
- `<data>`: desktop `%APPDATA%\dev.scranton.desktop`; CLI `--data <dir>` / `SCRANTON_DATA`. Default projects root for new folders: `Documents\Scranton\projects\<id>`.

## Modes (backward compatible)
- **Registry mode**: `visualize --data <dir>` / `app-server --data <dir>`.
- **Single mode** (unchanged): `--hive/--workspace` without `--data`. Exposes one implicit project `default` with one chat `default` mapped to that hive, so the UI can always use scoped routes. Project/chat create/remove return 409 `single_mode`.
- All existing unscoped routes (`/events`, `/api/state`, `/api/runs`, `/api/chat`, `/api/hitl`, `/api/control`, `/api/stop`...) keep working exactly as today in single mode. In registry mode they act on the most recently active chat, except `GET /api/control`, which aggregates across all chats in the shape the desktop tray reads (src-tauri/src/main.rs pending_human) plus `{ running, pendingHuman }` counts.

## Routes (registry and single mode; same hardening as control routes, GETs need `X-Scranton-Client: 1`)
- `GET /api/projects` -> `{ mode:'registry'|'single', maxConcurrentRuns, running, projects:[{ id, name, workspace, chats:[{ id, title, status:'idle'|'running'|'needs_human'|'done'|'failed'|'stopped', updatedAt, runs }] }] }`
- `POST /api/projects { name, workspace?, create? }` -> 201 `{ project }` (workspace omitted = create under default root; `create:true` creates a missing folder).
- `POST /api/projects/rename { id, name }`, `POST /api/projects/remove { id, deleteHistory? }` (409 while any of its chats runs; deleteHistory removes only Scranton data under `<data>`).
- `POST /api/projects/:p/chats { title? }` -> 201 `{ chat }`; `POST /api/projects/:p/chats/rename { id, title }`; `POST /api/projects/:p/chats/remove { id }` (409 while running).
- Scoped chat routes: prefix `/api/projects/:p/chats/:c`, then the existing suffix: `/events` (SSE), `/state`, `/runs` (GET list, POST start = same body as today's `POST /api/runs`), `/chat`, `/hitl`, `/stop`, `/control`.
- `GET .../runs` -> `{ runs:[{ runId, goal, status, startedAt, endedAt, current }] }` (archived + current, oldest first). `GET .../runs/:runId/events` -> archived events as `{ events:[...] }` (cap 20 MiB -> 413), read-only replay.
- Starting a run when `running >= maxConcurrentRuns` (config `maxConcurrentRuns`, env `SCRANTON_MAX_RUNS`, default 4) -> 429 `too_many_runs`. A chat already running -> 409.

## Thread context (follow-ups)
- `src/core/thread.js`: `listRuns(hiveDir) -> [{ runId, goal, status, startedAt, endedAt, summary }]` from archived + current run files (summary: plan milestones + outcome, bounded), and `formatThreadContext(runs, { maxChars: 8000 }) -> string` (newest runs kept when trimming).
- The server writes the formatted context of earlier runs to `<hive>/control/thread-context.json` `{ v:1, text }` before spawning the run and passes `--thread-context <file>` to `scranton.js run`; `cli.js` reads it and gives `threadContext` (string) to the Orchestrator, which adds it to Michael's planning prompt as earlier conversation in this thread (clearly delimited, not as instructions to override the new goal).

## Workspace safety for parallel runs
- Integration into the workspace takes a cross-process lock keyed by the workspace realpath (`os.tmpdir()/scranton-locks/<sha256-16>.lock`, PID + stale recovery), in addition to the existing in-process `locks` map in `worktree.js`. The existing baseline comparison keeps detecting conflicts; a conflict fails that milestone as today and must never write partial files.

## UI
- Left sidebar: projects (collapsible) with chats; status per chat (running / needs you / done / failed); "+ New project", "+ New chat" per project; switching never stops anything; badge on background chats needing a human. Hash route `#/p/<project>/c/<chat>`.
- Main pane = existing dashboard bound to the selected chat's scoped routes; run picker in the chat header (current live run or read-only replay of a past run); composer "Follow up" starts a new run in this chat (disabled while it runs; agent steering chat unchanged while running).
- New project dialog: name + folder path (absolute path text field; empty = create under default root). Remove/rename with confirm.

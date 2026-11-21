# Code map: src/core

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "src/core/agents-config.js"
kind: "where"
text: "The persistent agent settings store, `<settingsDir>/agents.json` (v:1). settingsDir is dataDir in registry/desktop mode and hiveDir in single mode; env SCRANTON_SETTINGS_DIR passes it to child runs.\n\nWhat it holds:\n- model and thinking for every agent;\n- full definitions of custom GATE agents: id, name, title, pass/fail keywords, read-only tools, instruction. At most 12.\n\nHow it behaves:\n- It is re-validated on every load. Invalid entries are skipped and reported as `warnings` in GET /api/agents and in `doctor`.\n- Model precedence: per-run request > env SCRANTON_<ID>_* > config agents.<id> > agents.json > pi default. Fields set by env or config are reported as pinned.\n- A custom agent without `<promptsDir>/<id>.md` uses a starter prompt generated from its definition.\n\nSpec: .enma/custom-agents-contract.md; §10 and §11 override earlier sections."
hash: "shape:750cc159fe69bef0"
written: "2026-11-09"
by: "core"
---

---
file: "src/core/live-activity.js"
symbol: "createLiveActivity"
ordinal: 0
kind: "how"
text: "Per-run writer of the non-durable `<hive>/live.json` (atomic, at most one write per 400 ms, write failures ignored) plus the durable `thoughts.jsonl` (`THOUGHTS_FILE`). update(instanceId, agent, record): an assistant `message_start` flushes open blocks and resets the instance; `message_update` merges thinking / text deltas by `contentIndex` (each part keeps its last 4000 characters), and the instance entry shows the cleaned last 2000 characters per kind with cut flags and `open` = the kind still being written; `tool_execution_start` sets phase tool, `tool_execution_end` / `message_end` set idle. A block that ends is appended to thoughts.jsonl as one JSON line ({ v, n, ts, runId, instanceId, agent, kind: reasoning | answer, text, cut }) with text cut to `THOUGHT_MAX` (20000); appending stops for the run once `THOUGHTS_MAX_BYTES` (8 MiB) is exceeded; blocks still open at message end, removal or close are flushed with cut: true. remove(instanceId) flushes and drops the instance; close() flushes all, then persists `emptyLive`."
see_also: "src/core/events.js EventRecorder; readLive in the same file; .enma/live-activity-contract.md"
hash: "span:0803a62b541c9d8d"
written: "2026-11-21"
commit: "cd0d158"
by: "core"
---

---
file: "src/core/model-windows.js"
symbol: "createModelWindows"
ordinal: 0
kind: "how"
text: "Resolver for a model's context window: resolve({ provider?, model }) -> { id, window, known }. Order: custom provider declarations first (provider store under PI_CODING_AGENT_DIR or ~/.pi/agent; providers with status 'error' are skipped), then pi's model registry through createModelRuntime() from auth.js (one shared lazy promise per process; a failed load is cached as null). A window counts only if every match has the same positive contextWindow; otherwise, or for a malformed ref (modelId: well-formed, 1..256 chars, no whitespace or C0/C1 control characters), the answer is the unknown recipient with LIMITS.window (128000) and known:false. resolve never throws and uses no network. warm() starts the registry load in the background (about 1.3 s cold here). Both sources are injectable ({ providers, runtime }); the server creates and warms one resolver in registry mode only and tests inject a fixture (test/server/model-windows-fixture.js)."
see_also: ".enma/context-budget-contract.md section 3; src/server/visualizer-server.js (warm), src/server/control.js (resolve only when a context pack is built)"
hash: "span:c10e303f0672f6c7"
written: "2026-11-17"
commit: "6e5199a"
by: "core"
---

---
file: "src/core/orchestrator.js"
symbol: "Orchestrator"
ordinal: 0
kind: "how"
text: "`run` emits `run_started` with the audited role prompts (`auditRole`), gets Michael's plan (or a direct answer in conversation mode) and schedules the milestones with `runDag` (`maxParallel` from `config.execution`, default 1). In conversation mode a `run_reply` is emitted before `run_finished`; agent texts are journaled as `agent_message` cut to 16000 characters with a `truncated` flag. `#runAgent` wires `onLive` to the run's live writer (`this.rec.live.update`) and `onUsage` to durable `agent_usage` events. `#askHumanNow` in `onBreaker === 'hive'` mode first rejects a stale response (`rejectResponse`), writes `<hive>/human/request.json` atomically (temp file + rename, through `safePath`), waits in `waitForResponse` and removes the file when the wait ends."
see_also: "src/core/live-activity.js; src/core/state.js; src/core/file-control.js; .enma/live-activity-contract.md; .enma/chat-view-contract.md; README section on --on-breaker hive"
hash: "span:fedbbeabd2e3fedb"
written: "2026-11-21"
commit: "cd0d158"
by: "core"
---

---
file: "src/core/pipeline-activity.js"
symbol: "pipelineSteps"
ordinal: 0
kind: "how"
text: "Pipeline completed step projection uses report.steps as exact authority, otherwise tracks outer implementer procedure scope step:* and commits only after outer verify→select_step. wave_merged steps wait for integration verify; lane-tagged local verify routes are ignored. Replan/finalize clears pending scope/merges. stepsDoneExact compares derived count to persisted status.progress.steps_done; derivation may undercount rather than claim unverified completion."
see_also: "engine/src/scranton_pipeline/nodes/common.py; routing.py; nodes/parallel.py; .scratch/live-backend-fix/REPORT.md"
hash: "span:4fd0865ee689e491"
written: "2026-11-12"
commit: "9ec5519"
by: "core"
---

---
file: "src/core/pipeline-activity.js"
symbol: "pipelineSteps"
ordinal: 0
kind: "trap"
text: "The procedure scope optional chain guards null/undefined only, not non-string JSON values. Normal engine events emit string scopes; external/corrupted procedure records with another type can throw during projection."
evidence: "`d.scope?.startsWith('step:')`"
see_also: "Final backend review a291 low; live-activity/backend/non-string-procedure-scope"
hash: "span:4fd0865ee689e491"
quote: "quote:7425f77c32572534"
written: "2026-11-12"
commit: "9ec5519"
by: "core"
---

---
file: "src/core/pipeline-command.js"
symbol: "resolvePipelineCommand"
ordinal: 0
kind: "trap"
text: "Packaged runtime roots never fall back to a dev/system interpreter: launch.json is validated for schema, platform/arch and fixed args; missing/invalid manifest rejects unless manifestless Windows x64 legacy python.exe exists. Dev POSIX uses bin/python in .scratch/pipeline/venv then engine/.venv; SCRANTON_PIPELINE_COMMAND remains highest priority."
evidence: "`throw Error('Pipeline runtime launch.json is missing; reinstall the packaged runtime');`"
see_also: "engine-runtime/launch.json generated by scripts/prepare-desktop.mjs; test/core/pipeline-command.test.js"
hash: "span:39b2ca06db320bf8"
quote: "quote:5c0a8b7fe00c2fe3"
written: "2026-11-11"
commit: "2118ea5"
by: "core"
---

---
file: "src/core/pipeline-supervisor.js"
kind: "where"
text: "Node side of Pipeline chats: one engine process per run/resume/cancel/demo invocation (`python -m scranton_pipeline ...`, always --parent-guard), run storage under `<dataDir>/projects/<p>/chats/<c>/pipeline/{runs,requests}`, workspaces under SCRANTON_PIPELINE_WORKSPACE_ROOT (Windows default %LOCALAPPDATA%\\Scranton\\pipeline), model catalogue (api_key accounts on OpenAI-compatible endpoints go direct with the key only in SCRANTON_PIPELINE_KEY_<ROLE> env; every other pi model is configured as provider \"command\" through tools/pipeline-pi-complete.js), launchError persistence, artifact reads by name. New non-demo starts write `requests/<runId>.history.json` from the injected context service: `context.forPipeline(p, c, { redact: sandboxText, projectMemory })`, persisted unchanged and passed as --history-file (legacy buildPipelineHistory when no service is injected); demo, resume, decision and cancel never attach history. Command resolution lives in pipeline-command.js (SCRANTON_PIPELINE_COMMAND -> bundled engine-runtime/python -> dev venv .scratch/pipeline/venv). Routes are mounted in src/server/registry-router.js; a chat's engine is fixed by `engine: \"pipeline\"` in chat.json and the legacy lease/recovery path is not used for these chats."
see_also: ".enma/pipeline-contract.md sections 6, 9, 14, 15, 26, 27; .enma/context-contract.md section 7; docs/PIPELINE.md; tests test/server/pipeline*.test.js, test/server/context.test.js with the fake engine tools/fake-pipeline.js"
hash: "shape:fc74c3f3aa73e7ec"
written: "2026-11-16"
commit: "2867259"
by: "core"
---

---
file: "src/core/prompts.js"
symbol: "resolvePrompt"
ordinal: 0
kind: "how"
text: "Prompt resolution: config-pinned agents.<id>.skill wins, else <promptsDir>/<id>.md, else builtin SKILL.md (or generated starter for custom gates). Frontmatter cleaned; failures name agent and path. missingKeywords advisory. The orchestrator snapshots resolved prompts per run and stagePrompt supplies the staged system.md to Pi; changing a custom prompt affects the next run. Built-in and custom gates share this precedence."
see_also: ".enma/custom-agents-contract.md; src/core/orchestrator.js, src/core/pi-runner.js"
hash: "span:ff3c2abb1be537fc"
written: "2026-11-11"
commit: "2118ea5"
by: "core"
---

---
file: "src/core/restore-points.js"
kind: "where"
text: "Restore points: the pre-run content of every file a run's integration replaces, deletes or creates in the user's workspace, kept so the run can be undone. On disk: `<hive>/restore-points/<runId>/manifest.json` plus `preimages/<sha256>` (a file the run created has no pre-image). Exports: `prepareRestorePoint({ hiveDir, runId, workspace, changes, before, initial, after })` - called by the worktree integration before it writes, returns `commit` / `rollback`; `listRestorePoints(hiveDir)` - newest first, `{ runId, createdAt, workspace, files, undoneAt, remaining }`, an entry that cannot be read is `{ runId, unreadable: true }`; `undoRun({ hiveDir, runId, force, siblings })`; `workspaceState(workspace)`. One definition for the whole module: a file is open when it is restorable, not undone and not `undoUnrestorable` (`openFile`); `remaining` counts open files; a point is settled when `undoneAt` is set or no file is open (`settled`). Limits: `MAX_PREIMAGE_BYTES` 16 MiB per file (larger files are recorded as not restorable), `MAX_MANIFEST_BYTES` 8 MiB, the current point plus the 9 newest other readable points are kept (pruned after commit, best effort). Not covered: execution modes that write into the workspace directly, the standalone `scranton agent` command, Pipeline chats. Manifests store the absolute workspace path."
see_also: "src/core/worktree.js (integration calls prepareRestorePoint); src/core/cli.js cmdUndo; src/server/registry-router.js routes `<chat scope>/restore-points` (GET) and `/undo` (POST); visualizer/public/js/undo.js; test/core/restore-points.test.js; README section on undo"
hash: "shape:9d6ad17c00800dd5"
written: "2026-11-21"
commit: "3bfce73"
by: "core"
---

---
file: "src/core/restore-points.js"
symbol: "undoRun"
ordinal: 0
kind: "how"
text: "Undo of one restore point. Holds the hive's run lease itself (`acquireRunLease`, `mode: 'undo'`, id `undo-<uuid>`, heartbeat) and releases it in `finally`. Refuses while a hive in `siblings` (other chats of the project; passed by the registry route and the CLI's registry form) has a lease that is not automatically recoverable. Selection: the given `runId`, else the newest readable point that is not `settled`; refused when a newer readable point is not settled; `force` is refused when an unreadable entry's directory is newer than the selected point. Runs inside `withWorkspaceLock` and yields after every file and directory (`await new Promise(setImmediate)`): without it a few hundred files froze the server and the parent guard aborted other chats' runs. Per file: not restorable, or a backup that is missing, irregular, oversized or fails size / SHA-256 -> `unrestorable`, persisted as `undoUnrestorable`; content differs from what the run last wrote and no `force` -> `changed`, left alone; otherwise the pre-image is written back atomically or a created file is unlinked, bracketed by `undoPending` saves; any other failure, also a transient error reading the backup -> `blocked` (`blockedReason`), not persisted, retried next time. Created directories are removed deepest first when empty; other errors become `warnings`. `undoneAt` is set once the point is settled."
see_also: "Result shape { runId, restored, removed, conflicts: [{ path, reason, code }], warnings }; src/core/run-lease.js cliRecoveryStatus and guardParent; src/core/run-recovery.js (releases an undo-mode lease without touching any run); test/core/restore-points.test.js; .scratch/usability/probe/ scenario scripts"
hash: "span:30b91d82be26c3ab"
written: "2026-11-21"
commit: "3bfce73"
by: "core"
---

---
file: "src/core/restore-points.js"
symbol: "workspaceState"
ordinal: 0
kind: "trap"
text: "Deliberately starts no git process. It only walks up from the workspace looking for a `.git` entry and reports `{ git, dirty: null, untracked: null }`. Running `git status` (or any git command that reads the work tree) inside the user's folder would honour that folder's own `.git/config` - an fsmonitor command or filter drivers named there are executed on the host, before the user has trusted anything. A first version did exactly that and was removed after review; do not \"improve\" the run-start notice by counting changed files with git."
evidence: "`const stat = fs.lstatSync(path.join(dir, '.git')); if (stat.isDirectory() || stat.isFile()) return { ...unknown, git: true };`"
see_also: "src/core/cli.js run-start notice (\"Git status is not inspected\"); test/core/restore-points.test.js"
hash: "span:f607dbd972cf00f7"
quote: "quote:ed3dfa3d87df155f"
written: "2026-11-21"
commit: "cd0d158"
by: "core"
---

---
file: "src/core/run-lease.js"
symbol: "cliRecoveryStatus"
ordinal: 0
kind: "how"
text: "Decides whether the CLI may recover a stale hive owner on its own. Returns `{ owner, host, seconds, automatic }`: `owner` is `runOwnerStatus` unchanged (`alive` = pid answers and heartbeat within `RUN_STALE_MS` = 30000 ms; `gone` = pid does not exist on this machine; everything else `unknown`); `automatic` is true only when the owner is `gone` AND the lease records no host or this machine's `os.hostname()` AND the heartbeat of that same run id is older than `RUN_STALE_MS`. A dead pid with a fresh heartbeat is therefore not recovered automatically - that is how a live run on another machine, in WSL or in another pid namespace sharing the hive looks. Used by `scranton run` / `recover` in cli.js and by `undoRun` to judge sibling hives; the server's orphan recovery keeps using `runOwnerStatus` directly. Leases carry `mode: 'undo'` when `undoRun` holds them; recovery releases such a lease without touching any run."
see_also: ".enma/orphan-recovery-contract.md; src/core/run-recovery.js recoverOrphan; src/core/restore-points.js undoRun; docs/CONTROL.md recovery section"
hash: "span:7de5c80505479479"
written: "2026-11-21"
commit: "cd0d158"
by: "core"
---

---
file: "src/core/run-summary.js"
kind: "where"
text: "What `scranton run` prints when a run ends. `formatRunSummary(orchestrator, result, durationMs)` builds the block from recorded data only: outcome, milestone counts by status from `orchestrator.rec.state`, the files whose integrated content differs from the initial snapshot (`orchestrator.worktrees.initial` vs `.integrated`; count plus up to 20 paths), an `Undo: scranton undo --hive <dir> --run <id>` line only when the run changed files and its restore point exists and is not undone, the private worktree for the standalone `scranton agent` command, duration, recorded usage / cost, and the path of `events.jsonl`. `quotePathArgument(value, platform)` quotes a path for the commands the CLI and doctor print (double quotes on Windows without doubling backslashes inside the path; single quotes elsewhere)."
see_also: "src/core/cli.js execute (writes the block to stderr); src/core/doctor.js; test/core/cli-usability.test.js; test/core/cli-undo.test.js"
hash: "shape:93ebef10277dfce6"
written: "2026-11-21"
commit: "cd0d158"
by: "core"
---

---
file: "src/core/usage.js"
symbol: "foldUsage"
ordinal: 0
kind: "how"
text: "Accumulates Team input/output/cost and per-role calls/tokens; tokens=input+output. Sets first-call startedAt and adds cumulative per-agent point on every delta. Above120points keeps even indices plus latest. Server state.js reconciles per-instance pending usage at finish; browser state.js mirrors this fold and tests compare reducers."
see_also: "src/core/state.js; visualizer/public/js/state.js; test/visualizer/live-activity.test.js"
hash: "span:645eb9de33d956f3"
written: "2026-11-12"
commit: "9ec5519"
by: "core"
---

---
file: "src/core/workflow.js"
kind: "where"
text: "The gate workflow vocabulary lives here:\n- GATE_ROLES (oscar, hank, angela), PASS_KEYWORDS per gate, ROLE_NAMES.\n- normalizeWorkflow({gates}): validates the normalized array-of-arrays form. Unknown, duplicate, non-gate and empty stages are refused with status 400.\n- activeRoles(config, noPlan): michael unless noPlan, then dwight, then the gates. It decides which roles need models (validateDockerModels).\n\nThe engine default is [[\"angela\"]] (legacy event order). The UI defaults to [[\"oscar\",\"hank\"],[\"angela\"]]. The CLI uses --gates \"oscar+hank,angela\": comma separates stages, plus runs roles in parallel. The spec is .enma/roles-contract.md."
hash: "shape:46c6bc6aa03bfa95"
written: "2026-11-09"
by: "core"
---

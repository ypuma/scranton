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
text: "Non-durable per-run live.json writer. Assistant message_start resets per-instance blocks/tails; message_update merges thinking/text by contentIndex, cleans and retains last2,000chars with cut flags. Writes atomically at400ms cadence; remove clears a finished instance, close immediately persists emptyLive. Orchestrator wires both pi transports; reasoning is not journaled."
see_also: "src/core/events.js EventRecorder; readLive; .enma/live-activity-contract.md"
hash: "span:0904cd92f2df17bf"
written: "2026-11-12"
commit: "9ec5519"
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
text: "run snapshots role prompts into audited run_started, obtains Michael plan or conversation direct answer, schedules dependency-ready milestones via runDag(maxParallel). Dwight snapshot feeds per-stage gates with separate checkouts; judges listed order, failed/missing gate keyword feeds Dwight, passing gates precede integration. Conversation adds answer/report prompt override, bounded agent_message and run_reply before run_finished. #runAgent wires onLive to ephemeral writer, onUsage to durable per-call agent_usage and structured targetFile/command tool events; serial JSON retains legacy no-instanceId agent_finished and explicitly removes its ephemeral tail."
see_also: "src/core/live-activity.js; src/core/state.js; .enma/live-activity-contract.md; .enma/chat-view-contract.md"
hash: "span:4bbc45fde7898f34"
written: "2026-11-12"
commit: "9ec5519"
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

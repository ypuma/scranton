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
file: "src/core/orchestrator.js"
symbol: "Orchestrator"
ordinal: 0
kind: "how"
text: "run() snapshots the system prompts of the roles the run uses (once per run, hashed into run_started.prompts). It publishes an immutable plan and runs dependency-ready milestone pipelines through runDag with maxParallel.\n\nPer milestone:\n- Dwight works until TASK_COMPLETE. His worktree is then snapshotted.\n- Each gate stage of workflow.gates runs in order:\n  - Every gate gets its own checkout via createGateWorktree, all prepared BEFORE launch.\n  - Runners start together and are awaited together (Promise.allSettled). gate_result is emitted as each settles.\n  - The stage is judged in LISTED order, never finish order: the first error or BLOCKED pauses for a human; any fail keyword or missing keyword means one failed cycle and one combined bug report to Dwight; otherwise the next stage starts.\n- integrateToTarget runs only after the last stage passes.\n\nThe legacy [[\"angela\"]] path keeps the old event sequence and emits no gate_result. The optional threadContext (earlier runs of the chat) is added to Michael's planning input, delimited and capped."
evidence: "`const checkout = await this.worktrees.createGateWorktree({ agent, milestoneId: m.id });` inside `Promise.allSettled(roles.map(...))`, then `this.emit('gate_result', ...)`, then `integrateToTarget({ milestoneId: m.id })`."
hash: "span:6ae4f575d318315a"
quote: "quote:051c6fdaaa6fc49e"
written: "2026-11-09"
by: "core"
---

---
file: "src/core/pipeline-supervisor.js"
kind: "where"
text: "Node side of Pipeline chats: one engine process per run/resume/cancel/demo invocation (`python -m scranton_pipeline ...`, always --parent-guard), run storage under `<dataDir>/projects/<p>/chats/<c>/pipeline/{runs,requests}`, workspaces under SCRANTON_PIPELINE_WORKSPACE_ROOT (Windows default %LOCALAPPDATA%\\Scranton\\pipeline), model catalogue (api_key accounts on OpenAI-compatible endpoints go direct with the key only in SCRANTON_PIPELINE_KEY_<ROLE> env; every other pi model is configured as provider \"command\" through tools/pipeline-pi-complete.js), launchError persistence, artifact reads by name. Command resolution lives in pipeline-command.js (SCRANTON_PIPELINE_COMMAND -> bundled engine-runtime/python -> dev venv .scratch/pipeline/venv). Routes are mounted in src/server/registry-router.js; a chat's engine is fixed by `engine: \"pipeline\"` in chat.json and the legacy lease/recovery path is not used for these chats."
see_also: ".enma/pipeline-contract.md sections 6, 9, 14, 15; docs/PIPELINE.md; tests test/server/pipeline*.test.js with the fake engine tools/fake-pipeline.js"
hash: "shape:fc74c3f3aa73e7ec"
written: "2026-11-09"
by: "core"
---

---
file: "src/core/prompts.js"
symbol: "resolvePrompt"
ordinal: 0
kind: "how"
text: "System prompt resolution, highest first:\n1. A config-pinned agents.<id>.skill (skillSource 'config', not editable).\n2. A custom file <promptsDir>/<id>.md, saved by PUT /api/agents/:id/prompt. promptsDir is <dataDir>/prompts in registry mode, otherwise <hiveDir>/prompts.\n3. The built-in agents/<id>/SKILL.md.\n\nFrontmatter is stripped. missingKeywords is advisory only. Read errors become a ConfigError naming the role and path. The orchestrator snapshots prompts once per run; stagePrompt writes the snapshot to <hive>/<instance>/system.md, the file pi receives (mounted read-only in Docker). A PUT during a run therefore only affects the next run."
evidence: "`const source = pinned ? 'config' : fs.existsSync(custom) ? 'custom' : 'builtin';` and `config.promptsDir ?? path.join(config.hiveDir, 'prompts')`"
hash: "span:e400e0c53093215b"
quote: "quote:ecf99b889ffd0bbf"
written: "2026-11-09"
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

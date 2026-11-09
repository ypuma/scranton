# Custom Agents and Model Customization Contract (Core, 2026-11-09)

Authoritative specification for three parallel lanes (Backend, Web UI, Terminal Dashboard).
Extends `.enma/roles-contract.md`, `.enma/auth-contract.md`, and `docs/EVENTS.md`. Default workflow remains `[["angela"]]`.

## 1. Persistent Settings Store (`agents.json`) & Precedence
- **Location**: `<settingsDir>/agents.json`, where `settingsDir` is `config.dataDir ?? config.hiveDir` (parent of `prompts/`). Written atomically (`writeFileAtomicSync`). Never mounted or symlinked into Docker or worktrees.
- **JSON Schema** (`v: 1`):
  ```json
  {
    "v": 1,
    "agents": {
      "<id>": {
        "id": "string (/^[a-z][a-z0-9]{1,19}$/, custom only)",
        "name": "string (1..40 chars, custom only)",
        "title": "string (1..60 chars, custom only)",
        "passKeyword": "string (/^[A-Z][A-Z0-9_]{2,39}$/, custom only)",
        "failKeyword": "string (/^[A-Z][A-Z0-9_]{2,39}$/, custom only)",
        "tools": ["read"|"grep"|"find"|"ls"|"bash"],
        "instruction": "string (1..1000 chars; required for custom, optional override for built-in gates)",
        "model": { "provider": "string", "model": "string" } | null,
        "thinking": "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|null
      }
    }
  }
  ```
- **Precedence Hierarchy (highest first)**:
  1. Per-run request `models`: `POST /api/runs` `{ models: { [role]: { provider, model, thinking? } } }`
  2. Environment variables: `SCRANTON_<ID>_PROVIDER`, `SCRANTON_<ID>_MODEL`, `SCRANTON_<ID>_THINKING` (uppercase ID)
  3. Config file: `scranton.config.json` -> `agents.<id>.provider`, `model`, `thinking`
  4. Persistent settings: `<settingsDir>/agents.json` -> `agents.<id>.model`, `thinking`
  5. Pi host profile / CLI default (`null`). In Docker mode, missing explicit provider/model is refused (HTTP 400).
- **Pinning Rules**: If tier 2 (`env`) or 3 (`config`) sets model, thinking, or prompt (`skill`), the field reports `{ value, source: 'env'|'config', pinned: true }` and UI disables editing. Tier 4 yields `{ value, source: 'settings', pinned: false }`. Unset yields `{ value: null, source: 'none', pinned: false }`.

## 2. Custom Gate Agent Specifications & Validation
- **Scope**: Gate agents ONLY. Planner (`michael`) and Developer (`dwight`) are built-in and immutable. Max 12 custom agents.
- **Identifier (`id`)**: `/^[a-z][a-z0-9]{1,19}$/`, no hyphens.
  - Reserved IDs (refused with HTTP 400): `human`, `runs`, `sessions`, `prompts`, `isolation`, `control`, `events`, `state`, `plan`, `run`, `orchestrator`, `system`, `default`, `agents`, `models`, `auth`, `providers`, `hitl`, `chat`, `michael`, `dwight`, `oscar`, `hank`, `angela`.
- **Name & Title**: `name` 1..40 chars; `title` 1..60 chars. Control characters stripped.
- **Keywords**: `passKeyword` & `failKeyword` match `/^[A-Z][A-Z0-9_]{2,39}$/`. Distinct, neither equals `BLOCKED`, nor collides with built-in keywords (`PLAN_READY`, `TASK_COMPLETE`, `REVIEW_APPROVED`, `CHANGES_REQUESTED`, `SECURITY_PASSED`, `SECURITY_ISSUES`, `TEST_PASSED`, `TEST_FAILED`) or other custom agents. Defaults: `<ID>_PASSED` / `<ID>_FAILED`. All gates accept `BLOCKED`.
- **Tools**: Non-empty subset of `['read', 'grep', 'find', 'ls', 'bash']`. No `write` or `edit`. On win32 without bash, `bash` falls back to `powershell`.
- **Handoff Instruction**: 1..1000 chars. Controls how Dwight's work is evaluated.
- **System Prompt**: `<settingsDir>/prompts/<id>.md`. On creation, populated with starter prompt modelled on `agents/oscar/SKILL.md` (read-only constraints, exact pass/fail/blocked keywords, fail-closed Markdown report structure, keyword on own last line).
- **Deletion**: Removes definition from `agents.json` and deletes `<settingsDir>/prompts/<id>.md`. Deletion of built-ins is rejected (HTTP 400). In-flight runs continue safely using their start snapshot.

## 3. Editable Handoff Instructions & Messages
- Handoff body generator (`messages.js` `handoffBody`):
  - Built-in defaults: Oscar ("Review the changes for correctness..."), Hank ("Audit the changes for security vulnerabilities..."), Angela ("Verify every acceptance criterion independently..."). Angela default remains byte-identical.
  - Custom instruction from `agents.json` overrides built-in default for gates. Resetting (`PATCH` with `instruction: null`) restores default.
  - Non-Angela guidance: "How to see the changes" (shared vs worktree/docker) and "Changed files" (max 200 paths, <=300 chars, control chars stripped) sections apply to Oscar, Hank, and ALL custom gate agents.
- Combined bug report (`gateBugReport`): Lists each failing gate in stage listed order with `## <Name>'s <Title> report`. Dwight outbox destination remains `'dwight'`.

## 4. Engine Lifecycle & Additive Events
- **Run-Scoped Roles & Snapshots**:
  - Orchestrator loads and freezes custom definitions and prompts at run start. Mid-run edits to `agents.json` or prompt files do not affect active runs.
  - Active gate roles: `normalizeWorkflow(workflow, availableGateIds)` validates stages against built-in + registered custom gates. Unknown or duplicate gate IDs throw HTTP 400.
- **`run_started` Event Extensions**:
  - `roles`: `Array<{ id: string, name: string, title: string, kind: 'planner'|'developer'|'gate', builtin: boolean, keywords: string[], passKeyword?: string, failKeyword?: string, definitionHash: string }>` for all roles used in the run. `definitionHash` is SHA-256 of canonical definition JSON.
  - `prompts`: `{ [id: string]: { source: 'builtin'|'custom'|'config', sha256: string } }` includes custom agents.
- **State Additions (`state.json`)**:
  - `agents`: keys for all roles in `run_started.roles` (defaults to 5 built-ins when idle).
  - `roles`: array mirroring `run_started.roles` when a run is active.
- **Gate Evaluation**:
  - Evaluated in strict listed array order within each stage. `[BLOCKED]` or infra crash triggers HITL pause. Missing/fail keyword fails stage, increments `failedCycles`, and emits combined bug report. All pass -> advance stage.

## 5. Fake Pi Test Harness Extensions
- **Environment Injections**: Orchestrator sets `SCRANTON_AGENT=<id>`, `SCRANTON_ROLE_KIND=planner|developer|gate`, `SCRANTON_PASS_KEYWORD=<passKeyword>`, `SCRANTON_FAIL_KEYWORD=<failKeyword>`.
- **`tools/fake-pi.js`**: Recognizes any gate role.
  - `happy`: emits `[${passKeyword}]`.
  - `flaky`: cycle 1 of `m2` emits `[${failKeyword}]`; cycle >= 2 emits `[${passKeyword}]`.
  - `changes_once`: cycle 1 emits `[${failKeyword}]`; cycle >= 2 emits `[${passKeyword}]`.
  - `blocked`: emits `[BLOCKED]`.
  - `security_issues`: only `hank` emits `[SECURITY_ISSUES]`; every other gate (built-in or custom) emits its pass keyword.
- **`tools/fake-pi-rpc.js`**: Replaces `[TASK_COMPLETE]` with `[${passKeyword}]` for any gate role.

## 6. HTTP Control API & CLI
All endpoints enforce `X-Scranton-Client: 1`, loopback peer/Host, Origin validation, <=64 KiB JSON body, 404 without control.
- `GET /api/agents`: Returns `{ roles: [...], workflow: { default: [["oscar", "hank"], ["angela"]] } }`.
  Each role: `{ id, name, title, kind, builtin, gate: boolean, keywords, passKeyword?, failKeyword?, tools, instruction, defaultInstruction?, model: { value, source, pinned }, thinking: { value, source, pinned }, prompt: { source, text, editable, builtinText, missingKeywords } }`.
- `POST /api/agents`: Body `{ id, name, title, instruction, passKeyword?, failKeyword?, tools?, model?, thinking? }`. Writes `agents.json`, creates starter prompt `<promptsDir>/<id>.md`. Returns `201 { ok: true, agent }`.
- `PATCH /api/agents/:id`: Body `{ name?, title?, instruction?, passKeyword?, failKeyword?, tools?, model?, thinking? }`.
  - Built-in `michael`/`dwight`: accepts `model`, `thinking`.
  - Built-in `oscar`/`hank`/`angela`: accepts `model`, `thinking`, `instruction` (null resets).
  - Custom agents: accepts all fields.
  - Returns `200 { ok: true, agent }`; 400 on invalid value or immutable field; 404 if not found; 409 if field pinned by config/env.
- `DELETE /api/agents/:id`: Deletes custom agent definition and prompt. Returns `200 { ok: true }`; 400 if built-in; 404 if not found.
- `PUT /api/agents/:id/prompt`: Max 32 KiB, trimmed non-empty. Writes atomic `<promptsDir>/<id>.md`. Returns `200 { ok: true }`; 409 if pinned.
- `DELETE /api/agents/:id/prompt`: Deletes custom prompt file (resets to built-in for built-ins, or starter prompt for custom). Returns `200 { ok: true }`.
- `GET /api/control`: `defaults.models` contains model entries for all built-in and custom roles. `defaults.agents` lists all registered agent IDs.
- **CLI Commands**:
  - `scranton agents`: Renders terminal table (ID, Name, Title, Kind, Model, Model Source, Prompt Source).
  - `scranton agent set-model <id> --provider <p> --model <m> [--thinking <t>]`: Writes model/thinking to `agents.json`.
  - `scranton agent remove-model <id>`: Clears model/thinking in `agents.json`.
  - `scranton run --gates "<spec>"`: Accepts custom agent IDs in stage specs (e.g. `--gates "oscar+hank,seclint,angela"`).

## 7. UI Render Invariants
- **Web UI (`visualizer/public/js/`)**:
  - Agents Drawer (`agents.js`, `agents-panel.js`): Lists built-in and custom agents. "+ Add agent" modal. Per-agent card displays prompt editor, model and thinking pickers (disabled with badge if pinned), editable handoff instruction, and delete button for custom agents.
  - Stage Editor (`control.js`, `control-panel.js`): In New Run modal, lists every gate role (`oscar`, `hank`, `angela`, plus custom). Checkbox enables gate; numeric input assigns stage (1..N). Enabled gates grouped by stage into parallel arrays. Default: `[["oscar", "hank"], ["angela"]]`.
  - Model Pickers (`accounts.js`): Option list includes "Agent default (<provider>/<model>)" when set in `agents.json` or config, falling back to "pi default".
  - Pipeline (`pipeline.js`): Columns dynamically created for each stage in `run_started.execution.workflow.gates`. Role cards render dynamically from `run_started.roles`.
- **Terminal Dashboard (`src/dashboard/render.js`)**:
  - Renders active roles from `st.roles` (derived from `run_started.roles`).
  - Layout adaptivity: runs with <= 5 roles keep EXACTLY today's layouts (5 columns >= 120, 2-row grid 80-119, compact when short). Runs with more than 5 roles use `compactPanels` (1 row per role), keeping height bounds and `MIN_LOG_ROWS`.

## 8. File Ownership Matrix (Strict Single Ownership)
| Lane | Owned Files |
|---|---|
| **Backend** | `src/core/workflow.js`, `src/core/prompts.js`, `src/core/config.js`, `src/core/keywords.js`, `src/core/state.js`, `src/core/messages.js`, `src/core/orchestrator.js`, `src/core/sandbox.js`, `src/core/pi-command.js`, `src/core/cli.js`, `src/core/agents-config.js` (new)<br>`src/server/control.js`, `src/server/registry-router.js`, `src/server/visualizer-server.js`<br>`tools/fake-pi.js`, `tools/fake-pi-rpc.js`, `bin/scranton.js`, `docs/**`, `README.md`<br>`test/core/**`, `test/server/**` |
| **Web UI** | everything under `visualizer/public/**` (all `js/*.js`, `index.html`, `styles.css`, `demo/**`)<br>`test/visualizer/**` |
| **Terminal Dashboard** | everything under `src/dashboard/**`<br>`test/dashboard/**` |

Backend additionally owns every other file under `src/core/**`, `src/server/**`, `tools/**`, `agents/**`, `bin/**`, `docs/**`, `README.md` (German).

## 9. Security, Preservation & Risks
- **Security & Integrity**:
  - ID Path Safety: Strict `/^[a-z][a-z0-9]{1,19}$/` prevents traversal, Windows device names, and separator injection. Reserved words prevent collisions with hive directory layout.
  - Store Isolation: `<settingsDir>/agents.json` and prompt files are never mounted into containers or worktrees.
  - Tool Allowlist: Custom gates restricted to `['read', 'grep', 'find', 'ls', 'bash']`. Write/edit tools are forbidden.
  - Keyword Collision Guard: Pass and fail keywords cannot match `BLOCKED`, built-in keywords, or other registered roles.
- **Preserved Artifacts & Baselines**:
  - `visualizer/public/demo/sample-events.jsonl` remains unchanged.
  - Default workflow remains `[["angela"]]`; Angela's default handoff text remains byte-identical.
  - Existing tests in `test/core/*.test.js`, `test/server/*.test.js`, `test/dashboard/*.test.js`, and `test/visualizer/*.test.js` keep their behaviour. A lane may adjust an existing test ONLY where it asserts the exact role SET or the exact `/api/agents` role shape; never weaken a behavioural, ordering, safety or bounds assertion, and list every such edit.
- **Risks & Mitigations**:
  1. *Docker Model Absence*: Docker runs require explicit provider and model for all active roles. *Mitigation*: `validateDockerModels` runs against `activeRoles(config)` (including custom gates), throwing HTTP 400 before container spawn.
  2. *Worktree Concurrency*: Spawning multiple parallel custom gates could contend on git locks. *Mitigation*: `WorktreeManager` queues checkout creation sequentially before parallel execution.
  3. *UI Drawer Overflow*: Up to 17 roles (5 built-in + 12 custom) in drawer. *Mitigation*: Agents drawer list and stage editor use scrollable containers with sticky headers.

## 10. Pinned cross-lane details (lead, 2026-11-09; these override anything above that conflicts)
1. **State.** `run_started.roles` (and `run_started.prompts`) list ONLY the roles the run invokes, in run order: michael (unless noPlan), dwight, then the gates stage by stage in listed order. Unused built-ins are not in it. `state.json` `agents` holds the 5 built-ins in `AGENT_IDS` order, ALWAYS, followed by the custom roles of the current run in `run_started.roles` order. `state.roles` is a copy of the latest `run_started.roles` and is absent before any run. The web reducer must produce exactly the same `agents` keys and `roles`; `test/visualizer/real-run*.test.js` compares them with the real engine.
2. **Custom-agent prompts.**
   - `POST /api/agents` writes NO prompt file. A custom agent without `<promptsDir>/<id>.md` uses a starter prompt generated deterministically from its CURRENT definition (name, title, keywords, tools, instruction).
   - It is reported as `prompt.source: 'builtin'`, with `builtinText` = that starter and `editable: true`. UIs label it "Starter" whenever the role has `builtin: false`.
   - `DELETE /api/agents/:id/prompt` removes the file, which brings back the starter. `DELETE /api/agents/:id` removes the definition and the file.
   - `run_started.prompts[id].sha256` hashes the exact text the run used, starter or custom.
3. **Catalog order.** Built-ins come first in `AGENT_IDS` order, then custom agents in creation order. This order is used by `GET /api/agents` `roles`, by `GET /api/control` `defaults.agents` (`[{ id, name, title, kind, builtin, gate, passKeyword?, failKeyword? }]`) and by `scranton agents`.
4. **Defaults per role.** `GET /api/control` `defaults.models[id]` keeps its CURRENT entry shape. It is now resolved env > config > agents.json for every built-in and custom role. A role whose default resolves to a provider+model is not a Docker gap.
5. **Gate verdict wording.** UIs show a custom gate's pass keyword as "Passed", its fail keyword as "Failed" and `BLOCKED` as "Blocked". Built-ins keep their existing wording.
6. **Events.** `gate_result` keeps its shape. `agent` may be a custom id, and `instanceId` is `<id>-<milestoneId>`. Keyword extraction for a gate accepts ONLY that gate's own pass/fail keywords plus `BLOCKED`, so a custom gate printing `[TEST_PASSED]` can never pass.
7. **Thinking levels.** `thinking` values are exactly the existing `THINKING_LEVELS` constant in `src/core`, and the §1 list is illustrative. The backend reports the real list.
8. **Error codes.**
   - Invalid field → 400.
   - Unknown id → 404.
   - Duplicate id, more than 12 custom agents, or a config/env-pinned field → 409.
   - Built-in delete, or changing an immutable built-in field → 400.
   - Error bodies keep the existing control-route error shape.
9. **Settings file.** `agents.json` is re-validated on EVERY load. An invalid entry (bad id, a forbidden tool such as `write`, keyword collisions) is skipped with a clear warning in `doctor` and `GET /api/agents` (`warnings: string[]`). It is never executed. A run whose workflow names a skipped or unknown gate is refused before any agent starts, with a message naming the id.
10. **CLI.** `scranton agent set-model|remove-model` cannot collide with the existing `scranton agent <role> "<task>"`, because agent ids cannot contain `-`.
11. **Workflow editor.** The web UI drops deleted or unknown gate ids from a stored workflow choice, and still requires at least one gate.

## 11. Review round 1 pins (lead, 2026-11-09)
1. **`run_started.roles` is always present.** Every `run_started` carries `roles`, including on the startup-failure path; use `[]` when the roles are not known yet. Both reducers (engine `state.js` and web `state.js`) REPLACE `roles` on every `run_started`, treating a missing list as `[]`, then rebuild `agents` from the 5 built-ins plus the custom roles in that list.
2. **Line breaks.** `instruction` keeps line breaks: `\r\n` is normalized to `\n`, and every other control character is stripped. `name` and `title` stay single-line, with all control characters stripped.
3. **Configured workflows.** A server-configured workflow (from the config file or `--gates`) that names a missing or invalid gate must never break the agents API or `/api/control`. It shows up as a `warnings` entry in `GET /api/agents` and in `doctor`, and a run that would use it is refused at start with HTTP 400 naming the id. `DELETE /api/agents/:id` returns 409 while the server's configured workflow names that gate.
4. **Gate tools are read-only at launch.** In every gate's pi argv, Scranton's own `--tools <allowlist>` is the LAST tool-setting flag. It comes after all `extraArgs` and before the positional inbox/prompt arguments, which keep their current positions. Tool-changing flags in `extraArgs` are refused for gate roles with a clear ConfigError.
5. **`definitionHash`** hashes the EFFECTIVE definition for every role, built-ins included: id, name, title, kind, keywords, effective tools after config overrides and the Windows fallback, and the instruction.
6. **Terminal dashboard.** It uses `run_started.roles` only for the name and title of CUSTOM roles (`builtin: false`). Which roles are shown, their order and the layout come from the workflow, exactly as before. A run without custom roles therefore renders byte-identically with or without `roles`.
7. **Windows tool fallback.** The web settings form shows a `powershell` tool as the `bash` checkbox and never sends `powershell`.

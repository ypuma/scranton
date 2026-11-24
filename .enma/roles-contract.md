# Roles and Multi-Stage Gate Contract (Core, 2026-11-09)

> Since 2026-11-24 the agents are shown under the names in `.enma/agent-names-contract.md`; the first names below (Michael, Dwight, Oscar, Hank, Angela) are the earlier display names, and the ids are unchanged.

Authoritative integration specification for the three parallel implementation lanes: Backend, Web UI, and Terminal Dashboard.
Deliverable path: `.enma/roles-contract.md`. Engine default workflow is legacy `[["angela"]]` so existing tests, runs, and recordings remain 100% green.

## 1. Roles, Identifiers and Keywords
- `AGENT_IDS = ['michael', 'dwight', 'oscar', 'hank', 'angela']` (canonical order: Planner -> Dev -> Reviewer -> Security -> QA).
- `GATE_ROLES = ['oscar', 'hank', 'angela']`. Non-gate roles: `michael`, `dwight`. Participants: `[...AGENT_IDS, 'human']`.
- Role definitions:
  - `oscar`: Code Reviewer. Tools: `read`, `grep`, `find`, `ls`, `bash` (win32: `powershell` fallback). Prompt: `agents/oscar/SKILL.md`.
    Keywords: `['REVIEW_APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']` (pass: `REVIEW_APPROVED`, fail: `CHANGES_REQUESTED`).
  - `hank`: Security Auditor. Tools: same as Oscar/Angela. Prompt: `agents/hank/SKILL.md`.
    Keywords: `['SECURITY_PASSED', 'SECURITY_ISSUES', 'BLOCKED']` (pass: `SECURITY_PASSED`, fail: `SECURITY_ISSUES`).
  - `michael`: `['PLAN_READY']`. `dwight`: `['TASK_COMPLETE', 'BLOCKED']`. `angela`: `['TEST_PASSED', 'TEST_FAILED', 'BLOCKED']`.
- Outbox message destination for all gate roles (`oscar`, `hank`, `angela`) is `'dwight'`.

## 2. Gate Workflow & Isolation
- **Configuration**: `workflow: { gates: [["oscar", "hank"], ["angela"]] }` in `scranton.config.json`.
  - Normalized structure: `Array<Array<GateRole>>`. Each role in `GATE_ROLES` appears at most once across all stages. >=1 stage required.
  - CLI flag: `--gates "oscar+hank,angela"` (comma separates stages; plus joins parallel gate roles).
  - **Defaults**: Engine default is `[["angela"]]` (legacy preservation). Web UI new run modal defaults to `[["oscar", "hank"], ["angela"]]`.
- **Worktree Isolation**:
  - Generalize `createQaWorktree({ milestoneId })` to `createGateWorktree({ agent, milestoneId })` in `src/core/worktree.js`.
  - Base ref is always the immutable developer snapshot (`snapshotWorktree({ agent: 'dwight', milestoneId })`).
  - Keep `createQaWorktree` as a backwards-compatible delegate calling `createGateWorktree({ agent: 'angela', milestoneId })`.
  - `WorktreeManager` serializes git operations internally so parallel worktree creation never collides on git locks.
- **Stage Execution Algorithm**:
  - After Dwight's `[TASK_COMPLETE]`, snapshot developer worktree. Stages execute in configured index order (0, 1, ...).
  - For stage `s`: create private checkouts for all stage gate roles; start pi processes concurrently via `Promise.all`.
  - Await all runners in the stage, then evaluate results strictly in **LISTED array order** (never finish order):
    1. Infra failure (exit != 0, crash, timeout) or `[BLOCKED]`: trigger HITL pause for first failing agent. Retrying re-runs only this stage.
    2. Fail keyword or missing keyword: stage FAILS. Increments milestone `failedCycles` by 1. Remaining stages are SKIPPED.
       Dwight receives ONE combined bug report. Phase resets to `dwight`.
    3. All pass: stage PASSES. Proceed to stage `s + 1`.
  - Integration: `integrateToTarget({ milestoneId })` runs ONLY after the final stage passes. Gate edits are never integrated.
- **Gate handoffs**: Oscar reviews changes for correctness, edge cases, error handling, regressions, maintainability and test coverage; Hank audits the changes for security vulnerabilities. Acceptance criteria are context only for these gates, not their verdict basis. Angela independently verifies acceptance criteria and retains the byte-identical legacy handoff. All gates are instructed not to create or modify project files. Oscar/Hank receive a paths-only changed-files section when an immutable developer snapshot is available: relative to the milestone base, control characters removed, at most 200 entries plus `and N more`. Shared trusted-host mode has no snapshot and omits this section.
- **Bug Report & Cycle Reason**:
  - Combined bug report body for Dwight (`src/core/messages.js`):
    `# Bug report: milestone <m.id> - <m.title>` followed by intro: `Gate verification failed for your previous work. Fix the reported failures first, then make sure every acceptance criterion holds.`
    This neutral intro is retained on breaker/human retries; human feedback retains role-labeled reports with the human-feedback intro. Only the legacy Angela-only workflow uses `Angela's QA failed your previous work...`.
    For each failing gate in listed order: `## <Name>'s <Role> report\n\n<report text>` (e.g. `## Oscar's Review report`, `## Hank's Security report`).
  - `cycle_result.reason`:
    - Single failure: `<Name> reported [<KEYWORD>]: <summaryLine>` (e.g. `Oscar reported [CHANGES_REQUESTED]: Unhandled promise rejection`).
    - Multiple stage failures: `Stage <index+1> failed: <Name1> [<KW1>], <Name2> [<KW2>]`.
    - Pass: All stages pass -> `All gates passed: <Name1> [<KW1>], ...` (engine legacy default: `Angela reported [TEST_PASSED]`).

## 3. Events & State Additions (Additive v1)
- New event `gate_result`:
  `{ v: 1, seq: <int>, ts: "<ISO>", runId: "<id>", type: "gate_result", milestoneId: string, cycle: number, stage: number, agent: "oscar"|"hank"|"angela", instanceId: string, result: "passed"|"failed"|"blocked"|"error", keyword: string|null }`
  Emitted immediately when each gate runner settles.
- `run_started` extensions:
  - `execution.workflow`: `{ gates: Array<Array<string>> }`
  - `prompts`: `{ [role: string]: { source: "builtin"|"custom"|"config", sha256: "<64-hex>" } }` (audit hashes, never text). Only roles used by the run are resolved, staged and hashed: Michael unless `noPlan`, Dwight, and every configured gate; standalone agent commands include only that role.
- `state.json`:
  - `agents`: keys for all 5 roles (`michael`, `dwight`, `oscar`, `hank`, `angela`) always present in `emptyAgents()`.
  - Older runs without `execution.workflow` default to active gates `[["angela"]]`. UIs determine active roles from `run_started.execution.workflow.gates` + `michael` + `dwight`. Inactive roles for a run remain idle / omitted in pipeline view.

## 4. Customizable System Prompts & Control API
- **Resolution Order (highest first)**:
  1. Config override: `agents.<id>.skill` in `scranton.config.json` -> `source: 'config'`, `editable: false`.
  2. Custom prompt: `<promptsDir>/<id>.md` -> `source: 'custom'`, `editable: true`.
  3. Built-in: `agents/<id>/SKILL.md` -> `source: 'builtin'`, `editable: true`.
- **Prompts Directory Location**:
  - Global across projects/chats: role personas are harness-level configuration matching global Accounts and Providers.
  - CLI single mode & `visualize --control` single mode: `<hiveDir>/prompts/<id>.md`.
  - Registry / desktop mode (`--data <dataDir>`): `<dataDir>/prompts/<id>.md` (outside workspace and all project hives).
  - Agents cannot modify prompt files (promptsDir is never mounted or linked into Docker or worktrees).
- **Runtime Delivery**:
  - `writeSystemPrompt` writes resolved prompt (frontmatter stripped) to `<hive>/<agent>/system.md`.
  - Host mode: `--append-system-prompt <file>`. Docker mode: bind-mounted read-only at `/scranton/prompt.md`.
- **Control HTTP Endpoints** (`X-Scranton-Client: 1`, loopback peer/Host, Origin check, 404 without control):
  - `GET /api/agents`: returns `{ roles: [...], workflow: { default: [["oscar", "hank"], ["angela"]] } }`.
    Role item: `{ id, name, title, keywords, tools, gate: boolean, prompt: { source, text, editable, builtinText, missingKeywords: string[] } }`.
    `missingKeywords` lists expected bracketed keywords absent from `text` (advisory warning only).
  - `PUT /api/agents/:id/prompt`: body `{ text: string }`. Max 32 KiB (32768 bytes), trimmed non-empty. Writes atomic `<promptsDir>/<id>.md`. Returns `200 { ok: true }`. Returns 409 if `editable: false`.
  - `DELETE /api/agents/:id/prompt`: deletes `<promptsDir>/<id>.md`. Returns `200 { ok: true }`. Returns 409 if `editable: false`.

## 5. Runs, Models & Docker Validation
- `POST /api/runs`: accepts optional `workflow: { gates: [...] }` and `models: { [role]: { provider, model, thinking? } }` for any role in `AGENT_IDS`.
- `validateDockerModels(config, roles)`:
  - Dynamically resolves active roles for the run: `noPlan ? ['dwight', ...gates.flat()] : ['michael', 'dwight', ...gates.flat()]`. (Standalone agent validates `[agentId]`).
  - Throws HTTP 400 if any active role lacks explicit provider or model. Inactive roles are never required.
- `GET /api/control`:
  - `defaults.workflow`: effective `{ gates }` from config/flags.
  - `defaults.models`: entries for all 5 roles (`michael`, `dwight`, `oscar`, `hank`, `angela`), value `{ provider, model } | null`.

## 6. UI Render Invariants
- **Web UI Pipeline (`visualizer/public/js/pipeline.js`, `styles.css`)**:
  - Horizontal stage flow: `Human -> Michael -> Dwight -> Stage 1 -> Stage 2 -> ...`
  - Single-agent stage: standard agent card.
  - Parallel-agent stage: stacked column (`.stage-column`) of standard-width cards (`.agent-stack`) with equal width, preserving horizontal connector alignment.
  - Message animation: `pathBetween` uses dynamic `getBoundingClientRect` anchors, supporting stacked cards cleanly.
  - Only roles active in `run_started.execution.workflow` are displayed in the run pipeline.
- **Terminal Dashboard (`src/dashboard/render.js`)**:
  - Width >= 120: 5-column panel layout.
  - Width 80-119: 2-row panel layout (Row 1: Michael, Dwight; Row 2: active gates) or compact panels if height < 24.
  - Short terminal (< 24 rows): compact 1-row-per-role view (`compactPanels`).
  - `Lanes`: concurrent parallel instances (e.g. `oscar-m1` and `hank-m1`) appear as concurrent live rows.
  - Event log: renders `gate_result` events (`who(agent) + ' gate ' + result + ' ' + (keyword || '-')`).

## 7. Fake Pi Test Harness Extensions
- `tools/fake-pi.js`:
  - Recognizes `SCRANTON_AGENT=oscar` and `SCRANTON_AGENT=hank`.
  - Scenario hooks (`FAKE_PI_SCENARIO`):
    - `happy`: Oscar outputs `[REVIEW_APPROVED]`; Hank outputs `[SECURITY_PASSED]`.
    - `changes_once`: Oscar outputs `[CHANGES_REQUESTED]` on cycle 1, `[REVIEW_APPROVED]` on cycle >= 2.
    - `flaky`: Milestone `m2` cycle 1 fails (Oscar: `[CHANGES_REQUESTED]`, Hank: `[SECURITY_ISSUES]`, Angela: `[TEST_FAILED]`).
    - `security_issues`: Hank outputs `[SECURITY_ISSUES]` with vulnerability details.
    - `blocked`: Gate agent outputs `[BLOCKED]`.
- `tools/fake-pi-rpc.js`:
  - Settle responses accept all new pass/fail keywords in addition to `TASK_COMPLETE`.

## 8. File Ownership Matrix (Strict Single Ownership)
Each file is owned by exactly ONE lane. No cross-lane edits.

| Lane | Owned Files |
|---|---|
| **Backend** | `agents/oscar/SKILL.md`, `agents/hank/SKILL.md`<br>`src/core/state.js`, `src/core/keywords.js`, `src/core/config.js`, `src/core/orchestrator.js`, `src/core/worktree.js`, `src/core/messages.js`, `src/core/sandbox.js`, `src/core/cli.js`, `src/core/doctor.js`, `src/core/hive.js`, `src/core/log.js`<br>`src/server/control.js`, `src/server/visualizer-server.js`, `src/server/registry-router.js`<br>`tools/fake-pi.js`, `tools/fake-pi-rpc.js`, `bin/scranton.js`<br>`docs/EVENTS.md`, `docs/CONTROL.md`<br>`test/core/**`, `test/server/**` |
| **Web UI** | everything under `visualizer/public/**` (incl. `styles.css`, `index.html`, every `js/*.js`, `demo/sample-events.jsonl`)<br>`test/visualizer/**` |
| **Terminal Dashboard** | everything under `src/dashboard/**`<br>`test/dashboard/**` |

Backend additionally owns every other file under `src/core/**`, `src/server/**`, `tools/**`, `agents/**`, `docs/**` and `README.md` (German).

## 9. Preservation & Risk Management
- **Preserved Artifacts**:
  - `visualizer/public/demo/sample-events.jsonl` remains an authentic 3-agent recording.
  - Existing tests in `test/core/*.test.js`, `test/server/*.test.js`, `test/dashboard/*.test.js`, and `test/visualizer/*.test.js` keep their behaviour because engine default gates are `[["angela"]]`. A lane may adjust an existing test ONLY where it asserts the exact role SET (e.g. a deep-equal of a 3-key `agents` map); it must never weaken a behavioural, ordering, safety or bounds assertion, and must list every such edit in its report.
- **Identified Risks & Mitigations**:
  1. *Git Index Lock during Parallel Worktree Creation*: Running `git worktree add` concurrently fails if `.git/index.lock` is held. *Mitigation*: `WorktreeManager` queues worktree creation sequentially before launching gate processes in parallel.
  2. *Docker Missing Models on Custom Workflow*: Launching Docker with Oscar/Hank active requires credentials for both. *Mitigation*: `validateDockerModels` runs against `workflow.gates.flat()`, returning clean HTTP 400 before spawn if any active gate role lacks a model.
  3. *Chat RPC Addressing*: Parallel gates run simultaneously on the same milestone. Agents must address exact instance IDs (e.g. `oscar-m1`, `hank-m1`), never plain role names.
  4. *Circuit Breaker Flapping*: If multiple parallel gates fail in stage `s`, breaker `failedCycles` increments by 1 (per cycle, not per failing agent), ensuring the 3-cycle threshold behaves consistently.

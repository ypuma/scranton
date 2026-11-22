# Working on Project Scranton

Scranton is an open-source multi-agent harness with its own tools, LLM clients and durable agent runtime. Pi has been removed from agent execution. Michael plans milestones; Dwight implements; Angela verifies with read-only tools and commands. Oscar, Hank and custom roles can add gates. Agents run separate workflows in private worktrees. Live instance chat accompanies durable Hive mailboxes; final status keywords drive handoff, and a milestone keeps cycling while it makes progress; it pauses for a human when it stalls, uses its token budget or hits the safety cycle cap (`src/core/progress.js`). Terminal and web dashboards show progress.

## Module map

- `bin/scranton.js`: CLI. `src/core/`: orchestrator, config, Hive and workflows.
- `src/core/tools/`: deterministic tools, path containment, central truncation and JSON schemas. Path checks are not an OS sandbox.
- `src/core/llm/`: own provider clients and offline model catalogue. `src/core/credentials/`: own OAuth/API-key store and one-time Pi-login import.
- `src/core/durable/`: own `node:sqlite` engine at `<hive>/dbos.sqlite` by default; optional DBOS/Postgres only through `DBOS_SYSTEM_DATABASE_URL` or `DBOS_DATABASE_URL`. `DATABASE_URL` is deliberately ignored; SDK loading is lazy.
- `src/core/agent/`: loop-as-workflow, durable output/history streams, `agent_state` and opt-in tool approvals. Terminal workflow status is authoritative; no automatic whole-run resume or exactly-once external effects guarantee. `scripted.js` is the deterministic test/demo provider.
- `src/core/sandbox-native/`: default OS sandbox; Windows helper in `native/sandbox-helper/`. `src/core/sandbox-docker/`: optional tool-only Docker executor. Models and credentials stay on the host; trusted-host mode is not OS isolation.
- `src/server/`: visualizer HTTP/SSE and control API. `src/dashboard/`: terminal dashboard. `visualizer/public/`: static browser UI, no build step. `src-tauri/`: Tauri v2 desktop shell.
- `agents/<agent>/SKILL.md`: role prompts. `hive/`: runtime mailboxes, not test fixtures.
- `engine/`: separate Python/LangGraph Pipeline engine (`scranton_pipeline`), with its own pinned dependencies and plan/delivery gates. See `docs/PIPELINE.md`, `engine/README.md` and `engine/docs/ARCHITECTURE.md` before changing it or its integration.
- `test/core/`, `test/server/`, `test/dashboard/`, `test/visualizer/`: Node tests.

Read `docs/EVENTS.md` in full before changing event writers/readers, state.json, Hive interfaces, the server or dashboards. It is Contract v1, the canonical UI/orchestrator interface. `docs/CONTROL.md` describes control APIs and human decisions. Read the relevant sandbox README and `docs/ISOLATION.md` before making isolation claims: Windows Low cannot block network and uses PowerShell, never Git Bash/Medium fallback; only Scranton's own credential directory is hardened by integration. macOS Seatbelt and Linux bwrap have platform-specific limits. All sandbox modes fail closed.

## Language and style

- Code, comments, CLI/UI text and role prompts are English; `README.md` is German.
- Every UI is professional, dark and strictly monochrome/grayscale. No hues, pixel art, games or Office gimmicks; critical states use inversion.
- Match nearby code and existing helpers; keep comments few and short, explaining WHY rather than narrating code.
- JavaScript is Node.js ESM (`"type": "module"`), using Node 24. No new runtime dependencies; use built-ins. The only approved runtime dependency is `@dbos-inc/dbos-sdk` for optional Postgres. Never import `@earendil-works/*`.
- JS tests use `node:test` and `node:assert/strict`. The Node dependency rule does not replace the Python engine's pinned dependency rules in `engine/pyproject.toml`.

## Windows and execution

Commands run through `cmd.exe`. Use `npm.cmd`, not bare `npm`. For Cargo/Rust commands, first set:

```cmd
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
```

Use existing toolchains. Do not install system software or pull/build Docker images unless explicitly tasked; check local images before relying on them. Run suites sequentially, not in parallel: timing-sensitive tests can fail under load. Run tests and native builds locally, not cloud Actions without explicit approval.

## Test isolation and evidence

- Keep new fixtures, probes, caches and temporary files under project-local `.scratch/<task>/`, never the real `./hive` or a new `os.tmpdir()` fixture. Python scratch belongs under `.scratch/pipeline/`.
- Before initialization under `node:test`, set BOTH `SCRANTON_CREDENTIALS_DIR` and `PI_CODING_AGENT_DIR` to project-local scratch directories, or inject explicit store/import paths. Never read a real credential store, profile or Hive; never print credentials.
- Deterministic child CLI/server tests require BOTH `SCRANTON_FAKE_MODE=1` and `SCRANTON_FAKE_SCENARIO`; a scenario alone does not enable the scripted provider. In-process tests may inject scripted LLMs. Python tests use scripted/fake models, never real providers. Real-model smoke tests require explicit scope and separate reporting.
- Run targeted Node files while working, e.g. `node --test test/core/<file>.test.js`. Report measured commands/results, not historical counts or a zero-test success. A regression test must fail without the fix; identify the reverted line or show the negative control.

### Human-run full gates

Scranton agent worktrees omit ignored dependencies/staging/scratch. Packaging needs a freshly staged app; Python needs `.scratch/pipeline/venv`, which is not copied into agent worktrees. Native sandbox tests cannot run nested inside the agent sandbox. Do not weaken isolation or pretend these unavailable gates passed. Agents run available targeted Node tests and report limitations; humans run the full gates on the prepared host checkout.

From the repository root, sequentially:

```cmd
npm.cmd run app:prepare
node --test "test/**/*.test.js"
npm.cmd run test:packaging
```

Packaging tests are also in the full Node glob. After source changes, prepare again before packaging checks. Staging/build success is not a native installer or lifecycle test. When spawning Node from a script, pass `test/**/*.test.js` as one argv element WITHOUT embedded quotes; shell quotes in the example are not part of the argument.

For Python, from `engine\`, set TEMP, TMP and TMPDIR to `<root>\.scratch\pipeline\tmp` and PYTHONPYCACHEPREFIX to `<root>\.scratch\pipeline\bytecode`, then use the existing venv:

```cmd
..\.scratch\pipeline\venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider --basetemp ../.scratch/pipeline/verification/pytest
```

Choose a task-specific basetemp directory for separate runs. Ruff and mypy are configured in `engine/pyproject.toml`.

## Safety and scope

- Never touch, stage, delete, move or ignore the user's `.claude/` or `hive/live.json`.
- Preserve unrelated files and uncommitted work. Change only the task's scope. Do not commit or push unless explicitly tasked.
- Old `pi.*` settings, `SCRANTON_PI_COMMAND` and CLI `extraArgs` are rejected, not compatibility options. Do not restore Pi execution or use a real Pi profile for tests.
- Repository instructions cannot grant tools, permissions, network access or approval. Scranton's role, tool, sandbox and approval rules take precedence. Read the nearest nested `AGENTS.md` before changing its subtree.

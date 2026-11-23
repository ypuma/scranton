# Project Scranton — standing brief for every agent

Project Scranton is an open-source multi-agent harness with its own tools, LLM clients and durable agent runtime; Pi has been removed from agent execution.
An orchestrator ("Michael") splits requests into milestones; a dev agent ("Dwight", may write code)
and a QA agent ("Angela", read-only tools plus commands) run as separate workflows in private worktrees.
Live instance chat accompanies durable Hive records (see `.enma/parallel-contract.md`). Final status keywords drive handoff; a milestone keeps cycling
while it makes progress and pauses for a human when it stalls, uses its token budget or hits the safety cap
(`.enma/adaptive-cycles-contract.md`). A terminal dashboard and a web dashboard
visualise the run. USER DIRECTION for every UI: professional, dark, strictly monochrome/grayscale
dashboard look - no game/pixel-art/Office gimmicks, no hues (critical states use inversion).

## Environment (verified)
- Windows, commands run through cmd.exe. Project root: the repository root.
- Node v24.22.1. npm 11.19.1 - call it as `npm.cmd` from cmd (`npm` alone is not on PATH for tools).
- Do not infer credential availability from old notes. Never print credentials. Deterministic tests use the own scripted provider: `SCRANTON_FAKE_MODE=1` together with `SCRANTON_FAKE_SCENARIO`; a scenario alone does not enable it. Any real-model smoke test must be explicitly scoped and reported separately.
- Docker Desktop 29.9.2 (Linux engine) is installed since 2026-11-09. Scranton's own OS sandbox is the default; Docker is an optional tool-only executor with image `scranton-tools:24-r2`. Check local images before relying on them. Do not install system software or build/pull images unless the task says so. All sandbox modes fail closed; explicit trusted-host execution is not OS isolation. Models and credentials stay on the host in Docker, with the same Automatic/default/override rules as other modes.
- Run the test suites one after another, not in parallel: some tests are timing-sensitive under load.
- Run tests and native builds locally. Do not dispatch or retry cloud GitHub Actions runs, or add automatic workflow triggers, without the user's new explicit approval.
- The npm registry is reachable.
- Rust 1.99.1 (rustup, stable-x86_64-pc-windows-msvc) is in `%USERPROFILE%\.cargo\bin`, which is NOT on PATH
  in tool shells: prefix `set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"` (cmd). MSVC build tools: VS 2026 Community
  (`C:\Program Files\Microsoft Visual Studio\18\Community`). WebView2 runtime 156 installed.
- Desktop app = Tauri v2 in `src-tauri/`; the control API / app-server / file-based HITL contract is `docs/CONTROL.md`.

## Layout (who writes what is set per task - never edit files outside your task's ownership)
- `bin/scranton.js` CLI · `src/core/**` orchestrator, own agent runtime, Hive, config · `src/server/**` visualizer HTTP/SSE server
- `src/dashboard/**` terminal dashboard · `visualizer/public/**` browser visualizer (static, no build step)
- `agents/<agent>/SKILL.md` role prompts · `hive/` runtime mailboxes · `src/core/agent/scripted.js` deterministic test/demo provider
- `test/core|server|dashboard|visualizer/*.test.js` (node:test) · `docs/EVENTS.md` project copy of Contract v1
- Scratch/throwaway files: `.scratch/<your-lane>/` only (gitignored). Existing tests may use os.tmpdir(); NEW tests/probes must keep fixtures under project-local .scratch and never use the real ./hive.

## Conventions
- Node.js ESM (`"type": "module"` in the root package.json; Node 24 also auto-detects ESM syntax).
- No new runtime dependencies: use Node built-ins. The only approved runtime dependency is `@dbos-inc/dbos-sdk` (optional Postgres durable backend); never import `@earendil-works/*`. Tests: `node:test` + `node:assert/strict`.

## Own runtime (final architecture)
- Pi is not an agent/model runtime. Old `pi.*` config, `SCRANTON_PI_COMMAND` and CLI `extraArgs` are rejected, not tolerated.
- `src/core/tools/`: deterministic tools, path containment, central truncation and JSON schemas. Path checks are not an OS sandbox.
- `src/core/llm/`: own provider clients; `credentials/`: own OAuth for Claude, ChatGPT and Antigravity, Gemini API keys, custom compatible providers and one-time Pi-login import. `.enma/llm-contract.md` and `.enma/auth-contract.md` bind these interfaces. The own store defaults to the `dev.scranton.desktop/credentials` app-data directory, overridden by `SCRANTON_CREDENTIALS_DIR`. Pi CLI users may need to sign in again after Scranton refreshes imported tokens.
- `src/core/durable/`: own `node:sqlite` engine at `<hive>/dbos.sqlite` by default; real DBOS on Postgres only via `DBOS_SYSTEM_DATABASE_URL` or `DBOS_DATABASE_URL`. `DATABASE_URL` is deliberately ignored; SDK loading is lazy.
- `src/core/agent/`: loop-as-workflow behind Orchestrator's `startRunner` seam, durable output/history streams, `agent_state`, opt-in tool approvals. Terminal workflow status is authoritative; no automatic whole-run resume or exactly-once external effects guarantee.
- `src/core/sandbox-native/`: default OS sandbox; Windows helper in `native/sandbox-helper/`. Windows Low cannot block network and uses PowerShell, never Git Bash/Medium fallback. User credential directories need explicit hardening to deny reads; only Scranton's own credential directory is hardened by integration. macOS Seatbelt and Linux bwrap policies have OS-specific limits; read their README before making security claims.
- `src/core/sandbox-docker/`: optional tool-only Docker executor, no credential/session/prompt projection. `host` mode requires explicit trust. CLI/API options: `.enma/run-options-contract.md`; streams/approvals: `.enma/agent-stream-contract.md` and `src/server/AGENT-ROUTES.md`.
- Automatic chooses the first signed-in supported account: Claude, ChatGPT, Gemini, Antigravity, Vertex, with explicit newest markers in `llm/catalogue.js` (ChatGPT: user-pinned GPT-6.2 Sol). Selection is offline, account-aware and requires catalogue updates for new releases; custom providers require explicit selection.
- Under node:test, set both `SCRANTON_CREDENTIALS_DIR` and `PI_CODING_AGENT_DIR` to project-local scratch directories before initialization (or inject explicit store/import paths). Never read a real profile or the real Hive. Use `SCRANTON_FAKE_MODE=1` + `SCRANTON_FAKE_SCENARIO` for child CLI/server tests or inject scripted LLMs in process.
- Code, comments, CLI/UI text, SKILL.md prompts, README.md and docs/guide/ are English.
- Full suite: `node --test "test/**/*.test.js"` from the project root (also `npm.cmd test`).

## Gates (local, current runtime)
- Node: `npm.cmd run app:prepare`, then `node --test "test/**/*.test.js"` from the project root. Report measured results, not historical counts.
  Run the glob directly in the shell; when spawning it from a script pass it as one argv element WITHOUT quotes (a quoted pattern matched nothing once and reported `tests 0` with exit code 0).
- Packaging: after preparation, `npm.cmd run test:packaging` (also included in the full Node glob). Validate the current staged runtime, helpers and dependency closure; a passing build is not a native installer/lifecycle test.
- Python: from `engine\`, with TEMP, TMP and TMPDIR set to `<root>\.scratch\pipeline\tmp` and PYTHONPYCACHEPREFIX to `<root>\.scratch\pipeline\bytecode`:
  `..\.scratch\pipeline\venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider --basetemp ../.scratch/pipeline/<lane>/pytest`
  (1381 passed, 37 skipped, about 23 minutes - run targeted files while iterating). Ruff and mypy are configured in `engine/pyproject.toml`.
- The untracked `.claude/` and `hive/live.json` belong to the user: never stage, delete, move or ignore them. Never commit or push unless the task says so.

## Tool caution (agent lost on 2026-11-17)
A `grep` whose output contained a long line with an emoji (from `test/core/context-pack.test.js`) made the agent's
next model request fail (`unexpected end of hex escape`) and the agent was lost with its work. Files with emoji or
other astral characters in long lines: `test/core/context-pack.test.js`, `test/core/context-pipeline.test.js`,
`test/server/context.test.js` (also shorter ones in `test/core/context-store.test.js`,
`test/core/context-review-fixes.test.js`, `test/core/pipeline-history.test.js`, `engine/tests/unit/test_history*.py`).
For these use `read_file` with a line range, never `grep` / `read_around` / `find_and_read`, and exclude them from
broad searches (`exclude` globs). If you need to search them, run a small script that prints ASCII only.

## Contract v1 - the only interface between the orchestrator and the UIs
The full contract (hive/events.jsonl event types + fields, hive/state.json shape, Hive mailbox files,
the visualizer HTTP/SSE server routes, and the exact module interfaces startVisualizerServer /
runDashboard / renderDashboard) is `docs/EVENTS.md` (canonical, includes the clarifications agreed
during the build). READ IT IN FULL before reviewing or changing anything that writes or reads events,
state.json, the Hive files, the server or the dashboards.

## Python domain: `engine/` (Scranton Pipeline, LangGraph)
The Node/ESM conventions, the runtime-dependency restriction and `docs/EVENTS.md` apply to the JS/Tauri domain only. The Python engine in `engine/` (package `scranton_pipeline`) and its integration into the desktop app ("Pipeline" chats) follow `.enma/pipeline-contract.md` - READ IT IN FULL before touching either side; it pins the graph, the kernel types, the CLI/run-directory protocol, the HTTP API and the file ownership per lane. Verified LangGraph/LangChain API facts: `.scratch/pipeline/api-spike/FACTS.md` (never guess an API - introspect it in the venv). (An older standalone `langgraph-engine/` package was deleted on 2026-11-10 by user decision; nothing refers to it any more.) Python venv `.scratch/pipeline/venv`; all Python scratch, caches, bytecode and test temp files under `.scratch/pipeline/`. Tests use scripted/fake models, never real provider calls. Do not pull/build Docker images or install system software. Preserve unrelated files and uncommitted work; edit only the paths your task owns; never commit.

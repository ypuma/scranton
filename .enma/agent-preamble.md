# Project Scranton — standing brief for every agent

Project Scranton is an open-source multi-agent harness around the **pi** coding-agent CLI
(npm `@earendil-works/pi-coding-agent`, v1.5.0, bin `dist/bundle/cli.js`, needs Node >= 22.19).
An orchestrator ("Michael") splits a request into milestones; a dev agent ("Dwight", may write code)
and a QA agent ("Angela", read-only + may run commands) are isolated pi processes. The parallel upgrade
adds live RPC agent chat alongside durable per-instance Hive records (see `.enma/parallel-contract.md`). Keywords in pi's final output drive the handoff; after
3 failed test cycles a circuit breaker pauses for a human. A terminal dashboard and a web dashboard
visualise the run. USER DIRECTION for every UI: professional, dark, strictly monochrome/grayscale
dashboard look - no game/pixel-art/Office gimmicks, no hues (critical states use inversion).

## Environment (verified)
- Windows, commands run through cmd.exe. Project root: `C:\Users\pumas\Documents\Project_Scranton`.
- Node v24.22.1. npm 11.19.1 - call it as `npm.cmd` from cmd (`npm` alone is not on PATH for tools).
- Pi is installed (project dependency; user confirms installation). Do not infer credential availability from old notes. Never print credentials. Use fake pi for deterministic tests; any real-model smoke test must be explicitly scoped and reported separately.
- Docker Desktop 29.9.2 (Linux engine) is installed since 2026-11-09, and the image `scranton-sandbox:1.5.0` is built locally. Do not install system software or build/pull other images unless the task says so. The Docker sandbox must fail closed; explicit trusted-host execution is not OS isolation. Docker mode needs an explicit provider+model for every role (pi default is refused).
- Run the test suites one after another, not in parallel: some tests are timing-sensitive under load.
- The npm registry is reachable.
- Rust 1.99.1 (rustup, stable-x86_64-pc-windows-msvc) is in `%USERPROFILE%\.cargo\bin`, which is NOT on PATH
  in tool shells: prefix `set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"` (cmd). MSVC build tools: VS 2026 Community
  (`C:\Program Files\Microsoft Visual Studio\18\Community`). WebView2 runtime 156 installed.
- Desktop app = Tauri v2 in `src-tauri/`; the control API / app-server / file-based HITL contract is `docs/CONTROL.md`.

## Layout (who writes what is set per task - never edit files outside your task's ownership)
- `bin/scranton.js` CLI · `src/core/**` orchestrator, pi runner, Hive, config · `src/server/**` visualizer HTTP/SSE server
- `src/dashboard/**` terminal dashboard · `visualizer/public/**` browser visualizer (static, no build step)
- `agents/<agent>/SKILL.md` role prompts · `hive/` runtime mailboxes · `tools/fake-pi.js` mock pi
- `test/core|server|dashboard|visualizer/*.test.js` (node:test) · `docs/EVENTS.md` project copy of Contract v1
- Scratch/throwaway files: `.scratch/<your-lane>/` only (gitignored). Existing tests may use os.tmpdir(); NEW tests/probes must keep fixtures under project-local .scratch and never use the real ./hive.

## Conventions
- Node.js ESM (`"type": "module"` in the root package.json; Node 24 also auto-detects ESM syntax).
- Zero runtime dependencies besides pi itself; use Node built-ins. Tests: `node:test` + `node:assert/strict`.
- Code, comments, CLI/UI text and SKILL.md prompts in English. README.md is German.
- Full suite: `node --test "test/**/*.test.js"` from the project root (also `npm.cmd test`).

## Contract v1 - the only interface between the orchestrator and the UIs
The full contract (hive/events.jsonl event types + fields, hive/state.json shape, Hive mailbox files,
the visualizer HTTP/SSE server routes, and the exact module interfaces startVisualizerServer /
runDashboard / renderDashboard) is `docs/EVENTS.md` (canonical, includes the clarifications agreed
during the build). READ IT IN FULL before reviewing or changing anything that writes or reads events,
state.json, the Hive files, the server or the dashboards.

## Python domain: `engine/` (Scranton Pipeline, LangGraph)
The Node/ESM conventions, the pi-only runtime-dependency restriction and `docs/EVENTS.md` apply to the JS/Tauri domain only. The Python engine in `engine/` (package `scranton_pipeline`) and its integration into the desktop app ("Pipeline" chats) follow `.enma/pipeline-contract.md` - READ IT IN FULL before touching either side; it pins the graph, the kernel types, the CLI/run-directory protocol, the HTTP API and the file ownership per lane. Verified LangGraph/LangChain API facts: `.scratch/pipeline/api-spike/FACTS.md` (never guess an API - introspect it in the venv). (An older standalone `langgraph-engine/` package was deleted on 2026-11-10 by user decision; nothing refers to it any more.) Python venv `.scratch/pipeline/venv`; all Python scratch, caches, bytecode and test temp files under `.scratch/pipeline/`. Tests use scripted/fake models, never real provider calls. Do not pull/build Docker images or install system software. Preserve unrelated files and uncommitted work; edit only the paths your task owns; never commit.

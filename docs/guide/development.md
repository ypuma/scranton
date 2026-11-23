# Development

Run local checks and verify what a release build actually proves.

[Back to the README](../../README.md)

## Local checks

From the repository root, run these sequentially on Windows:

```powershell
npm.cmd run app:prepare
npm.cmd test
npm.cmd run test:packaging
```

`npm.cmd test` runs `node --test "test/**/*.test.js"`. The packaging check requires freshly prepared resources: rerun `npm.cmd run app:prepare` before `npm.cmd run test:packaging` after relevant source changes. Verify packaging against the current source, not an earlier build. See [Desktop packaging and maintenance](../DESKTOP.md#paketierung-und-wartung).

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/core/` | Orchestration, tools, LLM clients, credentials, durability, sandbox adapters |
| `src/server/` | Control HTTP and SSE |
| `src/dashboard/` | Terminal dashboard |
| `visualizer/public/` | Web dashboard |
| `agents/` | Role prompts |
| `tools/` | Completion bridges |
| `sandbox/` | Optional Docker build recipe |
| `engine/` | Python/LangGraph Pipeline engine |
| `src-tauri/` | Tauri desktop shell |

Keep new test fixtures under `.scratch/`, never in the real Hive. Use isolated test credentials and a scripted provider for deterministic CLI/server tests; see the [repository contributor instructions](../../AGENTS.md#test-isolation-and-evidence).

## Release verification

Deterministic fake-provider and protocol tests do not establish real container isolation, model communication, or native desktop lifecycle behavior. The limited local Docker/model verification is documented in [Isolation](../ISOLATION.md); it does not replace a complete run or a native lifecycle test. Release an installer only on the strength of its own build and separate installation/lifecycle checks, not a previous package. A native build target is not evidence that the app runs on that OS.

# Pipeline native sandbox - contract

Binding for the engine, the Node runner, the supervisor/server, packaging, the UI and the docs. Set by Core on 2026-11-23.

The user asked, verbatim: "pipeline doesnt have native sandbox mose fix it" (mose = mode). Today the Pipeline engine only has `docker` and `host`. An omitted HTTP sandbox becomes host and is trusted automatically (`src/core/pipeline-supervisor.js` around `sandbox ?? { mode: 'host' }`).

The design and all evidence are in `.scratch/pipeline-native-sandbox/DESIGN.md`. Read §1-§5 there for every file:line this contract relies on. Where this contract and DESIGN.md differ, THIS contract wins. The deliberate differences are §2 and §9.

## 1. Mode
- New sandbox mode `scranton` (display name "Scranton sandbox"), next to `docker` and `host`. It reuses the Team runtime's native sandbox (`src/core/sandbox-native`, Windows helper `scranton-sandbox-helper`), so there is ONE policy implementation.
- `scranton` is the default for NEW runs: engine config, the CLI demo, HTTP and the UI.
- If it is unavailable, a run fails closed with an actionable reason. There is NO automatic fallback to Docker, host, or another Windows mode.
- Host is never chosen implicitly any more. It always needs an explicit `trustHost:true`. Demo runs are the only exemption (see §6).
- This release enables it on Windows only. On macOS and Linux it reports unavailable, with reason `Scranton sandbox for Pipeline is available on Windows only in this version`. Do not wire seatbelt or bwrap launching for Pipeline yet.

## 2. Windows sub-modes (same names and defaults as Team)
- `windows_mode` / `windowsMode` is `low` (the default, like Team's `createSandbox` default) or `strict`.
- **`low`:** restricted token at Low integrity.
  - Writes are limited to the owned workspace and the private temp.
  - The network is NOT blocked, and Medium files stay readable.
  - Report this honestly: `backend:"low-integrity"`, `check_network:"allow"`.
  - Setup recipes with `network:true` are allowed.
- **`strict`:** AppContainer with zero capabilities.
  - No network for checks or setup, and reads are limited to what app containers can read.
  - `backend:"appcontainer"`, `check_network:"none"`.
  - A setup recipe with `network:true` is rejected BEFORE anything runs. The engine raises a config error naming `setup[i].network`; HTTP answers 400 with the same field name.
  - Do not grant broad ACLs on user or toolchain folders to make tools work.
- Never label or relabel anything except roots allocated through §4 `allocate`.

## 3. Runner binding
- The runner is a Node script, `tools/pipeline-sandbox.js` (new).
- The engine finds it ONLY through the env var `SCRANTON_PIPELINE_NATIVE_COMMAND`: a JSON array of absolute paths, `[nodeExe, scriptPath]`.
  - The supervisor sets it for every engine child: `[process.execPath, <package root>/tools/pipeline-sandbox.js]`. This is analogous to the completion binding in `src/core/pipeline-command.js`.
  - Missing, invalid, non-absolute or nonexistent → native unavailable, reason `runner_missing`.
- The runner finds the helper exactly like Team does: the same resolver and the same override env, with the packaged path set by `src-tauri/src/main.rs`.
- **Runner process env:** a small control allowlist only.
  - Included: OS basics (SystemRoot, windir, PATHEXT, system PATH, host TEMP/TMP, USERPROFILE, LOCALAPPDATA, APPDATA, HOME), the helper override, and the Scranton credential-store location used for hardening.
  - Excluded: `NODE_OPTIONS` and other `NODE_*`, model keys `SCRANTON_PIPELINE_KEY_*`, and prompts.
- **Payload env:** the engine's `scrubbed_env` result, passed inside the exec request (§4), never inherited. `NODE_ENV` is allowed with explicit passthrough; other `NODE_*`, `SCRANTON_*`, `PI_CODING_AGENT_DIR` and credential-looking names are refused case-insensitively at config validation and at the runner. The runner hands it to `sandbox.spawn`, which forces TEMP/TMP to the private temp.

## 4. Runner protocol v1 (internal; JSON; one verb per process)
Invocation: `argv = <binding> + [verb, ...flags]`. Every verb takes `--protocol 1`; any other version is an error.

| Verb | Flags | stdout (one JSON line) |
|---|---|---|
| `probe` | `--windows-mode low\|strict --scratch ABS_DIR` | `{"protocol":1,"available":bool,"backend":"low-integrity"\|"appcontainer"\|null,"windows_mode":"low"\|"strict","check_network":"allow"\|"none"\|null,"setup_network_allowed":bool,"reason":string\|null}` |
| `allocate` | `--path ABS` | `{"protocol":1,"path":ABS,"marker":".scranton-sandbox-owned"}` |
| `exec` | `--request ABS_FILE` | none from the runner; stdout/stderr are the TOOL's streams (see below) |
| `recover` | `--record ABS_FILE` | `{"protocol":1,"recovered":bool}` with optional `warning` as below |

- **`probe`:**
  - Runs a REAL canary in a fresh owned root under `--scratch` (a host-only dir the caller supplies): a write inside succeeds; an overwrite of a sibling file outside fails with its bytes unchanged.
  - For `strict` it also checks that a TCP connect to a runner-owned 127.0.0.1 listener fails. A positive host control proves the listener is reachable.
  - Cleans up afterwards. Exits 0 whether or not native is available. A nonzero exit or bad JSON means unavailable with a bounded reason.
- **`allocate`:** creates ABS EXCLUSIVELY (the parent must exist; ABS must not) as an owned root with the marker. This is the Team `createOwnedDirectory` behaviour.
- **The `exec` request file** is written by the engine in a host-only control dir under the run dir, and deleted afterwards:
  `{"protocol":1,"root":ABS,"temp_parent":ABS,"cwd":ABS,"argv":[ABS_EXE,...],"env":{...},"network":bool,"windows_mode":"low"|"strict","deadline_ms":N,"receipt":ABS_FILE,"record":ABS_FILE}`
  - `root` must be an owned root, and `cwd` must lie inside `root`. `argv[0]` is absolute and resolved by the engine on the host. Never resolve it from the workspace; `.cmd`/`.bat` shims use the existing `run_process` rules.
  - The runner creates a fresh owned private temp under `temp_parent` and removes it afterwards.
- **`exec` streams:** the tool's stdout and stderr are streamed straight through to the runner's stdout and stderr. The runner never writes its own text to them.
- **`exec` stopping:**
  - The runner's stdin is a CONTROL pipe from the engine. EOF or any byte means stop: kill the sandboxed tree and write state `stopped`.
  - `deadline_ms` is a backstop: on expiry, kill the tree and write state `timed_out`. The engine stays the timing authority and passes its remaining timeout plus a small margin.
- **`exec` receipt:** the terminal receipt is written atomically (temp + rename) to `receipt`:
  `{"protocol":1,"state":"exited"|"stopped"|"timed_out"|"error","code":int|null,"error":null|{"code":"policy"|"launch"|"protocol"|"ownership"|"cleanup"|"workspace_link","message":string}}`
  - The runner exits 0 when the receipt is written. It exits nonzero only if it could not write the receipt.
  - The tool's exit code lives ONLY in the receipt. Never parse tool output to classify a failure.
- **Strict profiles:** for `strict`, write the planned profile name to `record` BEFORE creating the profile, and delete `record` after a successful dispose.
  - `recover` removes ACEs where safe without following reparse points, then reaps the recorded profile even if ACE cleanup was incomplete. The record remains until reap succeeds. Successful reap with partial ACE cleanup sets the optional `warning:"ace_cleanup_incomplete"` on either receipt or recover reply; the engine logs a warning without changing the tool result.
  - The engine calls `recover` for leftover records of its run on start, resume and finish.
- **Windows credential hardening:** apply exactly Team's existing lifecycle for the Scranton credential store (`src/core/orchestrator.js`, around the native invocation; `index.js` harden/backup). Share that code; do not copy it. Team behaviour must not change. Pipeline retains recovery backups with original labels and discards successful snapshots of already-hardened labels; it never automatically unhardens the shared store.
- Processes on Windows: the engine's outer Job owns Node and the helper, and the helper's inner Job owns the tool. No breakaway anywhere. Python keeps `output_not_closed` semantics, including the bounded drain after a kill.

## 5. Engine (`engine/src/scranton_pipeline`)
- **Config:**
  - `SandboxConfig.mode: Literal["scranton","docker","host"] = "scranton"` and `windows_mode: Literal["low","strict"] = "low"`.
  - Persisted configs of EXISTING runs (host/docker) must keep their digest and resume unchanged. Do not always serialise the new field; prove it with old fixtures.
- **Runs:** new `NativeSandbox` in `tools/native_sandbox.py` behind the existing `Sandbox` interface (`run`, `describe`, `preflight`, `cleanup`), and `build_sandbox` selects it.
  - `preflight` runs `probe` for the configured windows mode. On failure the run fails as infrastructure: `sandbox_failed` with a reason.
  - Checks, setup, parallel lanes and integration, the grounding probe or counterfactual, and eval acceptance all go through it.
  - Host Git, the completion `command` provider and model HTTP stay on the host, unchanged.
- **Workspaces:** in scranton mode the main, lane, probe and eval trees are allocated via `allocate` under their usual parent.
  - `snapshot_source` and the copies accept a destination containing exactly the marker.
  - The marker is reserved: never part of the source, edits, index, Git, diffs, delivery or copies.
  - Docker's `/workspace/.pipeline` state mount is NOT emulated. Setup output stays in the workspace.
- **Result mapping:**

  | Receipt / situation | Result |
  |---|---|
  | `exited` | the code, as a normal result (124 and 125 are ordinary codes) |
  | `stopped` or `timed_out`, or the engine's own stop/deadline | the existing stop and timeout semantics |
  | `error`, a missing receipt without an engine stop, or a protocol violation | infrastructure `sandbox_failed`; the run fails even for optional checks; never tolerated as a baseline failure |
  | retained pipe | `output_not_closed`, as today |

- **Status:** `status.sandbox` for scranton is `{"mode":"scranton","image":null,"windows_mode":...,"backend":...,"isolated":true,"check_network":"allow"|"none","setup_network":bool}`.
  - Events (schema stays 1): `sandbox_ready {mode,backend,windows_mode,check_network}` once per execution-bearing invocation after the probe, and `sandbox_failed {mode,backend,code,message}`.
  - Never put env, paths of credentials or executables, profile ids, or raw output in events.
- **CLI:**
  - `demo --sandbox scranton|docker|host` defaults to `scranton`; `--windows-mode` applies to scranton only.
  - `sandbox check --mode scranton [--windows-mode low|strict]` prints `{"native":{"platform":...,"low":<probe>,"strict":<probe>}}`, probing both if `--windows-mode` is absent. Without `--mode` it behaves as today (Docker).
  - No unconditional Docker sweeps on scranton or host invocations.
- **Tests:** tests that mean host pass host plus trust explicitly.

## 6. Supervisor and HTTP (`src/core/pipeline-*.js`, `src/server/**`)
- **Body:** `sandbox: {mode:'scranton'|'docker'|'host', image?, trustHost?, windowsMode?}`. An omitted sandbox means `{mode:'scranton', windowsMode:'low'}`, never host.
- **Errors:**

  | Status | When |
  |---|---|
  | 400 | unknown mode or field; `image` without docker; `trustHost` without host; `windowsMode` without scranton; strict with a setup `network:true` (field `setup[i].network`) |
  | 409 | host without `trustHost:true`; scranton unavailable after a fresh probe for that windows mode (reason included, no fallback) |
  | 503 | unusable engine, as today |

- **Demo:** an omitted demo sandbox → scranton if a fresh probe of low says available, else host. Demo stays exempt from trust.
- **Probe:** `GET /api/pipeline` adds `sandbox.native: {platform, available, reason, modes: {low: {available, reason, backend, checkNetwork, setupNetworkAllowed}, strict: {...}}}`.
  - It comes from `sandbox check --mode scranton`, cached for 3 s and independent of the Docker probe; a Docker failure must not delay it.
  - `available` is true if any mode is available.
- **Trust:** only a real acknowledgement sends `--trust-host`. Existing runs resume and decide with their persisted mode and trust, unchanged; this release does not re-prompt them.
- **Binding:** the supervisor sets `SCRANTON_PIPELINE_NATIVE_COMMAND` for every engine child, as in §3.
- **Fake engine:** `tools/fake-pipeline.js` emulates the new probe output.

## 7. UI (`visualizer/**`)
- **Form:** the Pipeline form `name="pf-sandbox"` radios are "Scranton sandbox" (new, first, default), "Docker" and "Host".
  - With Scranton selected, show a checkbox "Block network (strict)", which maps to `windowsMode:'strict'`. Hint: "Checks and setup run without network; tools must be readable by Windows app containers." Low hint: "Writes stay in the run workspace; network is not blocked."
  - Show availability and the reason per mode. Block Start when the selected mode is unavailable, and never switch the radio silently.
  - Keep the Docker image/build controls for Docker and the host warning/trust for Host.
  - Strict plus a "needs network" setup shows a plain explanation, and saved setup choices are kept.
- **Run details** show the engine-reported `status.sandbox` (backend, network), not the radio.
- Monochrome, accessible, English UI text.

## 8. Packaging and docs
- Add `tools/pipeline-sandbox.js` to the explicit staged tools list in `scripts/prepare-desktop.mjs`. That list is a known trap: a new helper missing from it is silently absent from the app. The staged runtime smoke must at least load the runner and run `probe` offline.
- **Docs:** `.enma/pipeline-contract.md` (sandbox section), `docs/PIPELINE.md`, `docs/CONTROL.md`, `docs/ISOLATION.md`, `docs/DESKTOP.md`, `engine/README.md`, `engine/docs/ARCHITECTURE.md`, and root `README.md` (German, "Sandbox" for Pipeline). Each states the low/strict differences honestly (network, reads), Windows-only, no state mount, and that Docker is needed for network setup in strict.

## 9. Not in this release (follow-ups, named in the docs)
- macOS and Linux Pipeline native.
- An `internetClient`-style capability for strict setup.
- Re-acknowledging trust for old host runs.
- A typed helper exit channel instead of exit 125.
- Per-exec relabel cost on large trees.
- Native support for dependency trees with links or junctions. For now select Docker; native fails closed with typed `workspace_link` / `sandbox_failed`.

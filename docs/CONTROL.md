# Control API v1 - starting runs and answering the human from a UI

Extends Contract v1 (docs/EVENTS.md). Used by the web dashboard and the Tauri desktop app.
Die bisherigen unscoped Reads bleiben im Single-Modus erhalten; Registry-/Scoped-Routen und deren zusätzlicher GET-Zugriffsschutz sind in Abschnitt 8 beschrieben.

## 1. File-based human answers (the Hive stays the communication layer)

New `--on-breaker hive` policy for `scranton run` / `scranton demo` (any pause: breaker trip, [BLOCKED], agent infrastructure failure):
- The orchestrator emits `hitl_request` as today, atomically publishes `hive/human/request.json` as `{ "v":1, "runId":string, "requestSeq":number, "milestoneId":string|null, "title":string, "reason":string, "options":string[], "ts":"<ISO>" }`, then waits for `hive/human/response.json`, polling every 250 ms (no timeout). Copy `runId` and `requestSeq` from that file and choose a decision from `options`; the event journal is not needed to answer. The request is removed when waiting ends; successful orphan recovery removes a stale request left by a hard crash.
- Response file (written atomically: temp file + rename; anyone may write it - the server, a script, a human):
  `{ "v": 1, "runId": string, "requestSeq": number, "decision": "feedback" | "retry" | "skip" | "abort", "feedback"?: string, "ts": "<ISO>" }`
  `requestSeq` = the `seq` of the `hitl_request` being answered. `feedback` is required (non-empty, max 16000 chars) when decision is "feedback".
- The orchestrator accepts it only if runId and requestSeq match the open request and decision is one of that request's options; then it moves the file to `hive/human/archive/response-<runId>-<requestSeq>.json` and continues exactly as with a terminal answer (same events: `hitl_response`, resets, `hive_write(human->dwight, feedback)` ...). A non-matching or invalid file is moved to `hive/human/archive/rejected-<ts>.json` with a `log` warn.
- While waiting, transient EBUSY/EPERM/EACCES reads are retried rather than rejected; malformed JSON younger than 1 s is retried to allow an in-progress write to complete. Older malformed files are rejected.
- A stale response.json present when the request opens is rejected the same way (never auto-applied).
- `ask` with a TTY still prompts in the terminal; `hive` never prompts. Configuration: `onBreaker` / `SCRANTON_ON_BREAKER`, with flags > env > config > default `ask`.
- `ts` must be an ISO timestamp; `v` must be 1. Optional feedback must be a string of at most 16000 characters for every decision.

## 2. Stop request

`hive/control/stop.json` `{ "v": 1, "runId": string, "ts": "<ISO>" }`. While a run is active (including while an agent workflow runs and while waiting for a human) the orchestrator polls it every 250 ms; on a match it behaves like Ctrl+C (cancels active workflows and their tool process trees, `run_finished` aborted, exit 130) and deletes the file. Non-matching files are deleted with a `log` warn.

## 3. HTTP control routes (server)

Enabled only when the server is started with `control: { workspace, runner? }` (`startVisualizerServer({ ..., control: { workspace, runner } })`, CLI `scranton visualize --control` and `scranton app-server`). Ohne Steuerung sind Run-/HITL-/Chat-/Stop-POSTs im Single-Modus nicht verfügbar; `GET /api/control` liefert `{ "v": 1, "enabled": false }`. Die neuen Projekt-/Scoped-Reads stehen unabhängig davon bereit (Abschnitt 8). Registry-Betrieb per CLI aktiviert die Steuerung automatisch.

All control routes (including `GET /api/control`) require a loopback TCP peer (`req.socket.remoteAddress`: 127.0.0.0/8, ::1 or IPv4-mapped ::ffff:127.x.x.x) and a local Host header. A forged Host never authorizes a remote peer. The CLI refuses `visualize --control` with a non-loopback `--host` (exit 2); programmatic servers enforce peer checks even on wildcard binds. Request rules for every POST: the existing Host check; `Content-Type: application/json`; header `X-Scranton-Client: 1`; if an `Origin` header is present it must equal the server's own origin (`http://<allowed host>:<port>`); body <= 262144 bytes; otherwise 403/415/413. No CORS headers are ever sent. Control routes always require a local Host, even on a non-loopback programmatic bind. Origin compares against that allowed Host hostname and the actual listening port. Stop POSTs send `{}`.

- `GET /api/control` -> `{ "v": 1, "enabled": true, "workspace": string (default workspace, absolute), "scenarios": ["happy","flaky","breaker","blocked","changes_once","security_issues","question","progress"], "run": null | { "pid": number, "mode": "run" | "demo", "request": string, "workspace": string, "startedAt": "<ISO>", "runId": string | null, "exitCode": null }, "lastExit": null | { "mode", "request", "exitCode": number, "finishedAt": "<ISO>", "outputTail": string (last ~4 KB of the child's stdout+stderr, ANSI stripped) }, "pendingHuman": null | { "runId", "requestSeq", "milestoneId", "reason", "options": [] } }`
  (`pendingHuman` = the last `hitl_request` of the current run in events.jsonl with no later `hitl_response`, only while a child run is alive.)
- `POST /api/runs` `{ "request": string (1-32768 chars, required unless demo), "workspace"?: string (absolute; default = control workspace; created if missing), "demo"?: { "scenario": one of scenarios, "delayMs"?: 0-5000 }, "maxCycles"?: 1-50, "maxStalledCycles"?: 1-10, "milestoneTokenBudget"?: 0-20000000, "noPlan"?: boolean, "conversation"?: boolean, "permissions"?: "ask" | "auto" | "bypass" }` -> `202 { "ok": true, "pid" }`; `409 { "error" }` if a child run is alive; `400 { "error" }` on validation failure.
  Adaptive milestone cycles (additive v1): these three optional fields are integers. `maxCycles` is the failed-cycle safety cap (CLI `--max-cycles`, config `maxFailedCycles`, default 12), not a fixed three-try retry policy. `maxStalledCycles` is the consecutive stalled-cycle threshold (CLI `--max-stalled`, default 2). `milestoneTokenBudget` limits tokens from this milestone's invocations (CLI `--milestone-tokens`, default 500000; 0 disables the budget). Counts/token windows start over after human feedback or retry; a progress verdict resets the stall count. Invalid values return 400 before launch. While any milestone waits for a human, no new milestone starts; already running pipelines continue. See [EVENTS.md](EVENTS.md#adaptive-milestone-cycles-additive-v1) for progress verdicts and breaker causes.
  `permissions` selects Team access/tool approval policy (`ask` by default), independently of `sandbox`; invalid values return 400 before launch. It is forwarded as `--permissions` and recorded in `run_started.permissions`. CLI/config equivalents: `--permissions`, `SCRANTON_PERMISSIONS`, config `permissions` (flag > env > file > default). `ask` keeps configured tool approvals; `auto` grants them automatically; `bypass` skips them. Outside reads explicitly ordered by the human are automatically granted in `ask`; other reads require a click (`auto`/`bypass`: automatic). Outside writes require a click in `ask`/`auto`, and are automatic in `bypass`. Protected credentials always require a click and take precedence over the run's hive/Scranton data classification, which requires a click for reads and refuses writes. An ordinary parent folder can be granted without unlocking protected descendants. The home folder and filesystem/drive roots always require a click. Model-requested UNC or device paths are rejected before filesystem access; configured protected roots may be UNC. No mode overrides these exceptions or OS sandbox limits. On macOS/Linux, if the one bounded scan of a grant cannot finish, `request_access` reports that it is not added to the shell policy; file tools can still use it. Outside writes are not covered by undo. See [EVENTS.md](EVENTS.md#user-orders-and-path-access-additive-v1).
  The server spawns `process.execPath <repo>/bin/scranton.js run|demo ... --hive <hiveDir> --workspace <ws> --on-breaker hive` (argv array, never a shell; requests of at most 4000 chars as a single argv element after `--`; longer requests via `--request-file <hive>/control/request.json`), env inherited, cwd = repo root, stdout/stderr captured (tail kept for lastExit), windowsHide true.
- `POST /api/hitl` `{ "decision", "feedback"? }` -> writes hive/human/response.json for the current `pendingHuman` (fills runId/requestSeq itself) -> `202 { "ok": true }`; `409` if nothing is pending; `400` on validation failure.
- `POST /api/runs/stop` -> writes hive/control/stop.json for the alive run's runId -> `202`; if the child has not exited 15 s later the server kills its process tree (Windows `taskkill /pid <pid> /T /F`). Repeated stop requests preserve the first kill deadline; server close may shorten it to 5 s. Heartbeat/stop polling ends on child exit, and any leftover stop.json belonging to that runId is removed. `409` if no run is alive.
- On server `close()` an alive child run is stopped the same way (stop file, then kill after 5 s) before close resolves.

HTML responses use a strict same-origin Content-Security-Policy (no inline scripts/styles, no objects, base URLs or framing), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The UI uses external scripts/styles and CSSOM style properties.

`runner` has the Node `spawn(executable, argv, options)` interface and returns a ChildProcess-compatible object (pid, stdout/stderr streams, error/close events).

### Voice dictation API

All `/api/voice/*` routes require a loopback TCP peer, a local Host header and `X-Scranton-Client: 1`. If `Origin` is present, it must match the server's own origin. The transcription route is an exception to the JSON content type and body limit above: it takes raw WAV audio with the limit below.

- `GET /api/voice/status` → `{ available, reason?, engine: { installed, version }, models: [{ id, label, bytes, installed, download?: { received, total } }], model, language }`. `model` is the selected model ID. `language` is `auto`, `de` or `en`. `reason` is set when unavailable (e.g. `unsupported_platform`, `engine_missing`).
- `POST /api/voice/settings` with JSON `{ model?, language? }` → the same status object. Settings are persisted in `<data>/voice.json`.
- `POST /api/voice/models/:id/download` → `202`. Download progress is visible through the status route.
- `DELETE /api/voice/models/:id/download` → `204`. Cancels a download or removes the model.
- `POST /api/voice/transcribe?language=auto|de|en` takes an `audio/wav` body (16 kHz mono PCM16, at most 10 MB) and returns `{ text, language, durationMs, model }`.

Transcription errors:

| Status | Meaning |
|---|---|
| 409 `model_missing` | No model installed. |
| 413 | Body too large. |
| 415 | Not a 16 kHz mono PCM16 WAV. |
| 503 `engine_unavailable` | No engine for this platform or engine not usable. |
| 429 `busy` | Only one transcription at a time. |

## 4. App server (used by the Tauri shell)

`scranton app-server [--port N (default 0)] [--data DIR | --hive DIR --workspace DIR]` starts the server with control enabled on 127.0.0.1, then prints exactly one line to stdout: `{"ready":true,"url":"http://127.0.0.1:<port>","pid":<pid>,"hive":"<abs>","workspace":"<abs>"}`. Die Ready-Felder `hive` und `workspace` sind auch im Registry-Modus nur die CLI-Konfigurationswerte, keine Auswahl eines Threads; Projekte/Chats über `/api/projects` abfragen. It exits cleanly (closing the server, stopping active child runs) on SIGINT/SIGTERM, on stdin EOF (the parent died) and on a line `quit` on stdin.

## 5. Desktop app (Tauri v2, `src-tauri/`)

- Bundles node.exe (sidecar) + the app files + production dependencies and Scranton runtime modules. No Node install needed on the target machine.
- Beim Start: `node <resources>/bin/scranton.js app-server --data <appData> --legacy-workspace <documents>/Scranton/workspace`; die Hülle liest die Ready-Zeile und navigiert zur URL. Legacy-Hive-Import nur durch Referenz, siehe Abschnitt 8. Beim Beenden schreibt sie `quit` nach stdin und beendet nach 5 s nötigenfalls den Prozessbaum.
- Web UI detects the shell via `window.__TAURI__` and then uses native notifications (plugin-notification) for: human needed (`hitl_request`), run finished. In a plain browser it uses the Notification API if the user allowed it.
- Tray icon: Show / Hide, "Human needed" badge text in the tooltip, Quit.

### New project folder picker

In the desktop app, **New project → Browse...** uses the existing Tauri dialog plugin through `globalThis.__TAURI__.core.invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: 'Choose project folder' } })`; an optional `defaultPath` string may be included inside `options`. The result is one absolute path string or `null` on cancellation. Selection only fills the editable workspace field; cancellation leaves it unchanged. Creating the project still submits the existing `POST /api/projects`, whose workspace validation (§8) remains authoritative. Empty workspace retains the default-project-folder behavior.

A plain browser has no native picker: enter an absolute path manually. There is no HTTP endpoint for host dialogs or server filesystem browsing.

The separate `dashboard-folder-picker` capability grants only `dialog:allow-open`, only to window `main` on `http://127.0.0.1:*` and `http://localhost:*`, with local content disabled. No dialog default/save/message, filesystem or shell permissions are granted. In the installed dialog plugin 2.8.4, `allow-open` has no option-level scope: it can open file as well as directory dialogs; `directory:true` is a UI request, not an ACL restriction. The plugin updates its internal selected-path scopes, but this capability exposes no filesystem commands. The bridge and response shape are verified against the installed plugin's `src/commands.rs` (`OpenDialogOptions`, `OpenResponse`, `open`) and `permissions/autogenerated/commands/open.toml`.

## 6. Parallel execution, direct chat and durable ownership (additive)

The existing security checks and 262144-byte JSON body limit apply to these additions.

- `POST /api/runs` additionally accepts `maxParallel` (1–32), `sandbox` (`scranton` default, `docker`, `host`), `sandboxImage` (Docker), `sandboxNetwork` (`allow` default, `none`; `bridge` alias), `trustedHost`, and `approvals:{tools:string[],timeoutSeconds?:number}`. Explicit host requires trust; trust conflicts with another explicit sandbox. Forward to the matching CLI flags. Default: 3 pipelines, private worktrees, own OS sandbox, no tool approvals (timeout 600 seconds when enabled). Docker is tool-only, no automatic image pull/build or host fallback. Demo uses the scripted provider and simulated host execution.
- `GET /api/control` adds `defaults.execution`, `instances` (current matching run's state instances, otherwise `{}`), `recoveryRequired` and `orphan: null | {runId,startedAt,owner,heartbeatAt,stopRequestedAt,recoveryError}`. `lastExit` includes `runId` and `startedAt` for explicit correlation, not timestamp guessing. No automatic orphan resumption is promised.
- `POST /api/chat` body `{ "runId": string, "to": string, "text": string }` requires the active matching run and a known nonterminal exact instance ID. Human text must be nonblank and at most 16000 characters; recipient syntax is a lowercase letter followed by up to 63 lowercase letters/digits/hyphens. Unknown/terminal recipients and inactive/mismatched runs return 409; invalid inputs return 400; a queue of 1000 command files returns 429.
- Accepted chat returns `202 { "ok": true, "id": "<uuid>", "delivery": "queued" }`. It atomically writes `hive/control/chat/<id>.json` with `{v:1,id,runId,from:"human",to,text,ts}`. The orchestrator consumes this command and publishes `chat_message`/`chat_delivery`; HTTP acceptance must never be described as delivery. Sender identity is not supplied by the client. There is no standalone CLI `message` command.
- `agent_chat({to,text})` is an own tool. The runner authenticates sender/run and the router addresses exact instances. `queued` is not sent; `delivered` confirms durable steering-queue acceptance, not model consumption; `rejected` is definitive, `unknown` is uncertain and must not be automatically resent. The tool callback has a 10-second acknowledgement deadline. No Pi extension or RPC transport is involved.
- Human questions are serialized: only the head request can be answered through `human/response.json`; already running independent pipelines may continue, but no new milestone starts while any milestone waits for a human decision. Scheduling resumes immediately after the decision. Clients must use the current pending request, not answer a queued request speculatively. Stop/abort applies to every active pipeline.

The durable lease is **`hive/control/owner.json`**, not `lease.json`. Server-launched run and demo processes receive a generated `SCRANTON_RUN_ID`, piped stdin/stdout/stderr plus a Node IPC channel, `SCRANTON_PARENT_GUARD=1` and the lease token in `SCRANTON_RUN_LEASE`. Before CLI parsing/configuration, `registerParentStartup` registers the startup protocol. All pre-work exits send token-authenticated `scranton-startup-refused`; before work the CLI awaits `scranton-startup-begun`, and `guardParent` sends `scranton-guard-registered`. After child close, the server can release a pre-work lease only for a matching refusal with no begun/guard registration (spawn failure before a PID is also safe to release). Missing/ambiguous registration retains ownership. Stdin EOF/error/close or lost heartbeat aborts the guarded run; IPC carries startup lifecycle messages, not chat. Standalone Hive writers also acquire ownership. Cleanup must finish before ownership is released; unresolved cleanup deliberately blocks a second run, including after a server restart. Stop can queue a stop file for an orphan's run ID without blindly killing an old stored PID. The owning CLI/demo process atomically writes `control/heartbeat.json` `{v:1,runId,pid,at:"<ISO>"}` immediately and every 5 s, including human waits; clean lease release removes it. This is separate from the server-to-child stdin watchdog. If cleanup remains unresolved, the CLI stops heartbeating and rewrites the heartbeat with `cleanup:"unresolved"` and `reason:string`; this always means `unknown`, even for a dead PID, with `orphan.recoveryError` = `Cleanup of this run could not be verified: <reason>`. Automatic recovery never releases it. If the initial heartbeat write fails, the CLI releases its newly acquired lease. Otherwise owner status is checked in order: absent/mismatched heartbeat → `unknown`; heartbeat PID proven absent (ESRCH) → `gone`; running PID (including EPERM) with a heartbeat no older than 30 s → `alive`; otherwise → `unknown`. Stale PID reuse never proves liveness. Leases add `host:string` (the acquiring machine's hostname); legacy leases may omit it. The startup/guard protocol and `runOwnerStatus` semantics are unchanged.

A server automatically recovers a `gone` orphan only when cleanup is verified (no Docker usage, or all matching containers confirmed removed). The CLI's next `run` additionally requires the recorded host to be absent (legacy) or equal to this hostname and the matching heartbeat to be older than 30 s; these conditions are rechecked after asynchronous cleanup. Fresh, foreign-host, missing or invalid heartbeat evidence keeps ownership and reports the observed process state, heartbeat age and host: wait and retry, or use `scranton recover ... --confirm-stopped` only after independently making sure nothing of that run is still running. For a lease with `mode:"undo"`, these same owner-evidence rules apply, but recovery only removes the lease and heartbeat: it never opens, archives or writes a run journal/state/directory, and leaves restore-point `undoPending` bookkeeping intact for the next undo. Both paths use `recoverOrphan` (the same Docker cleanup verification; neither independently enumerates surviving host-agent processes), with summary `Interrupted: the run's process ended without finishing`. It removes matching Scranton Docker containers using run labels (legacy containers require an exact recorded worktree mount), clears the pending human question through normal aborted completion, and writes `run_finished {status:"aborted",summary}` through the event recorder. The journal/state remain current and are archived normally when the next run starts. Ownership, heartbeat and stop files are removed only after successful recovery. Unreachable Docker or unverified removal retains the lease and exposes the reason in `orphan.recoveryError`, even if `run_finished` already exists. Worktrees/sessions remain available for diagnosis. Recovery runs in the background per chat; other chats do not wait for its Docker calls. Registry recovery discovery is throttled to once per second; live/deletion guards still read current ownership. Empty recovery locks, locks with a proven-dead PID, or locks older than five minutes are reclaimed (not the run lease itself). If the journal contains no events for this run, recovery archives the previous journal through the normal start path and emits `run_started` from the lease's request/workspace with `roles:[]`, followed by `run_finished`. Mixed matching-run journals or invalid sequences still fail closed.

CLI: `scranton recover [--hive DIR | --data DIR --project ID --chat ID] [--confirm-stopped]` inspects ownership and, without confirmation, recovers only a gone owner with a stale matching heartbeat (>30 s), absent/matching host and verified cleanup. Registry selection uses the same default data directory as `projects`; it never creates a chat and rejects Pipeline chats. Unknown ownership or unverified cleanup requires `--confirm-stopped`, only after independently confirming all prior processes/containers have stopped. Alive owners are never released. Success/no owner: exit 0; refusal/recovery failure: 1; usage: 2. Automatic recovery records `Interrupted: the run's process ended without finishing`; confirmed manual recovery records `Released by the user`. Successful recovery removes stale `human/request.json` as well as stop/lease/heartbeat files.

`POST /api/runs/release` takes only `{runId}` with the same loopback/Host/client/origin/JSON/262144-byte protections as Stop. No orphan or mismatched run ID returns 409 `{error}`; an `alive` owner returns 409 `{error:"The run is still running. Request a stop instead."}`. Otherwise the same recovery records summary `Released by the user`, returning 200 `{ok:true,warnings:string[]}`. During automatic recovery it returns 409 `{error:"Recovery is already in progress. Try again in a moment."}`. Conflict responses never set `recoveryError`; that field comes only from recovery attempts and clears on success or orphan replacement. For explicit manual Release only, unreachable Docker does not block release and adds exactly `Docker is not reachable; containers of this run could not be checked` to `warnings`; removal errors also become warnings. Warnings are appended to a newly emitted finish summary; if a finish already exists, it is preserved and warnings are still returned in the HTTP response. Other recovery/ownership failures retain the lease. No stored PID is killed. For `unknown`, release only after independently confirming the run has stopped: releasing an actually live unknown owner allows two runs to share the chat. Age alone is not authorization.

Docker is an explicit prerequisite, with no automatic image build/pull or silent host fallback. Trusted-host is not OS isolation and bridge is not blocked egress. See [ISOLATION.md](ISOLATION.md). The published DAG is immutable: dynamic replanning is unsupported and effective `maxReplans` is 0 (nonzero configuration warns). Shared isolation requires one host pipeline; shared+Docker is rejected and shared instance worktree metadata is null. Deterministic API/protocol tests do not establish real Docker/model behavior or native lifecycle correctness; validate those separately against the release artifact.

### Unreadable owner record

An empty or corrupt `control/owner.json` cannot be recovered with `--confirm-stopped`: the run identity/token is unverifiable. Stop every server/CLI using this hive, independently verify that its agent processes and containers have stopped, and preserve a copy of the hive for diagnosis. Only then manually move `control/owner.json` and `control/heartbeat.json` out of the hive to a backup location. Do not change events, state, run archives or restore-point manifests. Restart the server/CLI; an interrupted undo can then be retried. Never infer safety from a stored PID or age alone.

## 7. Anmeldung, API-Keys, eigene Provider und Modelle

Diese Routen sind nur mit aktivierter Steuerung verfügbar; ohne sie oder bei falscher HTTP-Methode antworten sie mit 404. Auch alle drei GETs verlangen Loopback-Peer, lokalen Host, `X-Scranton-Client: 1` und bei vorhandenem `Origin` den exakten Server-Ursprung. POSTs verlangen zusätzlich ein JSON-Objekt und höchstens 262144 Bytes. Fehlerantworten: `{ "error": string }`.

| Route | Anfrage | Erfolg |
|---|---|---|
| `GET /api/auth` | kein Body | `200 { accounts: Account[], login: LoginSession \| null }` |
| `POST /api/auth/login` | `{ provider: "anthropic" \| "openai" \| "google-antigravity" }` | `202 { id: string }` |
| `POST /api/auth/login/input` | `{ id: string, value: string }` | `202 { ok: true }` |
| `POST /api/auth/login/open` | `{ id: string }` | `202 { ok: true }` |
| `POST /api/auth/login/cancel` | `{ id: string }` | `202 { ok: true }` |
| `POST /api/auth/logout` | `{ provider: string }` | `202 { ok: true }` |
| `GET /api/auth/providers` | kein Body | `200 { providers: { id: string; label: string; methods: AuthMethod[] }[] }` |
| `POST /api/auth/key` | `{ provider: string, key: string }` | `202 { ok: true }` |
| `POST /api/providers/discover` | `{ baseUrl: string, api: Api, key: string }` | `200 { models: DiscoveredModel[] }` |
| `POST /api/providers` | `{ id: string, label?: string, baseUrl: string, api: Api, models: CustomModel[], key: string }` | `202 { ok: true }` |
| `POST /api/providers/remove` | `{ id: string }` | `202 { ok: true }` |
| `GET /api/models` | kein Body | `200 { providers: Provider[] }` |

Formen (TypeScript-Notation; `?` bedeutet optional, kein Tokenwert wird zurückgegeben):

```ts
type AuthMethod = "oauth" | "api_key";
type Api = "openai-completions" | "openai-responses" | "anthropic-messages";
type DiscoveredModel = { id: string; contextWindow?: number; maxTokens?: number };
type CustomModel = DiscoveredModel & { reasoning?: boolean; input?: ("text" | "image")[] };
type Account = {
  id: string;
  label: string; // u. a. "Claude (Pro/Max)", "ChatGPT", "Google Antigravity", "Gemini"
  methods: AuthMethod[];
  custom?: boolean;
  baseUrl?: string;
  api?: Api;
  status: "signed_in" | "signed_out" | "expired" | "error";
  kind: "oauth" | "api_key" | null;
  expiresAt?: string; // ISO: access-token expiry, not subscription expiry
  renewsOnUse?: boolean;
  renewFailedAt?: string; // ISO: observed failed renewal
  detail?: string;
};
type LoginSession = {
  id: string; // UUID
  provider: "anthropic" | "openai" | "google-antigravity";
  state: "starting" | "waiting_browser" | "waiting_code" | "completing"
    | "done" | "failed" | "cancelled";
  startedAt: string; // ISO
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  message?: string;
  error?: string;
};
type Provider = {
  id: string;
  label: string;
  signedIn: boolean;
  models: { id: string; name: string; reasoning?: boolean; contextWindow?: number }[];
};
```

`/api/auth` returns safe account/login snapshots, then explicitly starts background renewal. Renewable expired access remains signed_in with renewsOnUse; only permanent refresh rejection marks expired. Built-ins: anthropic (Claude OAuth/key), openai (ChatGPT OAuth/key), google (Gemini key), google-antigravity (OAuth). Antigravity and Gemini records are independent. The catalogue is Scranton-owned; see `.enma/auth-contract.md`.

`POST /api/auth/key` stores a literal key in Scranton credentials. Keys are trimmed, nonempty, at most 4096 characters, without embedded whitespace/controls or !/$ prefixes. Stored credentials win over environment values; malformed records block ambient fallback. Logout removes the stored record, not environment keys. Concurrent operations may return 409.

### Eigene Provider und Discovery

Die vier neuen POSTs (`/api/auth/key`, `/api/providers`, `/api/providers/discover`, `/api/providers/remove`) weisen zusätzliche Body-Felder mit 400 ab. `api` muss einer der oben genannten API-Typen sein. Basis-URLs verlangen HTTPS (HTTP nur für `localhost`, `127.0.0.1`, `[::1]`), ohne Zugangsdaten, Query oder Fragment; abschließende Slashes werden entfernt. Schlüssel dürfen nicht Teil der Provider-Metadaten sein.

- **Discovery:** Der Server fragt `<baseUrl>/models` mit `Authorization: Bearer <key>` ab. Nur Weiterleitungen desselben Ursprungs (Schema, Host, Port) sind erlaubt, höchstens drei; Zeitlimit 10 s einschließlich Body, Antwort maximal 1 MiB. Erwartet wird `{ data: [{ id, contextWindow?, maxTokens? }] }` mit höchstens 256 Einträgen. Zurück kommen nur IDs und vorhandene positive ganzzahlige Tokenlimits, niemals Keys oder die rohe Provider-Antwort. Beispiel: `https://api.abliteration.ai/v1` → `/v1/models`. Discovery speichert nichts und wird beim Hinzufügen deklarierter Modelle nicht automatisch ausgeführt.
- **Add:** validate ID, label, HTTPS/loopback baseUrl, API and 1–256 model declarations using `.enma/auth-contract.md`. Commit definition and literal key atomically in the own store; metadata never includes keys. Existing IDs conflict (409).
- **Remove:** remove only an own declared provider and its credential/renewal record; unknown or unmanaged IDs conflict. Imported definitions are Scranton-managed copies, never edits to their Pi originals.

Zugangsdaten und eigene Provider liegen in Scrantons eigenem `store.json`: Windows `%APPDATA%\dev.scranton.desktop\credentials`, macOS `~/Library/Application Support/dev.scranton.desktop/credentials`, Linux `$XDG_DATA_HOME/dev.scranton.desktop/credentials` (Standard `~/.local/share/dev.scranton.desktop/credentials`). `SCRANTON_CREDENTIALS_DIR` überschreibt das Verzeichnis. Beim ersten Initialisieren werden Pi-Logins und Provider einmalig aus `PI_CODING_AGENT_DIR` bzw. `~/.pi/agent` importiert; vorhandene Scranton-Einträge gewinnen. Danach liest oder schreibt Scranton dieses Pi-Profil nicht mehr. Wenn Scranton importierte Tokens erneuert, müssen Pi-CLI-Nutzer sich gegebenenfalls in Pi erneut anmelden. Der Store ist private App-Datenablage, kein verschlüsselter OS-Schlüsselbund.

Fehler für diese Erweiterungen: 400 bei Validierung, 409 bei Konflikten/unverwalteten oder extern geänderten Einträgen/defekter Provider-Konfiguration, 502 bei fehlgeschlagener Discovery; interne Fehler liefern bereinigte 500-Antworten. Die allgemeinen 403/413/415-Regeln gelten weiterhin. Ein angezeigter Key-Status bestätigt keinen erfolgreichen Provider-Request.

### Modellwahl und OAuth-Lifecycle

`/api/models` joins signed-in account metadata with the own LLM catalogue and custom declarations, without refresh/network discovery. Catalogue presence does not establish model entitlement. Validated login URLs only may open in the system browser; never open a client-supplied URL.

**Google Antigravity** uses the own credential adapter, PKCE and state validation, callback `http://localhost:51121/oauth-callback`; complete redirect URL required. Project discovery is real, no invented project. Own LLM client handles inference on the host in every sandbox mode. No extension registration or inference broker. No entitlement/quota guarantee.

One login per auth service, ten-minute timeout. Input is 1–4096 characters; wrong session/state returns 409. Claude manual input requires code#state or a complete state-matching URL; ChatGPT requires the complete callback URL. Logout changes only the selected own-store record, not environment keys. UI polls active login; saved credentials win late cancellation.

`POST /api/auth/login/open` accepts only the session ID, never a URL. It reopens the active session's stored, validated sign-in URL; missing/stale/terminal sessions or sessions without a URL return 409, extra fields return 400. Browser launches are limited to one per 2 seconds per auth service (including the initial automatic launch); earlier retries return 429. Spawn failures return a sanitized 500. The same control POST hardening applies. Browser openers are detached and unref'd: successful spawn, not browser exit, completes opening. Login cancellation, timeout and server close never wait for the opener. Once Scranton completes credential persistence successfully, a late cancellation cannot replace `done` with `cancelled`.

Credentials, refresh and LLM inference remain on the host. Docker runs only tool subprocesses; no token/key projection, model restriction or Antigravity broker. Both run routes validate per-run models against the signed-in own catalogue and apply model/thinking overrides in every Team sandbox mode. Unconfigured roles use Automatic; see `.enma/agent-stream-contract.md`.

`POST /api/runs` akzeptiert zusätzlich optional:

```ts
models?: {
  michael?: { provider: string; model: string; thinking?: Thinking };
  dwight?:  { provider: string; model: string; thinking?: Thinking };
  angela?:  { provider: string; model: string; thinking?: Thinking };
};
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

Provider and exact model ID must exist together in the signed-in catalogue in all Team sandbox modes. Unknown roles/extra fields/invalid Thinking produce 400 before launch. Omitted roles keep agent defaults; absent defaults use Automatic. Valid overrides become role environment values for that run, not config writes. Demo remains scripted and sends no model choice.

There is no Team Docker inference broker: all provider calls remain host-side. Container network policy governs tools only. Pipeline uses its separate check sandbox and host completion bridge.

Offline tests do not prove live OAuth acceptance, subscription entitlements, native macOS/Linux isolation or installed desktop lifecycle. Historical broker tests do not apply to the new tool-only executor. Verify these separately at release.

## 8. Projekte, Chat-Threads und Run-Historie

Dieser Abschnitt ergänzt die bestehenden Single-Hive-Routen und beschreibt die Registry-Implementierung (`projects.js`, `registry-router.js`, `thread.js`). Ein Thread ist ein eigener Hive; `/chat` bleibt dagegen der direkte Instanz-Chat eines aktiven Runs.

### Modi und Zugriffsschutz

- **Registry:** `visualize --data DIR` oder `app-server --data DIR` (alternativ `SCRANTON_DATA`, Konfiguration `dataDir`). Die CLI aktiviert dabei die Steuerung auch ohne `--control`. `maxConcurrentRuns` / `SCRANTON_MAX_RUNS` begrenzt aktive Runs über alle registrierten Chats (Standard 4), unabhängig von `execution.maxParallel` pro Run. Verbliebene Leases zählen als belegt.
- **Single:** ohne Datenverzeichnis bleiben `--hive`/`--workspace` und die unscoped Routen bestehen. Die Projekt-API zeigt ein implizites Projekt `default` und einen Chat `default`; Verwaltungs-POSTs liefern `409 {error:"single_mode"}`. Dies betrifft auch Rename. Scoped Reads funktionieren auch ohne aktivierte Steuerung; Run-/Chat-/HITL-/Stop-POSTs benötigen einen Controller.
- **Alle** Registry-/Projekt-/Scoped-Routen, einschließlich GETs und SSE, verlangen Loopback-Peer, lokalen Host, `X-Scranton-Client: 1` und bei vorhandenem `Origin` den exakten Server-Ursprung. Das gilt im Registry-Modus auch für die unscoped Aliase `/events`, `/api/state`, `/api/runs`, `/api/chat`, `/api/hitl`, `/api/stop`, `/api/runs/stop`, `/api/control`. POSTs verlangen ein JSON-Objekt, `Content-Type: application/json` und maximal 262144 Byte. Keine CORS-Freigabe.
- Im Single-Modus bleiben die unscoped Reads `/events` und `/api/state` sowie `GET /api/control` bei ihren bisherigen Regeln; die neuen Scoped-Routen verlangen dagegen den Client-Header. Die UI verwendet für Scoped-SSE **fetch mit lesbarem Response-Stream** und Client-Header statt `EventSource`, das keine benutzerdefinierten Header senden kann. SSE-Framing, Replay ab Dateianfang und Deduplizierung nach Run-ID/Sequenz bleiben gleich.

Fehlerantworten dieser API sind `{error:string}`; die Zeichenfolge ist kein zusätzliches `code`-Feld. Ein vom äußeren HTTP-Hostfilter abgewiesener Request kann stattdessen die Textantwort `Forbidden` erhalten.

### Datenformen und Projekt-/Chat-Verwaltung

TypeScript-Notation; Zeitangaben sind ISO-Strings, IDs sind servergeneriert:

```ts
type Project = { id: string; name: string; workspace: string; createdAt: string };
type Chat = {
  id: string; projectId: string; title: string; hiveDir: string;
  createdAt: string; updatedAt: string;
};
type ChatSummary = {
  id: string; title: string;
  status: "idle" | "running" | "needs_human" | "done" | "failed" | "stopped";
  updatedAt: string | null; runs: number; // Anzahl, kein Array
};
type ProjectsResponse = {
  mode: "registry" | "single"; maxConcurrentRuns: number; running: number;
  projectsRoot?: string; // Registry: absolute default parent folder for newly created projects
  projects: (Project & { chats: ChatSummary[] })[];
};
```

Im Single-Modus hat das implizite Projekt nur `{id:"default",name:"Default",workspace,chats}` (kein `createdAt`); der implizite Chat heißt `Default`. Chatstatus: offene menschliche Frage → `needs_human`; lebender Run oder Recovery-Lease → `running`; frühere Ergebnisse `success`/`partial`/`finished` → `done`, `aborted` → `stopped`, `failed` → `failed`, sonst `idle`. Ohne Controller kann Single-Status nur aus der Historie abgeleitet werden.

| Route | JSON-Anfrage | Erfolg |
|---|---|---|
| `GET /api/projects` | kein Body | `200 ProjectsResponse` |
| `POST /api/projects` | `{name:string, workspace?:string, create?:boolean}` | `201 {project:Project}` |
| `POST /api/projects/rename` | `{id:string, name:string}` | `200 {project:Project}` |
| `POST /api/projects/remove` | `{id:string, deleteHistory?:boolean}` | `200 {ok:true}` |
| `POST /api/projects/:p/chats` | `{title?:string}` | `201 {chat:Chat}` |
| `POST /api/projects/:p/chats/rename` | `{id:string, title:string}` | `200 {chat:Chat}` |
| `POST /api/projects/:p/chats/remove` | `{id:string}` | `200 {ok:true}` |

Es gibt keine separate `GET /api/projects/:p/chats`-Route: Chatlisten stehen in `GET /api/projects`. Nicht unterstützte Methoden/Routen liefern 404. Zusätzliche Body-Felder der Verwaltungs-POSTs liefern 400. Namen/Titel müssen nichtleer sein, höchstens 120 Zeichen vor dem Trimmen und ohne Steuerzeichen. Chat-Titel standardmäßig `New chat`; beim ersten servergestarteten Run mit diesem Titel wird er durch die ersten 60 Zeichen der Anfrage ersetzt. Die CLI legt neue Threads direkt mit diesem Zielausschnitt an. IDs entsprechen `^[a-z0-9][a-z0-9-]{0,39}$`; reservierte Gerätenamen wie `con` oder `nul` werden bei ID-Validierung abgewiesen.

`workspace` muss in der HTTP-API absolut sein und ein Verzeichnis bezeichnen. Ohne Pfad wird `<Benutzerprofil>/Documents/Scranton/projects/<id>` angelegt; `create:true` erlaubt einen fehlenden expliziten Ordner. Gespeichert wird der reale Pfad, unter Windows erfolgt der Duplikatvergleich ohne Groß-/Kleinschreibung. Datenverzeichnis und dessen Unterordner, Laufwerkswurzel, Benutzerprofilwurzel sowie Windows-Systemverzeichnis und dessen Unterordner sind als Workspace verboten. Defekte Metadaten werden nicht überschrieben; atomare Schreibvorgänge laufen unter einem Registry-Lock.

Entfernen verändert niemals Workspace-Dateien. Projektentfernung entfernt den Registry-Eintrag; `deleteHistory:true` (Standard false) löscht zusätzlich nur `<data>/projects/<id>`. Ein extern referenzierter Legacy-Hive bleibt erhalten. Chatentfernung löscht **nur `chat.json`**, nicht Hive/Run-Dateien. Ein aktiver oder ungeklärter Lease verhindert Projekt-/Chatentfernung mit 409.

### Scoped-Routen

Präfix `P = /api/projects/:p/chats/:c`; IDs aus der Registry übernehmen. Derselbe Präfix ist im Single-Modus mit `default/default` verfügbar. Die Projektbindung verhindert, dass ein Registry-Run per Body in einen anderen Workspace umgeleitet wird.

| Route | Anfrage | Erfolg |
|---|---|---|
| `GET P/events` | kein Body; SSE | `200 text/event-stream`, aktuelle vollständige Eventzeilen, danach Live-Stream |
| `GET P/state` | kein Body | `200` aktuelles `state.json`, anfangs `{v:1,status:"idle"}` |
| `GET P/control` | kein Body | `200` Single-Chat-Control-Snapshot (unten) |
| `GET P/runs` | kein Body | `200 {runs:RunSummary[]}` |
| `GET P/runs/:runId/events` | kein Body | `200 {events:object[]}` aus dem Archiv |
| `POST P/runs` | derselbe Run-Body wie `/api/runs` (§3, §6, §7) | `202 {ok:true,pid:number}` |
| `POST P/chat` | `{runId:string,to:string,text:string}` | `202 {ok:true,id:string,delivery:"queued"}` |
| `POST P/hitl` | `{decision,feedback?}` | `202 {ok:true}` |
| `POST P/stop` oder `POST P/runs/stop` | `{}` | `202 {ok:true}` |
| `POST P/release` oder `POST P/runs/release` | `{runId:string}` | `200 {ok:true,warnings:string[]}` (§6) |

Run-Body vollständig: `{request?,workspace?,demo?,maxCycles?,maxStalledCycles?,milestoneTokenBudget?,noPlan?,maxParallel?,sandbox?,sandboxImage?,sandboxNetwork?,trustedHost?,models?,conversation?,permissions?}` mit den bereits oben definierten Typen/Grenzen. Registry-`workspace` darf, falls gesetzt, nur der Projekt-Workspace sein; andernfalls `400 {error:"Workspace belongs to the project"}`. `request` ist außer bei Demo erforderlich. Andere Chats desselben Projekts dürfen parallel starten, nicht aber derselbe Chat. HTTP-202 bestätigt den Start/Spool-Auftrag, nicht den erfolgreichen Abschluss oder die Nachrichtenzustellung.

Der aktivierte Chat-Control-Snapshot enthält exakt diese Top-Level-Felder (Definitionen für Run/HITL/Execution/Instanzen wie oben bzw. in EVENTS.md):

```ts
type ChatControl = {
  v: 1; enabled: true; workspace: string; scenarios: string[];
  run: null | {
    mode: "run" | "demo"; request: string; workspace: string; startedAt: string;
    runId: string; exitCode: null; pid: number;
  };
  lastExit: null | {
    runId: string; startedAt: string; mode: "run" | "demo"; request: string;
    exitCode: number; finishedAt: string; outputTail: string;
  };
  pendingHuman: null | {
    runId: string; requestSeq: number; milestoneId: string | null;
    reason: string; options: string[];
  };
  defaults: { execution: object | null; configurationError: string | null };
  instances: object; sessions: object; chatAck: unknown | null;
  recoveryRequired: boolean;
  orphan: null | {
    runId: string | null; startedAt: string | null;
    owner: "alive" | "gone" | "unknown";
    heartbeatAt: string | null; stopRequestedAt: string | null; recoveryError: string | null;
  };
};
```

`instances`, `sessions` und `chatAck` stammen nur aus dem zum aktiven Kindprozess passenden State; fehlend sind sie `{}`, `{}`, `null`. Ohne Controller liefert `GET P/control` im Single-Modus `{v:1,enabled:false}`. Ein Orphan kann über Stop einen Stop-Auftrag erhalten, aber der Server beendet niemals blind dessen gespeicherte PID.

### Runliste, Replay und Thread-Kontext

```ts
type RunSummary = {
  runId: string; goal: string; status: string;
  startedAt: string | null; endedAt: string | null; current: boolean;
  summary: string;
  reply: {kind:"answer"|"report"|"summary"; text:string; truncated?:boolean} | null;
};
```

Die Runliste umfasst Archiv plus aktuellen/letzten Hive-Run, älteste zuerst (Sortierung nach `startedAt`, sonst Run-ID), einschließlich der bounded `summary`-Zusammenfassung und `reply` (null für alte Runs). Reply-Text stammt aus state.json oder dem archivierten run_reply-Ereignis und ist auf 4000 Zeichen begrenzt; Kürzung setzt truncated:true. GET /api/runs liefert dieselbe Form auch im Single-Modus (mit Client-Header). `current` bedeutet Übereinstimmung mit der Run-ID in `state.json`, nicht zwingend einen lebenden Prozess. `status` übernimmt `run_finished.status`, ersatzweise den State-Status, sonst `unknown`; nicht mit `ChatSummary.status` verwechseln.

Replay liest ausschließlich `<hive>/runs/<runId>/events.jsonl`, nicht die aktuelle Root-Datei. Es liefert nur vollständige LF-terminierte, als JSON-Objekt lesbare Zeilen; ungültige Zeilen werden übersprungen. Run-ID: `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`. Antworten: 400 `Invalid run ID`, 404 `Run archive not found`, 403 `Forbidden archive path` bei Pfadausbruch oder 413 `Archive exceeds 20 MiB`. Replay ist ein JSON-Read, kein SSE-Stream und keine Wiederaufnahme eines alten Runs.

Vor dem nächsten Registry-Run wird das Kontextpaket aus Dateien neu aufgebaut: Projektnotizen, Dreaming-Gedächtnis, andere Chats desselben Projekts sowie verdichtete ältere und detaillierte jüngste Turns dieses Chats. Michael erhält ein nach seinem Modell budgetiertes Paket in geschätzten Tokens, Dwight einen separaten modellbezogenen Kurzbrief; die Gates erhalten nichts Neues. Der Server übergibt `<hive>/control/thread-context.json` per `--thread-context`, die direkte Registry-CLI baut dasselbe Paket selbst. v2-Dokumente, Limits, v3-Transport und v1-/v2-Kompatibilität stehen in [Abschnitt 12](#12-context-system-registry-only). Es werden keine alten Pi-Prozesse fortgesetzt und keine vollständigen Transkripte zugesichert.

### Unscoped Aliase und aggregiertes Control

In Registry-Betrieb wählen die unscoped Aliase den zuletzt über einen Run-POST ausgewählten Chat dieses Servers, ersatzweise den Chat mit neuestem `chat.json.updatedAt`; reine UI-Navigation ändert das nicht. Ohne Chat: 404 `No active chat`. Für neue Clients immer Scoped-Routen verwenden. `/api/runs/release` ist der Registry-Alias für Release; `/api/stop` und `/api/runs/stop` sind Registry-Aliase für Stop; im Single-Modus die dokumentierte `/api/runs/stop`-Route verwenden.

`GET /api/control` ist im Registry-Modus **kein einzelner Chat-Snapshot**, sondern:

```ts
{
  v: 1; enabled: true;
  running: number;
  pendingHuman: number;
  chats: ({projectId:string; chatId:string} & (
    ChatControl | {
      v:1; enabled:true; run:null; pendingHuman:null;
      lastExit:ChatControl["lastExit"]; recoveryRequired:boolean;
      orphan:ChatControl["orphan"];
    }
  ))[];
}
```

`chats` enthält nur Chats mit lebendem Run, offener menschlicher Frage oder Recovery-Lease; noch nicht instanziierte Hive-Controller liefern die kompakte Form. `pendingHuman` zählt aktuelle offene Fragen, `running` zählt auch Recovery-Leases. Die Desktop-Tray-Auswertung akzeptiert diesen Zähler sowie das frühere Single-Snapshot-Objekt. Accounts-/Provider-Routen bleiben serverweit, nicht pro Thread.

### Fehler und Kapazität

- **400:** ungültige IDs/Namen/Titel/Typen/Pfade/Runparameter, zusätzliche Verwaltungsfelder oder kein JSON-Objekt.
- **403:** fehlender Client-Header, nichtlokaler Peer/Host, falscher Origin oder Archivpfadausbruch.
- **404:** unbekanntes Projekt (`Project not found`), unbekannter Chat (`Chat not found`), fehlendes Archiv, kein aktiver Alias-Chat oder nicht unterstützte Route/Methode.
- **409:** `single_mode`; bereits laufender Chat, fremde/ungeklärte Hive-Lease, laufende Chats beim Entfernen, defekte Metadaten, doppelter Workspace (`Workspace already registered`), belegter Registry-Lock (`Registry is busy`) oder schließender Server. Die konkrete Fehlermeldung variiert nach Prüfpfad, z. B. `Chat is running or requires recovery` oder `A run is already alive or the server is closing`; es gibt keinen einheitlichen Konflikt-Code.
- **413/415:** Body-/Archivgrenze überschritten bzw. falscher Content-Type.
- **429:** Registry-Runlimit erreicht → exakt `{error:"too_many_runs"}`; davon getrennt Instanz-Chatspool voll → `{error:"Chat queue is full"}`. Es wird kein Run für später eingereiht. Nach Freigabe eines Slots erneut starten.
- **500:** unerwarteter interner Fehler, bereinigt als `Registry operation failed` bzw. `Control operation failed`.

### Speicherung und Desktop-Import

`<data>/projects.json` ist `{v:1,projects:Project[]}`; je Thread liegen `chat.json` und standardmäßig `hive/` unter `<data>/projects/<p>/chats/<c>/`. `hiveDir` darf für den internen Legacy-Import extern sein, ist aber kein erlaubtes Chat-POST-Feld. Der Desktop startet `app-server --data <appData> --legacy-workspace <documents>/Scranton/workspace`. Nur wenn `projects.json` fehlt und `<data>/hive` existiert, entsteht Projekt `{id:"scranton",name:"Scranton",workspace,createdAt}` mit Chat `{id:"legacy",projectId:"scranton",title:"Previous runs",hiveDir:<data>/hive,createdAt,updatedAt}`. Der alte Hive wird referenziert, nicht verschoben. Bei leerem Profil beginnt die Registry ohne Projekte.

## 9. Roles, gate workflow and custom prompts

The five role IDs are `michael`, `dwight`, `oscar`, `hank`, `angela`. `POST /api/runs` and scoped follow-up `POST P/runs` accept optional `workflow:{gates:string[][]}`. Each nonempty stage contains only gate roles (`oscar`, `hank`, `angela`), with no duplicate role anywhere; at least one stage is required. Invalid workflows return 400 before spawning. Engine default: `[["angela"]]`. `--gates "oscar+hank,angela"` is supported by run, demo and app-server (as a launch default).

`defaults.workflow` is the effective workflow; defaults.models holds configured role provider/model refs or null. Run model/thinking overrides are validated against the signed-in own catalogue in all Team sandbox modes. Omitted roles retain configured defaults, otherwise use Automatic. No Docker-specific explicit-model rule or ignored overrides.

Global control endpoints (single and registry modes):

| Route | Body | Success |
|---|---|---|
| `GET /api/agents` | none | `200 {roles:Role[],workflow:{default:[["oscar","hank"],["angela"]]}}` |
| `PUT /api/agents/:id/prompt` | `{text:string}` | `200 {ok:true}` |
| `DELETE /api/agents/:id/prompt` | none | `200 {ok:true}` |

Role: `{id,name,title,keywords,tools,gate,prompt:{source,text,editable,builtinText,missingKeywords}}`. Missing expected bracketed keywords are advisory only. PUT requires nonblank text, at most 32768 UTF-8 bytes; writes are atomic. Config-pinned prompts reject PUT/DELETE with 409. DELETE restores built-in fallback. Unknown IDs return 404. Without control these routes are 404; all require the same loopback peer/Host, exact Origin when present and `X-Scranton-Client: 1` checks. PUT additionally requires JSON and the existing body bound (oversize 413).

Resolution: explicit agents.<id>.skill, saved prompt under <promptsDir>/<id>.md, then built-in/starter prompt. Single mode uses <hive>/prompts, Registry uses <data>/prompts. Each run snapshots resolved text once; each invocation receives it as host-side workflow input. No Pi CLI flag or Docker prompt mount. Events expose source and SHA-256 only.

## 10. Custom agents and persistent agent settings

Available in both single and registry mode, globally rather than per chat. Every agent route requires enabled control, loopback peer/local Host, `X-Scranton-Client: 1` and the exact server Origin when supplied. POST/PATCH/PUT require JSON object bodies <=262144 bytes before parsing. Wrong methods or disabled control return 404. Error bodies remain `{error:string}`.

| Route | Body | Success |
|---|---|---|
| `GET /api/agents` | none | `200 {roles:Role[],workflow:{default:[["oscar","hank"],["angela"]]},warnings:string[]}` |
| `POST /api/agents` | `{id,name,title,instruction,passKeyword?,failKeyword?,tools?,model?,thinking?}` | `201 {ok:true,agent:Role}` |
| `PATCH /api/agents/:id` | mutable fields from creation except id | `200 {ok:true,agent:Role}` |
| `DELETE /api/agents/:id` | none | `200 {ok:true}` |
| `PUT /api/agents/:id/prompt` | `{text:string}` <=32768 UTF-8 bytes, trimmed nonempty | `200 {ok:true}` |
| `DELETE /api/agents/:id/prompt` | none | `200 {ok:true}` |

Role shape: `{id,name,title,kind,builtin,gate,keywords,passKeyword?,failKeyword?,tools,instruction,defaultInstruction?,model:{value:{provider,model}|null,source,pinned},thinking:{value:string|null,source,pinned},prompt:{source,text,editable,builtinText,missingKeywords}}`. Catalog order is the five built-ins then custom agents in creation order. Sources for model/thinking are `env|config|settings|none`; env/config pins independently prevent editing that field. Config skill pins prevent prompt writes. Prompt source remains `config|custom|builtin`.

Custom IDs match `^[a-z][a-z0-9]{1,19}$`; reserved built-ins, routing names and Windows device names are refused before path construction. Name <=40, title <=60, instruction 1..1000 characters; control characters stripped. Pass/fail keywords match `^[A-Z][A-Z0-9_]{2,39}$`, are distinct and cannot collide with BLOCKED, built-ins or any registered role; defaults `<ID>_PASSED` and `<ID>_FAILED`. Tools are a nonempty subset of read, grep, find, ls, bash (Windows powershell fallback); write/edit are forbidden. At most 12 custom gates. Michael/Dwight accept only model/thinking patches; built-in gates additionally accept instruction (`null` restores default). Custom instructions cannot be reset to null. Built-ins cannot be deleted.

Invalid fields return 400, unknown IDs 404, duplicate IDs/capacity/pinned fields 409. Definitions and model/thinking settings are atomically stored in `<settingsDir>/agents.json` (`{v:1,agents:{[id]:entry}}`), where settingsDir is dataDir in registry mode, otherwise hiveDir. Every load revalidates: invalid hand-edited entries are skipped, reported in warnings and doctor, and cannot execute. Creating a custom agent writes NO prompt file: the current definition deterministically generates a starter (`prompt.source:"builtin"`, editable, builtinText = starter). Prompt deletion restores that starter; definition deletion also removes its saved prompt. Active runs retain snapshots.

`GET /api/control` defaults include agents in catalogue order, thinkingLevels and models for all registered IDs. Effective model precedence in every Team mode: per-run models > environment > config > agents.json > Automatic. Registered custom gate IDs are accepted in workflow/model overrides; metadata/definition/prompt snapshots remain run-scoped.

Gate tool configuration is deliberately restricted on every `loadConfig`, including `visualize`: `agents.oscar.tools`, `agents.hank.tools`, `agents.angela.tools` and custom `agents.<id>.tools` must be nonempty read-only allowlists (read, grep, find, ls, bash; Windows powershell fallback). Invalid built-in overrides fail with a ConfigError naming `agents.<id>.tools`; existing write/edit overrides must be removed. Shell access can still modify files and is not an OS security boundary.

All pi.* config, SCRANTON_PI_COMMAND and agents.<id>.extraArgs are rejected with actionable errors. Gate tools are validated at config load; no resource-loading or tool-changing CLI bypass. No Pi extension/MCP discovery. Shell remains writable inside the selected OS executor.

CLI: `scranton agents`, `scranton agent set-model <id> --provider P --model M [--thinking T]`, `scranton agent remove-model <id>`, `scranton run --gates "oscar+seclint,angela"`. Custom gates are used through workflows; standalone custom-agent commands are currently refused. Settings and prompt directories are never mounted into containers; only the resolved invocation prompt crosses that boundary read-only. Subscription minting and API-key handling remain provider-selected as documented in §7.

## 11. Team conversation mode

Both `POST /api/runs` and scoped `POST P/runs` accept optional `conversation:boolean`. Non-booleans return 400 before spawning. Explicit true/false becomes `--conversation`/`--no-conversation`; omission retains CLI/env/config defaults (engine false). The UI sends true for new runs, follow-ups and demos. Control discovery includes the fake `question` scenario; its default request is `How does the Team orchestrator handle a request?`, matching its scripted answer. `defaults.execution.conversation` is omitted unless true. Child agents receive SCRANTON_CONVERSATION=1|0, including Docker/RPC launches. No additional filesystem or dialog API is introduced.

Conversation runs emit agent_message plus exactly one run_reply immediately before run_finished (see EVENTS.md). The latter is persisted in state.reply and exposed without sender in RunSummary.reply. Follow-up planning sees bounded earlier replies as context, not instructions. The report phase is best-effort: stop/failure/timeout never changes a completed milestone outcome or raises a human question. Off-mode events/state/CLI output retain their prior format.

## Live activity (additive)

- `GET /api/live` und `GET /api/projects/:p/chats/:c/live` liefern 200 mit dem Liveobjekt aus
  [EVENTS.md](EVENTS.md#live-activity-and-usage-additive-v1), `Cache-Control: no-store`.
  Ohne Datei/passenden aktiven Run: `{v:1,runId:null,updatedAt:null,instances:{}}`.
- Die Zugriffsschutzregeln sind identisch zur benachbarten State-Route: Registry-Aliase und Scoped-GETs
  verlangen Loopback, lokalen Host, `X-Scranton-Client: 1` und gegebenenfalls exakten Origin.
  Der unscoped Single-Read behält wie `/api/state` seine bisherigen Leseregeln.
- `RunSummary` ergänzt `usage:{tokens,cost}|null`; aus archiviertem `state.usage`, bei alten States
  aus der Summe der Agententotals. Kein Reasoning in Archivantworten.

Clients pollen Live nur bei sichtbarer Seite und aktivem Run einmal pro Sekunde, prüfen Run-ID und
aktive Instanz und rendern ausschliesslich als Text. Fehler/404 schalten Live still ab.

## 11. Project dreaming (Registry only)

The project-scoped structural Dreaming routes are `GET /api/projects/:id/dreaming` and POSTs at `/preview`, `/sweep`, `/settings`, `/rollback`. All use the existing scoped loopback/Host/Origin/client-header protections; POSTs require JSON objects <=262144 bytes and reject extra fields. Preview/sweep/rollback accept only `{}`. Settings accepts optional strict booleans `enabled`/`applyPolicy`/`reflectionEnabled`, integer `intervalMinutes` (15–10080), `reflectionModel` (provider/model string or null), integer `reflectionMaxOutputTokens` (256–4096) and integer `reflectionTimeoutSeconds` (10–60). Success is 200 with the version-1 Dreaming payload, not a wrapper; busy/recovery conflicts are 409, Single mode is 409 `single_mode`.

Reflection adds `GET /api/projects/:id/dreaming/proposal` (200 reflection status), `POST /api/projects/:id/dreaming/propose` with `{provider?,model?}` (202 complete Dreaming status after synchronous preflight), `POST /api/projects/:id/dreaming/proposal/apply` and `/proposal/reject` with `{proposalId}` (200 complete status), and `POST /api/projects/:id/dreaming/cancel` with `{}` (200 complete status). The same guards and strict body limits apply. Propose uses the authenticated catalog selection or configured model; 202 confirms acceptance, not successful completion or adoption. Poll status to observe running/ready/failed/cancelled. Pending proposals require explicit ID-specific review; deterministic commands never call a model. Project removal drains owned reflection cancellation/cleanup before deleting history, so cancellation cannot recreate its directory.

Defaults: scheduling off, policy application independently off, interval 360 minutes. Scheduling runs only in the live Registry server, defers project activity/recovery and is stopped on server close. Explicit sweeps require no model. New runs may receive bounded, live-source-revalidated advisory project memory; separately opted-in retry caps cannot exceed current operator ceilings and require an exact current evaluator cohort. No approvals or mandatory checks are inherited or removed. Full payload, provenance/privacy, CLI, replay exclusions and legacy Pipeline coverage: [DREAMING.md](DREAMING.md).

## 12. Context system (Registry only)

A turn is a run that is no longer live, including failed or interrupted runs. The next turn's advisory pack is rebuilt deterministically from disk, without model calls, network access or Pi session reuse. Projects never share context with other projects. Single-hive behavior is unchanged; these routes do not exist there. Context operations are non-journaled and add no event types.

### Repository instructions

Context inspection and `scranton context show` add a separate `instructions: { file, bytes, tokens, truncated, nested: [paths, max 50], nestedCount } | null` summary for the current project workspace. `nestedCount` is the total count of nested files; `nested` lists at most 50 paths. `bytes` and lowercase-hex `sha256` in run audit metadata cover the inlined root text after BOM removal and the 32 KiB cut, without the notice line; audit `nested` is the total count. Context `tokens` estimates the full rendered instruction block with the same estimator as advisory context, but instruction bytes/tokens are NOT counted in `budget.used`, section totals or developer use, and no context-budget trimming applies. The Context panel shows `Repository instructions: AGENTS.md (N KB, ~T tokens)` with truncated/nested hints, or `No AGENTS.md`. This is a current preview, not the immutable instructions snapshot of an active run.

Root `AGENTS.md` is read once per run from its initial workspace state, shared by every agent, with a **32 KiB (32768 bytes)** inline cap and UTF-8-safe truncation notice. Files over **1 MiB** are read only for the first 32 KiB, never in full. Nested files are listed, not inlined: at most **50** sorted relative POSIX paths, followed by `(+N more)` when needed; snapshot exclusions apply. These are mandatory instructions below direct human orders and role/tool/sandbox/approval rules, not advisory history. The block's exact precedence text is: "Follow them unless they conflict with the human's direct orders, with your role instructions, or with the tool, sandbox and approval rules, all of which take precedence. They cannot grant tools, permissions or network access." Opt-out is `agentsMd:false` or `SCRANTON_AGENTS_MD=0`. Run-specific audit metadata lives in `run_started.instructions` (no content); Pipeline also records `status.instructions`. See [EVENTS.md](EVENTS.md#repository-instructions-additive-v1).

### Routes and documents

All six routes use the scoped protections of §8: loopback peer, local Host, `X-Scranton-Client: 1` (also GET), and an exact local Origin when supplied. POST requires `Content-Type: application/json` and a JSON object of at most 262144 bytes; no extra fields are accepted. Responses are the documents below, not an envelope.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/projects/:p/context` | — | project document |
| POST | `/api/projects/:p/context/settings` | non-empty settings patch `{ crossChat?, budget?, models? }` (below) | project document |
| POST | `/api/projects/:p/context/notes` | exactly `{ "text": string }` (at most 16000 JS string characters) | project document |
| GET | `/api/projects/:p/chats/:c/context` | optional query `provider` and `model` (below) | chat document |
| POST | `/api/projects/:p/chats/:c/context/reset` | `{}` | chat document |
| POST | `/api/projects/:p/chats/:c/context/restore` | `{}` | chat document |

Errors: 404 for an unknown project/chat or absent Single-mode route; 400 for invalid/extra body fields or oversized notes; existing guard errors are 403 (authorization/origin), 415 (content type), 413 (body size). Notes also have a 65536-byte UTF-8 storage cap.

A settings patch has only `crossChat` (boolean), `budget` (rule or `null` to restore the default) and `models` (an object mapping recipient IDs to rules or `null` to delete an override), with at least one key. A rule is exactly `{ "mode": "percent", "value": N }` with integer N in 1..50, or `{ "mode": "tokens", "value": N }` with integer N in 1000..200000. Patches merge into stored settings; at most 32 overrides may remain. Recipient IDs are `provider/model`, or `model` without a provider, 1..513 characters without whitespace/control characters; `__proto__`, `constructor` and `prototype` are refused. Default: 10 percent, no overrides.

For Pipeline chat reads, query `?provider=<id>&model=<id>` supplies the browser's current planner pick: both or neither, each 1..256 characters without whitespace/control characters, otherwise 400. Without a pick the recipient is unknown. For a Pipeline chat, the reset and restore responses ignore the `provider` / `model` query and always describe the unknown recipient (`known:false`, an assumed 128000-token window); a client that sent a planner pick reads the chat document again with `provider` / `model`. Team reads ignore these queries and use Agents defaults for Michael and Dwight. At Team run start the effective models include per-run picks on the trusted host; Docker ignores them and uses Agents defaults. Pipeline starts use `models.planner`. Windows are resolved from custom provider declarations, then Pi's local registry, without network access; an unknown window is 128000 tokens (`known:false`).

Project document (example):

```json
{ "v": 2,
  "settings": { "crossChat": true, "budget": { "mode": "percent", "value": 10 }, "models": {} },
  "defaults": { "budget": { "mode": "percent", "value": 10 }, "window": 128000, "percent": [1, 50], "tokens": [1000, 200000], "models": 32, "pipeline": [4000, 18750],
    "pipelineBytes": { "history": [12000, 50000], "context": [4000, 25000] } },
  "notes": { "text": "", "chars": 0, "tokens": 0, "limit": 16000, "updatedAt": null },
  "chats": [{ "id": "", "title": "", "engine": "team", "turns": 0, "lastActiveAt": null, "reset": false }] }
```

Chat document (example; what the next turn would receive now, excluding the live run):

```json
{ "v": 2, "engine": "team",
  "settings": { "crossChat": true, "budget": { "mode": "percent", "value": 10 }, "models": {} },
  "reset": null,
  "model": { "id": "anthropic/claude-sonnet-4-5", "window": 200000, "known": true },
  "budget": { "tokens": 20000, "used": 1053, "mode": "percent", "value": 10, "source": "project", "capped": null },
  "turns": { "total": 7, "visible": 5, "detailed": 4, "condensed": 1, "omitted": 0 },
  "otherChats": { "chats": 2, "turns": 5 },
  "notes": { "chars": 120, "tokens": 30, "limit": 16000, "cut": false },
  "memory": { "chars": 0, "tokens": 0 }, "truncated": false, "degraded": false,
  "sections": [{ "id": "recent", "title": "This chat - recent turns", "chars": 4210, "tokens": 1053, "text": "...", "exact": true }],
  "developer": { "model": { "id": null, "window": 128000, "known": false },
    "budget": { "tokens": 1280, "used": 450 }, "chars": 1800, "tokens": 450, "text": "..." } }
```

`engine` is `team` or `pipeline`; `reset` is null without a marker. Non-empty `sections` follow the order `notes`, `memory`, `other-chats`, `earlier`, `recent`. Team sections are exact injected text (`exact:true`, apart from the orchestrator's wrapper); `budget.used` and section `tokens` are estimates from weighted Unicode units, not a tokenizer. ASCII and U+2026 count as 1 unit, other code points through U+2E7F as 2, all others as 4; tokens are `ceil(units / 4)`. Both documents are v2; the old char/byte `budget.limit` is gone. `budget.source` is `model` when an override applies, otherwise `project`; `capped` is null, `min`, `window`, `max` or `engine`. Team budgets are `max(256, min(raw, 200000, floor(window / 2)))`, with `raw = floor(window * percent / 100)` or the fixed token value. The developer's independent model budget B gives a brief of `min(B, max(250, min(2000, floor(B / 10))))` tokens. Pipeline sections are readable wire projections (`exact:false`), `budget` includes `historyBytes` and `contextBytes`, and `developer` is null; `recent` projects the existing history `runs`, the other conversation layers project `context`. `truncated` signals bounded reading/rendering; `degraded` signals fallback to legacy context after an internal error or at least one unreadable run or artifact.

Pipeline's engine prompt budget (default `max_prompt_bytes = 200000`) bounds the allowances for the planner's effective B tokens: `H = max(12000, min(3 * B, floor(200000 / 4)))`, `C = max(4000, min(B, floor(200000 / 8)))`. The shown budget is `floor((H + C) / 4)` tokens (4000..18750); `capped:"engine"` applies when `H + C != 4 * B`. Used tokens are `ceil((min(wireBytes - contextBytes, H) + min(contextBytes, C)) / 4)`, not the literal rendered prompt's tokenizer count. Degraded fallback still reports the computed budget and the legacy context's use.

### Storage and controls

| File | Content |
|---|---|
| `<data>/projects/<p>/context/settings.json` | `{ "v": 2, "crossChat": true, "budget": { "mode": "percent", "value": 10 }, "models": {} }`, at most 65536 bytes; budget/models optional; v1 `{v:1,crossChat:boolean}` remains accepted |
| `<data>/projects/<p>/context/notes.md` | UTF-8 text, at most 16000 JS string characters and 65536 bytes |
| `<data>/projects/<p>/chats/<c>/context/state.json` | `{ "v": 1, "resetAt": null }` or an ISO string for `resetAt` |

Missing/corrupt files read as sharing on, default 10-percent budget, no overrides, empty notes and no reset. Context storage and the Pipeline history reader canonicalise the data-directory root once, accepting links at or above it, then reject every linked component below it; the Team context reader canonicalises ancestors above the hive but rejects a linked hive root and every linked component below it. All three readers reject files with multiple hard links; storage writes use a same-directory temporary file, fsync and atomic rename (mode `0o600`). Notes normalize CRLF to LF and remove controls except newline/tab; empty text clears them. Turns and packs are derived, not separately stored.

With `crossChat:false`, no chat of this project receives or provides the other-chats layer. Reset hides turns of this chat that started at or before the marker from all packs, including sibling digests, without deleting history or renumbering turns. Restore sets `resetAt:null`. Project notes and Dreaming memory are unaffected. Changes affect subsequent packs, not already running prompts. The Context indicator shows `≈` tokens and percent of the recipient's window when used. The drawer shows budget/use, percentages of budget and window, a monochrome meter, model/window, assumed-window and cap hints, and token estimates for sections and the developer brief. Its budget control selects percent or fixed tokens, optionally `Only for <model id>`, with Save and Reset to default (removes the applying override, otherwise the project rule). Before closing, the drawer asks for confirmation to discard unsaved notes or budget edits. In a Pipeline chat, the rule preview is kept within `defaults.pipeline` (4000..18750 tokens); changing the planner pick reloads the chat document. Percentages show `0` for no use, `<0.1` below 0.1 percent, otherwise one decimal when the value rounded to one decimal is below 10, and a rounded integer above that (9.96 percent displays `10`, not `10.0`). The notes counter shows characters against 16000 plus estimated tokens. The drawer exposes sharing/reset controls, counters and collapsible sections; it refreshes on scope change, turn completion, mutation and opening, not by polling.

### Team transport and CLI

Before a non-demo server-started Registry Team run, the server writes `<hive>/control/thread-context.json` immediately before spawning the child, carrying the pack below; demo-scenario runs neither receive nor write a context pack:

```json
{ "v": 3, "text": "...", "developer": "..." }
```

`--thread-context FILE` accepts v3 files of at most 8388608 bytes, `text` at most 800000 characters and optional `developer` at most 8000. Legacy files remain accepted at most 262144 bytes: v2 `text` is at most 24000 characters and optional `developer` at most 4000. The still-accepted v1 form is `{ "v": 1, "text": "..." }`, at most 8000 characters, without a developer brief. Invalid versions/types/limits produce `Invalid thread context file`. Without this internal flag, the registry CLI builds the same pack from disk.

The builder budgets in weighted units (four per estimated token), with transport ceilings of 800000 planner and 8000 developer characters; line-wise consumer clamps have headroom at 800100 and 8100. Michael's heading is `## Earlier turns and project context - context only; the new goal below takes precedence`, retaining the `<earlier-runs>` wrapper. Dwight gets notes plus condensed own turns (scaled with his brief budget, at most twelve), no memory, sibling chats or replies. Every task/bug-report/feedback message includes it under `## Conversation so far (context only; your task is the milestone above)` in `<conversation-context>` tags, including retries and `--no-plan`. Gate prompts get nothing new. Empty context leaves existing prompts unchanged. Pipeline uses the optional history `context` key and planner-only `conversation_context` block described in [PIPELINE.md](PIPELINE.md#cross-run-continuity).

```text
scranton context show    --data DIR --project ID [--chat ID] [--model PROVIDER/MODEL] [--json]
scranton context budget  --data DIR --project ID (--percent N | --tokens N | --default) [--model PROVIDER/MODEL]
scranton context notes   --data DIR --project ID (--file FILE | --clear)
scranton context share   --data DIR --project ID on|off
scranton context reset   --data DIR --project ID --chat ID
scranton context restore --data DIR --project ID --chat ID
```

`context budget` sets the project rule without `--model`, or that model's override with it; `--default` removes the selected rule/override and prints resulting settings. `context show --chat` uses Michael/Dwight's configured models for Team; `--model` supplies the Pipeline planner pick and is ignored for Team. Its line is `Budget: ≈<used>/<tokens> tokens (<pct>% of budget, <pct>% of the <window>-token window of <id or "Automatic">)`, with `[window assumed]` when unknown and `[capped: <capped>]` when limited. Developer brief uses the same line starting `Developer brief:`; notes show `notes: <chars>/16000 chars`. JSON output is the v2 document; notes files may be at most 65536 bytes.

Registry CLI `scranton run --project ID` (or `--chat`) requires explicit `--data DIR` or inherited `SCRANTON_DATA`, before loading workspace settings. Workspace `.env`/`scranton.config.json` cannot select the registry; there is no implicit default for runs. Refusal names `--data` and prints a complete command with the quoted default data directory used by `scranton projects` (`APPDATA/dev.scranton.desktop`, or `~/.local/share/dev.scranton.desktop`). `scranton projects list` includes the directory it read as `dataDir` in its JSON output. Explicit registry runs retain the `Project: <id>; chat: <id>; continue: ...` line.

Team requests remain at most 32768 JS string characters. Up to 4000 chars retain argv transport; longer requests are written atomically to `<hive>/control/request.json` as exactly `{ "v": 1, "request": string }`, passed with `--request-file FILE` instead of a positional request. The server deletes `request.json` when the child exits or fails to spawn, and removes a stale file before a run whose request travels in argv. Both control files are read by the CLI as bounded regular files after canonicalising the file's directory (`thread.js` for context; the identity-checked BOM-aware request reader in `cli.js` for request files): a data path through a junction or symlinked directory is allowed, but each file itself must be regular and nonlinked. The CLI also accepts literal text with `--request-file FILE`: UTF-8 with an optional BOM (dropped), or UTF-16 LE/BE detected by its BOM; invalid text in that encoding is rejected. If the first non-whitespace character is `{`, the content must be exactly the strict v1 envelope (no extra keys); malformed JSON is rejected, not treated as text. Otherwise arrays/scalars and other content remain literal text, minus exactly one final LF/CRLF/CR. The CLI never deletes the file. All request files must be regular, neither symlinks nor hardlinks, and at most 262144 bytes; requests must be non-blank and at most 32768 JS string characters, just like positional input. Every file rejection exits 2 with `Invalid request file` plus a short reason (`not found`, `not a regular file`, `a link`, `too large`, `not valid text`, `starts with { but is not a request envelope`, `empty`, `longer than 32768 characters`; unsafe/changed reads also fail closed). Positional-plus-file input is a usage error. Messages to running agents and HITL feedback are at most 16000 characters each. Pipeline tasks remain 32768 UTF-8 bytes and gate comments remain 4000 characters (argv transport).

### Restore points and undo (Registry only)

These routes have the same loopback/Host/Origin/client-header protections and JSON object/body limits as the context routes above. `P = /api/projects/:p/chats/:c`. They do not exist in Single mode and have no unscoped aliases.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `P/restore-points` | — | `200 { "points": [{ "runId":string, "createdAt":string, "files":number, "undoneAt":string|null, "remaining":number, "undone":number, "unrestorable":number }] }`, newest first |
| POST | `P/undo` | `{ "runId"?:string, "force"?:boolean }`, no other fields | `200 { "runId":string, "restored":string[], "removed":string[], "conflicts":[{ "path":string, "reason":string, "code":"changed"|"unrestorable"|"blocked" }], "warnings":string[] }` |

Omitted runId selects the newest open point, or, if none is open, the newest point not yet timestamped as settled (reporting its unrestorable conflicts and settling it); an explicitly selected settled point still reports its unrestorable files (restored/removed stay empty). IDs match `[A-Za-z0-9_-]{1,128}`. Empty histories (including Pipeline chats) return `{points:[]}`; undo without a point returns exactly `404 {"error":"No restore point available"}`. Undo holds this hive's run lease (mode `undo`, with heartbeat) throughout selection, workspace locking and writes, releasing it on every outcome. A competing run receives `An undo is running in this chat; wait for it to finish or recover it before starting a run.` Interrupted undo recovery releases only lease/heartbeat (§6), preserving per-file bookkeeping and the real last run. It checks caller-supplied sibling hives before and after taking the workspace lock, but does not lease siblings: a sibling run can start during undo. Registry callers supply all other chats' hives of the project; direct `--hive` has no sibling discovery. The following 409 `{error}` sentences distinguish refusals, even with force: `A run is active in this chat; stop it before undo.`, `A run is active in another chat of this project; stop or recover it before undo.`, `This chat needs recovery before undo.`, `An undo is already running in this chat.`, `Cannot force undo while newer restore point <id> is unreadable.`, and `Newer runs must be undone first: <run ids>. A run stays open while files changed after it are kept; force its undo or leave both.` The last rule applies within one hive, with or without explicit runId. Invalid/extra fields or malformed JSON return 400; authorization/content-type/size failures retain 403/415/413. Unknown scopes/methods are 404. Other internal errors retain sanitized 500 responses. Conflicts are a successful HTTP operation (200), not a 409: `changed` means the file no longer matches what the run wrote (no attribution to a user or another chat); force can overwrite it. `unrestorable` means a missing or unusable pre-image (not an independent regular file, size limit, or size/SHA-256 mismatch); force cannot help. Transient backup read failures (including EBUSY/EACCES or a changed artifact identity) are `blocked`, not persisted as unrestorable, and retried by the next undo. `blocked` means a retryable access/write failure or unsafe path state; the reason includes the error code when present, otherwise a safe guard cause (hardlink, non-regular file, link, unsafe parent or manifest limit), without file contents or absolute paths outside the workspace. Repair the path/access or close programs using the file and undo again; force does not bypass it. Kept `changed` and `blocked` files keep a partial point open (`undoneAt:null`, counted in `remaining`) as the default to continue. An open file is restorable, not undone and not marked `undoUnrestorable`; `remaining` counts exactly these files. A point is settled when `undoneAt` is set OR no file is open, even if the final timestamp save was interrupted; explicit undo writes the missing timestamp. Listing, default selection and reverse-order checks use this definition; unrestorable files remain in conflicts on explicit retries. A created directory that cannot be removed adds a warning such as `Cannot safely remove directory: nested (EBUSY).`, never keeps the point open, and is not a file conflict. Only actually changed paths are reported in restored/removed. A rolled-back first integration removes its empty point.

Team worktree integration (host and Docker) retains pre-run bytes of integrated paths in `<hive>/restore-points/<runId>/manifest.json` and `preimages/<sha256>`, newest ten points only. Original files over 16 MiB are not backed up and produce non-restorable conflicts. Shared/direct workspace execution, standalone agents and Pipeline chats are not covered. Undo is per-path, retryable after a partial conflict, and does not reset the Git index/history or unrelated files. These artifacts may contain sensitive original file content.

CLI: `scranton undo [--hive DIR | --data DIR --project ID --chat ID] [--run ID] [--force] [--list]` uses the same Hive resolution as recover. Without `--run`, undo selects the newest run that still has files to undo. List prints run ID, time, total file count and remaining count, distinguishing files still to undo, partly undone (x of y), undone, and nothing can be undone (no backup for n files); missing backups are mentioned in every applicable state. GET also supplies `undone` (files already put back or removed by undo) and `unrestorable` (files not restorable or marked `undoUnrestorable`); `files` remains the total and `remaining` counts only open files. Unreadable entries have `{runId,unreadable:true,createdAt:null,files:null,undoneAt:null,remaining:null}` in the GET result; core also retains `workspace` (null for unreadable entries). They are listed as unreadable, never selected for undo, and left alone by pruning; normal undo of readable points remains usable. Force is refused if an unreadable entry's directory mtime is newer than the selected point's createdAt; the refusal names the entry. Undo prints restored/removed paths, warnings and each conflict reason; changed-after-run conflicts name the exact `--force` retry, while `blocked` files print as `Blocked: <path>: <reason>.` without suggesting force. Exit 0 for success/list, 1 for conflicts or operational errors (including no point/busy/recovery), 2 for invalid arguments. If no file could be undone and all conflicts are unrestorable, CLI prints `Nothing could be undone: no backup for n files.` plus each reason. The run summary names `scranton undo --data <absolute-data> --project <projectId> --chat <chatId> --run <runId>` for Registry runs (retaining sibling-chat checks), or `scranton undo --hive <absolute-hive> --run <runId>` for standalone runs, with quoted directory paths, only for changed files with a point whose `remaining > 0`, and adds `Not restorable: n files have no backup.` when applicable (singular for one file). Every unguarded Team worktree run prints two preflight lines without executing Git or reading workspace Git configuration: `Workspace is inside a Git repository; existing files are the starting point (Git status is not inspected).` (or `No Git repository detected; existing files are the starting point.`), then `A restore point is kept for integrated changes; scranton undo restores the affected pre-run files (limits apply).` Detection only looks for a `.git` file/directory in the folder or its ancestors; core returns `dirty:null,untracked:null`. Direct modes warn that no restore point is kept; private standalone output remains private.

### Authority and limits

The current request wins; notes are subordinate standing preferences, this chat outranks siblings and newer turns outrank older ones. Rendering order is not budget priority: reserve the latest detailed turn, then notes within half the pack's unit budget (with a cut marker when needed), other recent own turns, condensed earlier own turns, sibling digests and finally memory. Other chats use left-over budget only. Full layer/read limits are in [README.md](../README.md#kontextsystem).

No approvals, completed steps/gates, check success, evidence IDs, checkpoints, sessions or execution state carry over. Fresh workspace/reads/checks/approvals remain required. Redaction is best effort; private absolute paths and proof-like references are masked or dropped and context delimiters are neutralized. Team “Files touched” comes from journaled Dwight write/edit tool events, not a delivery proof. Corrupt, oversized or linked artifacts degrade individually; unexpected pack errors fall back to the legacy result rather than prevent a run start. Condensation is deterministic, not a model-written summary; token estimates do not establish real-model quality.

## Durable agent streams and tool approvals

These are separate from the Contract-v1 `/events` journal and from HITL plan/circuit-breaker decisions. Authoritative wire details: [AGENT-ROUTES.md](../src/server/AGENT-ROUTES.md), [run options](../.enma/run-options-contract.md), [workflow stream](../.enma/agent-stream-contract.md).

- `GET /api/runs/:runId/agents/:instanceId/stream`; Registry: `GET /api/projects/:p/chats/:c/runs/:runId/agents/:instanceId/stream`. Same loopback/Host/client-header/Origin guards apply, including single mode. SSE `id:N`, `event:chunk`, `data:<stream JSON>`; `event:end` contains terminal status. Ping every 15 s. Query `fromOffset=N` is inclusive; `Last-Event-ID:N` resumes after N and wins over query. Numeric cursors span instance invocations in creation order. Readers must discard earlier chunks for a step on every `attempt_start`, including same-number recovery attempts. Backpressure/disconnect closes the read-only durable client. Lost run owner can end with interrupted without modifying the workflow.
- `GET|POST /api/approvals`; Registry: `/api/projects/:p/chats/:c/approvals`. GET returns pending unexpired `waiting_approval` checkpoints: `{approvals:[{workflowId,runId,instanceId,agent,step,callId,tool,args,timeoutSeconds,deadline}]}`. POST accepts `{workflowId,callId,approved:boolean,grant?:"read"|"write"}`, resolves the current step and uses `approveToolCall`: 202 accepted, 404 absent/foreign, 409 expired, usual 400/403/413/415 protections. First verdict for workflow/step/call wins; stale replies do not extend deadlines. Disabled single-hive control refuses POST.
- For `request_access`, the workflow pauses durably in `waiting_approval` using the same tool-approval machinery. The optional decision `grant` may narrow a requested write to read; `write` is allowed only when write was requested. Without `grant`, approval uses the requested mode. The card shows agent, path, mode and reason as plain text, with write/undo and protected-path warnings. The approval record adds `protected` (`null`, `credentials` or `scranton-state`) and `warning` (string or null). Offer Allow read, Allow write for a write request unless `protected` is `scranton-state`, and Deny. Denial or timeout returns "denied by the human" and the agent continues. Grants apply to all instances of this run from their next tool call; no later run inherits them. These approvals are distinct from breaker HITL and Pipeline gates.
- CLI: `--sandbox scranton|docker|host`, `--sandbox-network allow|none`, `--approve write,edit`, `--approval-timeout 600`; `scranton watch <workflowId>` and `scranton approve <workflowId> <callId> --yes|--no`, with `--hive DIR` or `--data DIR --project ID --chat ID`. Configured tool approvals are opt-in in `ask`; path access follows the policy above, including protected-path clicks in every mode. Timeout/denial becomes a model-visible tool error. Render arguments/text as untrusted text.

SQLite defaults to `<hive>/dbos.sqlite` per chat plus `agent-step-markers`; real DBOS uses only `DBOS_SYSTEM_DATABASE_URL` / `DBOS_DATABASE_URL`, never generic `DATABASE_URL`. Keep database and markers together. Durable reasoning is sensitive and must never enter Contract-v1 events/state. Terminal workflow status is authoritative; agent_state can remain nonterminal after cancellation. Stable invocation keys permit explicit reattachment, not automatic whole-run recovery.

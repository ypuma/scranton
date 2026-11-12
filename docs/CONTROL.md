# Control API v1 - starting runs and answering the human from a UI

Extends Contract v1 (docs/EVENTS.md). Used by the web dashboard and the Tauri desktop app.
Die bisherigen unscoped Reads bleiben im Single-Modus erhalten; Registry-/Scoped-Routen und deren zusätzlicher GET-Zugriffsschutz sind in Abschnitt 8 beschrieben.

## 1. File-based human answers (the Hive stays the communication layer)

New `--on-breaker hive` policy for `scranton run` / `scranton demo` (any pause: breaker trip, [BLOCKED], pi infrastructure failure):
- The orchestrator emits `hitl_request` as today, then waits for `hive/human/response.json`, polling every 250 ms (no timeout).
- Response file (written atomically: temp file + rename; anyone may write it - the server, a script, a human):
  `{ "v": 1, "runId": string, "requestSeq": number, "decision": "feedback" | "retry" | "skip" | "abort", "feedback"?: string, "ts": "<ISO>" }`
  `requestSeq` = the `seq` of the `hitl_request` being answered. `feedback` is required (non-empty, max 8000 chars) when decision is "feedback".
- The orchestrator accepts it only if runId and requestSeq match the open request and decision is one of that request's options; then it moves the file to `hive/human/archive/response-<runId>-<requestSeq>.json` and continues exactly as with a terminal answer (same events: `hitl_response`, resets, `hive_write(human->dwight, feedback)` ...). A non-matching or invalid file is moved to `hive/human/archive/rejected-<ts>.json` with a `log` warn.
- While waiting, transient EBUSY/EPERM/EACCES reads are retried rather than rejected; malformed JSON younger than 1 s is retried to allow an in-progress write to complete. Older malformed files are rejected.
- A stale response.json present when the request opens is rejected the same way (never auto-applied).
- `ask` with a TTY still prompts in the terminal; `hive` never prompts. Configuration: `onBreaker` / `SCRANTON_ON_BREAKER`, with flags > env > config > default `ask`.
- `ts` must be an ISO timestamp; `v` must be 1. Optional feedback must be a string of at most 8000 characters for every decision.

## 2. Stop request

`hive/control/stop.json` `{ "v": 1, "runId": string, "ts": "<ISO>" }`. While a run is active (including while a pi child runs and while waiting for a human) the orchestrator polls it every 250 ms; on a match it behaves like Ctrl+C (kills the active pi process tree, `run_finished` aborted, exit 130) and deletes the file. Non-matching files are deleted with a `log` warn.

## 3. HTTP control routes (server)

Enabled only when the server is started with `control: { workspace, runner? }` (`startVisualizerServer({ ..., control: { workspace, runner } })`, CLI `scranton visualize --control` and `scranton app-server`). Ohne Steuerung sind Run-/HITL-/Chat-/Stop-POSTs im Single-Modus nicht verfügbar; `GET /api/control` liefert `{ "v": 1, "enabled": false }`. Die neuen Projekt-/Scoped-Reads stehen unabhängig davon bereit (Abschnitt 8). Registry-Betrieb per CLI aktiviert die Steuerung automatisch.

All control routes (including `GET /api/control`) require a loopback TCP peer (`req.socket.remoteAddress`: 127.0.0.0/8, ::1 or IPv4-mapped ::ffff:127.x.x.x) and a local Host header. A forged Host never authorizes a remote peer. The CLI refuses `visualize --control` with a non-loopback `--host` (exit 2); programmatic servers enforce peer checks even on wildcard binds. Request rules for every POST: the existing Host check; `Content-Type: application/json`; header `X-Scranton-Client: 1`; if an `Origin` header is present it must equal the server's own origin (`http://<allowed host>:<port>`); body <= 64 KB; otherwise 403/415/413. No CORS headers are ever sent. Control routes always require a local Host, even on a non-loopback programmatic bind. Origin compares against that allowed Host hostname and the actual listening port. Stop POSTs send `{}`.

- `GET /api/control` -> `{ "v": 1, "enabled": true, "workspace": string (default workspace, absolute), "scenarios": ["happy","flaky","breaker","blocked","changes_once","security_issues","question"], "run": null | { "pid": number, "mode": "run" | "demo", "request": string, "workspace": string, "startedAt": "<ISO>", "runId": string | null, "exitCode": null }, "lastExit": null | { "mode", "request", "exitCode": number, "finishedAt": "<ISO>", "outputTail": string (last ~4 KB of the child's stdout+stderr, ANSI stripped) }, "pendingHuman": null | { "runId", "requestSeq", "milestoneId", "reason", "options": [] } }`
  (`pendingHuman` = the last `hitl_request` of the current run in events.jsonl with no later `hitl_response`, only while a child run is alive.)
- `POST /api/runs` `{ "request": string (1-4000 chars, required unless demo), "workspace"?: string (absolute; default = control workspace; created if missing), "demo"?: { "scenario": one of scenarios, "delayMs"?: 0-5000 }, "maxCycles"?: 1-10, "noPlan"?: boolean, "conversation"?: boolean }` -> `202 { "ok": true, "pid" }`; `409 { "error" }` if a child run is alive; `400 { "error" }` on validation failure.
  The server spawns `process.execPath <repo>/bin/scranton.js run|demo ... --hive <hiveDir> --workspace <ws> --on-breaker hive` (argv array, never a shell; request text as a single argv element), env inherited, cwd = repo root, stdout/stderr captured (tail kept for lastExit), windowsHide true.
- `POST /api/hitl` `{ "decision", "feedback"? }` -> writes hive/human/response.json for the current `pendingHuman` (fills runId/requestSeq itself) -> `202 { "ok": true }`; `409` if nothing is pending; `400` on validation failure.
- `POST /api/runs/stop` -> writes hive/control/stop.json for the alive run's runId -> `202`; if the child has not exited 15 s later the server kills its process tree (Windows `taskkill /pid <pid> /T /F`). Repeated stop requests preserve the first kill deadline; server close may shorten it to 5 s. Heartbeat/stop polling ends on child exit, and any leftover stop.json belonging to that runId is removed. `409` if no run is alive.
- On server `close()` an alive child run is stopped the same way (stop file, then kill after 5 s) before close resolves.

HTML responses use a strict same-origin Content-Security-Policy (no inline scripts/styles, no objects, base URLs or framing), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The UI uses external scripts/styles and CSSOM style properties.

`runner` has the Node `spawn(executable, argv, options)` interface and returns a ChildProcess-compatible object (pid, stdout/stderr streams, error/close events).

## 4. App server (used by the Tauri shell)

`scranton app-server [--port N (default 0)] [--data DIR | --hive DIR --workspace DIR]` starts the server with control enabled on 127.0.0.1, then prints exactly one line to stdout: `{"ready":true,"url":"http://127.0.0.1:<port>","pid":<pid>,"hive":"<abs>","workspace":"<abs>"}`. Die Ready-Felder `hive` und `workspace` sind auch im Registry-Modus nur die CLI-Konfigurationswerte, keine Auswahl eines Threads; Projekte/Chats über `/api/projects` abfragen. It exits cleanly (closing the server, stopping active child runs) on SIGINT/SIGTERM, on stdin EOF (the parent died) and on a line `quit` on stdin.

## 5. Desktop app (Tauri v2, `src-tauri/`)

- Bundles node.exe (sidecar) + the app files + production node_modules (pi). No Node install needed on the target machine.
- Beim Start: `node <resources>/bin/scranton.js app-server --data <appData> --legacy-workspace <documents>/Scranton/workspace`; die Hülle liest die Ready-Zeile und navigiert zur URL. Legacy-Hive-Import nur durch Referenz, siehe Abschnitt 8. Beim Beenden schreibt sie `quit` nach stdin und beendet nach 5 s nötigenfalls den Prozessbaum.
- Web UI detects the shell via `window.__TAURI__` and then uses native notifications (plugin-notification) for: human needed (`hitl_request`), run finished. In a plain browser it uses the Notification API if the user allowed it.
- Tray icon: Show / Hide, "Human needed" badge text in the tooltip, Quit.

### New project folder picker

In the desktop app, **New project → Browse...** uses the existing Tauri dialog plugin through `globalThis.__TAURI__.core.invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: 'Choose project folder' } })`; an optional `defaultPath` string may be included inside `options`. The result is one absolute path string or `null` on cancellation. Selection only fills the editable workspace field; cancellation leaves it unchanged. Creating the project still submits the existing `POST /api/projects`, whose workspace validation (§8) remains authoritative. Empty workspace retains the default-project-folder behavior.

A plain browser has no native picker: enter an absolute path manually. There is no HTTP endpoint for host dialogs or server filesystem browsing.

The separate `dashboard-folder-picker` capability grants only `dialog:allow-open`, only to window `main` on `http://127.0.0.1:*` and `http://localhost:*`, with local content disabled. No dialog default/save/message, filesystem or shell permissions are granted. In the installed dialog plugin 2.8.4, `allow-open` has no option-level scope: it can open file as well as directory dialogs; `directory:true` is a UI request, not an ACL restriction. The plugin updates its internal selected-path scopes, but this capability exposes no filesystem commands. The bridge and response shape are verified against the installed plugin's `src/commands.rs` (`OpenDialogOptions`, `OpenResponse`, `open`) and `permissions/autogenerated/commands/open.toml`.

## 6. Parallel execution, direct chat and durable ownership (additive)

The existing security checks and 64 KiB body limit apply unchanged to these additions.

- `POST /api/runs` additionally accepts `maxParallel` (integer 1–32), `sandbox` (`docker` or `host`), `sandboxImage` (image reference), `sandboxNetwork` (`bridge` or `none`) and `trustedHost` (boolean). `sandbox:"host"` requires `trustedHost:true`; `trustedHost:true` conflicts with explicit `sandbox:"docker"`. These map to `--parallel`, `--trusted-host`, `--sandbox`, `--sandbox-image`, `--sandbox-network`. Omitted settings follow configuration/defaults: 3 pipelines, worktrees, Docker, `scranton-sandbox:1.5.0-r2`, bridge, persistent sessions. Demo uses simulated trusted-host fake RPC, not a real container boundary.
- `GET /api/control` adds `defaults.execution`, `instances` (current matching run's state instances, otherwise `{}`), `recoveryRequired` and `orphan: null | {runId,startedAt,owner,heartbeatAt,stopRequestedAt,recoveryError}`. `lastExit` includes `runId` and `startedAt` for explicit correlation, not timestamp guessing. No automatic orphan resumption is promised.
- `POST /api/chat` body `{ "runId": string, "to": string, "text": string }` requires the active matching run and a known nonterminal exact instance ID. Human text must be nonblank and at most 4000 characters; recipient syntax is a lowercase letter followed by up to 63 lowercase letters/digits/hyphens. Unknown/terminal recipients and inactive/mismatched runs return 409; invalid inputs return 400; a queue of 1000 command files returns 429.
- Accepted chat returns `202 { "ok": true, "id": "<uuid>", "delivery": "queued" }`. It atomically writes `hive/control/chat/<id>.json` with `{v:1,id,runId,from:"human",to,text,ts}`. The orchestrator consumes this command and publishes `chat_message`/`chat_delivery`; HTTP acceptance must never be described as delivery. Sender identity is not supplied by the client. There is no standalone CLI `message` command.
- The managed Pi extension `tools/pi-agent-chat.js` exposes `agent_chat({to,text})`. Runtime derives the sender/run and routes to the exact instance; `queued` means not yet sent, `delivered` means a positive live RPC ACK, `rejected` means definitive refusal, and `unknown` means acceptance could not be determined. RPC command ACKs have a 5 s budget, broker replies 10 s, and extension UI replies 15 s. Timeout/cancellation after a possible send is not rejection. Attempted uncertain messages are journaled/emitted as `unknown`, return `ok:false` with an error, and are never automatically resent on detach/reattach or a later invocation. Completion rejects only never-sent queues; an in-flight message without an ACK becomes unknown. Even a runtime ACK does not prove the model has processed the content. Per-instance persistent sessions survive retries, not necessarily application crashes.
- Human questions are serialized: only the head request can be answered through `human/response.json`; independent pipelines may continue. Clients must use the current pending request, not answer a queued request speculatively. Stop/abort applies to every active pipeline.

The durable lease is **`hive/control/owner.json`**, not `lease.json`. Server-launched run and demo processes receive a generated `SCRANTON_RUN_ID`, piped stdin/stdout/stderr plus a Node IPC channel, `SCRANTON_PARENT_GUARD=1` and the lease token in `SCRANTON_RUN_LEASE`. Before CLI parsing/configuration, `registerParentStartup` registers the startup protocol. All pre-work exits send token-authenticated `scranton-startup-refused`; before work the CLI awaits `scranton-startup-begun`, and `guardParent` sends `scranton-guard-registered`. After child close, the server can release a pre-work lease only for a matching refusal with no begun/guard registration (spawn failure before a PID is also safe to release). Missing/ambiguous registration retains ownership. Stdin EOF/error/close or lost heartbeat aborts the guarded run; IPC carries startup lifecycle messages, not chat. Standalone Hive writers also acquire ownership. Cleanup must finish before ownership is released; unresolved cleanup deliberately blocks a second run, including after a server restart. Stop can queue a stop file for an orphan's run ID without blindly killing an old stored PID. The owning CLI/demo process atomically writes `control/heartbeat.json` `{v:1,runId,pid,at:"<ISO>"}` immediately and every 5 s, including human waits; clean lease release removes it. This is separate from the server-to-child stdin watchdog. If cleanup remains unresolved, the CLI stops heartbeating and rewrites the heartbeat with `cleanup:"unresolved"` and `reason:string`; this always means `unknown`, even for a dead PID, with `orphan.recoveryError` = `Cleanup of this run could not be verified: <reason>`. Automatic recovery never releases it. If the initial heartbeat write fails, the CLI releases its newly acquired lease. Otherwise owner status is checked in order: absent/mismatched heartbeat → `unknown`; heartbeat PID proven absent (ESRCH) → `gone`; running PID (including EPERM) with a heartbeat no older than 30 s → `alive`; otherwise → `unknown`. Stale PID reuse never proves liveness. The lease shape and startup/guard protocol are unchanged.

A server automatically recovers a `gone` orphan only when cleanup is verified (no Docker usage, or all matching containers confirmed removed), with summary `Interrupted: the run's process ended without finishing`. It removes matching Scranton Docker containers using run labels (legacy containers require an exact recorded worktree mount), clears the pending human question through normal aborted completion, and writes `run_finished {status:"aborted",summary}` through the event recorder. The journal/state remain current and are archived normally when the next run starts. Ownership, heartbeat and stop files are removed only after successful recovery. Unreachable Docker or unverified removal retains the lease and exposes the reason in `orphan.recoveryError`, even if `run_finished` already exists. Worktrees/sessions remain available for diagnosis. Recovery runs in the background per chat; other chats do not wait for its Docker calls. Registry recovery discovery is throttled to once per second; live/deletion guards still read current ownership. Empty recovery locks, locks with a proven-dead PID, or locks older than five minutes are reclaimed (not the run lease itself). If the journal contains no events for this run, recovery archives the previous journal through the normal start path and emits `run_started` from the lease's request/workspace with `roles:[]`, followed by `run_finished`. Mixed matching-run journals or invalid sequences still fail closed.

`POST /api/runs/release` takes only `{runId}` with the same loopback/Host/client/origin/JSON/64 KiB protections as Stop. No orphan or mismatched run ID returns 409 `{error}`; an `alive` owner returns 409 `{error:"The run is still running. Request a stop instead."}`. Otherwise the same recovery records summary `Released by the user`, returning 200 `{ok:true,warnings:string[]}`. During automatic recovery it returns 409 `{error:"Recovery is already in progress. Try again in a moment."}`. Conflict responses never set `recoveryError`; that field comes only from recovery attempts and clears on success or orphan replacement. For explicit manual Release only, unreachable Docker does not block release and adds exactly `Docker is not reachable; containers of this run could not be checked` to `warnings`; removal errors also become warnings. Warnings are appended to a newly emitted finish summary; if a finish already exists, it is preserved and warnings are still returned in the HTTP response. Other recovery/ownership failures retain the lease. No stored PID is killed. For `unknown`, release only after independently confirming the run has stopped: releasing an actually live unknown owner allows two runs to share the chat. Age alone is not authorization.

Docker is an explicit prerequisite, with no automatic image build/pull or silent host fallback. Trusted-host is not OS isolation and bridge is not blocked egress. See [ISOLATION.md](ISOLATION.md). The published DAG is immutable: dynamic replanning is unsupported and effective `maxReplans` is 0 (nonzero configuration warns). Shared isolation requires one host pipeline; shared+Docker is rejected and shared instance worktree metadata is null. Deterministic API/protocol tests do not establish real Docker/model behavior or native lifecycle correctness; validate those separately against the release artifact.

## 7. Anmeldung, API-Keys, eigene Provider und Modelle

Diese Routen sind nur mit aktivierter Steuerung verfügbar; ohne sie oder bei falscher HTTP-Methode antworten sie mit 404. Auch alle drei GETs verlangen Loopback-Peer, lokalen Host, `X-Scranton-Client: 1` und bei vorhandenem `Origin` den exakten Server-Ursprung. POSTs verlangen zusätzlich ein JSON-Objekt und höchstens 64 KiB. Fehlerantworten: `{ "error": string }`.

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

`/api/auth` liest nur Metadaten, ohne Refresh. Ein abgelaufener OAuth-Access-Token mit Refresh-Token bleibt `signed_in` mit `renewsOnUse:true`. Erst ein tatsächlich fehlgeschlagener Erneuerungsversuch liefert `expired` und `renewFailedAt`; erneuter Erfolg, Anmeldung oder Abmeldung löscht diese Fehlermetadaten. Immer enthalten sind `anthropic` (Claude), `openai` (ChatGPT), `google-antigravity` (Google Antigravity) und `google` (Gemini), außerdem gespeicherte Provider-Zugänge und Scranton-verwaltete eigene Provider. `methods` kann sowohl `oauth` als auch `api_key` enthalten oder leer sein; `kind` beschreibt den aktuellen Zugang. `google` (Gemini) unterstützt weiterhin API-Keys aus Google AI Studio; `google-antigravity` bietet ausschließlich OAuth über eine separate native Scranton-Providererweiterung für Pi 1.5.0. Die IDs und Store-Einträge sind unabhängig: Antigravity-Anmeldung oder -Abmeldung ersetzt bzw. löscht keinen vorhandenen Gemini-Key. Der Provider-Katalog unter `/api/auth/providers` liefert unterstützte Methoden der installierten Built-ins, der Antigravity-Erweiterung und verwalteten eigenen Provider, ohne `openai-codex`. Die OAuth-Route `/api/auth/login` akzeptiert `anthropic`, `openai` und `google-antigravity`; CLI-Aliase wie `gemini` werden in API-Bodies nicht verwendet.

`POST /api/auth/key` speichert einen literalen Key über Pis API-Key-Anmeldung in der gemeinsamen `auth.json`. Der Provider muss im Katalog `api_key` anbieten. Keys: maximal 4096 Zeichen vor dem Trimmen, danach nicht leer, kein eingebetteter Leerraum, keine Steuerzeichen und kein Präfix `!` oder `$`. Gespeicherte Keys haben Vorrang vor Umgebungsvariablen; Speichern ersetzt den bisherigen Zugang dieses Providers. `logout` entfernt auch gespeicherte API-Keys, aber keine Umgebungsvariablen; es akzeptiert bekannte Provider sowie IDs mit vorhandenem Store-Eintrag. Parallele Credential-Operationen können 409 liefern.

### Eigene Provider und Discovery

Die vier neuen POSTs (`/api/auth/key`, `/api/providers`, `/api/providers/discover`, `/api/providers/remove`) weisen zusätzliche Body-Felder mit 400 ab. `api` muss einer der oben genannten API-Typen sein. Basis-URLs verlangen HTTPS (HTTP nur für `localhost`, `127.0.0.1`, `[::1]`), ohne Zugangsdaten, Query oder Fragment; abschließende Slashes werden entfernt. Schlüssel dürfen nicht Teil der Provider-Metadaten sein.

- **Discovery:** Der Server fragt `<baseUrl>/models` mit `Authorization: Bearer <key>` ab. Nur Weiterleitungen desselben Ursprungs (Schema, Host, Port) sind erlaubt, höchstens drei; Zeitlimit 10 s einschließlich Body, Antwort maximal 1 MiB. Erwartet wird `{ data: [{ id, contextWindow?, maxTokens? }] }` mit höchstens 256 Einträgen. Zurück kommen nur IDs und vorhandene positive ganzzahlige Tokenlimits, niemals Keys oder die rohe Provider-Antwort. Beispiel: `https://api.abliteration.ai/v1` → `/v1/models`. Discovery speichert nichts und wird beim Hinzufügen deklarierter Modelle nicht automatisch ausgeführt.
- **Hinzufügen:** ID gemäß `^[a-z][a-z0-9-]{1,31}$`, keine Built-in-ID; optionales Label (Standard: ID) nicht leer, höchstens 120 Zeichen, ohne Steuerzeichen. `models` enthält 1–256 eindeutige IDs (je 1–256 Zeichen, kein Leerraum/Steuerzeichen); `contextWindow`/`maxTokens` sind positive sichere Ganzzahlen, `reasoning` ist boolean, `input` eine nicht leere Liste aus `text`/`image`. Unbekannte Modellfelder werden abgewiesen. Die Definition erhält `authHeader:true`, keinen `apiKey`; der Key wird separat über Pi gespeichert und der Katalog neu geladen.
- **Entfernen:** Nur unverändert von Scranton angelegte Definitionen samt gespeichertem Zugang werden gelöscht. Fremde, bereits vorhandene Provider können nicht überschrieben werden; zum Ersetzen einen verwalteten Provider zuerst entfernen.

Scranton schreibt in die echte Pi-`models.json` neben `auth.json` (Standard `%USERPROFILE%\.pi\agent`, Override `PI_CODING_AGENT_DIR`), hält vor dem ersten Überschreiben einer vorhandenen Datei einmalig `models.json.scranton-bak` und verwaltet Definitions-Digests in `scranton-providers.json`. Keine Keys in diesen Dateien. Ungültiges JSON, JSON mit Kommentaren oder eine fehlende/nicht objektförmige `providers`-Struktur werden nicht überschrieben. Scranton-Schreiber verwenden einen Verzeichnis-Lock (10 s Wartezeit); externe Editoren nehmen daran nicht teil. Models und Registry werden einzeln atomar geschrieben, nicht als dateiübergreifende Transaktion.

Fehler für diese Erweiterungen: 400 bei Validierung, 409 bei Konflikten/unverwalteten oder extern geänderten Einträgen/defekter Provider-Konfiguration, 502 bei fehlgeschlagener Discovery; interne Fehler liefern bereinigte 500-Antworten. Die allgemeinen 403/413/415-Regeln gelten weiterhin. Ein angezeigter Key-Status bestätigt keinen erfolgreichen Provider-Request.

### Modellwahl und OAuth-Lifecycle

`/api/models` liefert den Pi-Katalog für Anbieter mit Zugangsdaten (Abo oder Key), einschließlich des begrenzten Gemini-Katalogs der Antigravity-Erweiterung; `openai-codex` wird ausgelassen. `signedIn` ist kein Nachweis eines erfolgreichen Modellrequests. Ein Katalogeintrag bestätigt insbesondere keine Modellberechtigung des Abos; eine Anbieterablehnung erscheint als erste Fehlerzeile auf der Agentenkarte und vollständig im Fehlerlog. Der Server öffnet ausschließlich die vom Anbieter gelieferte, geprüfte HTTPS-Adresse im Systembrowser (`claude.ai`, `auth.openai.com` bzw. `accounts.google.com`), nicht eine vom Client übergebene URL.

**Google Antigravity** ist eine inoffizielle Drittclient-Anbindung, keine Zusage kostenloser Quotas, bestimmter Entitlements oder garantierter Modellverfügbarkeit. OAuth verwendet PKCE (S256) und State-Prüfung. Der Loopback-Callback ist `http://localhost:51121/oauth-callback`; alternativ wird die vollständige Redirect-URL mit passendem State erwartet, kein isolierter Code. Das Projekt wird vom Google-Dienst ermittelt (Projektauflösung der Providererweiterung), nicht erfunden oder aus einem Doku-Beispiel übernommen. Ohne zugewiesenes Projekt scheitert die Anmeldung mit einem Einrichtungshinweis. Credentials einschließlich Refreshdaten und Projektzuordnung liegen im normalen Pi-`auth.json`-Store. Scranton registriert den Provider nativ im ModelRuntime und lädt `src/core/antigravity/extension.js` bei dessen Pi-Kindprozessen ausdrücklich per `--extension`, auch für die Pipeline-Bridge. Die Accounts-Zeile hat nur **Sign in / Sign out**, kein **Add API key**.

Pro Auth-Service läuft eine Anmeldung, maximal zehn Minuten; eine weitere liefert 409, ein unbekannter Provider 400. `input.value` muss 1–4096 Zeichen enthalten und darf nicht nur aus Leerraum bestehen (Code oder vollständige Weiterleitungsadresse); falsche/nicht mehr wartende Session: 409. `cancel` erfordert die aktuelle Session-ID und bricht deren Anmeldung ab. `logout` entfernt nur diesen Provider-Eintrag im gemeinsamen Pi-Store, lässt Umgebungs-Keys bestehen und ist auch während eines Laufs erlaubt. Die UI fragt davor nach Bestätigung. Die Accounts-Seitenleiste pollt jede Sekunde, solange sie offen ist oder eine Anmeldung läuft; die letzte beendete Session kann weiterhin in `/api/auth` stehen.

`POST /api/auth/login/open` accepts only the session ID, never a URL. It reopens the active session's stored, validated sign-in URL; missing/stale/terminal sessions or sessions without a URL return 409, extra fields return 400. Browser launches are limited to one per 2 seconds per auth service (including the initial automatic launch); earlier retries return 429. Spawn failures return a sanitized 500. The same control POST hardening applies. Browser openers are detached and unref'd: successful spawn, not browser exit, completes opening. Login cancellation, timeout and server close never wait for the opener. Once Pi completes credential persistence successfully, a late cancellation cannot replace `done` with `cancelled`.

Credential-Metadaten und Docker-Credential-Auflösung wiederholen vorübergehende JSON-Parsefehler bis zu 250 ms; anhaltende Beschädigung bleibt ein Fehler. Für `google-antigravity` verwenden Team-Docker-Läufe einen authentifizierten Host-Inferenz-Broker. Google-OAuth-Refresh- und Accesscredentials bleiben ausschließlich auf dem Host; dieser erneuert sie bei Bedarf automatisch. Der Container erhält nur eine temporäre, auf erlaubte Modellaufrufe beschränkte Broker-Berechtigung pro Pi-/Sandbox-Aufruf, nicht gemeinsam für den gesamten Run. Modell-Streaming und Tool-Protokoll werden vermittelt; Werkzeuge werden weiterhin im Container ausgeführt, nicht als allgemeine Host-Befehle. Die Berechtigung ist zeitlich begrenzt; der Teardown schließt den Proxy und beendet offene Requests. Sie ist dennoch für den untrusted Agenten nutzbar: Solange sie gültig ist, kann er erlaubte Kontomodell-Quota verbrauchen. Das ist keine absolute Kontoisolation und kein allgemeiner Host-Zugang. Kein stiller Host-/Gemini-Key-Fallback. Die Pipeline-Modellbridge bleibt davon getrennt auf dem Host; ihre Checks können optional in Docker laufen. Für Claude/ChatGPT löst Docker weiterhin nur den explizit gewählten Provider der Rolle als kurzlebigen OAuth-Access-Token auf, API-Keys werden unverändert übergeben und sind für den Agenten lesbar. Built-ins benötigen ihren Standard-Env-Namen in `credentialEnvNames`; eigene Provider erhalten `SCRANTON_PROVIDER_<ID>_KEY` und eine schlüsselfreie read-only Modelldefinition. Docker verlangt vor dem Start für jede aktive Rolle einen expliziten Provider und ein Modell; fehlen diese auch in der Agentenkonfiguration, wird `pi default` mit HTTP 400 `{error:string}` abgewiesen. Dies gilt identisch für `POST /api/runs` und Follow-ups über `POST /api/projects/:p/chats/:c/runs`; kein Kindprozess, keine Lease und kein `run_started` entstehen. Bei `noPlan:true` entfällt nur Michael; Dwight und die gewählten Gates (eingebaute wie eigene) benötigen weiterhin einen Default. Die Oberfläche (New run und Follow-up) verwendet in Docker für jede aktive Rolle deren Agent-Default aus `GET /api/control` `defaults.models` (Agents-Dialog, `scranton.config.json` oder `SCRANTON_<ROLE>_PROVIDER`/`_MODEL`): Die Modellfelder zeigen `Agent default (provider/model)`, sind gesperrt, und der Request enthält kein `models`. Im Browser gespeicherte Modellwahlen (`scranton.models`) gelten nur für Trusted-Host-Läufe; sie werden in Docker weder gesendet noch gelöscht und erscheinen beim Zurückschalten auf den Host wieder. Fehlt einer aktiven Rolle (Dwight, Michael außer bei `noPlan:true`, die gewählten Gates einschließlich eigener) ein Default, startet die UI nicht, zeigt `No agent default` und verweist mit **Open Agents** auf den Agents-Dialog; es gibt keinen Ersatz durch eine gespeicherte Wahl, ein anderes Modell oder den Host. Nach dem Speichern im Agents-Dialog aktualisiert sich die Anzeige. Host-/Demo-Defaults bleiben unverändert; eine Demo bleibt gescriptet und sendet kein Modell. Ein expliziter unbekannter/nicht unterstützter Provider scheitert geschlossen. Details: [ISOLATION.md](ISOLATION.md).

`POST /api/runs` akzeptiert zusätzlich optional:

```ts
models?: {
  michael?: { provider: string; model: string; thinking?: Thinking };
  dwight?:  { provider: string; model: string; thinking?: Thinking };
  angela?:  { provider: string; model: string; thinking?: Thinking };
};
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

Auf dem Trusted Host müssen Provider und exakte Modell-ID gemeinsam im aktuellen `/api/models`-Katalog mit `signedIn:true` stehen. In Docker wird `models` nur der Form nach geprüft (Provider und Modell als Strings), ohne Katalogabgleich, und anschließend ignoriert: Jede aktive Rolle läuft mit ihrem aufgelösten Agent-Default. Unbekannte Rollen, zusätzliche Felder innerhalb einer Rollenwahl und ungültige Thinking-Werte werden in beiden Modi vor dem Start mit 400 abgewiesen. `{}` bzw. ausgelassene Rollen behalten die Agentenkonfiguration. Nur auf dem Trusted Host wird die Auswahl als `SCRANTON_<ROLE>_PROVIDER`, `_MODEL`, optional `_THINKING` in die Kindprozess-Umgebung gesetzt, ohne Konfigurationsdateien zu ändern; in Docker setzt der Server dafür keine Umgebungsvariablen. Erfolg bleibt `202 { ok:true, pid:number }`. **New run** speichert seine Modellauswahl lokal im Browser; die Demo verwendet keine Modelle.

**Betriebsgrenzen des Antigravity-Team-Docker-Brokers:** Nur lokale Engines sind unterstützt; ein entferntes `DOCKER_HOST` oder ein ausgewählter Remote-Docker-Kontext ist nicht unterstützt. Unter Windows/macOS bindet der Broker an Loopback, unter nativem Linux dagegen an das per Docker-Inspektion ermittelte IPv4-Gateway der Default-Bridge, **nicht an Loopback**; ohne gültiges Gateway scheitert der Start. Jede einzelne Inferenz hat eine Frist von **zehn Minuten**, unabhängig von der längeren Gültigkeit der Aufruf-Berechtigung. Der lokale HTTP-Transport ist nicht verschlüsselt und keine Egress-Firewall. Diese Brokergrenze ist von den Loopback-Regeln der Control-API oben zu unterscheiden.

Unter Windows Docker Desktop wurde dieser Pfad mit echten Containern und synthetischen Modellantworten geprüft. Natives Linux, macOS sowie Docker Desktop unter Linux und Rootless-Docker sind dafür nicht dynamisch verifiziert. Google-Antigravity-Login und Live-Modellaufrufe wurden nicht gegen ein echtes Konto geprüft; der Container-Nachweis belegt keine Google-Endpunktkompatibilität. Ein echter OAuth-Rundlauf wurde hier nicht getestet. Anbieterbedingungen und Nutzungslimits können Abo-Nutzung in Drittanbieter-Tools ändern oder einschränken; parallele Pipelines teilen die Limits eines Abos. Profil- und Docker-Token-Grenzen: [ISOLATION.md](ISOLATION.md); Anmeldung aus der App: [DESKTOP.md](DESKTOP.md).

## 8. Projekte, Chat-Threads und Run-Historie

Dieser Abschnitt ergänzt die bestehenden Single-Hive-Routen und beschreibt die Registry-Implementierung (`projects.js`, `registry-router.js`, `thread.js`). Ein Thread ist ein eigener Hive; `/chat` bleibt dagegen der direkte Instanz-Chat eines aktiven Runs.

### Modi und Zugriffsschutz

- **Registry:** `visualize --data DIR` oder `app-server --data DIR` (alternativ `SCRANTON_DATA`, Konfiguration `dataDir`). Die CLI aktiviert dabei die Steuerung auch ohne `--control`. `maxConcurrentRuns` / `SCRANTON_MAX_RUNS` begrenzt aktive Runs über alle registrierten Chats (Standard 4), unabhängig von `execution.maxParallel` pro Run. Verbliebene Leases zählen als belegt.
- **Single:** ohne Datenverzeichnis bleiben `--hive`/`--workspace` und die unscoped Routen bestehen. Die Projekt-API zeigt ein implizites Projekt `default` und einen Chat `default`; Verwaltungs-POSTs liefern `409 {error:"single_mode"}`. Dies betrifft auch Rename. Scoped Reads funktionieren auch ohne aktivierte Steuerung; Run-/Chat-/HITL-/Stop-POSTs benötigen einen Controller.
- **Alle** Registry-/Projekt-/Scoped-Routen, einschließlich GETs und SSE, verlangen Loopback-Peer, lokalen Host, `X-Scranton-Client: 1` und bei vorhandenem `Origin` den exakten Server-Ursprung. Das gilt im Registry-Modus auch für die unscoped Aliase `/events`, `/api/state`, `/api/runs`, `/api/chat`, `/api/hitl`, `/api/stop`, `/api/runs/stop`, `/api/control`. POSTs verlangen ein JSON-Objekt, `Content-Type: application/json` und maximal 65536 Byte. Keine CORS-Freigabe.
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

Run-Body vollständig: `{request?,workspace?,demo?,maxCycles?,noPlan?,maxParallel?,sandbox?,sandboxImage?,sandboxNetwork?,trustedHost?,models?,conversation?}` mit den bereits oben definierten Typen/Grenzen. Registry-`workspace` darf, falls gesetzt, nur der Projekt-Workspace sein; andernfalls `400 {error:"Workspace belongs to the project"}`. `request` ist außer bei Demo erforderlich. Andere Chats desselben Projekts dürfen parallel starten, nicht aber derselbe Chat. HTTP-202 bestätigt den Start/Spool-Auftrag, nicht den erfolgreichen Abschluss oder die Nachrichtenzustellung.

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

Vor dem nächsten servergestarteten Registry-Run werden frühere Ziele, Meilensteintitel/-status und Ergebnisse zusammengefasst: pro Run höchstens 1500 Zeichen Ergebnis-/Meilensteinzusammenfassung, zusätzlich höchstens 1500 Zeichen einer früheren Antwort (`Reply (<kind>): ...`), insgesamt höchstens 8000 Zeichen Thread-Kontext, neueste Runs bevorzugt. `<hive>/control/thread-context.json` enthält `{v:1,text:string}` und wird per `--thread-context` an den Kindprozess übergeben. Michael erhält diesen Kontext für die Planung, nicht als Anweisung zum Überschreiben des neuen Ziels. Die Registry-CLI berechnet ihn direkt. Es werden keine alten Pi-Prozesse fortgesetzt und keine vollständigen Transkripte zugesichert.

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

`defaults.workflow` in control snapshots is the effective workflow; `defaults.models` has all five role keys (`{provider,model}` or null). Run `models` accepts the same five IDs. On the trusted host they get the existing provider/model/thinking validation, catalog check included. In Docker, run `models` are ignored: the server still checks their structure (provider and model strings), but not against the catalog, and every active role runs on its agent default. Docker requires explicit models only for active roles: Dwight and all configured gates, plus Michael unless `noPlan:true`. This supersedes the fixed Dwight/Angela shorthand above.

Global control endpoints (single and registry modes):

| Route | Body | Success |
|---|---|---|
| `GET /api/agents` | none | `200 {roles:Role[],workflow:{default:[["oscar","hank"],["angela"]]}}` |
| `PUT /api/agents/:id/prompt` | `{text:string}` | `200 {ok:true}` |
| `DELETE /api/agents/:id/prompt` | none | `200 {ok:true}` |

Role: `{id,name,title,keywords,tools,gate,prompt:{source,text,editable,builtinText,missingKeywords}}`. Missing expected bracketed keywords are advisory only. PUT requires nonblank text, at most 32768 UTF-8 bytes; writes are atomic. Config-pinned prompts reject PUT/DELETE with 409. DELETE restores built-in fallback. Unknown IDs return 404. Without control these routes are 404; all require the same loopback peer/Host, exact Origin when present and `X-Scranton-Client: 1` checks. PUT additionally requires JSON and the existing body bound (oversize 413).

Resolution: explicit `agents.<id>.skill` configuration (not editable), then `<promptsDir>/<id>.md`, then built-in `agents/<id>/SKILL.md`. Single mode stores prompts in `<hive>/prompts`; registry mode in `<data>/prompts`, shared across all projects/chats. Prompt text is not logged. Each invocation stages only its resolved prompt at `<hive>/<instance>/system.md`; host Pi receives `--append-system-prompt`, Docker mounts that file read-only at `/scranton/prompt.md`, never the custom-prompt directory. Run events contain only source and SHA-256 audit hashes.

## 10. Custom agents and persistent agent settings

Available in both single and registry mode, globally rather than per chat. Every agent route requires enabled control, loopback peer/local Host, `X-Scranton-Client: 1` and the exact server Origin when supplied. POST/PATCH/PUT require JSON object bodies <=64 KiB before parsing. Wrong methods or disabled control return 404. Error bodies remain `{error:string}`.

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

`GET /api/control` defaults now include `agents:[{id,name,title,kind,builtin,gate,passKeyword?,failKeyword?}]` in catalog order, `thinkingLevels:["off","minimal","low","medium","high","xhigh","max"]`, and `models` with all registered IDs in the existing `{provider,model}|null` shape. Effective model/thinking precedence on the trusted host: per-run models > env > config > agents.json > Pi default. In Docker, per-run models are skipped: env > config > agents.json, with no Pi default fallback. `POST /api/runs` and `POST P/runs` accept registered custom gate IDs in workflow and registered custom IDs in models; on the trusted host explicit request models are catalog-checked as before, in Docker only structurally. Docker requires an agent default (provider+model) for every active role. Registry children receive the server settings/prompts directory, never workspace settings. Existing single-mode GET /api/control access rules are unchanged.

Gate tool configuration is deliberately restricted on every `loadConfig`, including `visualize`: `agents.oscar.tools`, `agents.hank.tools`, `agents.angela.tools` and custom `agents.<id>.tools` must be nonempty read-only allowlists (read, grep, find, ls, bash; Windows powershell fallback). Invalid built-in overrides fail with a ConfigError naming `agents.<id>.tools`; existing write/edit overrides must be removed. Shell access can still modify files and is not an OS security boundary.

Gate `pi.extraArgs` and `agents.<id>.extraArgs` are checked independently against audited pi 1.5.0 flags and arities. Tool-changing/resource-loading flags, unknown options, positional arguments, option-like values and missing values fail closed. Gates always disable MCP and extension discovery, regardless of `pi.minimalContext`; Gezielt geladen werden nur die verwaltete RPC-Chat-Erweiterung sowie bei `google-antigravity` die Providererweiterung; dadurch entstehen keine zusätzlichen Gate-Werkzeugrechte. Scranton's exact allowlist is the last tool-setting option, before positional inbox/prompt arguments. Planner/developer arguments are unchanged. Malformed configured workflows remain warnings, never CRUD failures; deletion returns 409 only if a valid configured workflow names the custom gate.

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

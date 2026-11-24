# Code map: src/server

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "src/server/control.js"
kind: "where"
text: "Each run is launched here as its own Node child: runner(process.execPath, args, { cwd: PACKAGE_ROOT, stdio: ['pipe','pipe','pipe','ipc'], env: SCRANTON_RUN_ID / SCRANTON_RUN_LEASE / SCRANTON_PARENT_GUARD / SCRANTON_PROMPTS_DIR / SCRANTON_SETTINGS_DIR, plus SCRANTON_FAKE_MODE/SCENARIO for demos }); request and thread context are passed as files (--request-file, --thread-context under hive/control). The server<->run channel is Node IPC, i.e. Node-specific - the switch point if the run process is ever replaced by a non-Node binary."
see_also: "Python pipeline calls back into Node helpers via SCRANTON_PIPELINE_COMPLETION_COMMAND / SCRANTON_PIPELINE_NATIVE_COMMAND set in src/core/pipeline-command.js (tools/pipeline-complete.js, tools/pipeline-sandbox.js)."
hash: "shape:c83b20271dee2dd7"
written: "2026-11-24"
commit: "ee8c972"
by: "core"
---

---
file: "src/server/registry-router.js"
kind: "where"
text: "Registry mode (visualize/app-server --data): /api/projects CRUD, chat CRUD, Dreaming routes, and scoped routes /api/projects/:p/chats/:c/<events|state|runs|chat|hitl|stop|control|pipeline...> mapped onto lazily created per-chat contexts (one hive per chat, pinned during in-flight requests, reaped when idle). Also the six context-system routes: GET /api/projects/:p/context, POST .../context/settings and .../context/notes, GET /api/projects/:p/chats/:c/context, POST .../context/reset and .../restore (strict bodies, same authorize/readBody guards, 404 for other context sub-paths; they do not exist in single-hive mode). One createContext service per router supplies those documents, the project/chat-bound provider handed to createControl (Team start writes thread-context v2 from forTeam) and the instance injected into the Pipeline supervisor. Chat inspection passes activeRunId (controller snapshot, else hive lease; Pipeline: the supervisor's active run) and Dreaming memory (context() for Team, structuredContext() for Pipeline; failures fall back to '' / []). Registry storage lives in src/core/projects.js; run history/thread summaries in src/core/thread.js. Server-spawned run children use --single-hive."
see_also: ".enma/context-contract.md section 8; src/core/context/index.js; test/server/context.test.js"
hash: "shape:b71f6c8f5e474b7b"
written: "2026-11-16"
commit: "2867259"
by: "core"
---

---
file: "src/server/relay.js"
symbol: "startRelay"
ordinal: 0
kind: "how"
text: "The phone relay is a separate, opt-in foreground process (`scranton relay`), not a dashboard binding. Attaches to `/api/control` on 127.0.0.1:<targetPort> only. `relayListener` selects loopback HTTP for a private HTTPS reverse proxy or private IPv4 TLS with a matching origin/port and certificate+key. `startRelay` checks exact external Host and same-origin POSTs before pairing/session/logout or an explicit dashboard method/path allowlist. A bounded in-memory session map owns each phone's TTL timer and open upstreams/SSE; `revoke` closes just those streams. Pairing HTML lives in relay-page.js, installed Windows commands and per-browser logout in Settings + docs/RELAY.md. No dashboard auth setup/agents API forwarding."
see_also: "src/server/relay-page.js; test/server/relay.test.js; visualizer/public/js/phone-relay.js; docs/RELAY.md; test/packaging/relay.test.js"
hash: "span:7ee5ab56ae41186f"
written: "2026-11-21"
commit: "81f6ea4"
by: "core"
---

---
file: "src/server/visualizer-server.js"
symbol: "handleEvents"
ordinal: 0
kind: "how"
text: "The journal SSE stream (text/event-stream) replays the events file from the first event on every connection; it does not read Last-Event-ID (only src/server/agent-routes.js does, for agent streams) and writes without waiting for 'drain'. Heartbeats and disconnect cleanup exist."
see_also: "Lane probe .scratch/audit-server-desktop/ (Last-Event-ID 98 -> first id 0; 100 writes without drain). Client reducer cost: visualizer/public/js/state.js reduce."
hash: "span:81237d46880168f9"
written: "2026-11-24"
commit: "ee8c972"
by: "core"
---

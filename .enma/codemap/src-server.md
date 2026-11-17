# Code map: src/server

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

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

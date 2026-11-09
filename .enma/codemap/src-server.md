# Code map: src/server

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "src/server/registry-router.js"
kind: "where"
text: "Registry mode (visualize/app-server --data): /api/projects CRUD, chat CRUD, and scoped routes /api/projects/:p/chats/:c/<events|state|runs|chat|hitl|stop|control> mapped onto lazily created per-chat contexts (one hive per chat, pinned during in-flight requests, reaped when idle). Registry storage lives in src/core/projects.js; run history/thread summaries in src/core/thread.js. Server-spawned run children use --single-hive."
hash: "shape:b71f6c8f5e474b7b"
written: "2026-11-08"
by: "core"
---

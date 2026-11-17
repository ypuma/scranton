# Code map: src/core/context

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "src/core/context/index.js"
kind: "where"
text: "The context system (multi-turn chats + cross-chat project context, registry mode only). createContext({ dataDir, registry, redact, now }) returns status / configure / setNotes (project document), inspect / reset / restore (chat document), forTeam (-> { text, developer, meta } for the Team planner pack and developer brief) and forPipeline (-> the closed §26 history object plus optional `context`, or null). Turns are derived from disk on every call (turns.js: Team hives via thread.js listContextRuns, Pipeline run dirs via pipeline-history.js listPipelineHistoryRuns); settings.json / notes.md / per-chat state.json live in store.js (hardened like dreaming/storage.js); limits in limits.js; pure rendering in pack.js. On an internal error forTeam / forPipeline return the legacy digest and only inspect / meta flag `degraded`. Default redact is dreaming/reflection.js redact; the Pipeline supervisor passes its own sandboxText."
see_also: ".enma/context-contract.md; test/core/context-*.test.js; .scratch/context-system/lane-a/REGRESSION-ANCHORS.md"
hash: "shape:1eb9129233bfe950"
written: "2026-11-16"
commit: "2867259"
by: "core"
---

---
file: "src/core/context/pack.js"
symbol: "buildTeamPack"
ordinal: 0
kind: "how"
text: "Pure builder of the Team planner pack and developer brief. Layers render in fixed order notes, memory, other-chats, earlier, recent, but budget is allocated by priority: latest turn in detail, full notes, older detailed turns newest first, own earlier turns condensed, sibling chats (left-over budget only), memory. Builder caps are 23900 (planner) and 3900 (developer) so the consumer clamps of 24000 / 4000 never cut a line. Own turns never vanish silently: each is detailed, condensed or counted in an explicit omitted line. `sections` mirror the injected text exactly (exact: true). For Pipeline, buildPipelineContext only yields raw { notes, lines, other_chats }; buildPipelineHistory selects `earlier` against its FINAL runs."
see_also: ".enma/context-contract.md sections 6, 7, 11; src/core/context/limits.js; test/core/context-pack.test.js"
hash: "span:e538a2e3e5319699"
written: "2026-11-16"
commit: "2867259"
by: "core"
---

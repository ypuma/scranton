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
file: "src/core/context/limits.js"
symbol: "budgetFor"
ordinal: 0
kind: "how"
text: "The context budget rule (tokens). settings = { budget?: { mode: 'percent'|'tokens', value }, models?: { [recipientId]: rule } }; a per-model override wins over the project rule, the default is 10 percent. raw = floor(window * value / 100) or the fixed value; result = clamp(raw, 256, min(200000, floor(window / 2))), with capped = 'min' | 'window' | 'max' | null and source 'model' | 'project'. briefFor (developer brief) = a tenth of the budget computed for the developer's own model, within 250..2000 tokens and never above that budget. pipelineAllowance turns the planner's budget B into wire bytes: history = clamp(3B, 12000, 50000), context = clamp(B, 4000, 25000) (the engine prompt budget of 200000 bytes / 4 and / 8), shown tokens = floor((history + context) / 4), i.e. 4000..18750, capped 'engine' when it differs from 4B. scaledLimits scales the Team builder's caps with U / 23900 (U = 4 x tokens), so U = 23900 reproduces the 0.3.0 pack byte for byte."
see_also: ".enma/context-budget-contract.md sections 4, 5, 8; visualizer/public/js/context.js previewText mirrors pipelineAllowance from defaults.pipelineBytes"
hash: "span:7bf57ba29e2f0bbb"
written: "2026-11-17"
commit: "6e5199a"
by: "core"
---

---
file: "src/core/context/pack.js"
symbol: "buildTeamPack"
ordinal: 0
kind: "how"
text: "Pure builder of the Team planner pack and developer brief, budgeted in UNITS (tokens.js; 4 units per token): `units` (default LIMITS.team = 23900, the 0.3.0 anchor) and `developerUnits` (default 3900); all inner caps come from scaledLimits(U, Udev). Layers render in fixed order notes, memory, other-chats, earlier, recent, but the budget is allocated by priority: latest turn in detail (its room is what is left after the notes and a reserved omission marker), older detailed turns newest first (up to caps.recent), own earlier turns condensed, sibling chats (left-over budget only), memory. Notes stay in full while they fit in U / 2; above that they are cut at a line boundary and end with the line '[project notes cut to fit the context budget]' (meta.notes.cut). Own turns never vanish silently: each is detailed, condensed or counted in an explicit omitted line. `sections` mirror the injected text exactly. meta carries budget { tokens, used } and developer { tokens, used }. With small budgets the full notes can leave room only for a condensed latest turn; the invariant \"a larger budget never loses the latest turn's detail\" is tested from U >= 4000. For Pipeline, buildPipelineContext only yields raw { notes, lines, other_chats }; buildPipelineHistory selects `earlier` against its FINAL runs."
see_also: ".enma/context-budget-contract.md section 5 (invariants I1-I10); src/core/context/limits.js scaledLimits; test/core/context-pack.test.js (I9 golden against 0.3.0), test/core/context-budget.test.js"
hash: "span:1c6f6ab692c40af2"
written: "2026-11-17"
commit: "6e5199a"
by: "core"
---

---
file: "src/core/context/tokens.js"
kind: "where"
text: "Token estimate of the context system (no tokenizer). units(text): weight per code point - 1 for ASCII and U+2026 (the builder's own cut mark), 2 up to U+2E7F, 4 above (astral and lone surrogates); tokens(text) = ceil(units / 4). clipUnits / cutUnits cut a string to a unit budget at code-point boundaries (cutUnits appends the ellipsis). pct(n, d) formats a percentage: '0' for nothing or a non-positive denominator, '<0.1' below 0.1, one decimal while the one-decimal rounding is below 10, else the raw value rounded to an integer. The browser carries the same units / pct rules in visualizer/public/js/context.js; test/core/context-tokens.test.js holds a generated parity sweep."
see_also: ".enma/context-budget-contract.md section 2; visualizer/public/js/context.js units / pct"
hash: "shape:c013bdc26e0521ee"
written: "2026-11-17"
commit: "6e5199a"
by: "core"
---

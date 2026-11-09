# Code map: langgraph-engine/src/scranton_engine

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "langgraph-engine/src/scranton_engine/graph.py"
symbol: "build_graph"
ordinal: 0
kind: "how"
text: "SUPERSEDED package (user decision 2026-11-09): the old standalone nine-node CLI MVP. Nothing in the product uses it; the current engine is engine/src/scranton_pipeline (see the entry on engine/src/scranton_pipeline/graph.py build_graph). Left on disk only until the user decides whether to delete it."
see_also: "memory plan pipeline-engine-plan"
hash: "span2:6e2a3f2191763602"
written: "2026-11-09"
by: "core"
retired: true
reason: "The whole langgraph-engine/ folder was deleted on 2026-11-10 at the user's request; the current engine is engine/src/scranton_pipeline (entry on graph.py build_graph)."
retired_by: "core"
retired_at: "2026-11-09"
---

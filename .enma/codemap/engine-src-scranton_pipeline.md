# Code map: engine/src/scranton_pipeline

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "engine/src/scranton_pipeline/graph.py"
symbol: "build_graph"
ordinal: 0
kind: "how"
text: "Scranton Pipeline (the CURRENT Python engine; `langgraph-engine/` is superseded). Sync LangGraph StateGraph with 16 fixed nodes: 3 LLM roles (plan, implement, review), 2 human gates (approve_plan, approve_delivery via interrupt), 11 Python nodes; single terminal node finalize. Every conditional edge has an explicit path_map; routing is the pure target/reason function in routing.py; bounds are enforced in the node that increments the counter; RetryPolicy(retry_on=TransientError) only on the LLM nodes; exceptions that must stay resumable leave the graph and runner.py reports `suspended`. Only fan-out: index_repo || baseline_checks joined into plan."
see_also: ".enma/pipeline-contract.md (sections 2, 13, 15); engine/docs/ARCHITECTURE.md; engine/docs/graph.mmd is pinned to the compiled graph by a test"
hash: "span2:d3f2b7fa3a59b812"
written: "2026-11-09"
by: "core"
---

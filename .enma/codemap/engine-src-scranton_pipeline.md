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

---
file: "engine/src/scranton_pipeline/grounding.py"
kind: "where"
text: "Evidence grounding core (contract sections 21, 25, 25b): stable evidence IDs (`evidence_id`, `context_id`, `check_id`, `diff_hunks`), the content-free registry `<run-dir>/evidence.jsonl` (`register`), the trace `<run-dir>/grounding.jsonl` (`append_trace`; first row is a `settings` row), and the pure scoring `score_trace` / `recompute_summary` used by `status.grounding`, the `score` CLI and the eval suite. The rules themselves (violations, absence search, criteria decided by checks, counterfactual probe, node `ground`) live in `nodes/grounding.py`."
see_also: ".enma/pipeline-contract.md sections 21-25b; .scratch/pipeline/g1/CHANGES.md, r8/CHANGES.md, r9/CHANGES.md"
hash: "shape2:f236cc3451f3ca35"
written: "2026-11-10"
commit: "16fd06b"
by: "core"
---

---
file: "engine/src/scranton_pipeline/guidance.py"
kind: "where"
text: "Wiring of the procedural guidance graph (contract section 23): `situation(role, state)` maps engine state to one id of the closed vocabulary, the pinned graph copy `<run-dir>/artifacts/procedure.json` is rendered into advisory prompt text under the request key `guidance` (own byte allowance on top of `limits.max_prompt_bytes`). The pure library (graph model, `problems`, `digest`, `render`, `prepare_candidate`, `accept`, packaged `default.json`) is `procedure/__init__.py`; the offline `evolve` loop and the judge-free `eval` harness are in `evals/` (`evolve.py`, `evaluate.py`, `pack.py`, built-in pack `evals/packs/core`). Off by default (`procedure.enabled`)."
see_also: ".enma/pipeline-contract.md sections 22, 23; .scratch/pipeline/p1/CHANGES.md, p2a/CHANGES.md, p2b/CHANGES.md"
hash: "shape2:2505ba1e1ac9d9f9"
written: "2026-11-10"
commit: "16fd06b"
by: "core"
---

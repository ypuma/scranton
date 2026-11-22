# Code map: engine/src/scranton_pipeline/nodes

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "engine/src/scranton_pipeline/nodes/workflow.py"
symbol: "package"
ordinal: 0
kind: "how"
text: "The delivery node writes candidate.diff against the private repo, recomputes the grounding summary, and incorporates both that summary and risk_flags into gate_digest. criteria_not_demonstrated refers specifically to met_not_demonstrated; accepted output violations can add grounding_violations. Read grounding.criteria for each acceptance state rather than inferring it from the flag list; package initializes applied false and writes a draft report."
see_also: "graph.py build_graph, routing.py after_package, report.py; guarded apply follows the delivery decision, not creation of a patch."
hash: "span2:a5a66e840bafa504"
written: "2026-11-21"
commit: "709b8c5"
by: "core"
---

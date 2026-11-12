# Code map: engine/src/scranton_pipeline/tools

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "engine/src/scranton_pipeline/tools/checks.py"
symbol: "failure_feedback"
ordinal: 0
kind: "how"
text: "Builds required non-passed check repair feedback with current status/exit/duration and baseline matched by check ID, explicitly retaining unknown cause/equivalence. Adds bounded untrusted early diagnostic and output tail with fresh redaction. Caps each entry to 6000 and combined joined feedback to 24000 bytes; very large check counts use omitted-details summary. Does not change verification gates."
see_also: "_failure_excerpt enforces run_dir/artifacts/logs containment, rejects links/reparse points and reads bounded prefix. tests/unit/test_check_feedback.py; tests/flow/test_run_robustness.py."
hash: "span2:f7c2360125cb8c53"
written: "2026-11-12"
commit: "9ec5519"
by: "core"
---

---
file: "engine/src/scranton_pipeline/tools/context.py"
symbol: "eviction_index"
ordinal: 0
kind: "how"
text: "Quality-aware oldest-first context eviction: failed reads, then truncated python_read prereads, then ordinary explicit context, finally complete python_read prereads and line-targeted reads. Order breaks ties within the tier. Both context-node accumulation and final prompt pruning share it; it removes items rather than slicing their contents."
hash: "span2:f18383589b737205"
written: "2026-11-12"
commit: "9ec5519"
by: "core"
---

---
file: "engine/src/scranton_pipeline/tools/context.py"
symbol: "unique_evidence"
ordinal: 0
kind: "how"
text: "Deduplicates by serialized request; request-less evidence gets an independent integer occurrence key and retains its own order/content. Explicit re-requests move to newest; identical automatic prereads retain the older position/content while copying python_read=True into a new dict (never mutate original). Retains automatic-read provenance across later replacements. Both node accumulation and prompt pruning use this helper."
see_also: "agents/prompts.py; nodes/workflow.py; tests/unit/test_context_retention.py actual select_step->implement and request-less evidence regressions."
hash: "span2:deb0ab0079e3bb3c"
written: "2026-11-12"
commit: "9ec5519"
by: "core"
---

---
file: "engine/src/scranton_pipeline/tools/process.py"
symbol: "run_process"
ordinal: 0
kind: "how"
text: "Owns subprocess stdout and drains with nonblocking os.read (Python>=3.12), checks stop/timeout between chunks, closes Job Object or kills original POSIX process group, then drains to EOF within 10s. Retained writer raises infrastructure output_not_closed. Log writing and redaction occur after successful drain; no incremental log artifact."
hash: "span2:87ad854944f0eac4"
written: "2026-11-12"
commit: "9ec5519"
by: "core"
---

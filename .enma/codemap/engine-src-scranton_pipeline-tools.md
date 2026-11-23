# Code map: engine/src/scranton_pipeline/tools

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "engine/src/scranton_pipeline/tools/checks.py"
symbol: "failure_feedback"
ordinal: 0
kind: "how"
text: "Builds repair feedback for required checks that did not pass (`r[\"required\"] and not check_ok(r)`); returns [] when there are none. More than 24000 failed checks give one summary line without details; otherwise each entry is capped at `min(6000, (24000 - n) // n)` bytes. Per entry: a redacted header with current status / exit code / duration and the baseline status matched by check id (root cause relationship stated as unknown); when the row carries `baseline_comparison`, the header also lists the tests failing now that did not fail at baseline (`comparison[\"new\"]`) and the count still failing, and is clipped to 2500 instead of 1000. The excerpt comes from `_new_failure_excerpt` for those new names when there is a comparison, falling back to `_failure_excerpt`; then a bounded, redacted `output_tail` labelled as untrusted data (at most `tail_bytes`). Does not change verification gates."
see_also: "tests/unit/test_check_feedback.py; tests/flow/test_run_robustness.py; _failure_excerpt enforces containment under the run directory"
hash: "span2:9e7a29170f97ab2d"
written: "2026-11-21"
commit: "cd0d158"
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
file: "engine/src/scranton_pipeline/tools/native_sandbox.py"
kind: "where"
text: "Engine side of sandbox mode `scranton` (default for new runs; SandboxConfig.windows_mode low|strict). It sits behind the existing Sandbox interface, and build_sandbox in tools/sandbox.py selects it. It calls the Node runner (tools/pipeline-sandbox.js) through SCRANTON_PIPELINE_NATIVE_COMMAND. A missing or invalid binding means unavailable, and there is no fallback to Docker or host. Setup, checks, parallel lanes, the grounding probe and eval acceptance run through it. Host Git, the `command` completion provider and model HTTP stay on the host. Strict rejects setup network:true at config validation (`setup[i].network`). Workspace links or hard links fail as typed sandbox_failed `workspace_link`, which recommends Docker. The real Windows gate is engine/tests/integration/, enabled with SCRANTON_PIPELINE_NATIVE_TEST=1."
see_also: ".enma/pipeline-native-sandbox-contract.md §5; unit tests engine/tests/unit/test_native_sandbox.py"
hash: "shape2:5d52c2f3b4c20d14"
written: "2026-11-23"
commit: "3191877"
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

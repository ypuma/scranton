# Code map: tools

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "tools/pipeline-sandbox.js"
kind: "where"
text: "Node runner behind the Pipeline native sandbox mode `scranton` (Windows only: low = Low integrity, network open; strict = AppContainer, no network). The engine finds it only via env SCRANTON_PIPELINE_NATIVE_COMMAND = JSON [node exe, this script], set by src/core/pipeline-supervisor.js for every engine child. Verbs probe / allocate / exec / recover, each with `--protocol 1`. exec takes a request file (root, temp_parent, cwd, argv, env, network, windows_mode, deadline_ms, receipt, record), streams the tool's stdout and stderr straight through, treats stdin as the stop pipe (EOF or a byte stops it), and reports the terminal state only in an atomic receipt file. allocate also writes a host-only sibling `.scranton-sandbox-allocation-<basename>.json`. Reuses src/core/sandbox-native (owned roots, helper resolver, credential-store hardening shared with Team). It must be listed in the explicit tools list in scripts/prepare-desktop.mjs, or the packaged app silently lacks it."
see_also: ".enma/pipeline-native-sandbox-contract.md §3-§4; tests test/core/pipeline-sandbox-runner.test.js; engine side engine/src/scranton_pipeline/tools/native_sandbox.py"
hash: "shape:a5c90452a7de23d9"
written: "2026-11-23"
commit: "3191877"
by: "core"
---

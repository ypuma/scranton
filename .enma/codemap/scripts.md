# Code map: scripts

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "scripts/prepare-desktop.mjs"
symbol: "pipelineForbidden"
ordinal: 0
kind: "trap"
text: "Desktop staging removes every file or directory of the engine package whose NAME matches this filter, case-insensitively - so package data in a folder called `scripts`, `bin`, `test`, `tests`, `pip…`, `wheel…` silently disappears from the installed app (it cost the built-in eval pack its `scripts/` folder once; now `turns/`). The engine test `engine/tests/evals` `test_pack_survives_desktop_staging` reads this very regex and fails on a forbidden name. Also: the staged interpreter is the embeddable Python (no cwd on sys.path, PYTHONPATH ignored) - anything shipped that runs `python -c \"import <project module>\"` must add `.` to sys.path itself."
evidence: "`tests?|(?:_?pytest|ruff|mypy|pip|setuptools|wheel)(?:[-_.].*)?|bin|Scripts)$/i`"
see_also: "memory plan pipeline-v3-plan; check with the staged runtime: src-tauri\\staged\\app\\engine-runtime\\python\\python.exe -B -m scranton_pipeline eval --pack core"
hash: "span:2019de51e07f9c63"
quote: "quote:4d55a269ab3acc47"
written: "2026-11-10"
commit: "16fd06b"
by: "core"
---

---
file: "scripts/prepare-desktop.mjs"
symbol: "prepareDesktop"
ordinal: 0
kind: "trap"
text: "Desktop staging is native-host selected, not Windows-only: prepareDesktop calls assertNativeBuild(desktopPlatform()) and uses host.nodeFile. It recreates sources and verifies Pi/runtime packaging; this is preparation, not proof that a native installer was built or executed. Dedicated runtime helper tools are explicitly listed, including dreaming-pi-complete.js."
evidence: "`const host = assertNativeBuild(desktopPlatform());` and `const node = path.join(tauri, 'binaries', host.nodeFile);`"
see_also: "src-tauri/tauri.conf.json; scripts/desktop-platform.mjs; engine/runtime-lock.json; test/packaging/desktop.test.js"
hash: "span:bcefa7ab45036889"
quote: "quote:413201cdc73aa180"
written: "2026-11-15"
commit: "f7a3179"
by: "core"
---

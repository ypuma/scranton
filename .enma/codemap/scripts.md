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
text: "Native Desktop-Vorbereitung ist ausdrücklich Windows-x64-only und erzeugt einen fest benannten Windows-Node-Sidecar; Tauri beforeDevCommand/beforeBuildCommand ruft diese Funktion über das Skript auf. Crossplatform-Nodekern bedeutet deshalb noch keinen Mac-Desktopbuild."
evidence: "`if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop packaging currently supports Windows x64 only.');` und `const node = path.join(tauri, 'binaries', 'node-x86_64-pc-windows-msvc.exe');`"
see_also: "src-tauri/tauri.conf.json; src-tauri/src/main.rs; engine/runtime-lock.json"
hash: "span:4adb983fbc6186d6"
quote: "quote:7ab54d9b9dd8cc02"
written: "2026-11-11"
commit: "2118ea5"
by: "core"
---

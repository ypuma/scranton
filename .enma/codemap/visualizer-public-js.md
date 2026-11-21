# Code map: visualizer/public/js

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "visualizer/public/js/chat-panel.js"
symbol: "createChatPanel"
ordinal: 0
kind: "trap"
text: "Tail-follow in the Messages transcript (and the same pattern in log.js createLog) must trust the `follow` flag, not the geometry. A scroller inside a hidden tab, or in a #dash that is not shown yet, measures 0. A scroller that shrinks (the composer grows on focus) reads as \"not at bottom\". Either case silently drops followers off the newest row. The ResizeObserver handles both: going from 0 to a height calls reveal(), and any other resize calls toBottom() for a follower. test/visualizer/scroll-follow.test.js covers this with a size-aware fake scroller; reverting either quoted line made it fail with \"on the newest message after the box shrank\" (actual 1100, expected 1170)."
evidence: "`const stick = follow || (laidOut() && atBottom());` and `else if (h > 0 && follow) toBottom();`"
hash: "span:3fce9aad3beb15ab"
quote: "quote:6b1deb25bcd733bb"
written: "2026-11-21"
commit: "cd0d158"
by: "core"
---

---
file: "visualizer/public/js/log.js"
symbol: "createLog"
ordinal: 0
kind: "trap"
text: "The event log is an ARIA grid (one Tab stop, roving cell tabindex keyed by data-seq + column). Tail-follow has three inputs:\n- `follow`: set by user scroll events, toBottom() and readAt().\n- `held`: set when a keyboard move or click lands on an older row. It stops the render's geometric \"at bottom\" check from yanking a reader who is still at the bottom.\n- geometry, used only when neither flag decides.\nKeyboard and click moves must go through readAt(). Relying on scroll events breaks, because an in-view row does not scroll and a scroll event can land while toBottom's one-frame `programmatic` guard is still set. Tests: test/visualizer/log-keyboard.test.js (its `frames` harness mode models that race) and scroll-follow.test.js."
evidence: "`const wasFollowing = follow || (!held && laidOut() && atBottom());` and `if (tr === visibleRows().at(-1)) return toBottom();` in readAt."
hash: "span:dcc97c09a82cc9e9"
quote: "quote:a7cbb4a7f98be000"
written: "2026-11-21"
commit: "cd0d158"
by: "core"
---

---
file: "visualizer/public/js/nav.js"
symbol: "createNav"
ordinal: 0
kind: "how"
text: "Owns the New project / rename / remove dialogs and the sidebar. New project's Browse control calls the Tauri dialog through `invoke('plugin:dialog|open', { options })`; a normal browser keeps manual absolute-path entry and says so in visible text. The folder hint is `folderHint(doc?.projectsRoot)`: it names the absolute default folder the server sends as `projectsRoot` in GET /api/projects and falls back to a generic wording when an older server sends none. A per-picker ticket (`picking !== ticket`) and the submit-disabled guard prevent concurrent submits / pickers and drop late picker answers. Paths longer than `FOLDER_MAX` (1024) are refused rather than truncated; selection only fills the form, creation happens through POST /api/projects."
see_also: "src-tauri/capabilities/dashboard-folder-picker.json; src/core/projects.js (projectsRoot); test/visualizer/project-folder.test.js; docs/CONTROL.md New project folder picker"
hash: "span:1077f009fa68e289"
written: "2026-11-21"
commit: "cd0d158"
by: "core"
---

---
file: "visualizer/public/js/tabs.js"
kind: "where"
text: "The activity panel's tabs (Events / Messages / Mailboxes) live in createTabs, wired in main.js. It implements an ARIA tablist with roving tabindex and Arrow/Home/End keys. It merged the old separate Event log, Messages and Mailboxes panels in the 2026-11-08 UI rework. Pre-rework copy of the whole UI: .scratch/ui-rework/baseline/public/."
hash: "shape:74784135d4ccc118"
written: "2026-11-08"
by: "core"
---

---
file: "visualizer/public/js/undo.js"
kind: "where"
text: "Everything the \"undo this run\" control knows that is not DOM: the two chat-scoped routes (`undoUrl`: `restore-points`, `undo`), parsing of their answers (`parseRestorePoints`, `parseUndo`, `conflictOf` - an unknown conflict code counts as `blocked`, a missing one as `changed`), the request body (`buildUndo`), all visible texts, and the availability rule `undoState(run, points)`: `none` (no point for the run shown, a Pipeline run, a run that is not over, or nothing to do), `unreadable`, `undone`, `unrestorable` (nothing left, nothing undone, files without a backup - no control), `older` (a newer point is still open - undo works backwards), `partial`, `offer`. Two ways to decide, by what the server sends: with the counts `undone` and `unrestorable` (`counted`) a point is undone only when `remaining` is 0 and `undone` > 0, open when `remaining` > 0, partly undone when both are above 0 - `undoneAt` then only dates a real undo; without them (older server) undone means `undoneAt` set or `remaining` 0. `undoneMark` and `changesNote` use the same helpers. Rendering and the request life cycle (confirmation with a re-check on OK, one shared in-flight POST, 120 s abort with an \"unknown result\" marker kept per run until newer points are adopted, dropping a stale result) are in `undo-panel.js` (`createUndo`), called from `drawOutcome` in `run-rail.js` and wired in `main.js`. Force is offered only for conflicts with code `changed`, in state `offer` or `partial`."
see_also: "src/server/registry-router.js (routes); src/core/restore-points.js listRestorePoints / undoRun; src/core/cli.js cmdUndo prints the same four states for `--list`; test/visualizer/undo.test.js"
hash: "shape:4b10248dc72397c9"
written: "2026-11-21"
commit: "9572556"
by: "core"
---

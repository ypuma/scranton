# Code map: visualizer/public/js

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "visualizer/public/js/chat-panel.js"
symbol: "createChatPanel"
ordinal: 0
kind: "trap"
text: "Tail-follow in the Messages transcript (and the same pattern in log.js createLog) must trust the `follow` flag, not the geometry. A scroller inside a hidden tab, or in a #dash that is not shown yet, measures 0. A scroller that shrinks (the composer grows on focus) reads as \"not at bottom\". Either case silently drops followers off the newest row. The ResizeObserver handles both: going from 0 to a height calls reveal(), and any other resize calls toBottom() for a follower. test/visualizer/scroll-follow.test.js covers this with a size-aware fake scroller."
evidence: "`const stick = follow || (laidOut() && atBottom());` and `else if (h > 0 && follow) toBottom();`. Reverting either produced `AssertionError: on the newest message after the box shrank` (actual 1100, expected 1170)."
hash: "span:c6a31cb03316b726"
quote: "quote:6b1deb25bcd733bb"
written: "2026-11-08"
by: "core"
---

---
file: "visualizer/public/js/log.js"
symbol: "createLog"
ordinal: 0
kind: "trap"
text: "The event log is an ARIA grid (one Tab stop, roving cell tabindex keyed by data-seq + column). Tail-follow has three inputs:\n- `follow`: set by user scroll events, toBottom() and readAt().\n- `held`: set when a keyboard move or click lands on an older row. It stops the render's geometric \"at bottom\" check from yanking a reader who is still at the bottom.\n- geometry, used only when neither flag decides.\nKeyboard and click moves must go through readAt(). Relying on scroll events breaks, because an in-view row does not scroll and a scroll event can land while toBottom's one-frame `programmatic` guard is still set. Tests: test/visualizer/log-keyboard.test.js (its `frames` harness mode models that race) and scroll-follow.test.js."
evidence: "`const wasFollowing = follow || (!held && laidOut() && atBottom());` and `if (tr === visibleRows().at(-1)) return toBottom();` in readAt."
hash: "span:70f662d549a7cca9"
quote: "quote:a7cbb4a7f98be000"
written: "2026-11-08"
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

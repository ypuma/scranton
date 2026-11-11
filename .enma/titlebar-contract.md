# Integrated title bar contract (lead, 2026-11-11)

User request: "make the bar at the top with closing, minimizing etc. integrated".
The desktop window loses its native Windows title bar. The web UI's existing top bar (`.topbar`, height `--topbar-h`) becomes the title bar and carries the window controls. In a normal browser nothing changes.

## 1. Native side (`src-tauri/**`)
- `tauri.conf.json`, window `main`: `"decorations": false`. The window stays resizable with its minimum size, keeps its shadow, and keeps working with the window-state plugin. Verify in the installed tauri / tao / wry sources how an undecorated window is resized and shadowed on Windows 10/11 and set what is needed explicitly (e.g. `"shadow": true`). Do not guess.
- New capability file `src-tauri/capabilities/dashboard-window-controls.json`, activated in `app.security.capabilities`:
  - `local: false`, `windows: ["main"]`, `remote.urls: ["http://127.0.0.1:*", "http://localhost:*"]` (same scope as the two existing capabilities).
  - Permissions, exactly: `core:window:allow-minimize`, `core:window:allow-toggle-maximize`, `core:window:allow-close`, `core:window:allow-is-maximized`, `core:window:allow-start-dragging`. Nothing else, unless the verified JS path in section 2 needs it; name any addition in the report.
- Closing from the UI must go through the existing `CloseRequested` handler in `src-tauri/src/main.rs` (graceful sidecar shutdown). No new Rust command unless the plugin path cannot work.

## 2. JS bridge (pinned; the native lane verifies it against the installed sources and reports any deviation)
`const win = globalThis.__TAURI__?.window?.getCurrentWindow?.()` (available because `withGlobalTauri` is true). Used methods, all returning promises:
`win.minimize()`, `win.toggleMaximize()`, `win.close()`, `win.isMaximized()`, `win.startDragging()`.
No event listeners (`onResized` needs event permissions): the UI re-reads `isMaximized()` on the DOM `resize` event and after its own toggle.
Dragging is done by the UI itself with `startDragging()`. The `data-tauri-drag-region` attribute is NOT used.

## 3. Web UI (`visualizer/public/**`)
- Desktop shell = `typeof globalThis.__TAURI__?.window?.getCurrentWindow === 'function'`. Then `document.body.dataset.shell = 'desktop'` and the controls are shown. Otherwise the controls stay hidden and the page looks exactly as today.
- Markup at the far right of `.topbar`: `<div class="window-controls" id="window-controls" hidden>` with three `<button type="button" tabindex="-1">`: `#win-minimize` (aria-label "Minimize"), `#win-maximize` (aria-label "Maximize" / "Restore", glyph switches with the state), `#win-close` (aria-label "Close"). Inline SVG line glyphs, about 46 px wide, full bar height, flush to the top right corner. Grayscale only: hover is a neutral tint; Close hover is an inversion, never red.
- The whole top bar is the drag area: primary-button `mousedown` on anything that is not an interactive control (`button, a, input, select, textarea, summary, label, [role="button"]`) calls `startDragging()`; a double click there calls `toggleMaximize()`.
- **Modal dialogs.** The page uses `<dialog>.showModal()` for drawers and confirms. That makes everything outside the dialog inert, and pointer events over the backdrop are dispatched with the dialog element as target. Requirement: minimize, maximize, close, drag and double-click-maximize keep working while any modal dialog or drawer is open, and nothing covers or dims the window controls. Suggested mechanism:
  - In the desktop shell, drawers and dialogs start below the bar (`top: var(--topbar-h)`), and the backdrop leaves the window-controls zone undimmed.
  - One capture-phase listener on `document` decides by pointer coordinates (`clientY < bar height`, control rectangles via `getBoundingClientRect()`), acts, and stops the event so a backdrop click does not also dismiss the dialog.
- A failed call (rejected promise) must never throw into the page; show nothing or a quiet status.
- Narrow widths: the bar may wrap today (`.topbar` rule near the end of styles.css); in the desktop shell the window controls stay on the first row at the top right.

## 4. Ownership
| Lane | Files |
|---|---|
| Frontend | `visualizer/public/**`, `test/visualizer/**` |
| Native | `src-tauri/**`, `test/packaging/**`, `docs/DESKTOP.md` |

## 5. Verification limits
Nobody can launch or drive the desktop app in this environment. The native lane proves the config with a compile (`cargo check`) and source evidence; the UI lane proves behaviour with fake-DOM tests and a mocked `__TAURI__` in the browser. Say so plainly in every report.

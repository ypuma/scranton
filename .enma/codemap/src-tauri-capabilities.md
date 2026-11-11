# Code map: src-tauri/capabilities

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "src-tauri/capabilities/dashboard-folder-picker.json"
kind: "where"
text: "Least-privilege native open-dialog capability for New project Browse. Enabled explicitly by tauri.conf.json alongside dashboard-notifications; grants only dialog:allow-open to window main at loopback HTTP URLs, local:false. The plugin permission covers file and directory dialogs; directory:true is supplied by the UI, not enforced by this ACL. Does not expose filesystem, shell, save or message commands."
see_also: "visualizer/public/js/nav.js createNav; test/packaging/folder-picker.test.js; docs/CONTROL.md New project folder picker"
hash: "content:fc68443d4f8d23af"
written: "2026-11-10"
commit: "2118ea5"
by: "core"
---

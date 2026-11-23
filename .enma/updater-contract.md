# Desktop auto-update - contract

Binding for the desktop shell (`src-tauri/**`), the Node server, the visualizer, the release scripts and the docs. Set by Core on 2026-11-23. The user asked, verbatim: "füge ein update bzw autoupdate in scranton hinzu". On the update source they answered, verbatim: "scranton auf github opensourcen". So updates come from the PUBLIC GitHub releases of `ypuma/scranton`, and no token is needed.

Facts it rests on (research 2026-11-23):
- Tauri 2.
- `tauri-plugin-updater` verifies a minisign signature against the configured `pubkey` before installing. It refuses downgrades and needs HTTPS.
- On Windows it runs the NSIS installer with `/P` (passive) `/UPDATE` and exits the app at once.
- In `/UPDATE` mode the NSIS template SKIPS the old uninstaller, so app data is never touched.
- The 2026-11-22 data wipe came from the interactive reinstall page ("Uninstall before installing" is the default, and its "Delete the application data" checkbox was ticked).
- The Rust shell starts the Node server (`src-tauri/src/main.rs` `startup`) and stops it gracefully on quit (`shutdown`: `quit` on stdin, 5 s, then `taskkill /T /F`).

## 1. Source and manifest
- **Endpoint:** `https://github.com/ypuma/scranton/releases/latest/download/latest.json`.
- **Release kind:** releases meant for auto-update are normal releases, not prereleases, and are marked latest. This is a change to the earlier release default (`prerelease: true`, `make_latest: false`).
- **Manifest:** the static Tauri `latest.json` format. Its `platforms` lists only the platforms actually built; today that is `windows-x86_64`, from local Windows builds.
- **Missing platform:** an install whose platform is missing gets state `unsupported` ("No update for this platform yet"), not an error.
- **Install mode:** `plugins.updater.windows.installMode = "passive"`.

## 2. Signing and builds
- **Keypair:** a Tauri updater (minisign) keypair.
  - **Private key:** stored only DPAPI-encrypted (CurrentUser) at `%USERPROFILE%\.scranton-release\updater.key.dpapi`, outside the repo and outside app data. The key may have an empty password, because DPAPI is the protection at rest.
  - **Generation:** `node scripts/updater-keygen.mjs`, which refuses to overwrite.
  - **Backup:** `node scripts/updater-keygen.mjs --export <file>` writes a plaintext copy only where the user asks. Losing the key ends updates for existing installs.
  - **Handling:** the key is never printed, logged, committed or passed on a command line. It reaches the build only as the `TAURI_SIGNING_PRIVATE_KEY` (content) / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` environment of that one process. A temporary plaintext file, if the Tauri CLI needs one, is deleted in a `finally`.
- **Public key:** in `src-tauri/tauri.conf.json` `plugins.updater.pubkey`.
- **`npm.cmd run app:build`** keeps working without any key, for contributors: `bundle.createUpdaterArtifacts` stays false in `tauri.conf.json`.
- **`npm.cmd run app:release`** (new) does all of this:
  - loads the key
  - builds with a config override that sets `createUpdaterArtifacts: true`
  - verifies the produced `.sig` against the committed pubkey, independently of Tauri
  - writes `latest.json` with `version`, `notes`, `pub_date` and, per built platform, `url` = `https://github.com/ypuma/scranton/releases/download/v<version>/<file>` and the `signature` text
  - writes everything into one output folder, and prints paths, sizes and SHA-256 only

## 3. Behaviour (desktop app)
- **Settings,** stored by Rust in `<app data>/updates.json`:
  - `autoCheck`, default true
  - `autoInstall`, default true
- **Check:**
  - 30 s after the server is ready, then every 6 h, and on demand
  - network timeout 15 s
  - offline or any failure sets state `error` with a short message; the next interval retries
- **Download:**
  - When an update is found and `autoInstall` is on, it downloads in the background, with progress.
  - Otherwise it downloads on click.
  - Downloaded bytes are cached under the app's local data dir (`updates/`), named by version. Older cached versions are deleted.
- **Install now** ("Restart and update"):
  - Allowed only when the Node server reports no active run (Team or Pipeline) and no pending human question. Otherwise it is refused with the reason.
  - It stops the Node server through the SAME graceful `shutdown` as quit before handing over to the installer.
  - Passive install, then the app restarts.
- **Automatic install:** when `autoInstall` is on and a cached download exists, the next app START installs it BEFORE the Node server starts.
  - That start does a short check (10 s). It installs only when the check returns the same version as the cache; the plugin verifies the cached bytes against that release's signature.
  - If the check fails or offers a different version, startup continues normally.
- **Never:** install a downgrade, install an unverified file, or run the installer while the server reports busy.

## 4. Interfaces
**Tauri commands**, callable from the main window only (the webview gets no updater plugin permissions):
- `update_status`, `update_check`, `update_download`, `update_set_settings({ autoCheck?, autoInstall? })`
- `update_install`: rejects with `busy` and the counts while busy
- Each returns, or rejects with, the status object.

**Status object:** `{ current, autoCheck, autoInstall, state, available?, progress?, lastCheck?, error?, busy? }`
- `state`: `idle | checking | up_to_date | available | downloading | ready | installing | unsupported | error`
- `available`: `{ version, notes, date }`
- `progress`: `{ downloaded, total|null }`
- `lastCheck`: ISO time
- `busy`: `{ running, waitingForHuman }`

Rust emits `update-status` with the status object on every change.

**Node server:** `GET /api/app/busy` → `{ running, waitingForHuman }`, counted over every chat and engine (registry and single mode). Loopback rules are the same as the other routes. Rust calls it before `update_install`.

## 5. UI (visualizer)
- **Settings drawer, "Updates" section:**
  - the current version, the state line, the last check
  - buttons: Check now / Download / Restart and update (disabled with the reason while busy)
  - toggles: "Check for updates automatically" and "Install updates automatically at the next start"
  - release notes as plain text
- **When an update is ready:** a quiet status line or banner, "Scranton <v> is ready - installs at the next start", with a "Restart now" action.
- **Browser mode** (no Tauri): show the version and "Updates are installed by the desktop app; a source checkout updates with git pull", plus a link to the releases page.

## 6. Docs
- `README.md` (German): how updates work, the settings, and that the first update-capable version is installed manually once.
- When installing manually over an older version, do NOT tick "Delete the application data".
- `docs/DESKTOP.md`: the updater, the key location and backup (losing the key ends updates for existing installs), and `app:release` step by step.

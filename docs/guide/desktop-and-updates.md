# Desktop and updates

Install Scranton, manage desktop updates, use the dashboards, and connect a phone privately.

[Back to the README](../../README.md)

## Install

Choose your package from the [latest release](https://github.com/ypuma/scranton/releases/latest). Verify the download's SHA-256 against `SHA256SUMS` before opening it (for example, with `Get-FileHash -Algorithm SHA256` in PowerShell, `shasum -a 256` on macOS, or `sha256sum` on Linux, followed by the path to the download).

- **Windows x64:** Run `Scranton_<version>_x64-setup.exe` (NSIS). The installer is not Windows code-signed, so expect a SmartScreen warning.
- **macOS 13.5 or later (Apple Silicon only; no Intel build):** Open `Scranton_<version>_aarch64.dmg` and copy Scranton to Applications before launching. The app is ad-hoc signed, not notarized, so Gatekeeper may block or warn. For a verified official download, after a blocked launch use **System Settings → Privacy & Security → Open Anyway** if offered and permitted. Alternatively, remove quarantine from only the installed copy with `xattr -dr com.apple.quarantine /Applications/Scranton.app`. This does not fix a corrupt download or an invalid signature.
- **Linux x64 or arm64:** On Debian-based distributions, install `Scranton_<version>_amd64.deb` (x64) or `Scranton_<version>_arm64.deb` (arm64) with your package manager. Alternatively, download `Scranton_<version>_amd64.AppImage` (x64) or `Scranton_<version>_aarch64.AppImage` (arm64), make it executable (`chmod +x`), and run it. The AppImage needs FUSE; if FUSE is unavailable, launch the file with `--appimage-extract-and-run`.

macOS and Linux packages have only been verified in automated CI: native builds, sandbox tests, and packaged app-server and Pipeline smoke tests. They have not been installed and tested on real machines. Installation, Linux desktop GUI behavior, and the macOS and Linux update flows are unverified.

Keep Git available. Team uses Seatbelt on macOS and requires an installed, usable `bwrap` on Linux. [Dictation](voice.md) and the [Pipeline Scranton sandbox](pipeline.md#check-and-setup-sandboxes) are Windows-only; Pipeline runs on macOS and Linux need Docker or explicit trusted host execution. Host execution is not OS isolation.

## Dashboards

```powershell
node bin/scranton.js dashboard
node bin/scranton.js dashboard --once --ascii
node bin/scranton.js visualize
node bin/scranton.js visualize --control --workspace workspace
```

The terminal and web dashboards use a dark, monochrome design. For a nondefault Hive, pass the same `--hive` used for the run. In Single mode, the HTTP server is read-only without `--control`; `--data` enables the project registry and control. Control requires a real loopback connection and a local Host header. POSTs require JSON and `X-Scranton-Client: 1`; scoped routes also enforce the client header on reads. CORS is not enabled. Do not expose the dashboard directly to a network. See [Events](../EVENTS.md) and the [Control API](../CONTROL.md) for event data, run/chat/approval controls, and recovery blockers.

## Phone relay

The phone relay must be started explicitly. It uses private Wi-Fi HTTPS or Tailscale **Serve**; the desktop app does not automatically open a LAN port. The installed-app workflow works on **Windows desktop 0.5.0 or later**. The **0.4.0** installer does not include the relay.

No checkout or separate Node/npm installation is needed. Find the actual installation folder from the Scranton shortcut using **Open file location**, or follow its **Properties → Target** to the executable. Once private Serve is configured, open PowerShell next to `scranton-desktop.exe` and `scranton-node.exe`:

```powershell
$dashboardPort = Read-Host 'Current dashboard port from Settings > Phone relay'
.\scranton-node.exe .\app\bin\scranton.js relay --origin https://your-computer.your-tailnet.ts.net --target-port $dashboardPort
```

Replace the example URL with your private Serve URL and enter the current port in **Settings → Phone relay**. Check the port again after an app restart. **Do not use Funnel or public port forwarding.** The [Phone relay reference](../RELAY.md) covers both private modes, certificates and keys, the Windows OpenSSL prerequisite for its certificate example, and checkout commands. **Settings → Phone relay → Disconnect** on the phone disconnects only that session; **Ctrl+C** in the relay terminal disconnects all sessions. Manage credentials and agent definitions locally. PC loopback previews are not reachable from the phone. See also the [installed-app instructions](../DESKTOP.md#smartphone-steuerung-ohne-checkout-windows).

## Automatic updates

| Installation | Update method |
| --- | --- |
| Windows x64 | The updater runs the signed NSIS installer. If your version predates the updater (first included in 0.7.0), install the current release directly. **Do not select “Delete the application data”** when upgrading manually. |
| macOS (Apple Silicon) | The updater uses the signed `.app.tar.gz` archive, not the DMG. Run the installed app from Applications, not from the DMG. |
| Linux AppImage | The updater uses the signed AppImage for your architecture. Keep the AppImage file in a writable location. |
| Linux DEB | Settings shows manual-update guidance. Download and install the newer `.deb` for your architecture; automatic updates are not available. |

Where automatic updates are available, Scranton checks by default about 30 seconds after the app is ready and then every six hours. It downloads available updates in the background and installs them at the next launch. When the download finishes, **Restart and update** installs immediately if no Team or Pipeline run is active and no human decision is pending. The updater verifies the package's `.sig` (included in `latest.json`); this is separate from OS code signing and notarization. The macOS and Linux update paths are configured but have not been tested end to end on installed copies.

In **Settings → Updates**, toggle automatic checking and automatic installation on next launch independently. You can also check manually. With automatic installation off, start the download and install yourself. A normal browser does not install desktop updates; update a checkout with `git pull`. See the [desktop updater reference](../DESKTOP.md#desktop-updates).

# Desktop and updates

Use the dashboards, connect a phone privately, and manage Windows desktop updates.

[Back to the README](../../README.md)

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

Automatic updates currently apply only to the Windows x64 desktop app. **0.7.0** was the first self-updating version. If you have an older version, manually install a current release from [GitHub Releases](https://github.com/ypuma/scranton/releases); you do not need to install 0.7.0 first. **Do not select “Delete the application data”** when installing manually over an older version.

By default, Scranton checks about 30 seconds after the app is ready and then every six hours. It downloads available updates in the background and installs at the next launch. When the download finishes, **Restart and update** installs immediately if no Team or Pipeline run is active and no human decision is pending. The updater verifies the GitHub release package signature; this is separate from Windows code signing.

In **Settings → Updates**, toggle automatic checking and automatic installation on next launch independently. You can also check manually. With automatic installation off, start the download and install yourself. A normal browser does not install desktop updates; update a checkout with `git pull`. See the [desktop updater reference](../DESKTOP.md#desktop-updates).

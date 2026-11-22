# Phone relay

Scranton Relay gives your phone access to the dashboard on the computer running the harness. It uses that dashboard's existing projects, chats, and runs. From the phone you can start and stop runs, follow live output, send messages, and answer human review requests.

The relay is explicit opt-in: installing or opening Scranton does not automatically expose a LAN listener. Choose one of the two **private** modes below. Do not use Tailscale Funnel, public router port forwarding, plain phone-facing HTTP, or disabled TLS verification.

## Installed Windows app: no checkout, Node or npm needed

This workflow requires **Scranton Desktop for Windows 0.5.0 or newer**. The **0.4.0** installer does not include the phone relay.

1. Start Scranton normally. Open **Settings → Phone relay** on the PC and note the **current** dashboard port. The desktop app picks a free port; check it again after restarting the app. Do not assume 1725.
2. Find the actual installation folder through the Scranton Start-menu shortcut: right-click → **Open file location**. If this opens a folder containing only a shortcut, use that shortcut's **Properties → Target** or **Open file location** again to reach `scranton-desktop.exe`. Do not assume a fixed install directory.
3. Open PowerShell in that folder, for example by typing `powershell` in Explorer's address bar. It contains the installed `scranton-node.exe` and `app\bin\scranton.js`. These are the runtime and CLI shipped with Scranton; no separate Node/npm installation, repository, or global `scranton` command is needed. Do not edit the installed `app` resources; updates replace them.
4. Set up private Tailscale **Serve** as below, then run this from the installation folder, replacing the example HTTPS origin with the one printed by Serve:

   ```powershell
   $dashboardPort = Read-Host 'Current dashboard port from Settings > Phone relay'
   .\scranton-node.exe .\app\bin\scranton.js relay --origin https://your-computer.your-tailnet.ts.net --target-port $dashboardPort
   ```

   For direct private Wi-Fi HTTPS instead, supply your own certificate/key and private address as explained below. From the same installation folder, the relay command is:

   ```powershell
   $dashboardPort = Read-Host 'Current dashboard port from Settings > Phone relay'
   .\scranton-node.exe .\app\bin\scranton.js relay --origin https://192.168.1.20:8443 --tls-cert "$env:USERPROFILE\Scranton-relay\lan-cert.pem" --tls-key "$env:USERPROFILE\Scranton-relay\lan-key.pem" --target-port $dashboardPort
   ```

   Replace the example IP with the PC's private address covered by the certificate. Those PEM files must already exist; keep them outside the installation folder. The bundled Node provides HTTPS but does not generate certificates for you.

## Checkout usage

The `node bin/scranton.js ...` commands below are for a Scranton **checkout**, run from its root with its Node/npm prerequisites and dependencies already installed. For an installed Windows app, keep the app running and substitute `.\scranton-node.exe .\app\bin\scranton.js relay` from the installation folder for `node bin/scranton.js relay`, always passing the current `--target-port`. Do not start a second dashboard for the installed app.

## Connect on the same Wi-Fi

Use direct HTTPS when the phone and PC are on the same local network. The phone only needs a browser.

1. Start the desktop app or run `node bin/scranton.js visualize --control`. The web dashboard defaults to port 1725. The desktop dashboard shows its port under **Settings → Phone relay**.
2. Find the PC's private IPv4 address. Create or obtain a PEM certificate and key with that IP address in the certificate's subject alternative name. **OpenSSL is not installed by default on Windows and is not bundled as a command with Scranton.** The example requires an independently available OpenSSL installation; otherwise obtain the certificate/key through your own certificate tooling, or use the Tailscale Serve alternative below (no local PEM generation needed). Do not install anything just to run the bundled CLI.

   For example, create a private folder outside the checkout/install folder, then use OpenSSL with an example IP:

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\Scranton-relay" | Out-Null
   openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout "$env:USERPROFILE\Scranton-relay\lan-key.pem" -out "$env:USERPROFILE\Scranton-relay\lan-cert.pem" -subj '/CN=192.168.1.20' -addext 'subjectAltName=IP:192.168.1.20'
   node bin/scranton.js relay --origin https://192.168.1.20:8443 --tls-cert "$env:USERPROFILE\Scranton-relay\lan-cert.pem" --tls-key "$env:USERPROFILE\Scranton-relay\lan-key.pem"
   ```

   Keep the key file private and outside the checkout. Use `--target-port` if attaching to a dashboard on a different port.
   To use a browser-trusted certificate, point a hostname you control at the PC's private IP. Issue the certificate for that hostname using DNS validation, use the hostname in `--origin`, and pass the PC's private IP with `--listen-ip`.

3. Allow inbound TCP to the relay port from the local subnet in the PC's firewall. The dashboard port stays on loopback. Guest Wi-Fi can isolate clients, so use a network that allows devices to reach each other.
4. Open the HTTPS URL on the phone and enter the pairing code printed by Scranton. For a self-signed certificate, establish trust for that exact certificate on the phone using your device's certificate settings and verify its identity/address independently. Do not bypass arbitrary certificate warnings or disable TLS checks; use a browser-trusted certificate or Serve if trust cannot be established. Keep the PC awake while connected.

## Connect through Tailscale Serve

1. Start the desktop app, or run the controlled web dashboard from the Scranton checkout. Tailscale must be separately installed, signed in and configured; it is not shipped by Scranton.

   ```powershell
   node bin/scranton.js visualize --control
   ```

   For a registry dashboard, use `node bin/scranton.js visualize --data .scranton-data`. The web dashboard defaults to port 1725. To attach to the desktop app, open **Settings → Phone relay** and use the currently displayed port as `--target-port`.

2. Connect the computer and the phone to the same Tailscale network. On the computer, run this in a separate terminal and keep it open. The command prints the private HTTPS URL. **Serve**, not **Funnel**, terminates trusted HTTPS inside your tailnet and forwards to the relay on PC loopback; the dashboard itself stays on loopback too. This needs no LAN firewall opening or local certificate/key files. Tailnet access rules still apply.

   ```powershell
   tailscale serve 1726
   ```

   [Tailscale Serve setup](https://tailscale.com/docs/features/tailscale-serve)

3. In another terminal, start the relay with the URL printed by Serve. Replace the example URL with yours.

   ```powershell
   node bin/scranton.js relay --origin https://your-computer.your-tailnet.ts.net
   ```

   With the desktop app or a dashboard on a custom port, also pass `--target-port <dashboard-port>`. If you change the relay's own port with `--port`, use that same port in the Serve command.

4. Open the HTTPS URL in your phone's browser and enter the pairing code printed by Scranton. Keep the computer awake and the dashboard, relay, and Serve running. If you restart the desktop app, check its new dashboard port before restarting the relay.

## Disconnect and pair again

On the phone, use **Settings → Phone relay → Disconnect** to revoke only that phone browser's authenticated session and close its live connections. This does not stop the relay or revoke other paired browsers. Closing a tab alone is not a reliable revocation operation. **Ctrl+C in the relay terminal** stops the relay and disconnects **all** paired browsers. A restart generates a fresh pairing code and invalidates old sessions. Stop the foreground Serve terminal with Ctrl+C too when finished (if you separately configured persistent/background Serve, disable that mapping through Tailscale).

Pairing creates an authenticated browser session; the code is not put in the URL. Sessions last at most 12 hours from pairing, independent of activity; disconnecting (logout) or stopping the relay ends them sooner. An expired or revoked session must pair again. Repeated incorrect codes trigger a temporary pairing cooldown; wait and use the current code from the PC rather than repeatedly guessing. Do not publish screenshots or terminal logs containing the code. Follow the running version's cooldown messages before retrying.

## Network and access

The dashboard listens on `127.0.0.1`. In reverse-proxy mode the relay also listens on loopback. In direct HTTPS mode it listens on the private IPv4 address in `--listen-ip` or `--origin`. You can use another private HTTPS reverse proxy in place of Tailscale Serve. Give the relay a dedicated HTTPS origin at the root path, preserve the original `Host` and `Origin` headers, and stream server-sent events. The proxy target is the relay port, 1726 by default.

Keep the HTTPS origin private. Anyone with the pairing code and access to the origin can read project activity and operate the harness with your privileges. The relay keeps the pairing code and authenticated browser sessions in memory, not as durable logins. Manage provider credentials, sign-in/API keys and agent definitions **only from the local PC dashboard**; the phone relay does not expose those management routes. Phone controls do not include restore-point inspection or Undo/restore; use the PC dashboard or CLI for those operations. A preview URL such as `http://localhost:3000` or `http://127.0.0.1:3000` refers to the device opening it: on a phone it is not the PC, and the relay does not forward arbitrary preview servers. Use the PC for loopback previews; this guide does not expose them.

The own-runtime agent output SSE and tool-approval routes are not added to the relay allowlist. Use the local PC dashboard or `scranton watch` / `scranton approve` in the selected chat scope. Existing journal/activity and human-review relay controls remain distinct from durable tool approvals.

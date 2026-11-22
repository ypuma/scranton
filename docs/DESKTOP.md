# Scranton Desktop (Windows, macOS und Linux)

Die native Tauri-v2-Anwendung startet den lokalen Scranton-Appserver und zeigt Dashboard und Human-in-the-Loop-Steuerung. Die eigene Laufzeit verwendet gebündeltes Node.js 24, eigene Tools, Providerclients, Credentials und dauerhafte Workflows. Keine API-Zugangsdaten im Installer; Modelle laufen bei den konfigurierten Anbietern.

## Voraussetzungen zum Bauen

- Nativer Buildhost passend zur Zielarchitektur (siehe Matrix unten); **Node.js 24 mit eingebauten Drittbibliotheken und ICU-Daten** sowie npm. Nicht jeder lokal lauffähige Node ist paketierbar: Shared-/System-Builds etwa aus Homebrew oder einer Linux-Distribution werden abgewiesen, wenn sie externe Node-/libuv-/OpenSSL-/ICU-Bibliotheken oder nicht erlaubte Loaderpfade benötigen. Geeignet ist ein natives Distributable, das das unten beschriebene Binary-/Konfigurationsgate besteht; weder Herkunftsname noch ein erfolgreicher Host-Smoke reichen. CI behält `actions/setup-node` mit Node 24 und nativer Architektur bei und muss dasselbe Gate bestehen. Die folgenden cmd-Beispiele gelten für Windows.
- Rust stable mit dem nativen Hosttarget (rustup), kein Cross- oder Universal-Build.
- Visual Studio Build Tools mit „Desktopentwicklung mit C++“ und Windows SDK.
- Microsoft Edge WebView2 Runtime. Der Installer bietet bei Bedarf den Download-Bootstrapper an; dafür ist Internet nötig.
- Internet für npm, Cargo und beim ersten Paketieren die NSIS-Werkzeuge.
- Für Pipeline: Python **3.14 x64 mit pip** (zuerst `.scratch/pipeline/venv`, sonst `python` oder `py -3.14`) sowie beim ersten Vorbereiten Netzwerkzugriff auf python.org und PyPI. Auf dem Zielrechner ist keine Python-Installation nötig. Bewusst ohne Pipeline bauen: `set "SCRANTON_SKIP_PIPELINE=1"` vor dem Build; danach zum Wiederaktivieren `set "SCRANTON_SKIP_PIPELINE="`.
- Git auf dem Zielrechner für private Worktrees/Snapshots. Team verwendet standardmäßig die eigene OS-Sandbox; unter Windows benötigt sie den Sandboxhelper, unter Linux bwrap. Docker bleibt optional. Pipeline behält ihre separate Host-/Docker-Checksandbox; [ISOLATION.md](ISOLATION.md), [PIPELINE.md](PIPELINE.md).

```bat
npm.cmd ci
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
npm.cmd run app:dev
```

`app:dev` führt die Vorbereitung automatisch aus und öffnet die native Anwendung. Zum Release-Build:

```bat
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
npm.cmd run app:build
```

Der `beforeBuildCommand` bereitet vor **jedem** Build die Ressourcen vor. Der NSIS-Installer liegt anschließend unter
`src-tauri\target\release\bundle\nsis\Scranton_0.6.0_x64-setup.exe`.
Die Anwendung wird pro Benutzer installiert, ohne Administratorrechte. Das Paket ist ohne separat konfiguriertes Codesigning unsigniert; Windows SmartScreen kann daher warnen.

## Smartphone-Steuerung ohne Checkout (Windows)

Dieser Workflow benötigt **Scranton Desktop für Windows 0.5.0 oder neuer**. Der Installer **0.4.0** enthält den Phone Relay nicht.

Der Relay startet **nur auf ausdrücklichen Wunsch** in einem eigenen Terminal. Die Desktop-App öffnet nicht automatisch einen LAN-Port. Starte die App und lies **Settings → Phone relay** für den aktuellen Dashboard-Port; nach einem App-Neustart kann er anders sein.

Finde den tatsächlichen Installationsordner über die Scranton-Verknüpfung im Startmenü: Rechtsklick → **Dateispeicherort öffnen / Open file location**. Liegt dort nur eine Verknüpfung, öffne deren **Eigenschaften → Ziel** bzw. erneut **Dateispeicherort öffnen**, bis du beim Ziel `scranton-desktop.exe` bist. Öffne PowerShell in **diesem** Ordner (z. B. `powershell` in die Explorer-Adressleiste eingeben). Dort liegen `scranton-node.exe` und `app\bin\scranton.js`; nicht vom Repository oder einem angenommenen Standardpfad ausgehen.

Mit privatem Tailscale **Serve** auf dem Relay-Port 1726, wie in der [Relay-Anleitung](RELAY.md#connect-through-tailscale-serve) beschrieben:

```powershell
$dashboardPort = Read-Host 'Current dashboard port from Settings > Phone relay'
.\scranton-node.exe .\app\bin\scranton.js relay --origin https://your-computer.your-tailnet.ts.net --target-port $dashboardPort
```

Die URL durch die eigene private Serve-URL ersetzen; das Telefon und der PC müssen im selben Tailnet sein. Kein zusätzliches Node/npm, Checkout oder globaler `scranton`-Befehl nötig. Tailscale selbst ist separat einzurichten. Die vollständige Anleitung enthält auch **direktes privates WLAN-HTTPS mit eigenem Zertifikat und Schlüssel**, Checkout-Befehle und TLS-/Firewall-Voraussetzungen. Kein Funnel und keine öffentliche Portweiterleitung verwenden. Auf dem Telefon trennt **Settings → Phone relay → Disconnect** nur diese Sitzung; **Ctrl+C** im Relay-Terminal trennt alle. Zugangsdaten/Agentendefinitionen bleiben lokal zu verwalten, und eine PC-Loopback-Vorschau ist auf dem Telefon nicht erreichbar.

## Daten und Konfiguration

- Registry: `%APPDATA%\dev.scranton.desktop\projects.json`.
- Chats: `%APPDATA%\dev.scranton.desktop\projects\<projectId>\chats\<chatId>\chat.json` und jeweils `hive\`.
- Bisheriger Hive: `%APPDATA%\dev.scranton.desktop\hive` bleibt bei einem Legacy-Import an seinem bisherigen Ort.
- Optionales Env-File: `%APPDATA%\dev.scranton.desktop\.env`
- Legacy-Workspace: `<Windows-Dokumente>\Scranton\workspace` (auch bei umgeleitetem Dokumente-Ordner). Neue Projekte ohne Ordnerangabe verwenden standardmäßig `<Benutzerprofil>\Documents\Scranton\projects\<id>`.
- Fenstergröße/-position werden im App-Datenverzeichnis gespeichert.
- Zugangsdaten und eigene Provider liegen in Scrantons eigenem `store.json`: Windows `%APPDATA%\dev.scranton.desktop\credentials`, macOS `~/Library/Application Support/dev.scranton.desktop/credentials`, Linux `$XDG_DATA_HOME/dev.scranton.desktop/credentials` (Standard `~/.local/share/dev.scranton.desktop/credentials`). `SCRANTON_CREDENTIALS_DIR` überschreibt das Verzeichnis. Beim ersten Initialisieren werden Pi-Logins und Provider einmalig aus `PI_CODING_AGENT_DIR` bzw. `~/.pi/agent` importiert; vorhandene Scranton-Einträge gewinnen. Danach liest oder schreibt Scranton dieses Pi-Profil nicht mehr. Wenn Scranton importierte Tokens erneuert, müssen Pi-CLI-Nutzer sich gegebenenfalls in Pi erneut anmelden. Der Store ist private App-Datenablage, kein verschlüsselter OS-Schlüsselbund.
- Private Schatten-Repositories und Worktrees: `%LOCALAPPDATA%\Scranton\iso\<token>\` (`shadow\` und `w<uuid>\`); ohne `LOCALAPPDATA` unter `<Benutzerprofil>\AppData\Local\Scranton\iso\<token>\`. Überschreibbar durch einen kurzen absoluten `SCRANTON_ISOLATION_ROOT` (leer = nicht gesetzt; realpath-normalisiert, keine Überschneidung mit dem Workspace). Zuordnung zum Run über `<Hive>\isolation\<token>.json` (`storage`, `runId`, `workspace`). Der Pointer wird atomar vor dem Laufverzeichnis geschrieben. Artefakte bleiben nach Erfolg, Fehler oder Abbruch erhalten. Chatentfernung oder Projektentfernung mit Historienlöschung bereinigt zugeordnete Isolationsordner automatisch, sofern sie sicher innerhalb der aktuell konfigurierten Wurzel liegen, nicht in Benutzung sind und die Zuordnung stimmt. Andernfalls scheitert die Entfernung; betroffene Ordner und Registry-Eintrag bleiben erhalten. Details und Grenzen siehe [ISOLATION.md](ISOLATION.md#aufbewahrung-und-bewusste-bereinigung). Dauerhafte Agentenstreams: `<Hive>/dbos.sqlite`, Marker: `<Hive>/agent-step-markers/`. Chat und Mailboxen enthalten sensible Nutzerdaten und werden nicht mit dem Programm ausgeliefert.

Die Kennung wurde vor der ersten Veröffentlichung von `dev.scranton.app` auf `dev.scranton.desktop` geändert. Dadurch verschiebt sich das App-Datenverzeichnis nach `%APPDATA%\dev.scranton.desktop\` (einschließlich `.env` und Fensterzustand). Es gibt keine automatische Migration; bisher wurde nichts veröffentlicht.

Die App startet den Sidecar mit `app-server --data <appData> --legacy-workspace <Windows-Dokumente>\Scranton\workspace`. Existiert noch keine `projects.json`, aber der bisherige `<appData>\hive`, importiert der Server ihn als Projekt **Scranton** (`scranton`) mit Chat **Previous runs** (`legacy`) durch Referenz: Hive und Historie werden **nicht verschoben**. Ohne alten Hive beginnt die Projektliste leer. Dies betrifft nicht die frühere Änderung der App-Kennung oben. Die `.env` wird bewusst **nicht** automatisch mit Schlüsseln angelegt. Beispiel:

```dotenv
ANTHROPIC_API_KEY=dein-schluessel
# Alternativ der Schlüssel des gewünschten Providers, z. B. OPENAI_API_KEY.
```

Nach Änderungen an Umgebungsvariablen oder `.env` die App vollständig beenden und neu starten. Vom gestarteten Prozess geerbte Umgebungsvariablen haben Vorrang. Der gebündelte Node lädt `.env` vor dem CLI-Import; zusätzlich wird `SCRANTON_ENV_FILE` auf diesen Pfad gesetzt. Gestartete Runs erben die Umgebung; Docker erhält keine Providercredentials. Schlüssel gehören weder ins Git-Repository noch in die Paket-Ressourcen. Die Datei liegt unverschlüsselt im Benutzerprofil.

Die mitgelieferte `scranton.config.json` legt Modelle und Agenteneinstellungen fest. Projektordner werden über **New project** registriert; innerhalb eines Chats ist der Workspace an das Projekt gebunden. Das App-Verzeichnis ist kein Workspace: dort installierte Ressourcen werden bei Updates ersetzt.

## Projekte, Chatwechsel und Follow-ups

Die linke Seitenleiste zeigt einklappbare Projekte und deren Chats. **+ New project** fragt Name und absoluten Ordnerpfad ab; ein leeres Pfadfeld erzeugt einen Standardordner. Das Plus am Projekt (**New chat**) öffnet den Run-Dialog für einen neuen Thread. **Rename** und **Remove** sind über das jeweilige Aktionsmenü erreichbar; Entfernen verlangt Bestätigung und löscht niemals Projektdateien. Bei Projekten kann zusätzlich die Scranton-Historie unter dem Datenverzeichnis gelöscht werden. Laufende Chats bzw. ungeklärte Leases blockieren das Entfernen.

Ein Chatwechsel ändert nur die Ansicht, beendet keinen Run. Hintergrund-Chats mit Rückfragen tragen **needs you**; der Link `#/p/<project>/c/<chat>` wählt einen Thread. Im Chatkopf wechselt die Run-Auswahl zwischen aktuellem Live-Run und schreibgeschütztem Replay früherer archivierter Runs. Zurück zur Live-Ansicht wechseln, um wieder zu steuern.

**Follow up** (auch Strg+Enter) startet den nächsten Run im selben Chat mit früheren Runs als begrenztem Planungskontext. Während eines Runs oder einer Wiederherstellungsblockade ist der Composer gesperrt; zum Eingreifen während eines Runs dient weiterhin der Instanz-Chat. Mehrere Chats/Projekte laufen parallel bis `maxConcurrentRuns` / `SCRANTON_MAX_RUNS` (Standard 4), ein Run pro Chat. Das ist unabhängig von den Pipelines pro Run und erhöht nicht das gemeinsame Rate-Limit eines Abos.

## Accounts: Abos, API-Keys und eigene Provider

In der App **Accounts** → **Sign in** bei **Claude (Pro/Max)** oder **ChatGPT** wählen. Der lokale Server öffnet den **Systembrowser**, nicht die WebView. Die Callback-Ports `127.0.0.1:53692` (Claude) und `127.0.0.1:1455` (ChatGPT) müssen frei sein. Anmeldung im Browser abschließen; falls nötig, Code oder vollständige Weiterleitungsadresse in der Accounts-Seitenleiste einfügen. Die Adresse lässt sich dort kopieren, falls der Browser nicht automatisch öffnet. **Cancel** bricht den Versuch ab; **Sign out** entfernt den gespeicherten Provider-Zugang nach Bestätigung, nicht etwaige Umgebungs-Keys. Während eines Laufs kann Abmelden weitere Modellaufrufe beeinträchtigen.

Google-Konto-OAuth erfolgt über **Google Antigravity**, mit vollständiger state-matching Redirect-URL und Projektauflösung durch Google. Inoffizielle Drittclient-Anbindung, keine Quota-/Entitlementgarantie. Eigener Credentialadapter und LLM-Client laufen auf dem Host, auch wenn Docker die Tools ausführt. Keine Brokerberechtigung oder Tokenprojektion.

Gemini (`google`) verwendet **Add API key**; OAuth für dieses Provider-ID ist derzeit nicht implementiert. Antigravity bleibt unabhängig. Auch Claude/ChatGPT unterstützen API-Keys; Keys werden im eigenen Store gespeichert, niemals über die API zurückgegeben. Gespeicherte Zugänge haben Vorrang vor Umgebungs-Keys.

Eigene Provider: ID, HTTPS-/Loopback-Basis-URL, API-Typ, Key und deklarierte oder per **Fetch models** ermittelte Modelle. Definition und Key liegen atomar im eigenen Store; bestehende IDs werden nicht überschrieben. Remove entfernt nur die eigene Deklaration und deren Zugang. Keine Änderungen an Pi-Dateien; [README](../README.md#anmelden).

Unter **Options → Models** gelten Rollenwahlen in jedem Team-Sandboxmodus. Leere Wahl übernimmt den Agent-Default, sonst **Automatic** (Claude → OpenAI → Gemini → Antigravity → Vertex, jeweils mit explizitem Neuestes-Modell-Marker in `llm/catalogue.js`; ChatGPT-Modus: `gpt-6.2-sol` nach Nutzerwahl, direktes OAuth und API-Keys: API-Katalog. Neue Releases benötigen Katalogupdates, keine Live-Modellabfrage). Ohne passendes Konto scheitert der Start; eigene Provider brauchen explizite Auswahl. Katalogpräsenz garantiert keine Modellberechtigung. Overrides gelten nur für den gestarteten Run.

Docker ist ein optionaler Tool-Executor: LLM, Tokens und Workflows bleiben auf dem Host. `none` sperrt das Toolnetz, nicht Modellanfragen. Windows Low kann Netzwerk nicht sperren und verwendet PowerShell statt Git Bash. Normale Benutzer-Credentialverzeichnisse brauchen ausdrückliche Härtung; nur Scrantons eigener Store wird durch Integration geschützt. Exakte OS-Grenzen: [ISOLATION.md](ISOLATION.md).

Historische Broker-/Pi-Prüfungen belegen die neue Laufzeit nicht. Reale Anmeldung, Providerakzeptanz, native macOS-/Linux-Sandbox und installierter Lifecycle sind separat zu prüfen; in diesem Dokumentationspass nicht ausgeführt.

## Integrierte Titelleiste

Die Desktop-App verwendet die obere Dashboard-Leiste statt einer separaten Windows-Titelleiste. Rechts liegen **Minimize**, **Maximize / Restore** und **Close**; freie Bereiche der Leiste dienen zum Ziehen, ein Doppelklick maximiert bzw. stellt wieder her. Im normalen Browser bleibt die Fenstersteuerung ausgeblendet. Das Fenster bleibt an den Rändern größenveränderlich; der native Schatten ist ausdrücklich aktiviert. Windows kann dabei einen hellen 1-Pixel-Rand und unter Windows 11 abgerundete Ecken zeichnen.

Alternativen: **Alt+F4** schließt über denselben geregelten Beenden-Pfad, **Win+Pfeiltasten** nutzt die Windows-Fensteranordnung. Das Tray-Menü bietet weiterhin **Show / Hide** und **Quit**. Die gespeicherte Maximierung wird weiterhin durch das Window-State-Plugin wiederhergestellt.

Prüfgrenze: Konfiguration, enge Capability und Rust-Kompilierung werden automatisiert geprüft; die installierten Tauri-/Tao-Quellen zeigen Rand-Hit-Testing, Maximierung auf die Monitor-Arbeitsfläche und Zustandswiederherstellung. Die neue native Titelleiste wurde hier **nicht gestartet oder am Desktop bedient**. Schatten/Rand unter Windows 10/11, DPI-/Mehrmonitorverhalten, Win+Pfeiltasten, Ziehen, tatsächliche IPC-Aufrufe und Beenden müssen am gestarteten Build geprüft werden. Quellprüfung bzw. gemockte UI-Tests sind kein nativer Laufzeitnachweis.

## Verhalten und Sicherheit

- Das Hauptfenster startet unsichtbar und mit dunklem Hintergrund; nach der JSON-Ready-Zeile des Servers erscheint das Dashboard. Der Server bindet an `127.0.0.1` auf einem freien Port. Nach 20 Sekunden ohne gültige Ready-Zeile erscheint ein nativer Fehlerdialog mit dem letzten stderr-Ausschnitt.
- Eine zweite Instanz fokussiert das vorhandene Fenster. Das Tray-Menü bietet **Show / Hide** und **Quit**; der Tooltip „Scranton — Human needed“ basiert auf `GET /api/control` → `pendingHuman`, nicht auf dem möglicherweise veralteten Hive-Snapshot. Nur ein noch lebender Run kann ihn aktivieren.
- Die Hülle überwacht den Sidecar auch nach der Ready-Zeile. Bei unerwartetem Exit erscheint ein nativer Fehlerdialog mit Exitstatus und bis zu 8 KiB stderr-Ende. **Restart** startet den Server neu und lädt dessen neue URL; **Quit** beendet die App. Es gibt keine automatische Neustartschleife.
- Das Fensterkreuz beendet die App (nicht nur ins Tray minimieren). Beim Beenden sendet die Hülle `quit` über stdin; nach fünf Sekunden wird nötigenfalls der Prozessbaum mit `taskkill /T /F` beendet. Ein harter OS-Abbruch kann diese Aufräumphase verhindern; der Server beendet sich zusätzlich bei stdin-EOF.
- `withGlobalTauri: true` stellt unter anderem `window.__TAURI__.notification` und `window.__TAURI__.window.getCurrentWindow()` bereit. Die drei aktiven Capabilities gelten ausschließlich für das Fenster `main`, nicht für lokale Seiten (`local: false`), und für `http://127.0.0.1:*` bzw. `http://localhost:*`.
- Im Windows-Release mit WebView2 per CDP geprüft: Auch mit dem vom Server gelieferten `default-src 'self'; script-src 'self'; ...; connect-src 'self'` bleiben die injizierten Tauri-Globals und die IPC-Aufrufe für Benachrichtigungsberechtigung und Versand funktionsfähig. Dafür ist auf diesem Windows-Build keine `connect-src`-Erweiterung nötig. Nicht freigegebene Dateisystem-IPC bleibt gesperrt. Andere Plattformen/WebViews wurden nicht geprüft.
- Freigegeben sind ausschließlich die drei Benachrichtigungsrechte `notification:allow-is-permission-granted`, `notification:allow-request-permission`, `notification:allow-notify`, der vorhandene Ordnerdialog `dialog:allow-open` sowie die fünf Titelleistenrechte `core:window:allow-minimize`, `core:window:allow-toggle-maximize`, `core:window:allow-close`, `core:window:allow-is-maximized`, `core:window:allow-start-dragging`. Keine Default-Permissions, Shell-, Dateisystem- oder weiteren Core-Rechte für die Webseite. JS-`close()` löst `CloseRequested` aus; der vorhandene Rust-Handler fängt es ab und beendet den Sidecar geordnet.
- Der variable Port erfordert eine Loopback-Port-Wildcard. Auch andere lokale Dienste auf diesen Hosts liegen deshalb im Ursprungsscope, erhalten aber nur die oben aufgezählten Benachrichtigungs-, Dialog- und Titelleistenrechte. Navigation erfolgt beim Start nur auf eine geprüfte `http://127.0.0.1:<port>`-URL.
- Notification-Anzeige hängt von Windows-Berechtigungen/Benachrichtigungseinstellungen ab. In der Entwicklungsumgebung kann Windows PowerShell-Identität/Icons anzeigen; für die endgültige Anwendungsidentität den installierten Build verwenden.

Capability-Syntax geprüft gegen die [Tauri-v2-Capabilities-Dokumentation](https://v2.tauri.app/security/capabilities/) (Abschnitt Remote API Access) und die beim Build generierten Schemas. Die Kennung `dev.scranton.desktop` vermeidet die macOS-Warnung zum `.app`-Suffix.

## Paketierung und Wartung

`scripts/prepare-desktop.mjs` prüft natives Node und Rust-Hosttarget, kopiert App-Ressourcen frisch und installiert Produktionsabhängigkeiten separat. Es stagt `tools/completion-client.js`, `tools/pipeline-complete.js`, `tools/dreaming-complete.js`, `scripts/runtime-smoke.mjs`, Notices und Tools-Lock. Der Sandboxhelper wird aus `native/sandbox-helper/` gebaut, als `scranton-sandbox-helper-<target>[.exe]` unter `src-tauri/binaries/` abgelegt und über `bundle.externalBin` ausgeliefert. Hashgeprüfte rg/fd-Binaries kommen über `stageTools`; keine Runtime-Downloads durch Agententools. Dockerimage, Nutzerprofile und Credentials sind nicht enthalten.

Das Node-Gate in `scripts/desktop-platform.mjs` verlangt Majorversion 24, passende PE-/ELF64-/dünne Mach-O-CPU, explizit deaktivierte Shared-Buildoptionen (`node_shared*`) und eingebautes vollständiges ICU (`icu_small=false`, `icu_gyp_path=tools/icu/icu-generic.gyp`). Zusätzlich liest es die Loaderdeklarationen direkt aus den Binarybytes, ohne `ldd` und ohne Abhängigkeit vom Bibliotheksbestand des Buildhosts: ELF `DT_NEEDED` darf nur `libc`, `libm`, `libdl`, `librt`, `libpthread`, `libstdc++` und `libgcc_s` mit den im Gate exakt erlaubten SONAMEs referenzieren; der glibc-Interpreter muss zur CPU passen. RPATH/RUNPATH, Audit-/Filterloads werden verweigert. Mach-O erlaubt nur die exakten Systempfade für `libSystem.B`, `libc++.1`, CoreFoundation und Security, keine `@rpath`-/Homebrewpfade, RPATH-, Environment-, Lazy- oder Upward-Loads. PE erlaubt nur die im Gate aufgezählten Windows-System-DLLs, keine Delay-Imports. Fehlende, unbekannte oder beschädigte Loaderdaten brechen ab. Das ist **kein vollständig statisch gelinkter Node**: die erlaubten OS-/C-/C++-Systembibliotheken bleiben Zielsystemvoraussetzungen. `packaging-manifest.json` hält Gatepolicy, deklarierte Abhängigkeiten und Node-SHA-256 fest; dies ersetzt keinen Start auf dem ältesten unterstützten Zielsystem.

Produktionsabhängigkeiten entstehen frisch mit `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, nicht durch Übernahme des Host-node_modules. Einzige direkte Runtimeabhängigkeit ist `@dbos-inc/dbos-sdk` 5.6.0 für optionales Postgres; SQLite ist Node-intern. Pi-Pakete sind entfernt. `packaging-manifest.json` protokolliert Node-/Helper-/Tools-/Lock-Hashes, Runtime-Smoke und Pipeline-Metadaten, keine Credentials.

Nach Vorbereitung startet das gebündelte Node den gestagten `scripts/runtime-smoke.mjs` mit leerem PATH und isoliertem Scratchprofil. Der Smoke verbietet Netzwerk, prüft Agentimport/SQLite und scripted Dreaming-/Pipeline-Completions. Gates: `npm.cmd run app:prepare`, danach `node --test "test/**/*.test.js"`; separat `npm.cmd run test:packaging`. Nach Quelländerungen neu vorbereiten. Diese Dokumentationsarbeit hat keinen neuen Build oder Installer ausgeführt; Staging/Smoke sind kein realer Modell-, Sandbox- oder nativer Lifecycle-Nachweis.

### Gebündelte Pipeline-Laufzeit

Die Pipeline benötigt `tools/pipeline-complete.js` und `tools/completion-client.js` in den App-Ressourcen. Die Host-Bridge verwendet eigene Clients/Credentials für tool-/sessionlose Completions, Kataloganzeige `via:"bridge"`. Kein Python-Wheel, kein Pi-Extensionloader und kein Checkcontainer. Stagingtests ersetzen keinen echten Providerlauf.

Zusätzlich wird eine private portable Pipeline unter `engine-runtime/` ausgeliefert: Windows x64 verwendet offizielles Embeddable-CPython **3.14.8**, macOS/Linux die gepinnten Astral-`python-build-standalone`-Archive **CPython 3.14.10**, Release **20261110**, jeweils für den nativen Host. Die plattformspezifischen Runtime-Locks pinnen URL, Version und SHA-256; Requirements-Locks pinnen die dazu passenden Wheels. Windows verwendet weiterhin `engine/runtime-lock.json` und `engine/requirements.lock`; POSIX-Locks liegen separat unter `engine/`. Die konkrete Lockauswahl ist in `scripts/desktop-runtime.mjs` festgelegt. Abhängigkeiten werden ausschließlich aus hashverifizierten Wheels installiert (`--require-hashes --only-binary=:all: --no-compile`), nie systemweit. Private `site-packages/` enthalten die Runtime-Closure plus frisch kopiertes `scranton_pipeline`, Demo-Daten und das Pipeline-Sandboxrezept. Tests, Buildtools, Credentials und Bytecode-Caches werden nicht ausgeliefert. Die einzige PEM-Ausnahme im privaten Wheelbaum ist die **reguläre Datei** `site-packages/certifi/cacert.pem`: die öffentliche CA-Liste des hashgepinnten certifi-Wheels, keine Zugangsdaten. Andere PEM-/Key-/P12-/PFX-Dateien bleiben ausgeschlossen, auch gleichnamige Dateien in anderen oder verschachtelten Paketen.

`engine-runtime/launch.json` legt Schema, Plattform, Architektur und Start fest:

```json
{"schema":1,"platform":"darwin","arch":"arm64","executable":"python/bin/python3","args":["-I","-B","bootstrap.py"]}
```

Windows verwendet `platform:"win32", arch:"x64", executable:"python/python.exe"`; Linux `platform:"linux"` mit x64 oder arm64. Der Node-Resolver prüft das Manifest und löst Interpreter und `bootstrap.py` absolut innerhalb der Runtime auf; nicht vom aktuellen Workspace abhängig. `-I` isoliert den Interpreter von Benutzer-/Umgebungspfaden, `-B` unterdrückt Bytecode; der Bootstrap bindet nur die privaten Sitepakete ein. Windows behält seine isolierte `python314._pth`. Alte Windows-Pakete **ohne** Launchmanifest bleiben mit `python/python.exe -m scranton_pipeline` kompatibel; ein vorhandenes ungültiges Manifest darf nicht still in diesen Fallback gehen. Endnutzer brauchen weder Python noch pip, und es gibt keinen automatischen Systemruntime-Download.

Downloads, Wheels, pip-Cache und Tempdateien liegen unter `.scratch/pipeline/`, nach OS/Architektur/Locks getrennt und vor Wiederverwendung gehasht. Ein ungültiger Cache führt zum Fehler; nur den benannten beschädigten Cache bewusst entfernen. `src-tauri/staged/pipeline-cache.json` ist ein lokaler Beschleunigungsbeleg, keine verteilte Ressource. Die Vorbereitung startet immer den gestagten Interpreter isoliert mit leerem PATH für `version` und `graph --format mermaid`; das Packaginggate führt zusätzlich die scripted Demo bis zum Plan-Gate aus. Das Manifest protokolliert Plattform/Architektur, Runtime-/Engineversion, Startmanifest, Dateibaum und Requirements-Hash. Das ist kein installierter App- oder Modellrundlauf. Fehlende Buildruntime/verifizierte Archive brechen ab; nur bewusstes `SCRANTON_SKIP_PIPELINE=1` entfernt die Runtime und setzt `pipeline:null` (in der nativen CI nicht erlaubt).

Frühere Messung des zusätzlichen Ressourcenbedarfs am 09.11.2026 (vor den späteren Enginekorrekturen, keine aktuelle Baum-/Releaseidentität): rund **61,55 MiB** (64.535.048 Bytes, 3.776 Dateien; davon CPython 24.405.943 Bytes, Wheels und Engine 40.129.105 Bytes). Enthalten sind 36 `.pyd`, 10 `.dll` und ein Standardbibliothek-`.zip`. Ein separat komprimierter ZIP-Vergleich ergibt rund 22,89 MiB; das ist **keine** Messung des NSIS-Installerzuwachses. Die tatsächliche Installergröße hängt von dessen Kompression und dem vollständigen Release ab und muss nach einem echten `app:build` gemessen werden.

Die vorhandene Tauri-Ressourcenzuordnung `"staged/app/": "app/"` kopiert laut [Tauri-Ressourcendokumentation](https://v2.tauri.app/develop/resources/) Verzeichnisse rekursiv und ohne Dateiendungsfilter. Daher brauchen `.pyd`, `.dll` und `.zip` keine eigenen Globs. Der Rust-Sidecar startet unverändert Node aus `resources/app` (Entwicklung: `staged/app`); der Node-Resolver findet Python darunter. Weder neue Rust-Kommandos noch neue WebView-Berechtigungen sind erforderlich. Tauris Ressourcenkopie folgt Datei-Symlinks und schreibt deren Inhalt als reguläre Dateien; Verzeichnis-Symlinks sind dagegen kein verlässlicher rekursiver Ressourcenvertrag. Die vier lokal vorliegenden, gegen ihre Runtime-Locks SHA-256-geprüften POSIX-Archive (Release 20261110) wurden vollständig geprüft: Darwin x64/arm64 jeweils 9 Datei-Symlinks, Linux x64/arm64 jeweils 1048 Datei-Symlinks, **keine Verzeichnis-Symlinks**, auch nicht über Linkketten. Die Linux-Terminfolinks werden ohnehin entfernt. Deshalb wird nichts vorsorglich materialisiert; Extraktion und Runtime-Fingerprint verweigern Verzeichnislinks für künftige Archive bzw. veränderte Caches. Im nativen Installationsgate bleiben `python/bin/python3`, relative Bibliotheksauflösung, SQLite/SSL/certifi sowie `version`, `graph` und Demo aus den **installierten** Ressourcen zu prüfen; ein archivbasierter Windows-Probe ist kein POSIX-Installationsnachweis.

Dass der fertige NSIS-Installer alle Dateien tatsächlich installiert und der installierte Release startet, ist erst am gebauten Installer nachzuweisen; Staging allein beweist das nicht.

`npm.cmd run test:packaging` prüft zusätzlich Manifest/Dateibaum, ausgeschlossene Dateien, den Resolver aus der **gestagten** Node-Kopie sowie `demo --run-root <Projekt-Scratch> --delivery patch` mit normalem PATH für Git: erwartet werden Exit 3 und genau eine JSON-Zeile mit `awaiting_approval` / Gate `plan`. Die Demo verwendet Skriptmodelle ohne Anbieteraufruf. Das belegt Importierbarkeit, Graph-Kompilation, Demo-Daten, Git/SQLite und das erste Human-Gate, aber weder echte Modellzugänge noch spätere Freigaben, vollständige Auslieferung, Docker oder den nativen Installer-Lifecycle. Bei bewusst ausgelassener Pipeline werden die Engine-Tests mit Begründung übersprungen. Gesamtprüfstand Packaging: **6 Tests, Stand 2026-11-09 abends**, hier nicht erneut ausgeführt; für einen Release nach diesen Dokumentationsänderungen neu vorbereiten und prüfen.

Das monochrome Icon entsteht reproduzierbar mit `npm.cmd run app:icon` aus einem selbst geschriebenen PNG-Encoder (`node:zlib`) und Tauri Icon. Die erzeugten Icons sind eingecheckte Build-Eingaben. `src-tauri/icons/icon.ico` kann unverändert als `visualizer/public/favicon.ico` übernommen werden; `32x32.png` ist die PNG-Alternative (mit passendem HTML-Link). Die native Paketierung braucht diese Browser-Kopie nicht.

`SCRANTON_DESKTOP_STUB` wird bei der Vorbereitung ausdrücklich abgewiesen; ein alter Entwicklungsstub darf nicht versehentlich ausgeliefert werden.

## Parallelbetrieb und lokaler Prüfstand

Echte Team-Läufe verwenden dauerhafte Agentenworkflows, private Worktrees und die eigene OS-Sandbox. Explizites Docker bleibt tool-only und fail-closed; Hostmodus benötigt Vertrauen. Parallelität zählt Meilenstein-Pipelines. QA prüft exakt Dwights Snapshot, QA-Änderungen werden nicht integriert. Chat adressiert Instanzen; delivered bestätigt die Steering-Queue, nicht Modellverarbeitung. Keine automatische Wiederholung bei unknown. Team-Neuplanung bleibt aus; Pipeline besitzt ihren eigenen begrenzten Neuplanungsablauf.

Stabile Session-IDs laden keine Pi-Historie. Jeder Aufruf hat einen Workflow mit dauerhaften output/history-Streams; explizite Invocation-Keys ermöglichen Reattachment. Keine automatische Wiederaufnahme des gesamten Orchestrator-Runs. SQLite und Marker je Chat aufbewahren; keine Pi-Sessionverzeichnisse als neue Transcriptquelle.

Nach einem Sidecar-Absturz prüft der Server die dauerhafte Lease `hive/control/owner.json` und den alle 5 s vom Run geschriebenen Heartbeat. Ist dessen PID nachweislich beendet (`gone`) und die Containerbereinigung verifiziert (oder kein Docker verwendet), wird der Run automatisch als abgebrochen abgeschlossen; der Chat kann danach einen neuen Run starten. `alive` erlaubt weiterhin **Request stop**. Ohne passenden Heartbeat oder bei veraltetem Heartbeat mit noch existierender PID gilt `unknown`: **Release chat** erst nach unabhängiger Prüfung bestätigen, dass der Run beendet ist. Sonst könnten zwei Runs denselben Chat verwenden. Die Freigabe protokolliert `Released by the user`, entfernt Lease/Heartbeat/Stop-Auftrag und erledigt die offene Rückfrage; Historie, Sessions und Worktrees bleiben erhalten. Passende Scranton-Container werden bereinigt. Automatische Wiederherstellung behält bei unerreichbarem Docker oder fehlgeschlagener Entfernung die Lease und zeigt `recoveryError`; nur eine ausdrücklich bestätigte manuelle Freigabe kann mit diesen Warnungen fortfahren. Ein regulär beendeter Run mit ungeklärtem Cleanup schreibt `cleanup:"unresolved"` samt Grund in den Heartbeat, bleibt `unknown` und gesperrt; angezeigt wird `Cleanup of this run could not be verified: <reason>`. Während automatischer Wiederherstellung antwortet Release mit 409 und `Recovery is already in progress. Try again in a moment.`; andere Chats warten nicht auf die Docker-Aufrufe. Konfliktantworten werden nicht als Wiederherstellungsfehler gespeichert; Fehler verschwinden bei erfolgreicher Freigabe oder Wechsel des verwaisten Runs. Ein Absturz vor dem ersten Run-Ereignis archiviert bei Wiederherstellung die alte Historie und protokolliert den neuen Run als begonnen und abgebrochen. Leere, nachweislich verwaiste oder mehr als fünf Minuten alte Recovery-Locks werden übernommen; dies erlaubt kein altersbasiertes Löschen der Run-Lease. Andere Fehler behalten die Lease und werden angezeigt. Keine gespeicherte PID wird blind beendet. Die Hülle gewährt beim Beenden 5 s für `quit`/Cleanup; `taskkill /T /F` danach kann auch Run-Kinder ohne Chance auf `guardParent`-Abbruch hart beenden. Die Wiederherstellung beim nächsten Start deckt diesen Fall ab. Startup-IPC und stdin-Watchdog bleiben unverändert. Details: [CONTROL.md](CONTROL.md), §6.

Die oben beschriebene frühere WebView2-/Benachrichtigungsprüfung ist kein Nachweis für neue Laufzeitfunktionen. Fake-/Protokolltests ersetzen keinen Installer-/nativen Lifecycle-Test. Docker Desktop ist inzwischen eingerichtet; ein begrenzter Docker-/ChatGPT-Smoke-Test mit `OK`, Exit 0 und verifiziertem Cleanup ist in [ISOLATION.md](ISOLATION.md) dokumentiert. Vollständige Pipeline- sowie native Start-/Abbruch-/Neustart-/Cleanup-Prüfungen sind weiterhin separat am jeweiligen Release zu belegen. Ein Build allein ist kein Lifecycle-Nachweis.

## Deinstallieren

Deinstallieren entfernt Programmdateien, nicht Hive, Credentialstore, .env oder Workspace. Nach dem Beenden bei Bedarf gesondert sichern/entfernen. Das einmalig gelesene Pi-Profil bleibt unangetastet und kann anderen Anwendungen gehören.

## Native Builds und CI-Matrix

Die fünf **Buildziele** werden getrennt gebaut; es gibt kein Universalpaket, keinen Cross-Target-Download eines fremden Node und keinen System-Python-Fallback beim Nutzer. Ein fertiges macOS-Paket ist erst nach erfolgreichem nativen Build **und** separater Installations-/Lifecycleprüfung nachgewiesen. In diesem Windows-Entwicklungsdurchlauf wurden keine macOS-/Linux-App gestartet oder deren Installer ausgeführt.

| System / Architektur | Rust-Hosttarget | GitHub-Runner | Automatisches Tauri-Overlay / Ausgabe |
|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | `windows-2022` | `tauri.windows.conf.json`: NSIS `.exe` |
| macOS Apple Silicon | `aarch64-apple-darwin` | `macos-15` | `tauri.macos.conf.json`: `.app` und `.dmg` |
| macOS Intel | `x86_64-apple-darwin` | `macos-15-intel` | `tauri.macos.conf.json`: `.app` und `.dmg` |
| Linux glibc x64 | `x86_64-unknown-linux-gnu` | `ubuntu-22.04` | `tauri.linux.conf.json`: `.deb` und `.AppImage` |
| Linux glibc arm64 | `aarch64-unknown-linux-gnu` | `ubuntu-22.04-arm` | `tauri.linux.conf.json`: `.deb` und `.AppImage` |

Runnerlabels gemäß [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), abgerufen am 11.11.2026: **`macos-15` ist arm64**, Intel verlangt **`macos-15-intel`**. Keine veraltete Annahme `macos-latest = Intel`. Runnerverfügbarkeit und enthaltene SDKs können sich ändern; der Workflow prüft Node-Plattform/-Architektur und `rustc -vV` vor dem Build. Tauri lädt das OS-Overlay automatisch; nicht mit `--target` auf einen anderen Host ausweichen.

### macOS und Linux lokal vorbereiten

macOS: Xcode Command Line Tools und Rust stable separat installieren, auf genau der Zielarchitektur arbeiten. Node 24 und Build-Python 3.14 mit pip müssen nativ verfügbar sein, nicht unter einer unbeabsichtigten Rosetta-Übersetzung. Die aktuelle Node-Komponente verlangt macOS **mindestens 13.5**; das Overlay setzt dieselbe Deploymentuntergrenze. Linux: glibc, kein musl; Node 24 verlangt mindestens **glibc 2.28**. Das sind **Komponentenuntergrenzen, keine verifizierten Mindestversionen der gesamten App**: Python, Wheels, WebKitGTK und die beim nativen Build gelinkten Bibliotheken können neuere Systeme verlangen. Ubuntu-22.04-Builds beweisen insbesondere keine Kompatibilität auf beliebigen glibc-2.28-Systemen. Auf dem ältesten versprochenen Zielsystem separat prüfen, bevor ein Release diese Zusage macht.

Ubuntu 22.04 (x64 oder arm64), Buildabhängigkeiten:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2 file desktop-file-utils xdg-utils
```

AppImage-Builds in CI verwenden `APPIMAGE_EXTRACT_AND_RUN=1`, damit die Werkzeuge nicht von einem FUSE-Mount im Runner abhängen. Dies ist keine Zusage, dass jede Zielumgebung AppImages ausführen kann. WebKitGTK 4.1 und die im Paket deklarierten Bibliotheksabhängigkeiten bleiben Laufzeitvoraussetzungen unter Linux; keine Windows-WebView2-Installation dort.

Im nativen macOS-/Linux-Checkout, nach Bereitstellung von Node 24, Rust stable und Python 3.14:

```sh
npm ci
npm run app:prepare
node --test --test-concurrency=1 "test/packaging/*.test.js"
cargo test --manifest-path src-tauri/Cargo.toml
npm run app:build
```

Bei einem macOS-Start über Finder kann PATH anders als in der Terminal-Shell sein. Der Ruststarter ergänzt ausschließlich für den Darwin-Node-Sidecar fehlende Einträge `/usr/local/bin`, `/opt/homebrew/bin`, `/Applications/Docker.app/Contents/Resources/bin` und `$HOME/.docker/bin`; bestehende Einträge behalten Vorrang, leere Einträge und Duplikate werden entfernt. Windows/Linux bleiben unverändert. Das installiert weder Git noch Docker und liest keine Shell-Startupdateien. Die tatsächliche Finder-/Git-/Docker-Auflösung bleibt am nativen Macpaket zu prüfen.

Die Windows-Befehle weiter oben verwenden `npm.cmd` und MSVC/WebView2 statt der POSIX-Werkzeuge. Artefakte liegen unter `src-tauri/target/release/bundle/{nsis,macos,dmg,deb,appimage}` je nach Host. Anwendung, Node-Sidecar und Ressourcen gemeinsam verteilen, niemals nur das einzelne Programm. Git und gegebenenfalls eine Linux-Docker-Engine sind weiterhin separat nötig. Nutzerdatenpfade der Windows-Abschnitte sind Windows-Beispiele; auf macOS/Linux verwendet Tauri das jeweilige native App-Datenverzeichnis. Den aktuellen tatsächlichen Pfad prüfen, bevor Daten gesichert/entfernt werden.

### Workflow, Artefakte und Signierung

**Checks und native Builds laufen standardmäßig lokal auf dem Entwicklerrechner, nicht auf GitHub Actions.** `.github/workflows/desktop-native.yml` hat ausschließlich den manuellen Trigger `workflow_dispatch`, keine automatischen Push-, Pull-Request- oder Zeitplantrigger. Ein Cloudlauf über **Actions → Native desktop builds → Run workflow** ist nur eine Ausnahme nach neuer ausdrücklicher Zustimmung des Nutzers, niemals der automatische oder standardmäßige Buildweg; das gilt auch für Wiederholungen fehlgeschlagener Cloudläufe.

Unter Windows aus dem Projektroot mit den oben genannten Voraussetzungen, nacheinander:

```bat
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
npm.cmd run app:prepare
node --test --test-concurrency=1 "test/packaging/*.test.js"
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run app:build
```

Die lokalen Pakete liegen unter `src-tauri/target/release/bundle/`, unter Windows der NSIS-Installer in `nsis/`. Windows baut ausschließlich Windows; macOS- und Linux-Pakete benötigen jeweils einen nativen Builder mit passender OS-/CPU-Architektur und den Voraussetzungen aus den Abschnitten oben. Ein lokaler Windows-Build liefert keinen plattformübergreifenden Build- oder Laufzeitnachweis.

Der nur ausnahmsweise manuell freigegebene GitHub-Workflow behält seine Gates bei. Pro nativem Host: Node 24, Rust stable und Python 3.14, `npm ci`, serielle portable Core-/Resolver-/CSP-Gates und Python-Dateirechte-/Sandbox-User-Gates (`test_fs_modes.py`, `test_snapshot_modes.py`, `test_sandbox_user.py` nach Installation von `engine[dev]`), `app:prepare` einschließlich credential-freier eigener Runtime-/Pipeline-Smokes, Manifestpflichtprüfung, vollständige serielle Packagingtests, Rusttests, `app:build`. Die Pipeline darf dabei nicht absichtlich ausgelassen werden. Tests werden nicht pauschal auf Nicht-Windows übersprungen; Plattformregressionen sollen den betreffenden Job scheitern lassen. Das ist ein begrenztes Buildgate, **nicht die vollständige JS-/Python-/UI-Testsuite**. Diese weiter separat lokal und seriell ausführen. Weder echte OAuth-/Modellaufrufe noch Docker-Imagebuilds sind CI-Bestandteil.

Nur bei einem ausdrücklich freigegebenen Cloudlauf wird jedes Format separat hochgeladen, mit OS/Architektur und **unsigned** im Namen, 14 Tage Aufbewahrung; fehlende Dateien führen zum Fehler. Das `.app` liegt als `.app.tar.gz` vor, damit Unix-Rechte und Symlinks beim Artefakttransport erhalten bleiben. DMG, NSIS, DEB und AppImage haben eigene Downloads. Der Workflow veröffentlicht **keinen GitHub Release**, pusht nicht und verändert keine Repositorydateien im Remote.

Diese CI ist absichtlich **unsigniert** und braucht keine Signing-Secrets. Windows SmartScreen und macOS Gatekeeper können warnen oder den Start blockieren; dies ist kein notarisiertes, öffentlich freigegebenes Macpaket. Sicherheitsprüfungen nicht pauschal deaktivieren. Signierung/Notarisierung ist ein separater geschützter Maintainerprozess: Apple Developer ID mit `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` sowie Notarisierungszugang (z. B. `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, alternativ API-Key-Verfahren gemäß aktueller Tauri-Doku); Windows-Codesigning entsprechend Zertifikat und Signaturwerkzeug. Keine solchen Secrets in PR-Jobs geben. Ein späterer optionaler Signierjob muss bei nicht konfigurierten Secrets ausbleiben, ohne die unsignierten Buildjobs zu blockieren. [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).

Vor öffentlicher Verteilung pro OS/Architektur nachweisen: Installation aus dem tatsächlichen Artefakt, nativer Start/Ready/WebView, Ordnerdialog, bestehende Chats, Offline-Pipeline-Demo durch die Gates, Schließen/Abbruch/Neustart und Kindprozessbereinigung. Ein Windows-Smoke oder ein CI-Build ersetzt diesen Nachweis auf macOS/Linux nicht. Auch ein partieller Linux-Docker-Smoke prüft weder die native Linux-WebView noch macOS/WKWebView und darf nicht als solcher Laufzeitnachweis gelten.

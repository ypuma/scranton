# Scranton Desktop (Windows x64)

Die native Tauri-v2-Anwendung startet den lokalen Scranton-App-Server und zeigt das vollständige Dashboard mit Run- und Human-in-the-Loop-Steuerung. Node.js und die Produktionsabhängigkeiten einschließlich pi werden mitgeliefert. Auf dem Zielrechner ist keine separate Node-Installation nötig. Die Modelle laufen weiterhin über die vom Nutzer konfigurierten Anbieter; API-Zugangsdaten sind nicht enthalten.

## Voraussetzungen zum Bauen

- Windows x64; Node.js 24 (mindestens mit Unterstützung für `--env-file-if-exists`) und npm.
- Rust stable mit dem Target `x86_64-pc-windows-msvc` (rustup).
- Visual Studio Build Tools mit „Desktopentwicklung mit C++“ und Windows SDK.
- Microsoft Edge WebView2 Runtime. Der Installer bietet bei Bedarf den Download-Bootstrapper an; dafür ist Internet nötig.
- Internet für npm, Cargo und beim ersten Paketieren die NSIS-Werkzeuge.
- Für Pipeline: Python **3.14 x64 mit pip** (zuerst `.scratch/pipeline/venv`, sonst `python` oder `py -3.14`) sowie beim ersten Vorbereiten Netzwerkzugriff auf python.org und PyPI. Auf dem Zielrechner ist keine Python-Installation nötig. Bewusst ohne Pipeline bauen: `set "SCRANTON_SKIP_PIPELINE=1"` vor dem Build; danach zum Wiederaktivieren `set "SCRANTON_SKIP_PIPELINE="`.
- Git auf dem Zielrechner für private Worktrees. Für echte Standardläufe zusätzlich eine separat eingerichtete Linux-Docker-Engine und das lokale Sandbox-Image; keine automatische Installation. Alternativ ausdrücklich Trusted-Host wählen (keine OS-Isolation). Siehe [ISOLATION.md](ISOLATION.md).

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
`src-tauri\target\release\bundle\nsis\Scranton_0.1.0_x64-setup.exe`.
Die Anwendung wird pro Benutzer installiert, ohne Administratorrechte. Das Paket ist ohne separat konfiguriertes Codesigning unsigniert; Windows SmartScreen kann daher warnen.

## Daten und Konfiguration

- Registry: `%APPDATA%\dev.scranton.desktop\projects.json`.
- Chats: `%APPDATA%\dev.scranton.desktop\projects\<projectId>\chats\<chatId>\chat.json` und jeweils `hive\`.
- Bisheriger Hive: `%APPDATA%\dev.scranton.desktop\hive` bleibt bei einem Legacy-Import an seinem bisherigen Ort.
- Optionales Env-File: `%APPDATA%\dev.scranton.desktop\.env`
- Legacy-Workspace: `<Windows-Dokumente>\Scranton\workspace` (auch bei umgeleitetem Dokumente-Ordner). Neue Projekte ohne Ordnerangabe verwenden standardmäßig `<Benutzerprofil>\Documents\Scranton\projects\<id>`.
- Fenstergröße/-position werden im App-Datenverzeichnis gespeichert.
- Pi-Zugangsdaten: `%USERPROFILE%\.pi\agent\auth.json`, gemeinsam mit der Pi-CLI; `PI_CODING_AGENT_DIR` überschreibt das Profilverzeichnis. Trusted-Host liest es direkt. Docker mountet es nicht und erhält bei Abo-Nutzung nur einen kurzlebigen Access-Token (siehe [ISOLATION.md](ISOLATION.md)).
- Private Schatten-Repositories und Worktrees: `%LOCALAPPDATA%\Scranton\iso\<token>\` (`shadow\` und `w<uuid>\`); ohne `LOCALAPPDATA` unter `<Benutzerprofil>\AppData\Local\Scranton\iso\<token>\`. Überschreibbar durch einen kurzen absoluten `SCRANTON_ISOLATION_ROOT` (leer = nicht gesetzt; realpath-normalisiert, keine Überschneidung mit dem Workspace). Zuordnung zum Run über `<Hive>\isolation\<token>.json` (`storage`, `runId`, `workspace`). Der Pointer wird atomar vor dem Laufverzeichnis geschrieben. Artefakte bleiben nach Erfolg, Fehler oder Abbruch erhalten. Chatentfernung oder Projektentfernung mit Historienlöschung bereinigt zugeordnete Isolationsordner automatisch, sofern sie sicher innerhalb der aktuell konfigurierten Wurzel liegen, nicht in Benutzung sind und die Zuordnung stimmt. Andernfalls scheitert die Entfernung; betroffene Ordner und Registry-Eintrag bleiben erhalten. Details und Grenzen siehe [ISOLATION.md](ISOLATION.md#aufbewahrung-und-bewusste-bereinigung). Persistente Sessions pro Instanz: `<Hive>/sessions/`. Chat und Mailboxen enthalten sensible Nutzerdaten und werden nicht mit dem Programm ausgeliefert.

Die Kennung wurde vor der ersten Veröffentlichung von `dev.scranton.app` auf `dev.scranton.desktop` geändert. Dadurch verschiebt sich das App-Datenverzeichnis nach `%APPDATA%\dev.scranton.desktop\` (einschließlich `.env` und Fensterzustand). Es gibt keine automatische Migration; bisher wurde nichts veröffentlicht.

Die App startet den Sidecar mit `app-server --data <appData> --legacy-workspace <Windows-Dokumente>\Scranton\workspace`. Existiert noch keine `projects.json`, aber der bisherige `<appData>\hive`, importiert der Server ihn als Projekt **Scranton** (`scranton`) mit Chat **Previous runs** (`legacy`) durch Referenz: Hive und Historie werden **nicht verschoben**. Ohne alten Hive beginnt die Projektliste leer. Dies betrifft nicht die frühere Änderung der App-Kennung oben. Die `.env` wird bewusst **nicht** automatisch mit Schlüsseln angelegt. Beispiel:

```dotenv
ANTHROPIC_API_KEY=dein-schluessel
# Alternativ der Schlüssel des gewünschten Providers, z. B. OPENAI_API_KEY.
```

Nach Änderungen an Umgebungsvariablen oder `.env` die App vollständig beenden und neu starten. Vom gestarteten Prozess geerbte Umgebungsvariablen haben Vorrang. Der gebündelte Node lädt `.env` vor dem CLI-Import; zusätzlich wird `SCRANTON_ENV_FILE` auf diesen Pfad gesetzt. Gestartete Runs erben die Umgebung; Docker reicht nur die Provider-Allowlist weiter. Schlüssel gehören weder ins Git-Repository noch in die Paket-Ressourcen. Die Datei liegt unverschlüsselt im Benutzerprofil.

Die mitgelieferte `scranton.config.json` legt Modelle und Agenteneinstellungen fest. Projektordner werden über **New project** registriert; innerhalb eines Chats ist der Workspace an das Projekt gebunden. Das App-Verzeichnis ist kein Workspace: dort installierte Ressourcen werden bei Updates ersetzt.

## Projekte, Chatwechsel und Follow-ups

Die linke Seitenleiste zeigt einklappbare Projekte und deren Chats. **+ New project** fragt Name und absoluten Ordnerpfad ab; ein leeres Pfadfeld erzeugt einen Standardordner. Das Plus am Projekt (**New chat**) öffnet den Run-Dialog für einen neuen Thread. **Rename** und **Remove** sind über das jeweilige Aktionsmenü erreichbar; Entfernen verlangt Bestätigung und löscht niemals Projektdateien. Bei Projekten kann zusätzlich die Scranton-Historie unter dem Datenverzeichnis gelöscht werden. Laufende Chats bzw. ungeklärte Leases blockieren das Entfernen.

Ein Chatwechsel ändert nur die Ansicht, beendet keinen Run. Hintergrund-Chats mit Rückfragen tragen **needs you**; der Link `#/p/<project>/c/<chat>` wählt einen Thread. Im Chatkopf wechselt die Run-Auswahl zwischen aktuellem Live-Run und schreibgeschütztem Replay früherer archivierter Runs. Zurück zur Live-Ansicht wechseln, um wieder zu steuern.

**Follow up** (auch Strg+Enter) startet den nächsten Run im selben Chat mit früheren Runs als begrenztem Planungskontext. Während eines Runs oder einer Wiederherstellungsblockade ist der Composer gesperrt; zum Eingreifen während eines Runs dient weiterhin der Instanz-Chat. Mehrere Chats/Projekte laufen parallel bis `maxConcurrentRuns` / `SCRANTON_MAX_RUNS` (Standard 4), ein Run pro Chat. Das ist unabhängig von den Pipelines pro Run und erhöht nicht das gemeinsame Rate-Limit eines Abos.

## Accounts: Abos, API-Keys und eigene Provider

In der App **Accounts** → **Sign in** bei **Claude (Pro/Max)** oder **ChatGPT** wählen. Der lokale Server öffnet den **Systembrowser**, nicht die WebView. Die Callback-Ports `127.0.0.1:53692` (Claude) und `127.0.0.1:1455` (ChatGPT) müssen frei sein. Anmeldung im Browser abschließen; falls nötig, Code oder vollständige Weiterleitungsadresse in der Accounts-Seitenleiste einfügen. Die Adresse lässt sich dort kopieren, falls der Browser nicht automatisch öffnet. **Cancel** bricht den Versuch ab; **Sign out** entfernt den gespeicherten Provider-Zugang nach Bestätigung, nicht etwaige Umgebungs-Keys. Während eines Laufs kann Abmelden weitere Modellaufrufe beeinträchtigen.

Für **Gemini** unter **Accounts** → **Add API key** einen Schlüssel aus Google AI Studio hinterlegen. Pi 1.5.0 bietet keinen Google-Konto-Login. Auch Claude/ChatGPT und weitere unterstützte Anbieter können API-Keys verwenden; **Replace key** ersetzt den Zugang, **Remove key** löscht nur den gespeicherten Key, nicht Umgebungsvariablen. Ein gespeicherter Key ersetzt einen vorhandenen Abo-Zugang desselben Providers. Schlüssel werden in Pis `auth.json` gespeichert und vom API-Server nie zurückgegeben.

Das Formular für eigene Provider nimmt Name/ID, Basis-URL, API-Typ und Key entgegen. Modelle lassen sich per **Fetch models** ermitteln und auswählen oder manuell deklarieren. Die Vorlage **abliteration.ai** verwendet `https://api.abliteration.ai/v1` mit `openai-completions`; Discovery fragt `/v1/models` ab. **Remove provider** entfernt nur eine unverändert von Scranton verwaltete Definition samt gespeichertem Key. Die echte Pi-`models.json` enthält keine von Scranton geschriebenen Schlüssel; vorhandene Dateien erhalten einmalig `models.json.scranton-bak`, die Verwaltung steht in `scranton-providers.json`. Details und CLI-Alternative: [README](../README.md#anmelden).

Unter **Options → Models** wird das Modell pro Rolle gewählt; **pi default** verwendet die Agentenkonfiguration. Docker verlangt dabei einen expliziten Provider und ein Modell für jede aktive Rolle; fehlen diese, verweigert der Server auch Follow-ups vor dem Start. Der Modellkatalog garantiert keine Abo-Berechtigung. Für dieses Profil wurde `openai/gpt-6.1-sol` im begrenzten Docker-Smoke-Test verifiziert. Die Auswahl wird lokal gespeichert und gilt als Override nur für den neuen Lauf. API-Keys bleiben eine Alternative; gespeicherte Pi-Zugänge haben Vorrang vor Umgebungs-Keys (siehe [README](../README.md#anmelden)).

Ein echter OAuth-Rundlauf wurde hier nicht getestet. Anbieterbedingungen und Nutzungslimits gelten auch für Drittanbieter-Tools und können sich ändern oder die Nutzung einschränken; parallele Pipelines teilen die Limits eines Abos.

## Verhalten und Sicherheit

- Das Hauptfenster startet unsichtbar und mit dunklem Hintergrund; nach der JSON-Ready-Zeile des Servers erscheint das Dashboard. Der Server bindet an `127.0.0.1` auf einem freien Port. Nach 20 Sekunden ohne gültige Ready-Zeile erscheint ein nativer Fehlerdialog mit dem letzten stderr-Ausschnitt.
- Eine zweite Instanz fokussiert das vorhandene Fenster. Das Tray-Menü bietet **Show / Hide** und **Quit**; der Tooltip „Scranton — Human needed“ basiert auf `GET /api/control` → `pendingHuman`, nicht auf dem möglicherweise veralteten Hive-Snapshot. Nur ein noch lebender Run kann ihn aktivieren.
- Die Hülle überwacht den Sidecar auch nach der Ready-Zeile. Bei unerwartetem Exit erscheint ein nativer Fehlerdialog mit Exitstatus und bis zu 8 KiB stderr-Ende. **Restart** startet den Server neu und lädt dessen neue URL; **Quit** beendet die App. Es gibt keine automatische Neustartschleife.
- Das Fensterkreuz beendet die App (nicht nur ins Tray minimieren). Beim Beenden sendet die Hülle `quit` über stdin; nach fünf Sekunden wird nötigenfalls der Prozessbaum mit `taskkill /T /F` beendet. Ein harter OS-Abbruch kann diese Aufräumphase verhindern; der Server beendet sich zusätzlich bei stdin-EOF.
- `withGlobalTauri: true` stellt `window.__TAURI__.notification` bereit. Die einzige aktive Capability gilt ausschließlich für das Fenster `main`, nicht für lokale Seiten (`local: false`), und für `http://127.0.0.1:*` bzw. `http://localhost:*`.
- Im Windows-Release mit WebView2 per CDP geprüft: Auch mit dem vom Server gelieferten `default-src 'self'; script-src 'self'; ...; connect-src 'self'` bleiben die injizierten Tauri-Globals und die IPC-Aufrufe für Benachrichtigungsberechtigung und Versand funktionsfähig. Dafür ist auf diesem Windows-Build keine `connect-src`-Erweiterung nötig. Nicht freigegebene Dateisystem-IPC bleibt gesperrt. Andere Plattformen/WebViews wurden nicht geprüft.
- Freigegeben sind ausschließlich `notification:allow-is-permission-granted`, `notification:allow-request-permission`, `notification:allow-notify`. Keine Default-Permissions, Shell-, Dateisystem-, Fenster- oder sonstigen Core-Rechte für die Webseite. Rust verwaltet Sidecar, Fenster und Tray intern ohne JS-Kommandos.
- Der variable Port erfordert eine Loopback-Port-Wildcard. Auch andere lokale Dienste auf diesen Hosts liegen deshalb im Ursprungsscope, erhalten aber nur diese drei Benachrichtigungsrechte. Navigation erfolgt beim Start nur auf eine geprüfte `http://127.0.0.1:<port>`-URL.
- Notification-Anzeige hängt von Windows-Berechtigungen/Benachrichtigungseinstellungen ab. In der Entwicklungsumgebung kann Windows PowerShell-Identität/Icons anzeigen; für die endgültige Anwendungsidentität den installierten Build verwenden.

Capability-Syntax geprüft gegen die [Tauri-v2-Capabilities-Dokumentation](https://v2.tauri.app/security/capabilities/) (Abschnitt Remote API Access) und die beim Build generierten Schemas. Die Kennung `dev.scranton.desktop` vermeidet die macOS-Warnung zum `.app`-Suffix.

## Paketierung und Wartung

`scripts/prepare-desktop.mjs` kopiert das laufende `node.exe` als `binaries/node-x86_64-pc-windows-msvc.exe` und explizite App-Ressourcen nach `src-tauri/staged/app/`. Enthalten sind `tools/pi-agent-chat.js`, `tools/pipeline-pi-complete.js`, `tools/fake-pi-rpc.js`, der Legacy-Fake und `sandbox/Dockerfile` samt `.dockerignore`. Das Sandbox-Image selbst ist nicht enthalten. Quell-Ressourcen werden neu angelegt, Links und bekannte Credential-/Laufzeitverzeichnisse ausgeschlossen; es wird kein Host-`node_modules` kopiert.

Produktionsabhängigkeiten entstehen separat mit `npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund`. Jede Vorbereitung erstellt `node_modules` mit `npm ci` neu, damit dort keine fremden oder veralteten Dateien aus früheren Staging-Läufen überleben. Pi ist exakt auf **1.5.0** festgelegt. Die Vorbereitung liest das tatsächlich lokal installierte `package.json` und dessen `bin.pi`, prüft die Lockfile-Version und vergleicht anschließend den kompletten Pi-Paketbaum per SHA-256 mit dem gestagten Paket. Abweichungen brechen den Build ab. `packaging-manifest.json` protokolliert Version, relativen Einstiegspunkt, Pi-Dateianzahl/-Größe/-Hash und Lockfile-Hash, keine Credentials oder Entwicklerpfade.

Danach startet das gebündelte Node den gestagten Pi-Einstiegspunkt mit `--help`, leerem PATH und leerem, isoliertem Profil ohne Anbieter-Umgebung. `npm.cmd run test:packaging` prüft zusätzlich Ressourcen und installierte nicht-optionale Produktionsabhängigkeiten; vorher `npm.cmd run app:prepare` ausführen. Diese Prüfung ersetzt weder einen echten Modelllauf noch einen Container-/Installer-Lifecycle-Test. Nach Quelländerungen vor Tests/Release erneut vorbereiten; auch `npm.cmd test` enthält die Paketierungstests und braucht vorher `npm.cmd run app:prepare`. Löschen von `src-tauri/staged/` erzwingt einen frischen Durchlauf. Ausgaben und `target/` sind gitignored. Release und Sidecar gehören zusammen; nicht nur die einzelne App-EXE verteilen.

### Gebündelte Pipeline-Laufzeit

Die Pipeline benötigt zusätzlich den in `scripts/prepare-desktop.mjs:prepareDesktop` ausdrücklich aufgeführten Helper `tools/pipeline-pi-complete.js`; er wird mit den App-Quellen frisch gestagt und verwendet das gebündelte Node/pi für tool- und sessionlose Completions. Er ist kein Python-Wheel und läuft auf dem Host, nicht im Checkcontainer. So ist die **via pi**-Modellwahl einschließlich verfügbarer Abomodelle auch im Paket vorgesehen. Staging/Offlineprüfungen sind kein Nachweis eines echten Modellrundlaufs durch die Bridge.

Zusätzlich wird `engine-runtime/python/` mit dem offiziellen Windows-x64-Embeddable-CPython **3.14.8** ausgeliefert, daneben `engine-runtime/site-packages/` mit 46 exakt gesperrten Laufzeitdistributionen und dem Paket `scranton_pipeline` aus `engine/src` einschließlich aller Demo-Daten. `engine/runtime-lock.json` enthält URL, Version und den veröffentlichten SHA-256 der [Python-Release-Seite](https://www.python.org/downloads/release/python-3148/); `engine/requirements.lock` enthält die gegen PyPI verifizierten Wheel-Hashes. Installiert wird ausschließlich aus Wheels mit `--require-hashes --only-binary=:all: --no-compile`, niemals aus Quellarchiven und niemals systemweit. Entwicklungswerkzeuge, Tests, Bytecode-Caches und Credential-Dateien sind ausgeschlossen.

`python314._pth` enthält ausschließlich `python314.zip`, `.` und `..\\site-packages`; Python ignoriert damit `PYTHONPATH` und Benutzer-Site-Packages. Pip selbst wird nicht mitgeliefert. Die Downloads liegen unter `.scratch/pipeline/cache/`; Archiv und sämtliche Wheels werden bei jeder Vorbereitung erneut gehasht. Stimmen Locks und der komplette gestagte Laufzeitbaum mit dem lokalen Cache-Beleg überein, entfallen Download und Installation; der Engine-Quellcode wird weiterhin frisch kopiert. Beschädigte Download-Caches führen zum Fehler (betroffenen Cache entfernen und erneut vorbereiten). Pip-Cache und temporäre Dateien bleiben unter `.scratch/pipeline/`. `src-tauri/staged/pipeline-cache.json` ist nur ein lokaler Beschleunigungsbeleg und keine ausgelieferte Ressource.

Die Vorbereitung startet anschließend immer den **gestagten** Interpreter mit leerem PATH und sauberer Umgebung für `version` und `graph --format mermaid`. Die Prüfaufrufe verwenden zusätzlich `-B`, weil der isolierte Embeddable-Interpreter auch `PYTHONDONTWRITEBYTECODE` ignoriert; vor der Manifestmessung werden Bytecode-Caches zusätzlich entfernt. Das Manifest protokolliert unter `pipeline` Engine-/Python-Version, Dateianzahl, Bytes, Baum-SHA-256 und den SHA-256 von `requirements.lock`. Ohne passenden Build-Interpreter oder verifizierten Download bricht die Vorbereitung ab. Nur `SCRANTON_SKIP_PIPELINE=1` lässt bewusst **keine** Pipeline-Laufzeit zurück und schreibt `pipeline: null`; die App meldet die Engine dann als nicht verfügbar.

Frühere Messung des zusätzlichen Ressourcenbedarfs am 09.11.2026 (vor den späteren Enginekorrekturen, keine aktuelle Baum-/Releaseidentität): rund **61,55 MiB** (64.535.048 Bytes, 3.776 Dateien; davon CPython 24.405.943 Bytes, Wheels und Engine 40.129.105 Bytes). Enthalten sind 36 `.pyd`, 10 `.dll` und ein Standardbibliothek-`.zip`. Ein separat komprimierter ZIP-Vergleich ergibt rund 22,89 MiB; das ist **keine** Messung des NSIS-Installerzuwachses. Die tatsächliche Installergröße hängt von dessen Kompression und dem vollständigen Release ab und muss nach einem echten `app:build` gemessen werden.

Die vorhandene Tauri-Ressourcenzuordnung `"staged/app/": "app/"` kopiert laut [Tauri-Ressourcendokumentation](https://v2.tauri.app/develop/resources/) Verzeichnisse rekursiv und ohne Dateiendungsfilter. Daher brauchen `.pyd`, `.dll` und `.zip` keine eigenen Globs. Der Rust-Sidecar startet unverändert Node aus `resources/app` (Entwicklung: `staged/app`); der Node-Resolver findet Python darunter. Weder neue Rust-Kommandos noch neue WebView-Berechtigungen sind erforderlich. Dass der fertige NSIS-Installer alle Dateien tatsächlich installiert und der installierte Release startet, ist erst am gebauten Installer nachzuweisen; Staging allein beweist das nicht.

`npm.cmd run test:packaging` prüft zusätzlich Manifest/Dateibaum, ausgeschlossene Dateien, den Resolver aus der **gestagten** Node-Kopie sowie `demo --run-root <Projekt-Scratch> --delivery patch` mit normalem PATH für Git: erwartet werden Exit 3 und genau eine JSON-Zeile mit `awaiting_approval` / Gate `plan`. Die Demo verwendet Skriptmodelle ohne Anbieteraufruf. Das belegt Importierbarkeit, Graph-Kompilation, Demo-Daten, Git/SQLite und das erste Human-Gate, aber weder echte Modellzugänge noch spätere Freigaben, vollständige Auslieferung, Docker oder den nativen Installer-Lifecycle. Bei bewusst ausgelassener Pipeline werden die Engine-Tests mit Begründung übersprungen. Gesamtprüfstand Packaging: **6 Tests, Stand 2026-11-09 abends**, hier nicht erneut ausgeführt; für einen Release nach diesen Dokumentationsänderungen neu vorbereiten und prüfen.

Das monochrome Icon entsteht reproduzierbar mit `npm.cmd run app:icon` aus einem selbst geschriebenen PNG-Encoder (`node:zlib`) und Tauri Icon. Die erzeugten Icons sind eingecheckte Build-Eingaben. `src-tauri/icons/icon.ico` kann unverändert als `visualizer/public/favicon.ico` übernommen werden; `32x32.png` ist die PNG-Alternative (mit passendem HTML-Link). Die native Paketierung braucht diese Browser-Kopie nicht.

`SCRANTON_DESKTOP_STUB` wird bei der Vorbereitung ausdrücklich abgewiesen; ein alter Entwicklungsstub darf nicht versehentlich ausgeliefert werden.

## Parallelbetrieb und lokaler Prüfstand

Echte Läufe verwenden standardmäßig RPC, private Worktrees, persistente Instanz-Sessions und Docker. Parallelität zählt Meilenstein-Pipelines, nicht Rollen. Der Plan legt Abhängigkeiten fest; erst QA plus sichere Integration geben Nachfolger frei. Nutzer-Git-Index und -Historie bleiben erhalten, QA-Änderungen werden nicht integriert. Direkter Chat adressiert eine Instanz-ID; `queued` bedeutet noch nicht gesendet; `delivered` ist ein RPC-ACK, kein Nachweis der Modellverarbeitung. `unknown` bleibt bei Timeout/Abbruch eines möglicherweise angenommenen Sends unklar und wird nicht automatisch wiederholt (RPC/Broker/Erweiterung: 5/10/15 s). Dynamische Neuplanung und ein `message`-CLI-Befehl sind nicht implementiert; `maxReplans` ist effektiv 0. Die Fake-Demo kennzeichnet simulierten Trusted-Host-Betrieb ausdrücklich. Docker-Bridge erlaubt Egress und ist keine Netzsperre.

Stabile Scranton-Instanz-/Session-IDs sind keine Garantie durchgehender Pi-Historie: Docker setzt am festen Pfad `/workspace` fort; Trusted-Host-Angela startet bei neuen QA-Checkout-Verzeichnissen mit frischer Pi-Historie. Pi 1.5.0 bindet geladene Sessions an den gespeicherten CWD. Ein sicheres, verifiziertes CWD-Rebinding ist noch nicht implementiert; Details: [ISOLATION.md](ISOLATION.md).

Nach einem Sidecar-Absturz prüft der Server die dauerhafte Lease `hive/control/owner.json` und den alle 5 s vom Run geschriebenen Heartbeat. Ist dessen PID nachweislich beendet (`gone`) und die Containerbereinigung verifiziert (oder kein Docker verwendet), wird der Run automatisch als abgebrochen abgeschlossen; der Chat kann danach einen neuen Run starten. `alive` erlaubt weiterhin **Request stop**. Ohne passenden Heartbeat oder bei veraltetem Heartbeat mit noch existierender PID gilt `unknown`: **Release chat** erst nach unabhängiger Prüfung bestätigen, dass der Run beendet ist. Sonst könnten zwei Runs denselben Chat verwenden. Die Freigabe protokolliert `Released by the user`, entfernt Lease/Heartbeat/Stop-Auftrag und erledigt die offene Rückfrage; Historie, Sessions und Worktrees bleiben erhalten. Passende Scranton-Container werden bereinigt. Automatische Wiederherstellung behält bei unerreichbarem Docker oder fehlgeschlagener Entfernung die Lease und zeigt `recoveryError`; nur eine ausdrücklich bestätigte manuelle Freigabe kann mit diesen Warnungen fortfahren. Ein regulär beendeter Run mit ungeklärtem Cleanup schreibt `cleanup:"unresolved"` samt Grund in den Heartbeat, bleibt `unknown` und gesperrt; angezeigt wird `Cleanup of this run could not be verified: <reason>`. Während automatischer Wiederherstellung antwortet Release mit 409 und `Recovery is already in progress. Try again in a moment.`; andere Chats warten nicht auf die Docker-Aufrufe. Konfliktantworten werden nicht als Wiederherstellungsfehler gespeichert; Fehler verschwinden bei erfolgreicher Freigabe oder Wechsel des verwaisten Runs. Ein Absturz vor dem ersten Run-Ereignis archiviert bei Wiederherstellung die alte Historie und protokolliert den neuen Run als begonnen und abgebrochen. Leere, nachweislich verwaiste oder mehr als fünf Minuten alte Recovery-Locks werden übernommen; dies erlaubt kein altersbasiertes Löschen der Run-Lease. Andere Fehler behalten die Lease und werden angezeigt. Keine gespeicherte PID wird blind beendet. Die Hülle gewährt beim Beenden 5 s für `quit`/Cleanup; `taskkill /T /F` danach kann auch Run-Kinder ohne Chance auf `guardParent`-Abbruch hart beenden. Die Wiederherstellung beim nächsten Start deckt diesen Fall ab. Startup-IPC und stdin-Watchdog bleiben unverändert. Details: [CONTROL.md](CONTROL.md), §6.

Die oben beschriebene frühere WebView2-/Benachrichtigungsprüfung ist kein Nachweis für neue Laufzeitfunktionen. Fake-/Protokolltests ersetzen keinen Installer-/nativen Lifecycle-Test. Docker Desktop ist inzwischen eingerichtet; ein begrenzter Docker-/ChatGPT-Smoke-Test mit `OK`, Exit 0 und verifiziertem Cleanup ist in [ISOLATION.md](ISOLATION.md) dokumentiert. Vollständige Pipeline- sowie native Start-/Abbruch-/Neustart-/Cleanup-Prüfungen sind weiterhin separat am jeweiligen Release zu belegen. Ein Build allein ist kein Lifecycle-Nachweis.

## Deinstallieren

Unter Windows „Installierte Apps“ → „Scranton“ → „Deinstallieren“ entfernt das Programm. Hive, `.env`, pi-Profil und Workspace sind Nutzerdaten und werden nicht automatisch gelöscht. Bei Bedarf nach dem Beenden der App separat sichern oder entfernen; andere Programme können dasselbe pi-Profil verwenden.

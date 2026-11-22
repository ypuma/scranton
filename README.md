# Project Scranton

Open-Source-Multi-Agenten-Harness mit **Scrantons eigener Laufzeit**, nativer Desktop-App, Terminal- und Web-Dashboard. Michael plant, Dwight implementiert und Angela prüft; Oscar und Hank ergänzen optionale Gates. Markdown-Mailboxen im Hive und ein kontrollierter Instanz-Chat verbinden die Rollen. Pi ist nicht mehr der Agenten- oder Modellclient. Native Buildziele sind Windows x64, macOS und Linux; ein Buildziel allein ist kein nativer Laufzeitnachweis.

| Rolle | Aufgabe |
|---|---|
| Michael | Anfrage in einen validierten Meilensteinplan zerlegen |
| Dwight | Einen Meilenstein implementieren und Tests schreiben |
| Oscar | Code-Review: Korrektheit, Wartbarkeit und Regressionen |
| Hank | Sicherheitsprüfung: Vertrauensgrenzen, Eingaben und Geheimnisse |
| Angela | Den exakten Entwickler-Snapshot prüfen; Gate-Änderungen werden nicht übernommen |

## Schnellstart

Voraussetzungen: **Node.js 24** (lokale Dauerhaftigkeit benötigt `node:sqlite`), npm und Git. Standard ist **Scrantons eigene OS-Sandbox**. Windows benötigt den nativen Sandboxhelper; macOS verwendet `sandbox-exec`, Linux ein separat verfügbares, nutzbares `bwrap`. Fehlende Voraussetzungen führen zum Fehler, nicht zum Host-Fallback. Docker ist ein optionaler Tool-Executor und wird nicht automatisch installiert, gebaut oder geladen. Details: [ISOLATION.md](docs/ISOLATION.md).

Alle folgenden Befehle im geklonten Scranton-Ordner ausführen; `node bin/scranton.js` funktioniert ohne globalen CLI-Eintrag. Optional macht `npm.cmd link` den in `package.json` deklarierten Befehl `scranton` verfügbar, sofern der globale npm-Binordner im PATH liegt.

```powershell
npm.cmd ci
node bin/scranton.js help

# 1. Bei einem Anbieter anmelden (hier: ChatGPT-Abo), Status prüfen
node bin/scranton.js login chatgpt
node bin/scranton.js accounts

# 2. Optional Modelle je Agent wählen (sonst Automatic) (Beispiel für die drei Standardrollen)
node bin/scranton.js agents --hive .scranton-hive
node bin/scranton.js agent set-model michael --provider openai --model gpt-5.3-codex --hive .scranton-hive
node bin/scranton.js agent set-model dwight --provider openai --model gpt-5.3-codex --hive .scranton-hive
node bin/scranton.js agent set-model angela --provider openai --model gpt-5.3-codex --hive .scranton-hive

# 3. C:\Projekte\MeineApp durch einen eigenen Projektordner ersetzen
node bin/scranton.js doctor --workspace "C:\Projekte\MeineApp" --hive .scranton-hive
node bin/scranton.js run "Ergänze eine kleine Funktion mit Tests" --workspace "C:\Projekte\MeineApp" --hive .scranton-hive --sandbox scranton
```

Der echte Lauf nutzt Modellkontingent bzw. kostet Geld. Die explizite Modellwahl ist optional; ohne Wahl gilt Automatic (siehe unten). `doctor` prüft Verfügbarkeit offline, ohne Modellaufruf oder Token-Refresh. Warnungen ergeben Exit 0, Fehler Exit 1. Agent-Defaults bleiben im angegebenen Hive; Modellwahl, Prüfung und Lauf sollten denselben `--hive` verwenden.

Im Standard-Worktree-Modus arbeiten Agenten in privaten Kopien. Nach bestandenen Gates schreibt Scranton fertige Meilensteine **in den gewählten Projektordner zurück** – nicht erst am Laufende. Vorhandene uncommittete Änderungen bilden die Ausgangsbasis und können dabei weiterbearbeitet werden; Git-Historie, Index und Branch des Benutzer-Repositories werden nicht verändert. Spätere überlappende Nutzeränderungen führen zum Integrationskonflikt. Vorher sichern; private Kopien und begrenzte Restore Points sind kein vollständiges Backup. Bei Fehlern zuerst Terminaldiagnose, `.scranton-hive/state.json`, `.scranton-hive/events.jsonl` und die Instanz-Outboxen unter `.scranton-hive/<instanz>/outbox.md` ansehen; frühere Läufe liegen unter `.scranton-hive/runs/`. Details: [Integration](#parallelität-prüfung-und-integration).

Ohne Modellaufruf ausprobieren:

```powershell
node bin/scranton.js demo
```

Die Demo benutzt den scripted Provider im normalen dauerhaften Agentenloop, private Worktrees und ausdrücklich simulierten Trusted-Host-Modus. Keine echten Modellaufrufe oder Shellbefehle durch den Standard-Scriptadapter; kein Sandboxnachweis. Szenarien: `happy`, `flaky`, `breaker`, `blocked`, `changes_once`, `security_issues`, `question`.

```powershell
node bin/scranton.js demo --scenario breaker --delay 50 --on-breaker skip
```

Für optionale Docker-Läufe Docker separat einrichten und das Image bewusst bauen:

```powershell
docker build --pull=false -t scranton-tools:24-r1 sandbox
node bin/scranton.js run "Baue eine Todo-CLI mit Tests" --workspace workspace --parallel 3 --sandbox docker
```

Der explizite Build benötigt das Basisimage und apt-Pakete; das Tool-Image enthält Git/Bash/ripgrep/fd, keinen Modellclient. Scranton baut oder lädt es nicht beim Runstart. Rechte, Netz und Grenzen: [ISOLATION.md](docs/ISOLATION.md).

Standardläufe verwenden `--sandbox scranton`. Nur für bewusst vertrauenswürdige Aufgaben kann der Hostmodus ausdrücklich bestätigt werden:

```powershell
node bin/scranton.js run "Baue eine Todo-CLI mit Tests" --workspace workspace --trusted-host
```

**Trusted-Host ist keine OS-Isolation.** Shellbefehle besitzen Benutzerrechte. Private Worktrees trennen Dateistände, nicht Prozessrechte. Legacy-`execution.isolation:"shared"` verlangt eine Pipeline und expliziten Hostmodus; Shared-Instanzen haben `worktree:null` und keine private Dateigrenze.

## Eigene Laufzeit, Streams und Freigaben

- `src/core/tools/`: deterministische Tools mit Pfadbegrenzung, zentraler Kürzung und JSON-Schemas. Diese Dateiprüfungen sind keine Shell-/OS-Isolation.
- `src/core/llm/` und `credentials/`: eigene Providerclients, Claude-/ChatGPT-/Antigravity-OAuth, Gemini per API-Key sowie eigene OpenAI-kompatible Provider.
- `src/core/durable/`: eigener SQLite-Workflowmotor je Chat in `<hive>/dbos.sqlite`, Marker in `<hive>/agent-step-markers`. Nur `DBOS_SYSTEM_DATABASE_URL` oder `DBOS_DATABASE_URL` wählen echtes DBOS auf Postgres; `DATABASE_URL` wird absichtlich ignoriert. DBOS wird nur dafür geladen. Datenbank und uncheckpointierte Marker gemeinsam aufbewahren.
- `src/core/agent/`: Agentenloop als Workflow, dauerhafte `output`-/`history`-Streams und `agent_state` mit `thinking`, `tool_call`, `waiting_approval`, `compaction_failed`, `done`. Terminaler Workflowstatus ist maßgeblich; Exactly-once für externe Effekte wird nicht garantiert.

**Automatic** wählt das erste angemeldete unterstützte Konto in fester Reihenfolge: `anthropic/claude-sonnet-4-5`, `openai/gpt-5.3-codex`, `google/gemini-2.5-pro`, `google-antigravity/gemini-3-pro`. Ohne passendes Konto folgt ein Fehler; keine Auswahl nach Katalogsortierung und keine automatische Wahl eigener Provider. Explizite Provider-/Modellpaare haben Vorrang. Dieselbe Regel gilt in allen Team-Sandboxmodi; der Katalog garantiert keine Modellberechtigung.

```powershell
node bin/scranton.js run "Prüfe die Änderung" --sandbox scranton --sandbox-network allow --approve write,edit --approval-timeout 600
node bin/scranton.js watch WORKFLOW-ID --hive .scranton-hive
node bin/scranton.js approve WORKFLOW-ID CALL-ID --yes --hive .scranton-hive
# Ablehnen: --no statt --yes
```

Freigaben sind opt-in (`approvals.tools:[]` als Default), Timeout standardmäßig 600 Sekunden; Ablehnung/Timeout wird ein Toolfehler für das Modell. Ohne TTY zeigt die CLI den separaten Freigabebefehl. Registry-Scope: `--data DIR --project ID --chat ID`. `watch` liest einen Workflow, nicht den gesamten Run.

HTTP: `GET /api/runs/:runId/agents/:instanceId/stream` (SSE), `GET|POST /api/approvals`; Registry jeweils unter `/api/projects/:p/chats/:c`. Wiederanschluss mit `Last-Event-ID` oder inklusivem `?fromOffset=N`. POST-Freigabe: `{workflowId,callId,approved:boolean}` mit Control-Headern. Exakte Cursor-, Scope- und Sicherheitsregeln: [CONTROL.md](docs/CONTROL.md), [Agent routes](src/server/AGENT-ROUTES.md).

## Anmelden

```powershell
node bin/scranton.js login claude
node bin/scranton.js login chatgpt
node bin/scranton.js login antigravity
node bin/scranton.js login gemini
node bin/scranton.js login openrouter --api-key
node bin/scranton.js accounts
node bin/scranton.js logout claude
# Alternativ: node bin/scranton.js logout chatgpt
```

**Google Antigravity** bietet Google-Konto-OAuth (`login antigravity`, Provider `google-antigravity`) über Scrantons eigenen Credentialadapter und LLM-Client. Vollständige Redirect-URL einschließlich State verwenden. Die Projektzuordnung kommt vom Google-Dienst; ohne Projekt scheitert die Einrichtung. Inoffizielle Drittclient-Anbindung, keine Garantie für Modellberechtigung oder kostenlose Quotas. LLM und Tokens bleiben auch bei Docker auf dem Host; es gibt keinen Team-Inferenz-Broker mehr.

**Gemini** bleibt unabhängig davon als API-Key-Pfad aus [Google AI Studio](https://aistudio.google.com/apikey) erhalten. `node bin/scranton.js login gemini` (Provider `google`) und `node bin/scranton.js login <provider> --api-key` lesen den Schlüssel über eine verdeckte Eingabe oder stdin, **niemals als Kommandozeilenargument**. Nur literale Keys ohne eingebetteten Leerraum oder Steuerzeichen sind erlaubt; Präfixe `!` und `$` werden abgewiesen. Bei Claude/ChatGPT ersetzt ein gespeicherter API-Key den bisherigen Abo-Zugang dieses Providers.

`login` öffnet den Systembrowser und zeigt die Anmeldeadresse auch im Terminal. Anmeldung dort abschließen; falls angefordert, den Autorisierungscode oder die vollständige Weiterleitungsadresse im Terminal einfügen. Pro Server/CLI-Prozess läuft höchstens eine Anmeldung; nach zehn Minuten wird sie abgebrochen. `accounts` zeigt den Status ohne Token-Refresh, `logout` entfernt nur den gespeicherten Zugang des gewählten Anbieters.

Im kontrollierten Web-Dashboard und in der Desktop-App verwaltet **Accounts** Anmeldungen, API-Keys und eigene Provider. **New run** und Follow-ups verwenden den angemeldeten Scranton-Katalog. Eine leere Rollenwahl übernimmt den Agent-Default, ohne Default gilt **Automatic**. Modell- und Thinking-Overrides gelten pro Run in allen Team-Sandboxmodi und schreiben keine Konfigurationsdatei. Alternativ `agents.<rolle>.provider/model` oder `SCRANTON_<ROLE>_PROVIDER` und `_MODEL` setzen.

Zugangsdaten und eigene Provider liegen in Scrantons eigenem `store.json`: Windows `%APPDATA%\dev.scranton.desktop\credentials`, macOS `~/Library/Application Support/dev.scranton.desktop/credentials`, Linux `$XDG_DATA_HOME/dev.scranton.desktop/credentials` (Standard `~/.local/share/dev.scranton.desktop/credentials`). `SCRANTON_CREDENTIALS_DIR` überschreibt das Verzeichnis. Beim ersten Initialisieren werden Pi-Logins und Provider einmalig aus `PI_CODING_AGENT_DIR` bzw. `~/.pi/agent` importiert; vorhandene Scranton-Einträge gewinnen. Danach liest oder schreibt Scranton dieses Pi-Profil nicht mehr. Wenn Scranton importierte Tokens erneuert, müssen Pi-CLI-Nutzer sich gegebenenfalls in Pi erneut anmelden. Der Store ist private App-Datenablage, kein verschlüsselter OS-Schlüsselbund.

Docker führt nur Subprozesswerkzeuge aus; weder Provider-Keys noch OAuth-Tokens, Prompts oder Sessions werden in den Container projiziert. `--sandbox-network none` sperrt Containerwerkzeuge, nicht die weiterhin hostseitigen LLM-Anfragen.

**Prüfstand und Grenzen:** Offline-/scripted Tests beweisen weder reale OAuth-Annahme noch Modellberechtigungen oder native macOS-/Linux-Isolation. Anbieterbedingungen und gemeinsame Abo-Rate-Limits gelten weiterhin. Historische Pi-/Brokerprüfungen sind keine Freigabe der eigenen Laufzeit.

### Eigene Provider (OpenAI-kompatibel)

Beispiel für **abliteration.ai** (Key ebenfalls nur über verdeckte Eingabe oder stdin):

```powershell
node bin/scranton.js provider add abliteration --base-url https://api.abliteration.ai/v1 --api openai-completions --discover --label abliteration.ai
node bin/scranton.js provider remove abliteration
```

`--discover` fragt hier `https://api.abliteration.ai/v1/models` ab; alternativ Modell-IDs mit `--models a,b` deklarieren. Unterstützte API-Typen: `openai-completions`, `openai-responses`, `anthropic-messages`. Die Basis-URL verlangt HTTPS (HTTP nur auf Loopback), ohne URL-Zugangsdaten, Query oder Fragment. Discovery folgt nur Weiterleitungen desselben Ursprungs und speichert allein noch keinen Provider. Im **Accounts**-Formular Basis-URL, API-Typ und Key eingeben, Modelle ermitteln/auswählen oder IDs manuell eintragen und den Provider speichern; für abliteration.ai gibt es eine Vorlage. Danach stehen seine Modelle unter **New run** zur Wahl. **Remove provider** bzw. `node bin/scranton.js provider remove <id>` entfernt Definition und gespeicherten Key.

Eigene Providerdefinitionen und deren Keys werden atomar im eigenen Store gespeichert; Keys erscheinen nicht in Provider-Metadaten oder API-Antworten. Bestehende IDs werden nicht überschrieben. Pi-Dateien werden nur beim einmaligen Import gelesen, niemals verwaltet oder zurückgeschrieben.

## Projekte und Chats

Ein **Projekt entspricht einem Ordner** auf dem Rechner. Jeder **Chat ist ein Thread mit eigener Laufhistorie** und eigenem Hive. **Follow up** startet einen neuen Run im selben Thread; der Harness baut dafür einen begrenzten Kontext aus früheren Turns und Projektwissen, nicht aus vollständigen Pi-Transkripten oder wiederverwendeten Pi-Sessions. Der laufende Instanz-Chat zum Steuern von Dwight/Angela bleibt davon getrennt.

In **New project** öffnet **Browse...** in der Desktop-App die native Ordnerauswahl. Die Auswahl trägt nur den absoluten Workspace-Pfad ein; erst **Create project** registriert das Projekt nach serverseitiger Pfadprüfung. Abbrechen lässt den bisherigen Pfad unverändert. Im normalen Browser ist die native Auswahl nicht verfügbar: den absoluten Ordnerpfad manuell eintragen. Das Pfadfeld bleibt auch in der Desktop-App editierbar; ein leerer Pfad verwendet weiterhin den Standard-Projektordner.

Mehrere Projekte und mehrere Chats desselben Projekts können gleichzeitig laufen, aber nur **ein Run je Chat**. Das Registry-Limit ist `maxConcurrentRuns` in der Konfiguration bzw. `SCRANTON_MAX_RUNS`, Standard **4**; es zählt Runs über alle registrierten Projekte, einschließlich blockierender Run-Leases. `--parallel` begrenzt dagegen Meilenstein-Pipelines innerhalb eines Runs. Alle Chats/Pipelines desselben Abos teilen dessen Rate-Limit.

```powershell
node bin/scranton.js projects add "Meine App" --data .scranton-data --workspace C:\Projekte\MeineApp
node bin/scranton.js projects list --data .scranton-data
node bin/scranton.js chats PROJEKT-ID --data .scranton-data
node bin/scranton.js run "Implementiere die erste Version" --data .scranton-data --project PROJEKT-ID
node bin/scranton.js run "Ergänze Tests" --data .scranton-data --project PROJEKT-ID --chat CHAT-ID
node bin/scranton.js visualize --data .scranton-data
node bin/scranton.js projects remove PROJEKT-ID --data .scranton-data
```

IDs aus den Listen übernehmen. Ohne `--chat` legt `run` einen neuen Thread an; mit `--chat` folgt ein weiterer Run im vorhandenen Thread. Im Registry-Modus bestimmt das Projekt den Workspace und der Chat den Hive; `run` akzeptiert dort keine zusätzlichen `--workspace`/`--hive`. Für einen fehlenden Projektordner `projects add ... --create` verwenden; ohne `--workspace` entsteht er unter `Documents\Scranton\projects\<id>`. Derselbe reale Ordner kann nicht doppelt registriert werden. Entfernen verändert niemals Workspace-Dateien; `--delete-history` löscht zusätzlich die zugehörigen Scranton-Daten unter dem Datenverzeichnis.

`--data DIR` (alternativ `SCRANTON_DATA`, für andere Befehle auch Konfiguration `dataDir`) aktiviert die Registry. `run --project`/`--chat` verlangt ausdrücklich `--data` oder ein geerbtes `SCRANTON_DATA`; ohne diese Angabe wird kein Standardregister gelesen, sondern ein vollständiger Befehl mit dem Desktop-Datenverzeichnis vorgeschlagen. `.env` und `scranton.config.json` im Projektordner können keine Registry für einen Run auswählen und werden für explizite Registry-Runs nicht ausgewertet. Ein gestarteter Registry-Run nennt Projekt-/Chat-ID samt Fortsetzungsbefehl. `visualize --data` aktiviert auch die Steuerung und ist nur lokal zu verwenden. `projects`/`chats` verwenden ohne Datenpfad standardmäßig das Desktop-Datenverzeichnis; `projects list` nennt das gelesene Verzeichnis als `dataDir` in der JSON-Ausgabe. Der bisherige **Single-Modus mit `--hive`/`--workspace` ohne Registry bleibt erhalten**; die Oberfläche zeigt ein implizites Projekt und einen Chat `default`, ohne Projekt-/Chat-Verwaltung. Das Terminal-Dashboard bleibt an einen Hive gebunden. API und Speicherlayout: [CONTROL.md](docs/CONTROL.md).

### Kontextsystem

Ein **Turn** ist ein nicht mehr laufender Run: Nutzeranfrage und Ergebnis, auch bei Fehler oder Abbruch. Für den nächsten Turn entsteht deterministisch aus Dateien auf der Platte ein beratendes **Kontextpaket**, ohne Modellaufruf oder Pi-Session-Wiederverwendung. Das gilt nur im **Registry-/Desktop-Modus**; der Single-Hive-Modus bleibt unverändert. Projekte teilen niemals Kontext miteinander.

Die Anzeige-/Lesereihenfolge der Schichten ist **Projektnotizen → Dreaming-Gedächtnis → andere Chats desselben Projekts → ältere Turns dieses Chats als Einzeiler → jüngste Turns im Detail**; innerhalb der eigenen Historie steht der neueste Turn zuletzt. Die Budgetpriorität ist davon verschieden: neuester Turn im Detail, Projektnotizen innerhalb ihres Teilbudgets, weitere jüngste Turns (neueste zuerst), ältere eigene Turns, andere Chats, zuletzt Dreaming. Die aktuelle Anfrage hat immer Vorrang; Notizen sind nachgeordnete Nutzerpräferenzen, dieser Chat hat Vorrang vor anderen Chats und neuerer Kontext vor älterem. Nicht mehr passende eigene Turns werden verdichtet oder ausdrücklich als ausgelassen gezählt.

Das Budget wird in **geschätzten Tokens** angegeben, ohne Tokenizer: ungefähr vier Zeichen pro Token bei englischem ASCII-Text; andere Schriften werden nach Unicode-Codepoint gewichtet (ASCII und `…`: eine Einheit, übrige Codepoints bis U+2E7F: zwei, darüber: vier; vier Einheiten ergeben ein Token, aufgerundet). Die Zähler sind Schätzungen, keine vom Modellanbieter gemessenen Tokenzahlen.

Pro Projekt lässt sich ein **Anteil des Modell-Kontextfensters** (Standard **10 %**, einstellbar **1–50 %**) oder eine feste Zahl (**1000–200000 Tokens**) speichern, mit bis zu **32 modellbezogenen Overrides**. Ein Override für `provider/model` hat Vorrang vor der Projektregel. Das effektive Team-Budget ist auf höchstens die Hälfte des Fensters und **200000 Tokens** begrenzt, wobei die Untergrenze von **256 Tokens** Vorrang hat. Ist das Fenster unbekannt, rechnet Scranton mit **128000 Tokens** und kennzeichnet diese Annahme. Michael und Dwight werden getrennt nach ihrem jeweiligen Modell budgetiert.

| Grenze (`src/core/context/limits.js`) | Wert |
|---|---|
| Team-Planung (Michael) | Modellbezogenes Tokenbudget; Teilbudgets und Zahl detaillierter Turns skalieren damit (höchstens **12** im Detail); Transport höchstens **800000 Zeichen** |
| Team-Entwicklung (Dwight) | Ein Zehntel seines effektiven Budgets, mindestens **250**, höchstens **2000 Tokens**, nie mehr als das eigene Budget; Notizen und verdichtete eigene Turns, keine fremden Chats, kein Gedächtnis, keine Antworten |
| Gespeicherte Projektnotizen / Dreaming-Quelle | **16000 Zeichen / 65536 Bytes** bzw. weiterhin **2000 Zeichen** vor der Paketbudgetierung |
| Andere Chats | Höchstens **6 Chats × 3 Turns**, nur Restbudget |
| Pipeline-Kontextbudget | Durch das Engine-Promptbudget begrenzt: **4000–18750 geschätzte Tokens** für History und Kontext zusammen; nicht das gesamte Modellfenster |
| Pipeline-Transport mit `budget` | Notizen höchstens **16000 Codepoints**, ältere Turns **64 × 240**, andere Chats **6 × 3 × 240**; Python akzeptiert höchstens **65536 UTF-8-Bytes** für `context` und **262144 Bytes** insgesamt; Node hält zusätzlich die berechneten Bytezulagen ein |
| Eingaben | Team-Anfrage **32768 Zeichen**, Nachricht an einen laufenden Agenten und HITL-Feedback je **16000 Zeichen**; Pipeline-Aufgabe weiterhin **32768 UTF-8-Bytes**, Pipeline-Gatekommentar weiterhin **4000 Zeichen** |
| Turn-/Geschwistersammlung | Eigener Chat höchstens **500** Runs; **12** zuletzt aktualisierte andere Chats mit je **4** neuesten Runs; gemeinsames Lesebudget **64 MiB**. Die bestehende Pipeline-Auswahl der jüngsten Runs und des Planankers liest bei Bedarf separat weitere Artefakte |

Eingabe-Zeichengrenzen zählen JS-Stringlänge; beim Kürzen bleiben Codepoints ganz. Projektnotizen stehen vollständig im Team-Paket, wenn sie höchstens die Hälfte des Paketbudgets belegen; sonst werden sie mit Hinweis gekürzt. Bei Platzmangel schrumpfen detaillierte Turns zuerst um Dateien, dann Plan, Antwort und Anfrage, sonst werden sie zum Einzeiler. Gate-Agenten (Oscar, Hank, Angela und eigene Gates) erhalten nichts Neues. Dwight erhält den Kurzbrief bei Aufgaben und Wiederholungen, auch ohne Planung. In **Pipeline-Chats** erhält nur der Planner History und einen separaten `conversation_context`-Block. Mit den Bytezulagen `H` und `C` im History-Objekt gelten **`min(H, max_prompt_bytes // 4, room)`** und **`min(C, max_prompt_bytes // 8, room)`**; Implementer und Reviewer bleiben unverändert. Ohne `budget` gelten unverändert die bisherigen Wire- und Promptgrenzen ([PIPELINE.md](docs/PIPELINE.md#cross-run-continuity)). Andere Chats liefern nur verdichtete Zeilen, niemals Einträge in `runs`.

Die **Context**-Zeile bei **Follow up** zeigt bei belegtem Kontext **`≈` Tokens und den Prozentanteil am Modellfenster** und öffnet die Seitenleiste mit Budget, Verbrauchsmeter, Modell-ID und Fenstergröße, aufklappbaren Schichten und bei Team dem Entwicklerbrief. Die Seitenleiste nennt Verbrauch in Tokens, Prozent des Budgets und Prozent des Fensters sowie eine etwaige Begrenzung. Prozentwerte lauten `0` bei leerem Verbrauch, `<0.1` unter 0,1 Prozent, sonst mit einer Nachkommastelle, solange der auf eine Nachkommastelle gerundete Wert unter 10 liegt, darüber als gerundete ganze Zahl (9,96 Prozent erscheint als `10`, nicht `10.0`). Dort lassen sich Prozent-/Tokenmodus, Wert und `Only for <model id>` setzen; **Reset to default** entfernt den wirksamen Modell-Override, sonst die Projektregel. Vor dem Schließen fragt die Seitenleiste nach, ob ungespeicherte Notiz- oder Budgetänderungen verworfen werden sollen. Im Pipeline-Chat bleibt die Budgetvorschau innerhalb von **4000–18750 Tokens**; eine geänderte Plannermodellwahl lädt das Chatdokument neu. Team-Schichten zeigen den eingespeisten Text, Pipeline-Schichten eine lesbare Projektion, nicht den wörtlichen Prompt. **Share context between the chats of this project** ist pro Projekt standardmäßig an; aus bedeutet weder Empfang noch Weitergabe der Schicht „andere Chats“. Projektnotizen lassen sich dort bearbeiten und speichern; leerer Text löscht ihren Inhalt. **Start fresh from here** setzt einen Chatmarker: Turns, die zu diesem Zeitpunkt oder früher begannen, werden aus allen Paketen ausgeblendet, auch aus der Sicht anderer Chats. Die Historie bleibt erhalten, **Restore earlier turns** entfernt den Marker. Projektnotizen und Dreaming bleiben vom Reset unberührt; Kontextänderungen gelten für nächste Turns, nicht rückwirkend für laufende Prompts.

```text
node bin/scranton.js context show    --data DIR --project ID [--chat ID] [--model PROVIDER/MODEL] [--json]
node bin/scranton.js context budget  --data DIR --project ID (--percent N | --tokens N | --default) [--model PROVIDER/MODEL]
node bin/scranton.js context notes   --data DIR --project ID (--file FILE | --clear)
node bin/scranton.js context share   --data DIR --project ID on|off
node bin/scranton.js context reset   --data DIR --project ID --chat ID
node bin/scranton.js context restore --data DIR --project ID --chat ID
```

`context budget` setzt ohne `--model` die Projektregel, mit `--model` deren Override; `--default` entfernt die jeweilige Regel. `context show --chat` nennt `Budget: ≈<used>/<tokens> tokens` mit Prozent des Budgets, Prozent des Modellfensters, Fenstergröße und Modell-ID; ein unbekanntes Fenster wird mit `[window assumed]`, eine Begrenzung mit `[capped: ...]` markiert. Der Entwicklerbrief erhält eine eigene Budgetzeile, Notizen einen Zeichenstand gegen 16000. `--model` wählt beim Anzeigen eines Pipeline-Chats das Plannermodell; Team verwendet die Agentenkonfiguration. `--json` liefert die v2-Dokumente, Notizdateien dürfen höchstens 65536 Bytes haben.

Gespeichert werden `<data>/projects/<id>/context/settings.json` (`{v:2,crossChat:true,budget:{mode:"percent",value:10},models:{}}`; höchstens **65536 Bytes**, v1 bleibt lesbar), daneben `notes.md` und `<data>/projects/<id>/chats/<chat>/context/state.json` (`{v:1,resetAt:null}` oder ISO-Zeitpunkt). Turns und Pakete werden daraus und aus der Laufhistorie abgeleitet, nicht als neue Zusammenfassungen gespeichert. Fehlende/defekte Einstellungen verwenden die Defaults; unlesbare, zu große oder verlinkte Artefakte werden isoliert ausgelassen, statt einen Runstart zu verhindern. HTTP-Dokumente und Transport: [CONTROL.md, Abschnitt 12](docs/CONTROL.md#12-context-system-registry-only).

**Grenzen:** Kontext ist nur beratend: Keine Freigaben, abgeschlossenen Schritte, Check-Erfolge, Evidenz-IDs, Checkpoints oder Ausführungszustände werden übernommen; neue Reads, Prüfungen und Freigaben bleiben erforderlich. Redaktion von Zugangsdaten ist Best Effort, keine Anonymisierung. **Files touched** in Team-Turns stammt aus journalisierten `write`-/`edit`-Toolereignissen von Dwight und ist ein Pfadzeiger, kein Liefernachweis. Verdichtung ist deterministisch, keine modellgeschriebene Zusammenfassung. Aus den Kontextschätzungen folgt keine Aussage über die Qualität mit echten Modellen.

## Dreaming: lokales Projektgedächtnis

Dreaming gilt für registrierte Projekte mit **Team- und Pipeline-Chats** und ist **standardmäßig aus**. Die strukturelle Konsolidierung benötigt weder Modellaufrufe noch zusätzliche Dienste; die unten beschriebene optionale Modellreflexion ist davon getrennt. Zwei Konzepte werden bewusst unterschieden: [OpenClaw dreaming](https://docs.openclaw.ai/concepts/dreaming) inspiriert die Light/REM/Deep-Konsolidierung belegter Beobachtungen; [Dream-RSI](https://arxiv.org/html/2609.14858v1) inspiriert den Vergleich alternativer Explorationsstrategien auf eingefrorenen Ergebnissen. Scranton adaptiert Letzteres konservativ auf tatsächlich aufgezeichnete autonome Wiederholungsketten, nicht auf erfundene unabhängige Welten. Diese strukturelle Implementierung ist deterministisch, kein generatives Traummodell und kein Nachweis wissenschaftlicher Qualitäts- oder Geschwindigkeitsverbesserungen.

```powershell
node bin/scranton.js dreaming status --data .scranton-data --project PROJEKT-ID --json
node bin/scranton.js dreaming preview --data .scranton-data --project PROJEKT-ID --json
node bin/scranton.js dreaming run --data .scranton-data --project PROJEKT-ID
node bin/scranton.js dreaming on --data .scranton-data --project PROJEKT-ID
node bin/scranton.js dreaming off --data .scranton-data --project PROJEKT-ID
node bin/scranton.js dreaming rollback --data .scranton-data --project PROJEKT-ID
```

`on` aktiviert ausschließlich automatische Sweeps im laufenden Registry-Server (Standard alle 360 Minuten), nur bei projektweitem Leerlauf ohne Recovery-Blockade. Das Abschalten bewahrt das Gedächtnis. Vorschau schreibt nichts; Rollback stellt das letzte Vorbild wieder her. **Policy-Anwendung ist separat aus**: Erst `applyPolicy:true` über Settings erlaubt beim nächsten echten Run ausschließlich eine Verringerung bis `min(Nutzergrenze, gelernte Grenze)`, passend zu Engine, Wiederholungsgrenze und exakter Prüfrezept-Kohorte. Keine Schritte, Checks, Rechte oder menschlichen Freigaben werden dadurch übersprungen; laufende Runs bleiben unverändert.

Team nutzt strukturierte Zyklus-/Gate-Ergebnisse. Neue Pipeline-Läufe liefern explizite `dream_attempt`-Ereignisse; alte `check_finished`-Historien haben keine zuverlässige Versuchsbindung und liefern nur finale strukturelle Beobachtungen, **keine erfundenen Replay-Versuche**. Pipeline-Replay und -Anwendung enthalten sich außerdem bei erforderlichen Final-Checks oder fehlenden erforderlichen Schritt-Checks. Das begrenzte Projektgedächtnis kommt nur als neu belegter, ausdrücklich beratender Kontext in die nächste Planung; fehlgeschlagene Änderungen gelten nicht als geliefert. Python-Guidance/Procedural Graphs bleiben davon getrennt.

Für die strukturelle Konsolidierung gespeichert werden feste beschreibende Ergebnistexte, Aufgaben-Hashes und Quellen-Digests unter `<data>/projects/<id>/dreaming`, **keine Rohaufgaben, Prompts, Logs oder Agentenprosa** und keine Workspace-`MEMORY.md`. Verlinkte/externe und unsichere Historien werden abgewiesen; menschlich beeinflusste oder gekürzte Ketten sind ausgeschlossen. Die ursprünglichen Laufhistorien können weiterhin sensible Daten enthalten und werden nicht bereinigt. Grenzen, HTTP-API, Datenschutz und Replay-Verfahren: [DREAMING.md](docs/DREAMING.md).

### Optionale, Claude-inspirierte Modellreflexion

Zusätzlich kann **„Propose“** redigierte Ausschnitte aus höchstens vier abgeschlossenen echten Team-/Pipeline-Läufen an ein **explizit gewähltes, angemeldetes Provider/Modell** senden. Das kostet gegebenenfalls Tokens/Geld oder Abo-Kontingent. Maximal 1000 Textzeichen pro Lauf, 12000 Zeichen gesamte Anfrage, 4096 Ausgabezeichen, konfigurierbar 256–4096 Ausgabetokens und höchstens 60 Sekunden. Redigierung ist Best Effort, keine Anonymisierung; unbekannte Geheimnisformate können verbleiben. Assistentenbehauptungen sind von aufgezeichneten Check-/Exit-Ergebnissen getrennt. Nutzungs-/Kostenangaben erscheinen nur, wenn bekannt.

Die Vorschläge enthalten typisierte Notizen (`user`, `feedback`, `project`, `reference`), tatsächliches Vorher/Nachher und Quellzitate. **Erst explizites Apply mit Vorschlags-ID übernimmt sie**; Reject verwirft, Cancel bricht die Generierung ab, Rollback stellt den letzten Zustands-/Settings-Stand wieder her (nicht verbrauchte Tokens). Quellen werden vor Übernahme und späterer Kontext-Injektion erneut geprüft. Beratendes Gedächtnis bleibt zusammen auf 2000 Zeichen begrenzt, aktuelle Aufgabe und derselbe Chat haben Vorrang. Keine Übernahme von Freigaben oder Check-Erfolg; kein On-Demand-Abruf von Themendateien und kein belegter Qualitätsgewinn.

Automatische Generierung braucht **beide** Opt-ins `enabled` und `reflectionEnabled`, ein konfiguriertes Modell, neue Eingabe und Projektleerlauf ohne offenen Vorschlag. Automatisches Apply gibt es nicht. Defaults: `reflectionEnabled:false`, `reflectionModel:null`, `reflectionMaxOutputTokens:2048`, `reflectionTimeoutSeconds:60`. Normale Runs und strukturelle Preview/Sweep rufen niemals ein Reflexionsmodell auf; Run-Starts brechen laufende Reflexion ab, ohne deren Cleanup abzuwarten.

```powershell
node bin/scranton.js dreaming propose --data .scranton-data --project PROJEKT-ID --provider PROVIDER --model MODELL --json
node bin/scranton.js dreaming apply --data .scranton-data --project PROJEKT-ID --proposal VORSCHLAGS-ID --json
node bin/scranton.js dreaming reject --data .scranton-data --project PROJEKT-ID --proposal VORSCHLAGS-ID --json
node bin/scranton.js dreaming cancel --data .scranton-data --project PROJEKT-ID --json
```

Der begrenzte Reflexionstransport verwendet `tools/dreaming-complete.js` und eigene LLM-Clients ohne Tools/Sessions. Vor Inferenz wird die unterstützte API-Ausgabetokenbegrenzung geprüft; nicht unterstützte Payloadpfade scheitern geschlossen. Katalogpräsenz garantiert keine Endpunktkompatibilität. Tests bleiben offline/scripted.

**Quellenabgrenzung:** Die recherchierten offiziellen Claude-Code-Dokumente beschreiben Auto Memory und `/memory`, keinen dokumentierten öffentlichen `/dream`-Befehl. Ein von Dritten extrahierter Konsolidierungsprompt belegt keine öffentliche Verfügbarkeit oder Trigger. **Managed Agents Dreams ist ein anderes Produkt.** Quellen, Übertragungs-/Budgetgrenzen und API: [Recherche](docs/CLAUDE_CODE_DREAMING_RESEARCH.md), [DREAMING.md](docs/DREAMING.md).

## Scranton Pipeline

Neben Team-Chats gibt es **Pipeline-Chats** mit eigener Python-/LangGraph-Engine: begrenzte Plan-/Edit-/Prüfschritte im privaten Snapshot sowie menschliche Plan- und Lieferfreigaben. Die Host-Bridge `tools/pipeline-complete.js --provider P --model M [--thinking T] <request.json> <response.json>` verwendet Scrantons eigene LLM-Clients und Credentialstore für eine Completion mit `tools:[]`, ohne Agentensession. Der Supervisor meldet `via:"bridge"` und konfiguriert `provider:"command"`. Kompatible API-Key-Konten können weiterhin `via:"direct"` verwenden. Modellaufrufe laufen auf dem Host, unabhängig von der Pipeline-Check-Sandbox. Automatisierte Tests nutzen lokale/scripted Provider; historische Pi-Smokes sind kein Nachweis des neuen Transports. Einstieg: [PIPELINE.md](docs/PIPELINE.md), [Engine](engine/README.md), [Architektur](engine/docs/ARCHITECTURE.md).

Pipeline ergänzt begrenzte **Neuplanung** mit erneuter menschlicher Planfreigabe und **parallele Schritte** in privaten Lanes mit anschließender Integrationsprüfung.
Die **Docker-Sandbox** hat ein eigenes, lokal über **Build sandbox image** baubares Image; Demo-Szenarien zeigen Grundablauf, Neuplanung, Parallelität und **Evidence checks** (`demo --scenario evidence`, HTTP `demoScenario:"evidence"`) ohne Modellaufrufe. Die Evidence-Demo weist einen blinden Plan (`unseen_target`) und einen falschen Abwesenheitsclaim für `add` (`false_absence`, mit Treffern) ab und repariert beide; am Liefer-Gate steht ein durch die Baseline `demonstrated`-Kriterium neben einem `met_not_demonstrated`, mit `criteria_not_demonstrated`, ohne `grounding_violations`. Nach beiden Freigaben gelingt der Run. Das Szenario verlangt `enforce` (CLI `--grounding observe`: Exit 2, HTTP: 400); Ablauf und aufgezeichnete R9-Scores stehen in der [Engine-Anleitung](engine/README.md#evidence-demo-abgewiesen-repariert-trotzdem-erfolgreich). Bedienung und Grenzen: [PIPELINE.md](docs/PIPELINE.md), Konfiguration/CLI: [Engine-README](engine/README.md).
**Evidence grounding** prüft gezeigte Evidenz, Abwesenheitsclaims und Kriterien durch Python; **Evidence** unterscheidet demonstrierte Wirkung von schon vorher grünen Checks. Die Gegenprobe verlangt erst bestandene Testchecks mit der Änderung und dann einen Fehlschlag ohne sie (auch Importfehler zählen); Abwesenheit gilt nur im policy-erlaubten Suchraum: `missing_file` vergleicht ausschließlich Namen (auch vorhandene Verzeichnisse), Nichttextdateien sind nur von der Symbol-Inhaltssuche ausgeschlossen; leere Suchabdeckung bleibt `unverifiable`. Vollständiges Überschreiben braucht immer einen aktuellen, ungekürzt gezeigten Vollread der Datei, sonst `unseen_edit` mit dem Hinweis auf `replacements`. Die Ausnahme für nicht vollständig lieferbare Python-Reads gilt bei Edits nur für `replacements`/`delete` mit wenigstens teilweise gezeigter aktueller Datei; modellangeforderte Reads werden vor Python-eigenen entfernt. Ein `approve` trotz eigener `not_met`-Assessments oder eigener `blocking`-Findings ist ungültiger Output; nur ein ansonsten konsistentes `approve` trotz unerfülltem Python-Checkkriterium führt in die begrenzte Reviewrevision statt in die Outputreparatur.
Eine **judge-freie Eval-Suite** (`eval --pack core`) und optionale **Procedural guidance (experimental)** mit Offline-`evolve` ergänzen den Ablauf; Guidance ist standardmäßig aus, verdrängt keine Evidenz und verändert keine Ausführungsrechte oder Graphkanten. Auch der abschließende Gateway-Cap berücksichtigt die tatsächlich gerenderten Guidancebytes zusätzlich zum Basispromptbudget innerhalb der eigenen Zulage. `evolve` bewahrt abgelehnte Runden in beiden JSONL-Historien vollständig; nur ihre Kopie im Refinerprompt wird auf 2 KB je Zeile kompaktiert.
Das Lieferflag `grounding_violations` warnt nur vor angenommenen Verstößen unter `observe`; unter `enforce` bleiben reparierte Verstöße im Score und in den Anzahlen, nicht als dieses Flag.
Diese drei Erweiterungen sind nur scripted geprüft, nicht mit echten Modellen; Regression, bewusste Aktivierung und Grenzen: [Engine-README](engine/README.md), Entwurfsbegründung: [Architektur](engine/docs/ARCHITECTURE.md).

## Parallelität, Prüfung und Integration

Standard: eigener dauerhafter Agentenloop, bis zu drei aktive Meilenstein-Pipelines, private Git-Worktrees und Scranton-OS-Sandbox. Instanzen heißen z. B. `michael`, `dwight-m1`, `angela-m1`; Rollen sind bei parallelen Aufgaben keine eindeutigen Chat-Adressen.

Der Plan enthält `dependsOn`: Fehlt das Feld, hängt der Meilenstein vom Vorgänger ab; explizites `[]` bedeutet unabhängig. Unbekannte, eigene oder zyklische Abhängigkeiten werden abgewiesen. Eine Abhängigkeit ist erst nach erfolgreicher QA **und sicherer Integration** erfüllt; übersprungene/fehlgeschlagene Voraussetzungen geben Nachfolger nicht frei.

Scranton erstellt ein **privates Schatten-Repository** unter `hive/isolation/`, auch für schmutzige, noch nicht committete oder Nicht-Git-Workspaces. Das Benutzer-Repository wird nicht für interne Branches/Commits verwendet: HEAD, Index und Historie bleiben erhalten. Ignorierte Abhängigkeiten/Buildausgaben und bekannte Credential-Dateien werden nicht in den Snapshot aufgenommen. Deshalb müssen Tests ihre benötigten Abhängigkeiten im privaten Checkout selbst bereitstellen. Das ist kein vollständiger Geheimnisscanner.

Nach `[TASK_COMPLETE]` erhält Angela einen eigenen Worktree aus genau diesem Entwickler-Snapshot. Nur der geprüfte Entwicklerstand darf ins Ziel zurückfließen. Integration ist serialisiert und prüft Änderungen gegen die Ausgangsbasis; überlappende Nutzeränderungen werden als Konflikt gemeldet, nicht überschrieben. Diagnose-Worktrees bleiben erhalten. Vor echten Aufträgen trotzdem sichern; ein Worktree ist kein Backup.

### Restore Points und Undo

Für Team-Worktree-Integration (Scranton-Sandbox, Trusted Host oder Docker) speichert Scranton die ursprünglichen Bytes der betroffenen Dateien vor dem Zurückschreiben unter `<hive>/restore-points/<runId>/`. Auch uncommittete Ausgangsdateien werden so erhalten. Der Start nennt in zwei Zeilen nur, ob im Ordner oder einem Elternordner `.git` gefunden wurde, sowie die Restore-Point-Grenzen. Er führt dafür kein Git aus, liest keine Git-Konfiguration und zählt keine uncommitteten/ungetrackten Dateien. Die Abschlussübersicht nennt den exakten Undo-Befehl nur, wenn noch Dateien zurückzusetzen sind, und weist auf die Anzahl nicht restaurierbarer Dateien hin.

```powershell
node bin/scranton.js undo --hive .scranton-hive --list
node bin/scranton.js undo --hive .scranton-hive
node bin/scranton.js undo --hive .scranton-hive --run RUN-ID
node bin/scranton.js undo --data .scranton-data --project PROJEKT-ID --chat CHAT-ID
```

Undo arbeitet innerhalb eines Hives rückwärts: Ohne `--run` wählt Undo den neuesten Run, für den noch Dateien zurückzusetzen sind. Ein älterer Punkt wird auch mit `--force` abgewiesen, solange neuere Punkte noch offen sind; die Meldung nennt deren Run-IDs und den Ausweg: spätere Änderungen mit `--force` überschreiben oder beide Stände belassen. Behaltene `changed`-Dateien und vorübergehend blockierte `blocked`-Dateien halten einen Punkt offen; `remaining` zählt nur restaurierbare Dateien ohne `undoneAt` und ohne `undoUnrestorable`. Die Liste nennt zusätzlich `undone` (bereits zurückgesetzte Dateien) und `unrestorable` (Dateien ohne brauchbares Backup); `files` bleibt die Gesamtzahl. `--list` unterscheidet noch zurückzusetzende, teilweise zurückgesetzte und vollständig zurückgesetzte Punkte von Punkten ohne restaurierbare Dateien und nennt fehlende Backups ausdrücklich. Ein Punkt gilt als erledigt, wenn `undoneAt` gesetzt ist oder keine Datei mehr offen ist (`remaining:0`), auch wenn der abschließende Zeitstempel nach einem Abbruch noch fehlt; ein explizites Undo ergänzt ihn; nicht restaurierbare Dateien werden auch bei erneutem explizitem Undo weiter gemeldet. Nicht entfernbare angelegte Verzeichnisse liefern Warnungen, halten den Punkt aber nicht offen. Unlesbare Einträge erscheinen als `unreadable`, werden nie ausgewählt und beim Pruning ausgelassen. Normales Undo bleibt daneben möglich; `--force` wird jedoch abgewiesen, wenn der Verzeichniszeitstempel eines unlesbaren Eintrags neuer als der gewählte Punkt ist. Die Meldung nennt diesen Eintrag. Ein vollständig zurückgerollter erster Integrationsversuch hinterlässt keinen Punkt. Undo stellt betroffene Dateien auf den Vorlaufstand zurück und entfernt vom Run angelegte Dateien; gemeldet werden nur tatsächlich geänderte Pfade. Konflikte enthalten Pfad, Grund und Code: `changed` bedeutet, dass der aktuelle Inhalt nicht mehr dem vom Run geschriebenen Stand entspricht, egal ob durch Menschen oder einen anderen Chat; nur dann kann `--force` helfen. `unrestorable` bedeutet fehlendes oder unbrauchbares Backup (keine unabhängige reguläre Datei, Größenlimit oder abweichende Größe/SHA-256), was Force nicht behebt; vorübergehende Lesefehler wie EBUSY/EACCES oder eine während des Lesens geänderte Datei sind dagegen `blocked` und werden beim nächsten Undo erneut versucht. `blocked` bedeutet einen behebbaren Zugriffs-/Schreibfehler oder unsicheren Pfadzustand; die CLI meldet ihn als `Blocked` mit Fehlercode oder sicherem Grund (etwa Hardlink, Verzeichnis/Link, unsicherer Elternpfad oder Manifestlimit), ohne Dateiinhalte oder fremde absolute Pfade und ohne Force-Empfehlung: Ursache beheben und Undo erneut ausführen; `--force` hilft hier nicht. Ein aktiver Run in diesem Chat, notwendige Recovery oder ein aktiver/ungeklärter Run eines anderen Projektchats blockiert Undo auch mit Force. Undo hält während der ganzen Operation dieselbe Hive-Lease wie ein Run und wird bei einem konkurrierenden Undo oder Run ausdrücklich als Undo benannt. Nach einem Undo-Absturz gibt Recovery unter denselben Besitznachweisregeln nur Lease und Heartbeat frei: Laufhistorie, Events und Restore-Point-Buchführung bleiben unverändert; ein erneutes Undo setzt die Dateiarbeit fort. Andere Chats werden geprüft, nicht projektweit gesperrt: Ein Geschwister-Run kann während Undo neu starten; die Integration ist weiterhin über den Workspace-Lock serialisiert. Exit 0: erledigt/Liste, 1: Konflikte oder Betriebsfehler, 2: Aufruffehler.

**Grenzen:** Die neuesten **10** Punkte bleiben erhalten; Vorlaufdateien über **16 MiB** werden nicht gesichert und sind auch mit Force nicht restaurierbar. Gesichert sind nur tatsächlich integrierte Dateien, nicht der ganze Ordner. **Nicht abgedeckt:** Shared-/direkte Workspace-Ausführung, der einzelne `agent`-Befehl und Python-Pipeline-Chats. Shared schreibt direkt in den Ordner; ein privater Einzelagent behält seine Ergebnisse dagegen im am Ende genannten Worktree, ohne Integration. Git-Index und Historie werden nicht zurückgesetzt. Restore Points enthalten möglicherweise sensible ursprüngliche Dateiinhalte und gehören nicht ins öffentliche Repository.

Bei Integrationskonflikten ist **Retry kein Rebase**: Der Entwickler-Worktree behält seine unveränderliche Ausgangsbasis. Ohne Änderung der Konfliktursache kann derselbe Konflikt erneut auftreten. Du kannst abbrechen, den Konflikt bewusst außerhalb des Laufs auflösen und einen frischen Lauf starten oder den Meilenstein überspringen; Nutzerarbeit und Diagnoseartefakte nicht automatisch löschen.

## Optionen

| Option | Bedeutung |
|---|---|
| `--workspace DIR`, `--hive DIR`, `--config FILE` | Ziel, Laufzeitdaten, Konfiguration |
| `--parallel N` | Maximale aktive Pipelines (Standard 3); Parallelität erfordert Worktrees |
| `--sandbox docker` | Optionaler Container-Modus, kein stiller Host-Fallback |
| `--sandbox-image IMAGE` | Lokal vorhandenes Linux-Image, Standard `scranton-tools:24-r1` |
| `--sandbox-network allow\|none` | `allow` erlaubt Tool-Netzwerkzugang (`bridge` nur als Alias); `none` sperrt ihn, nicht die hostseitigen LLM-Aufrufe |
| `--trusted-host` | Explizit auf dem Host ausführen, Worktrees bleiben getrennt |
| `--no-plan` | Eine Aufgabe ohne Modellplanung |
| `--request-file FILE` | `run`: UTF-8 (BOM optional) oder UTF-16 mit BOM; erstes Nicht-Leerzeichen `{` verlangt das strikte Envelope `{"v":1,"request":"..."}`, sonst wörtlicher Text; höchstens 32768 Zeichen / 262144 Bytes |
| `--max-cycles N` | Fehlgeschlagene QA-Zyklen bis zum Circuit Breaker (Standard 3) |
| `--on-breaker ask\|abort\|skip\|hive` | Menschliche Entscheidung im Terminal, automatisch oder dateibasiert |
| `--timeout-min N` | Zeitlimit pro Agent (Standard 20 Minuten) |

Eine Anfrage kann statt als Argument mit `node bin/scranton.js run --request-file auftrag.txt --workspace "C:\Projekte\MeineApp" --hive .scranton-hive` aus UTF-8-Text (optionale BOM wird entfernt) oder UTF-16 mit LE-/BE-BOM gelesen werden; ungültige Kodierung wird abgewiesen. Ist das erste Nicht-Leerzeichen `{`, muss der Inhalt das strikte v1-Envelope sein (nur `v` und `request`); auch kaputtes JSON wird dann abgewiesen. Sonst bleibt der Inhalt wörtlicher Text, wobei genau ein abschließendes LF/CRLF/CR entfernt wird; Arrays und Skalare bleiben Text. Die Anfrage darf nicht leer oder nur Leerraum sein und höchstens 32768 JS-Zeichen enthalten. Fehlende Dateien, Verzeichnisse, Symlinks, Hardlinks, mehr als 262144 Bytes und ungültige Inhalte liefern Exit 2 mit `Invalid request file` plus kurzem Grund. Die CLI löscht die Datei nie; ein gleichzeitiges Positionsargument ist unzulässig.

`agent <michael|dwight|oscar|hank|angela> "Aufgabe"` startet genau eine auditierte Instanz mit derselben Run-Lease und Isolation wie ein Lauf. Es startet keine zusätzliche QA-Pipeline und integriert private Änderungen im Standard-Worktree-Modus nicht ins Ziel. Im expliziten Shared-Host-Modus arbeitet es dagegen direkt im Workspace. Die vollständige lokale CLI-Hilfe ist maßgeblich. Exit-Codes: 0 Erfolg, 1 teilweise/fehlgeschlagen/abgebrochen, 2 Aufruffehler, 130 Strg+C.

## Sessions und direkter Chat

Agentenaufrufe sind Workflows mit checkpointierten Modell- und Toolschritten, keine CLI-/RPC-Prozesse. Abbruch signalisiert laufende Anfragen und Werkzeuge; Cleanup wird vor Freigabe der Run-Lease abgewartet. Unklare externe Effekte werden nicht als sicher fehlgeschlagen behandelt oder blind wiederholt.

Session-IDs identifizieren Instanzen, laden aber keine Pi-Sessiondateien. Kanonische Modellhistorie liegt im dauerhaften `history`-Stream des Workflows, Ausgaben im `output`-Stream; ein neuer Aufruf ist ein eigener Workflow. Gleicher expliziter Invocation-Key hängt an denselben Workflow an. Dauerhafte Schritte sind keine automatische Wiederaufnahme des gesamten Orchestrator-Runs. Hive und Datenbank enthalten sensible Aufgaben, Antworten und Reasoning und gehören nicht in Releases.

`agent_chat({to,text})` ist ein eigenes Tool für exakte Instanz-IDs. Menschen verwenden den Instanz-Chat bzw. `POST /api/chat`. `queued` heißt nicht gesendet, `delivered` bestätigt die dauerhafte Steering-Queue, nicht Modellverarbeitung; `rejected` ist definitive Ablehnung, `unknown` bleibt unklar und wird nicht automatisch wiederholt. Kein eigenständiger `message`-CLI-Befehl. Details: [CONTROL.md](docs/CONTROL.md).

## Circuit Breaker und Oberflächen

Nach drei aufeinanderfolgenden fehlgeschlagenen Testzyklen fragt Scranton nach Feedback, Retry, Skip oder Abort. `[BLOCKED]` und Infrastrukturfehler fragen nach Abschluss aller Gates der Stufe, ohne drei Zyklen zu verbrauchen. Menschliche Rückfragen werden serialisiert; unabhängige Pipelines können weiterlaufen. Abort betrifft alle aktiven Prozesse.

```powershell
node bin/scranton.js dashboard
node bin/scranton.js dashboard --once --ascii
node bin/scranton.js visualize
node bin/scranton.js visualize --control --workspace workspace
```

Die Dashboards sind dunkel und strikt monochrom. Im Single-Modus ist der HTTP-Server ohne `--control` schreibgeschützt; `--data` aktiviert dagegen Registry und Steuerung. Steuerung benötigt eine echte Loopback-Verbindung, lokalen Host-Header, bei POST JSON und `X-Scranton-Client: 1`; keine CORS-Freigabe. Nicht ungeschützt ins Netz stellen. [EVENTS.md](docs/EVENTS.md) beschreibt Ereignisse, [CONTROL.md](docs/CONTROL.md) Run-/Chat-/HITL-Steuerung und Wiederherstellungsblockaden.

Für die Steuerung vom Smartphone verbindet der **ausdrücklich gestartete** Phone Relay das Dashboard über privates WLAN-HTTPS oder Tailscale **Serve** mit deinem Handy; die App öffnet nicht automatisch einen LAN-Port. Dieser Workflow benötigt **Scranton Desktop für Windows 0.5.0 oder neuer**; der Installer **0.4.0** enthält den Phone Relay nicht. **Ohne Checkout und ohne separates Node/npm:** Den tatsächlichen Installationsordner über die Scranton-Verknüpfung → **Dateispeicherort öffnen** finden (ggf. über deren Eigenschaften zum EXE-Ziel weitergehen), PowerShell neben `scranton-desktop.exe` und `scranton-node.exe` öffnen und nach dem Einrichten von privatem Serve ausführen:

```powershell
$dashboardPort = Read-Host 'Current dashboard port from Settings > Phone relay'
.\scranton-node.exe .\app\bin\scranton.js relay --origin https://your-computer.your-tailnet.ts.net --target-port $dashboardPort
```

Die Beispiel-URL durch die eigene Serve-URL ersetzen und den aktuell in **Settings → Phone relay** angezeigten Port eingeben; nach App-Neustart neu prüfen. **Kein Funnel, keine öffentliche Portweiterleitung.** Die [Einrichtung der Smartphone-Steuerung](docs/RELAY.md) erklärt beide privaten Modi einschließlich Zertifikat/Schlüssel und OpenSSL-Voraussetzung unter Windows sowie die weiterhin gültigen Checkout-Befehle. **Settings → Phone relay → Disconnect** trennt nur das aktuelle Telefon, **Ctrl+C** im Relay-Terminal alle Sitzungen. Zugangsdaten und Agentendefinitionen lassen sich nur lokal verwalten; PC-Loopback-Vorschauen sind vom Telefon nicht erreichbar. [Desktop-Details](docs/DESKTOP.md#smartphone-steuerung-ohne-checkout-windows)

Mit `--on-breaker hive` veröffentlicht Scranton während des Wartens `<hive>/human/request.json` mit `v`, `runId`, `requestSeq`, `milestoneId`, `title`, `reason`, `options`, `ts`. Daraus **runId und requestSeq unverändert übernehmen** und eine Entscheidung aus `options` wählen; kein Lesen von `events.jsonl` nötig. Beispiel für die vom Nutzer atomar (temporäre Datei, dann Umbenennen) geschriebene `<hive>/human/response.json`:

```json
{ "v": 1, "runId": "run-id", "requestSeq": 42, "decision": "feedback", "feedback": "Bitte das fehlende Kriterium testen.", "ts": "2026-11-08T12:00:00.000Z" }
```

`v:1`, passende Run-ID/Sequenz und ein ISO-Zeitstempel sind erforderlich; bei `feedback` zusätzlich nichtleerer Text (höchstens **16000 Zeichen**). Andere Entscheidungen: `retry`, `skip`, `abort`, sofern in `options`. Scranton archiviert die Antwort und entfernt die Anfrage beim Ende des Wartens. Nach hartem Absturz kann die Anfrage stehenbleiben; erfolgreiche Recovery entfernt sie.

Eine dauerhafte Run-Lease verhindert einen zweiten Schreiber auf denselben Hive. Nach einer Unterbrechung wird ein Besitzer beim nächsten CLI-Run nur automatisch als abgebrochen abgeschlossen und archiviert, wenn sein Prozess hier nachweislich fehlt, der in der Lease gespeicherte Host fehlt (Legacy) oder diesem Host entspricht, sein passender Heartbeat älter als 30 Sekunden ist und die Bereinigung verifiziert ist. Sonst nennt die Meldung Prozessbefund, Heartbeat-Alter und Host: warten und erneut versuchen oder nach eigener Prüfung aller alten Prozesse/Container `scranton recover ... --confirm-stopped` verwenden. Derselbe strengere Schutz gilt für CLI-Recovery ohne Bestätigung; die bestehende automatische Server-Recovery bleibt unverändert. Dies setzt keine alten Agentenprozesse fort. Zur Prüfung und manuellen Recovery:

```powershell
node bin/scranton.js recover --hive .scranton-hive
node bin/scranton.js recover --data .scranton-data --project PROJEKT-ID --chat CHAT-ID
# Nur nach eigener Prüfung, dass alle früheren Prozesse/Container beendet sind:
node bin/scranton.js recover --hive .scranton-hive --confirm-stopped
```

Ein lebender Besitzer wird nie freigegeben. Bei unbekanntem Besitzer oder ungeklärter Containerbereinigung bleibt die Sperre ohne `--confirm-stopped` erhalten; die Bestätigung kann Bereinigungswarnungen liefern. Nicht blind Lease-Dateien löschen oder gespeicherte PIDs beenden.

## Modelle und Konfiguration

Rangfolge: Flags > Umgebung > `scranton.config.json` > Defaults. `.env` wird geladen, bestehende Umgebungswerte gewinnen. Keine Zugangsdaten ins Repository schreiben; Vorlage: [`.env.example`](.env.example).

```json
{
  "execution": {
    "maxParallel": 3,
    "isolation": "worktree",
    "sandbox": { "mode": "scranton", "network": "allow" },
    "persistentSessions": true,
    "maxReplans": 0
  }
}
```

Dynamische Team-Neuplanung ist nicht implementiert: veröffentlichter DAG unveränderlich, effektives `maxReplans:0`. Rollenmodelle kommen aus Agent-Defaults oder Run-Overrides. LLM-Zugang bleibt hostseitig; Docker-`none` sperrt nur Toolnetz, `allow` (Alias `bridge`) erlaubt Egress.

Alte Pi-Einstellungen werden mit klarer Fehlermeldung abgewiesen: sämtliche `pi.*`-Optionen, `SCRANTON_PI_COMMAND` und `agents.<id>.extraArgs`. Modelle, Tools und Thinking direkt konfigurieren; keine fremden Pi-Erweiterungen, Skills oder MCP-Discovery. Projektdateien bleiben untrusted Eingaben.

**Gate-Werkzeuge sind absichtlich eingeschränkt:** `agents.oscar.tools`, `agents.hank.tools` und `agents.angela.tools` müssen wie eigene Gates eine nichtleere Teilmenge von `read`, `grep`, `find`, `ls`, `bash` sein (Windows-Fallback `powershell`). `write`/`edit` oder andere Werkzeuge führen bei jedem Konfigurationsladen, auch bei `visualize`, zu einem `ConfigError`, der den Schlüssel `agents.<id>.tools` nennt. Bestehende Konfigurationen müssen entsprechend angepasst werden. Shellwerkzeuge können weiterhin Dateien verändern; dies ersetzt keine OS-Isolation.

Gates erlauben nur `read`, `grep`, `find`, `ls` und Shell (`bash` bzw. `powershell`). Keine `write`-/`edit`-Tools; Shell ist dennoch schreibfähig. Die OS-Sandbox begrenzt Prozesse, die Tool-Allowlist ersetzt diese Grenze nicht. `extraArgs` sind für alle Rollen abgewiesen.

## Entwicklung, Desktop und Prüfstand

```powershell
npm.cmd run app:prepare
npm.cmd test
npm.cmd run test:packaging
```

Die Paketierungsprüfung benötigt frisch vorbereitete Ressourcen: `npm.cmd run app:prepare`, dann `npm.cmd run test:packaging`. Sie ersetzt keinen echten Modell-, Sandbox- oder Installer-Lifecycle-Test. Der Verpackungsstand muss separat am aktuellen Quellstand bestätigt werden; [DESKTOP.md](docs/DESKTOP.md).

Struktur: `src/core/` Orchestrierung, Tools, LLM, Credentials, Durable und Sandboxadapter; `src/server/` Control/SSE; `src/dashboard/` Terminal; `visualizer/public/` Web; `agents/` Rollenprompts; `tools/` Completionbridges; `sandbox/` optionales Dockerrezept. Neue Testfixtures liegen unter `.scratch/`, nie im echten Hive.

**Prüfgrenzen:** Deterministische Fake-/Protokolltests belegen keine echte Containergrenze, Modellkommunikation oder native Desktop-Lifecycle-Funktion. Der lokale Docker-/Modell-Prüfstand ist in [ISOLATION.md](docs/ISOLATION.md) dokumentiert; er ersetzt keinen vollständigen Agentenlauf oder nativen Lifecycle-Test. Einen Installer nur anhand des zugehörigen Builds und separater Installations-/Lifecycle-Prüfung freigeben, nicht anhand eines früheren Pakets.

## Fünf Rollen, Gates und eigene Systemprompts

Michael plant, Dwight entwickelt, Oscar prüft den Code, Hank untersucht Sicherheitsrisiken und Angela testet die Akzeptanzkriterien. Alle Prüfer arbeiten ohne Dateiänderungen; ihre privaten Checkouts werden niemals integriert. Der Engine-Standard bleibt aus Kompatibilitätsgründen nur Angela. Für Review und Sicherheit vor QA:

```powershell
node bin/scranton.js run "Prüfe und implementiere die Änderung" --gates "oscar+hank,angela"
node bin/scranton.js demo --scenario changes_once --gates "oscar,hank,angela" --delay 0
```

Konfiguration: `"workflow": {"gates": [["oscar", "hank"], ["angela"]]}`. Komma trennt sequenzielle Stufen, Plus verbindet parallele Prüfer. Jede Gate-Rolle darf nur einmal vorkommen; leere Stufen sind ungültig. Parallelresultate werden stets in Listenreihenfolge bewertet. Eine fehlgeschlagene Stufe liefert Dwight einen gemeinsamen Bericht und zählt als ein Fehlzyklus. BLOCKED/Infrastrukturfehler pausieren nach Abschluss aller Gates der Stufe; Retry wiederholt nur diese Stufe. Integration erfolgt erst nach allen bestandenen Gates. Auch Docker verwendet ohne explizite Modellwahl Automatic; Oscar/Hank unterstützen ebenfalls `SCRANTON_OSCAR_PROVIDER/MODEL/THINKING` bzw. `SCRANTON_HANK_PROVIDER/MODEL/THINKING`.

Eigene Prompts gelten pro Harness-Datenverzeichnis: `<hive>/prompts/<rolle>.md`, bei Registry `<data>/prompts/<rolle>.md`. Vorrang: explizites `agents.<rolle>.skill`, gespeicherter Prompt, eingebauter Prompt. Frontmatter wird entfernt; der Agentenworkflow erhält den aufgelösten Run-Snapshot. Keine Promptmounts in Docker. Änderungen gelten erst für nächste Runs; Events enthalten Herkunft und SHA-256, keinen Prompttext. API: [CONTROL.md](docs/CONTROL.md), Abschnitt 9.

## Eigene Agenten und Modelle

Über **Agents** lassen sich bis zu zwölf eigene Prüfagenten anlegen: Name, Titel, Handoff-Anweisung, erlaubte Lesewerkzeuge und eindeutige Erfolgs-/Fehlerkeywords. Jeder Agent hat einen editierbaren Systemprompt; ohne gespeicherten Prompt entsteht automatisch ein Starter aus seiner aktuellen Definition. Prompt zurücksetzen stellt diesen Starter wieder her. Michael und Dwight bleiben feste Rollen, ihre Modelle und Prompts sind weiterhin einstellbar. Eigene Agenten sind ausschließlich Gates, keine zusätzlichen Entwickler.

Modell und Thinking liegen pro Agent in `agents.json` unter `--data` bzw. `--hive`. Vorrang in allen Team-Sandboxmodi: Run-Auswahl > Umgebung > `scranton.config.json` > `agents.json` > Automatic. Umgebungs-/Configfelder sind im Editor gesperrt. Thinking: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

```powershell
node bin/scranton.js agents --data .scranton-data
node bin/scranton.js agent set-model seclint --provider openai --model MODEL_ID --thinking high --data .scranton-data
node bin/scranton.js agent remove-model seclint --data .scranton-data
node bin/scranton.js run "Änderungen prüfen" --gates "oscar+seclint,angela" --hive hive
```

`seclint` muss vorher im selben Datenverzeichnis über die Agents-Oberfläche oder `POST /api/agents` angelegt werden. Für Registry-Läufe zusätzlich Projekt/Thread wählen; das letzte Beispiel zeigt den Single-Hive-Modus. Eigene IDs sind 2–20 Kleinbuchstaben/Ziffern, beginnen mit einem Buchstaben und enthalten keine Bindestriche. Änderungen wirken erst beim nächsten Lauf; aktive Läufe behalten Definitionen und Prompts. Ungültige manuelle Einträge werden übersprungen und unter Agents sowie in `doctor` gemeldet. API-Details: [CONTROL.md](docs/CONTROL.md).

### Gesprächsmodus (Team)

Mit `node bin/scranton.js run "Wie ist diese Codebasis aufgebaut?" --conversation` zeigt die CLI die Nachrichten jeder Rolle und am Ende einen eigenen Antwortblock. Fragen kann Michael direkt beantworten, ohne Plan oder Meilensteine. Nach einer Aufgabe schreibt er einen Abschlussbericht; bei Fehler oder Zeitüberschreitung erscheint stattdessen eine deterministische Zusammenfassung. `node bin/scranton.js demo --scenario question --conversation` demonstriert den Fragepfad ohne Modellaufruf.

Engine und CLI lassen den Modus standardmäßig aus (`--no-conversation`); alternativ `execution.conversation:true` in der Konfiguration oder `SCRANTON_CONVERSATION=1`. Die Weboberfläche fordert ihn mit `conversation:true` an. Im Registry-Modus fließen frühere Antworten als Teil des oben beschriebenen Kontextsystems in Folgefragen ein, nicht als vollständiges Transkript. Antworten werden als untrusted Text behandelt; der Modus verleiht Agenten keine zusätzlichen Werkzeuge oder Rechte.
Michael erhält nur bei aktivem Gesprächsmodus einen zusätzlichen Systemprompt-Abschnitt für Plan, direkte Antwort oder Bericht; gespeicherte Prompts bleiben unverändert. Fehlgeschlagene Berichtstexte bleiben als Agentennachricht sichtbar. CLI und Terminal-Dashboard entfernen Steuer-/Bidi-Zeichen aus Nachrichtentexten; große, im Terminal unterdrückte Agentennachrichten verdrängen keine sichtbaren Ereignisse.

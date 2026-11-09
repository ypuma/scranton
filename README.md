# Project Scranton

Open-Source-Multi-Agenten-Harness rund um **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** (1.5.0), mit nativer Windows-App, Terminal- und Web-Dashboard. Michael plant, Dwight implementiert und Angela prüft. Der Orchestrator verwaltet Markdown-Mailboxen im Hive; direkte Nachrichten laufen über einen kontrollierten Chat-Broker.

| Rolle | Aufgabe |
|---|---|
| Michael | Anfrage in einen validierten Meilensteinplan zerlegen |
| Dwight | Einen Meilenstein implementieren und Tests schreiben |
| Oscar | Code-Review: Korrektheit, Wartbarkeit und Regressionen |
| Hank | Sicherheitsprüfung: Vertrauensgrenzen, Eingaben und Geheimnisse |
| Angela | Den exakten Entwickler-Snapshot prüfen; Gate-Änderungen werden nicht übernommen |

## Schnellstart

Voraussetzungen für den Quellcode: Node.js >= 22.19, npm und Git. Für echte Standardläufe außerdem eine **Linux-Docker-Engine und ein lokal gebautes Sandbox-Image**. Scranton installiert oder startet keine Engine und baut/lädt Images nicht automatisch. Die Desktop-App liefert Node und Pi mit, aber **nicht Docker oder Git**.

```powershell
npm.cmd ci
node bin/scranton.js help
node bin/scranton.js doctor
node bin/scranton.js demo
```

Die Demo benutzt Fake-RPC statt eines Modells, private Worktrees und ausdrücklich **simulierten Trusted-Host-Modus**. Sie benötigt keine Modell-Keys oder Docker, ist aber kein Beleg für eine Container-Sicherheitsgrenze. Szenarien: `happy`, `flaky` (Standard), `breaker`, `blocked`.

```powershell
node bin/scranton.js demo --scenario breaker --delay 50 --on-breaker skip
```

Vor dem ersten echten Standardlauf Docker separat einrichten und das Image bewusst bauen:

```powershell
docker build -t scranton-sandbox:1.5.0-r2 sandbox
node bin/scranton.js run "Baue eine Todo-CLI mit Tests" --workspace workspace --parallel 3
```

Dieser Docker-Befehl lädt Basisimage sowie apt/npm-Pakete. Das r2-Rezept enthält `fd-find` (mit `fd`-Symlink) und ripgrep für Pis `find`-/`grep`-Werkzeuge. Buildrezept, Rechte, Netz und Grenzen: [ISOLATION.md](docs/ISOLATION.md).

Ohne Docker nur nach bewusster Vertrauensentscheidung:

```powershell
node bin/scranton.js run "Baue eine Todo-CLI mit Tests" --workspace workspace --trusted-host
```

**Trusted-Host ist keine OS-Isolation.** Pi und Shellbefehle besitzen dann die Rechte deines Benutzerkontos. Private Git-Worktrees trennen Dateien, nicht Betriebssystemrechte. `--parallel 1` allein schaltet Docker nicht ab. Legacy-`execution.isolation:"shared"` verlangt eine einzelne Pipeline und expliziten Host-Modus; shared+Docker wird abgewiesen. Shared-Instanzen melden `worktree:null` und haben keine private Dateigrenze.

## Anmelden

```powershell
scranton login claude
scranton login chatgpt
scranton login gemini
scranton login openrouter --api-key
scranton accounts
scranton logout claude
# Alternativ: scranton logout chatgpt
```

**Gemini** verwendet einen API-Key aus [Google AI Studio](https://aistudio.google.com/apikey), keinen Google-Konto-Login: Pi 1.5.0 unterstützt diese Anmeldung nicht. `scranton login gemini` (Alias für `google`) und `scranton login <provider> --api-key` lesen den Schlüssel über eine verdeckte Eingabe oder stdin, **niemals als Kommandozeilenargument**. Nur literale Keys ohne eingebetteten Leerraum oder Steuerzeichen sind erlaubt; Präfixe `!` und `$` werden abgewiesen. Bei Claude/ChatGPT ersetzt ein gespeicherter API-Key den bisherigen Abo-Zugang dieses Providers.

Im Quellcheckout statt `scranton` jeweils `node bin/scranton.js` verwenden. `login` öffnet den Systembrowser und zeigt die Anmeldeadresse auch im Terminal. Anmeldung dort abschließen; falls angefordert, den Autorisierungscode oder die vollständige Weiterleitungsadresse im Terminal einfügen. Pro Server/CLI-Prozess läuft höchstens eine Anmeldung; nach zehn Minuten wird sie abgebrochen. `accounts` zeigt den Status ohne Token-Refresh, `logout` entfernt nur den gespeicherten Zugang des gewählten Anbieters.

Im Web-Dashboard mit `--control` und in der Desktop-App öffnet **Accounts** die Konto-Seitenleiste: **Sign in**, bei Bedarf Code einfügen, **Cancel** oder **Sign out**; außerdem **Add API key**, **Replace key** und **Remove key** sowie ein Formular für eigene Provider. In **New run** lässt sich für Michael, Dwight und Angela jeweils ein Modell aus dem Pi-Katalog der angemeldeten Konten bzw. konfigurierten API-Keys wählen. Die Auswahl bleibt lokal im Browser gespeichert; **pi default** übernimmt die Agentenkonfiguration. Alternativ `agents.<rolle>.provider/model` in `scranton.config.json` oder `SCRANTON_<ROLE>_PROVIDER=<Provider-ID>` zusammen mit `SCRANTON_<ROLE>_MODEL=<Modell-ID>` setzen (`ROLE`: `MICHAEL`, `DWIGHT`, `ANGELA`). Die UI-Auswahl gilt nur für den gestarteten Lauf und schreibt keine Konfigurationsdatei.

Zugangsdaten liegen in Pis eigener `%USERPROFILE%\.pi\agent\auth.json`, gemeinsam mit der Pi-CLI; `PI_CODING_AGENT_DIR` ersetzt dieses Profilverzeichnis. Scranton hält keine separate Credential-Kopie im Hive. API-Keys funktionieren weiterhin: In Pi 1.5.0 hat ein gespeicherter Provider-Zugang (OAuth oder API-Key) Vorrang vor Umgebungs-Keys. Ohne gespeicherten Eintrag greift die Anbieter-Umgebung; ein fehlgeschlagener OAuth-Refresh fällt nicht still darauf zurück. Abmelden löscht keine Umgebungs-Keys, diese können danach wieder aktiv werden. Docker erhält bei Abo-Nutzung nur kurzlebige Access-Tokens, niemals den Refresh-Token; Details: [ISOLATION.md](docs/ISOLATION.md).

**Grenzen:** Ein echter OAuth-Rundlauf wurde hier nicht getestet. Abo-Nutzung in Drittanbieter-Tools unterliegt den Bedingungen und Nutzungslimits des Anbieters; diese können sich ändern oder die Nutzung einschränken. Parallele Pipelines teilen die Rate-Limits desselben Abos.

### Eigene Provider (OpenAI-kompatibel)

Beispiel für **abliteration.ai** (Key ebenfalls nur über verdeckte Eingabe oder stdin):

```powershell
scranton provider add abliteration --base-url https://api.abliteration.ai/v1 --api openai-completions --discover --label abliteration.ai
scranton provider remove abliteration
```

`--discover` fragt hier `https://api.abliteration.ai/v1/models` ab; alternativ Modell-IDs mit `--models a,b` deklarieren. Unterstützte API-Typen: `openai-completions`, `openai-responses`, `anthropic-messages`. Die Basis-URL verlangt HTTPS (HTTP nur auf Loopback), ohne URL-Zugangsdaten, Query oder Fragment. Discovery folgt nur Weiterleitungen desselben Ursprungs und speichert allein noch keinen Provider. Im **Accounts**-Formular Basis-URL, API-Typ und Key eingeben, Modelle ermitteln/auswählen oder IDs manuell eintragen und den Provider speichern; für abliteration.ai gibt es eine Vorlage. Danach stehen seine Modelle unter **New run** zur Wahl. **Remove provider** bzw. `scranton provider remove <id>` entfernt Definition und gespeicherten Key.

Scranton ergänzt die echte `%USERPROFILE%\.pi\agent\models.json` (bzw. das Profil aus `PI_CODING_AGENT_DIR`) nur um selbst angelegte Provider und entfernt nur unverändert verwaltete Einträge. Vor dem ersten Überschreiben einer vorhandenen Datei entsteht einmalig `models.json.scranton-bak`; `scranton-providers.json` registriert die verwalteten Definitionen. **Keys stehen niemals in diesen Definitionen**, sondern in Pis `auth.json`. Bestehende fremde Provider werden nicht überschrieben; ungültiges JSON/JSON mit Kommentaren und extern geänderte verwaltete Definitionen werden nicht still repariert oder entfernt.

## Projekte und Chats

Ein **Projekt entspricht einem Ordner** auf dem Rechner. Jeder **Chat ist ein Thread mit eigener Laufhistorie** und eigenem Hive. **Follow up** startet einen neuen Run im selben Thread; Michael erhält Ziele, Meilensteine und Ergebnisse früherer Runs als begrenzten Kontext (höchstens 8000 Zeichen, neueste Runs bevorzugt), nicht automatisch die vollständigen Pi-Transkripte. Der laufende Instanz-Chat zum Steuern von Dwight/Angela bleibt davon getrennt.

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

`--data DIR` (alternativ `SCRANTON_DATA`, Konfiguration `dataDir`) aktiviert die Registry. `run --project` verlangt aus Sicherheitsgründen `--data` oder `SCRANTON_DATA`; `.env` und `scranton.config.json` im Projektordner werden für Registry-Runs nicht ausgewertet. `visualize --data` aktiviert auch die Steuerung und ist nur lokal zu verwenden. `projects`/`chats` verwenden ohne Datenpfad standardmäßig das Desktop-Datenverzeichnis. Der bisherige **Single-Modus mit `--hive`/`--workspace` ohne Registry bleibt erhalten**; die Oberfläche zeigt ein implizites Projekt und einen Chat `default`, ohne Projekt-/Chat-Verwaltung. Das Terminal-Dashboard bleibt an einen Hive gebunden. API und Speicherlayout: [CONTROL.md](docs/CONTROL.md).

## Scranton Pipeline

Neben Team-Chats gibt es **Pipeline-Chats** mit einer eigenständigen Python-/LangGraph-Engine: feste, begrenzte Plan-/Edit-/Prüfschritte in einem privaten Snapshot sowie menschliche Plan- und Lieferfreigaben. Die Übernahme in den Projektordner ist eine separate Entscheidung; Trusted-Host-Checks bieten keine OS-Isolation. Die Desktopform bietet Checks und explizite Setuprezepte; Fehlerausgaben lassen sich aufklappen, nicht gestartete Läufe zeigen ihre Aufrufdiagnose und fehlgeschlagene Läufe einen partiellen Diff. Private Gitmetadaten liegen außerhalb des Check-Workspace; getrackte Checkänderungen werden nach Baseline/Verify restauriert und gemeldet. Von pi als verfügbar gemeldete Modelle, einschließlich Abos, sind **via pi** als tool-/sessionlose Completions nutzbar; angemeldete API-Key-Konten auf verifizierten kompatiblen Endpunkten gehen direkt. Ein echter Lauf wurde am **2026-11-09 um 22:37** über die Desktop-HTTP-API auf dem Drei-Dateien-Projekt `.scratch/pipeline/real-smoke/project` ausgeführt: alle drei Rollen `openai/gpt-6.1-sol` **via pi**, ChatGPT-Subscription des Benutzers, Trusted-Host-Sandbox. Planner: 2 Aufrufe (ein Kontextzug), Implementer: 1, Reviewer: 1; pi meldete **7647 Input-/601 Outputtokens**. Baselinecheck rot, finaler Check grün, Ein-Zeilen-Diff; die Quelldatei änderte sich erst nach Lieferfreigabe; Abschluss **`succeeded`**. Dieser eine Lauf belegt **nicht** andere Provider, größere Repositories, Reparatur-/Revisionsschleifen mit echten Modellen oder Dockerbetrieb mit echten Modellen. Einstieg: [Desktop und HTTP-API](docs/PIPELINE.md), [Engine-Installation und CLI-Demo](engine/README.md), [Architektur und Grenzen](engine/docs/ARCHITECTURE.md).

## Parallelität, Prüfung und Integration

Standard: RPC-Transport, bis zu drei aktive Meilenstein-Pipelines, private Git-Worktrees und persistente Sessions. Eine Pipeline führt jeweils Entwicklung oder QA aus. Instanzen heißen z. B. `michael`, `dwight-m1`, `angela-m1`; Rollen sind keine eindeutigen Chat-Adressen bei parallelen Aufgaben.

Der Plan enthält `dependsOn`: Fehlt das Feld, hängt der Meilenstein vom Vorgänger ab; explizites `[]` bedeutet unabhängig. Unbekannte, eigene oder zyklische Abhängigkeiten werden abgewiesen. Eine Abhängigkeit ist erst nach erfolgreicher QA **und sicherer Integration** erfüllt; übersprungene/fehlgeschlagene Voraussetzungen geben Nachfolger nicht frei.

Scranton erstellt ein **privates Schatten-Repository** unter `hive/isolation/`, auch für schmutzige, noch nicht committete oder Nicht-Git-Workspaces. Das Benutzer-Repository wird nicht für interne Branches/Commits verwendet: HEAD, Index und Historie bleiben erhalten. Ignorierte Abhängigkeiten/Buildausgaben und bekannte Credential-Dateien werden nicht in den Snapshot aufgenommen. Deshalb müssen Tests ihre benötigten Abhängigkeiten im privaten Checkout selbst bereitstellen. Das ist kein vollständiger Geheimnisscanner.

Nach `[TASK_COMPLETE]` erhält Angela einen eigenen Worktree aus genau diesem Entwickler-Snapshot. Nur der geprüfte Entwicklerstand darf ins Ziel zurückfließen. Integration ist serialisiert und prüft Änderungen gegen die Ausgangsbasis; überlappende Nutzeränderungen werden als Konflikt gemeldet, nicht überschrieben. Diagnose-Worktrees bleiben erhalten. Vor echten Aufträgen trotzdem sichern; ein Worktree ist kein Backup.

Bei Integrationskonflikten ist **Retry kein Rebase**: Der Entwickler-Worktree behält seine unveränderliche Ausgangsbasis. Ohne Änderung der Konfliktursache kann derselbe Konflikt erneut auftreten. Du kannst abbrechen, den Konflikt bewusst außerhalb des Laufs auflösen und einen frischen Lauf starten oder den Meilenstein überspringen; Nutzerarbeit und Diagnoseartefakte nicht automatisch löschen.

## Optionen

| Option | Bedeutung |
|---|---|
| `--workspace DIR`, `--hive DIR`, `--config FILE` | Ziel, Laufzeitdaten, Konfiguration |
| `--parallel N` | Maximale aktive Pipelines (Standard 3); Parallelität erfordert Worktrees |
| `--sandbox docker` | Container-Modus (Standard), kein stiller Host-Fallback |
| `--sandbox-image IMAGE` | Lokal vorhandenes Linux-Image, Standard `scranton-sandbox:1.5.0-r2` |
| `--sandbox-network bridge\|none` | `bridge` erlaubt Netzwerkzugang; `none` sperrt Container-Netz |
| `--trusted-host` | Explizit auf dem Host ausführen, Worktrees bleiben getrennt |
| `--no-plan` | Eine Aufgabe ohne Modellplanung |
| `--max-cycles N` | Fehlgeschlagene QA-Zyklen bis zum Circuit Breaker (Standard 3) |
| `--on-breaker ask\|abort\|skip\|hive` | Menschliche Entscheidung im Terminal, automatisch oder dateibasiert |
| `--timeout-min N` | Zeitlimit pro Agent (Standard 20 Minuten) |

`agent <michael|dwight|oscar|hank|angela> "Aufgabe"` startet genau eine auditierte Instanz mit derselben Run-Lease und Isolation wie ein Lauf. Es startet keine zusätzliche QA-Pipeline und integriert private Änderungen im Standard-Worktree-Modus nicht ins Ziel. Im expliziten Shared-Host-Modus arbeitet es dagegen direkt im Workspace. Die vollständige lokale CLI-Hilfe ist maßgeblich. Exit-Codes: 0 Erfolg, 1 teilweise/fehlgeschlagen/abgebrochen, 2 Aufruffehler, 130 Strg+C.

## Sessions und direkter Chat

Bis zur ersten gültigen RPC-Antwort nach jedem Prozessstart gilt für **alle** Kommandos (auch Chat-Steering und Abbruch) dieselbe Frist: **60 Sekunden ab Spawn** für Docker-/Pi-Start und Prompt-Preflight. Ohne Antwort meldet Scranton `pi did not start within 60 s (no answer to the first prompt)`; auch bei Timeout/Abbruch wird der eigene Container entfernt und die Entfernung geprüft. Nach der ersten Antwort erhalten noch wartende sowie neue RPC-Kommandos jeweils 5 s; Brokerantworten behalten 10 s und die Erweiterung 15 s. Interne Overrides dürfen die Budgets nur verkürzen.

Jede Run-/Instanz-Kombination hat eine stabile UUID und ein eigenes Sessionverzeichnis. Wiederholungen behalten bei aktivierten persistenten Sessions dieselbe ID und Historie; der RPC-Prozess kann zwischen Aufrufen enden. Stabile Scranton-Instanz-/Session-IDs garantieren nicht dieselbe Pi-Historie: Docker nutzt den festen Pfad `/workspace` und kann dort fortsetzen; Trusted-Host-Angela erhält pro QA-Zyklus ein neues Checkout-Verzeichnis und beginnt dort eine frische Pi-Historie. Pi 1.5.0 bindet geladene Sessions an ihren gespeicherten CWD; ein erzwungenes Laden alter QA-Sessions würde den falschen Checkout prüfen. Verifiziertes CWD-Rebinding bleibt eine künftige Erweiterung. Das ist **keine automatische Wiederaufnahme nach einem App-Absturz**. Hive/Sessions enthalten Aufgaben, Antworten und möglicherweise sensible Inhalte und gehören nicht in ein Release oder öffentliches Repository.

Das verwaltete Pi-Tool `agent_chat` sendet `{to,text}` an eine **exakte Instanz-ID**; Sender und Run setzt der Broker. Menschen verwenden den Instanz-Chat der Oberfläche bzw. `POST /api/chat`. Nachrichten können warten; eine Queue-Bestätigung bedeutet nicht, dass das Modell den Text schon verarbeitet hat. Der Broker protokolliert `queued` (noch nicht gesendet), `delivered` (RPC-ACK), `rejected` (definitiv abgewiesen) oder `unknown` (Annahme unklar); auch ein RPC-ACK ist kein Nachweis inhaltlicher Verarbeitung. Unbekannte/beendete Empfänger werden abgewiesen. Bei `unknown` erfolgt kein automatischer Neuversand, auch nicht beim nächsten Instanzaufruf. ACK-Budgets: 5 s für RPC-Kommandos, 10 s für den Broker, 15 s für die Erweiterung. Ein eigenständiger `message`-CLI-Befehl existiert nicht; Server- und Tool-Chat sind implementiert. Details: [CONTROL.md](docs/CONTROL.md).

## Circuit Breaker und Oberflächen

Nach drei aufeinanderfolgenden fehlgeschlagenen Testzyklen fragt Scranton nach Feedback, Retry, Skip oder Abort. `[BLOCKED]` und Infrastrukturfehler fragen nach Abschluss aller Gates der Stufe, ohne drei Zyklen zu verbrauchen. Menschliche Rückfragen werden serialisiert; unabhängige Pipelines können weiterlaufen. Abort betrifft alle aktiven Prozesse.

```powershell
node bin/scranton.js dashboard
node bin/scranton.js dashboard --once --ascii
node bin/scranton.js visualize
node bin/scranton.js visualize --control --workspace workspace
```

Die Dashboards sind dunkel und strikt monochrom. Im Single-Modus ist der HTTP-Server ohne `--control` schreibgeschützt; `--data` aktiviert dagegen Registry und Steuerung. Steuerung benötigt eine echte Loopback-Verbindung, lokalen Host-Header, bei POST JSON und `X-Scranton-Client: 1`; keine CORS-Freigabe. Nicht ungeschützt ins Netz stellen. [EVENTS.md](docs/EVENTS.md) beschreibt Ereignisse, [CONTROL.md](docs/CONTROL.md) Run-/Chat-/HITL-Steuerung und Wiederherstellungsblockaden.

Mit `--on-breaker hive` wartet Scranton auf atomar geschriebenes `hive/human/response.json`:

```json
{ "v": 1, "runId": "run-id", "requestSeq": 42, "decision": "feedback", "feedback": "Bitte das fehlende Kriterium testen.", "ts": "2026-11-08T12:00:00.000Z" }
```

Run-ID und Sequenz müssen zur aktuell offenen Rückfrage passen. Feedback: 1–8000 Zeichen; andere Entscheidungen: `retry`, `skip`, `abort`. Eine dauerhafte Run-Lease verhindert einen zweiten Schreiber auf denselben Hive. Bei unklarer Bereinigung bleibt sie absichtlich gesperrt: nicht blind löschen oder gespeicherte PIDs beenden.

## Modelle und Konfiguration

Rangfolge: Flags > Umgebung > `scranton.config.json` > Defaults. `.env` wird geladen, bestehende Umgebungswerte gewinnen. Keine Zugangsdaten ins Repository schreiben; Vorlage: [`.env.example`](.env.example).

```json
{
  "execution": {
    "maxParallel": 3,
    "isolation": "worktree",
    "sandbox": { "mode": "docker", "image": "scranton-sandbox:1.5.0-r2", "network": "bridge" },
    "persistentSessions": true,
    "maxReplans": 0
  }
}
```

Dynamische Neuplanung ist nicht implementiert: Der veröffentlichte DAG bleibt unverändert. Effektiv ist `maxReplans` immer 0; ein konfigurierter Wert ungleich 0 wird mit Warnung ignoriert. Agentenmodelle über `agents.<rolle>.provider/model/thinking` oder `SCRANTON_<MICHAEL|DWIGHT|ANGELA>_PROVIDER`, `_MODEL`, `_THINKING`. Scranton erzwingt kein bestimmtes Modell. Anbieter-Keys werden zur Laufzeit gesetzt. Host-Pi kann sein Benutzerprofil verwenden; Docker mountet das Host-Pi-Profil **nicht** und reicht nur explizit erlaubte Provider-Umgebungsvariablen weiter. Docker-`bridge` ist keine Egress-Firewall; `none` verhindert auch Cloud-Modellzugang. Ollama unter Host-`localhost` ist aus dem Container nicht derselbe Dienst; eigene Netz-/Provider-Konfiguration erforderlich.

Pi-Auflösung im Host-Modus: explizites `pi.command`/`SCRANTON_PI_COMMAND`, lokale Paketabhängigkeit, dann PATH. Die Desktop-Ressourcen enthalten die lokale Pi-Abhängigkeit und ihren echten Einstiegspunkt; kein globales Pi nötig. Eigene Overrides dürfen nicht auf Entwicklerpfade zeigen. Minimaler Kontext deaktiviert automatisch geladene Skills, Kontextdateien, Erweiterungen und MCP; die verwaltete Chat-Erweiterung wird gezielt geladen. Fremde Projektdateien bleiben untrusted Eingaben.

**Gate-Werkzeuge sind absichtlich eingeschränkt:** `agents.oscar.tools`, `agents.hank.tools` und `agents.angela.tools` müssen wie eigene Gates eine nichtleere Teilmenge von `read`, `grep`, `find`, `ls`, `bash` sein (Windows-Fallback `powershell`). `write`/`edit` oder andere Werkzeuge führen bei jedem Konfigurationsladen, auch bei `visualize`, zu einem `ConfigError`, der den Schlüssel `agents.<id>.tools` nennt. Bestehende Konfigurationen müssen entsprechend angepasst werden. Shellwerkzeuge können weiterhin Dateien verändern; dies ersetzt keine OS-Isolation.

Für Gates akzeptieren `pi.extraArgs` und `agents.<id>.extraArgs` nur geprüfte Pi-1.5.0-Optionen mit vollständigen Werten. Werkzeugänderungen, Ressourcenlader (Erweiterungen, Skills, Templates, Themes), unbekannte Flags und positionale Argumente werden abgewiesen. MCP und Erweiterungs-Discovery bleiben für Gates auch bei `pi.minimalContext:false` deaktiviert; nur Scrantons verwaltete RPC-Chat-Erweiterung wird gezielt geladen. Die abschließende Werkzeug-Allowlist bleibt unverändert, zusätzliche Erweiterungswerkzeuge werden dadurch nicht freigeschaltet. Michael und Dwight behalten ihr bisheriges Verhalten.

## Entwicklung, Desktop und Prüfstand

```powershell
npm.cmd run app:prepare
npm.cmd test
npm.cmd run test:packaging
```

Die Paketierungsprüfung setzt vorbereitete Ressourcen voraus. Sie prüft Pi-Paketidentität, Produktionsabhängigkeiten, verwaltete Tools und einen credential-freien `--help`-Start mit gebündeltem Node und leerem PATH. Das ist kein Modell-, Container- oder Installer-End-to-End-Test. [DESKTOP.md](docs/DESKTOP.md) beschreibt Tauri-Build und Nutzerdaten.

Struktur: `src/core/` Orchestrierung/Isolation/RPC, `src/server/` Control/SSE, `src/dashboard/` Terminal, `visualizer/public/` Web, `agents/` Rollenprompts, `tools/` verwaltete Erweiterung/Fakes, `sandbox/` explizites Docker-Buildrezept. Tests verwenden temporäre Verzeichnisse, nicht den echten Hive.

**Prüfgrenzen:** Deterministische Fake-/Protokolltests belegen keine echte Containergrenze, Modellkommunikation oder native Desktop-Lifecycle-Funktion. Der lokale Docker-/Modell-Prüfstand ist in [ISOLATION.md](docs/ISOLATION.md) dokumentiert; er ersetzt keinen vollständigen Agentenlauf oder nativen Lifecycle-Test. Einen Installer nur anhand des zugehörigen Builds und separater Installations-/Lifecycle-Prüfung freigeben, nicht anhand eines früheren Pakets.

## Fünf Rollen, Gates und eigene Systemprompts

Michael plant, Dwight entwickelt, Oscar prüft den Code, Hank untersucht Sicherheitsrisiken und Angela testet die Akzeptanzkriterien. Alle Prüfer arbeiten ohne Dateiänderungen; ihre privaten Checkouts werden niemals integriert. Der Engine-Standard bleibt aus Kompatibilitätsgründen nur Angela. Für Review und Sicherheit vor QA:

```powershell
scranton run "Prüfe und implementiere die Änderung" --gates "oscar+hank,angela"
scranton demo --scenario changes_once --gates "oscar,hank,angela" --delay 0
```

Konfiguration: `"workflow": {"gates": [["oscar", "hank"], ["angela"]]}`. Komma trennt sequenzielle Stufen, Plus verbindet parallele Prüfer. Jede Gate-Rolle darf nur einmal vorkommen; leere Stufen sind ungültig. Parallelresultate werden stets in Listenreihenfolge bewertet. Eine fehlgeschlagene Stufe liefert Dwight einen gemeinsamen Bericht und zählt als ein Fehlzyklus. BLOCKED/Infrastrukturfehler pausieren nach Abschluss aller Gates der Stufe; Retry wiederholt nur diese Stufe. Integration erfolgt erst nach allen bestandenen Gates. Docker braucht explizite Modelle für alle aktiven Rollen; Oscar/Hank unterstützen ebenfalls `SCRANTON_OSCAR_PROVIDER/MODEL/THINKING` bzw. `SCRANTON_HANK_PROVIDER/MODEL/THINKING`.

Eigene Prompts gelten global pro Harness-Datenverzeichnis: im Single-Modus `<hive>/prompts/<rolle>.md`, im Registry-/Desktop-Modus `<data>/prompts/<rolle>.md`. Die Agents-API erlaubt Lesen, Speichern und Zurücksetzen (maximal 32 KiB, leere Texte werden abgewiesen). Fehlende Statuskeywords werden nur als Hinweis gemeldet. Vorrang hat ein explizites `agents.<rolle>.skill` in der Konfiguration; solche Prompts sind in der API nicht editierbar. Danach folgen gespeicherter Prompt und eingebauter Rollenprompt. Frontmatter wird entfernt; Pi bekommt nur die aufgelöste Datei, Docker als read-only Mount. Zu Runbeginn werden alle Prompts einmal aufgelöst; alle Aufrufe verwenden diesen Snapshot. Änderungen während eines Runs gelten erst für den nächsten Run. Events enthalten Herkunft und SHA-256 statt Prompttext. API-Details: [CONTROL.md](docs/CONTROL.md), Abschnitt 9.

## Eigene Agenten und Modelle

Über **Agents** lassen sich bis zu zwölf eigene Prüfagenten anlegen: Name, Titel, Handoff-Anweisung, erlaubte Lesewerkzeuge und eindeutige Erfolgs-/Fehlerkeywords. Jeder Agent hat einen editierbaren Systemprompt; ohne gespeicherten Prompt entsteht automatisch ein Starter aus seiner aktuellen Definition. Prompt zurücksetzen stellt diesen Starter wieder her. Michael und Dwight bleiben feste Rollen, ihre Modelle und Prompts sind weiterhin einstellbar. Eigene Agenten sind ausschließlich Gates, keine zusätzlichen Entwickler.

Modell und Thinking werden pro Agent dauerhaft in `agents.json` gespeichert: im Registry-Modus unter `--data`, sonst unter `--hive`. Vorrang: Run-Auswahl > Umgebungsvariablen > `scranton.config.json` > `agents.json` > Pi-Standard. Durch Umgebung oder Konfiguration festgelegte Felder sind gegen UI-/CLI-Änderungen gesperrt. Unterstützte Thinking-Werte: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Docker verlangt für jede aktive Rolle einen expliziten Provider und ein Modell; gespeicherte Defaults zählen mit.

```powershell
node bin/scranton.js agents --data .scranton-data
node bin/scranton.js agent set-model seclint --provider openai --model MODEL_ID --thinking high --data .scranton-data
node bin/scranton.js agent remove-model seclint --data .scranton-data
node bin/scranton.js run "Änderungen prüfen" --gates "oscar+seclint,angela" --hive hive
```

`seclint` muss vorher im selben Datenverzeichnis über die Agents-Oberfläche oder `POST /api/agents` angelegt werden. Für Registry-Läufe zusätzlich Projekt/Thread wählen; das letzte Beispiel zeigt den Single-Hive-Modus. Eigene IDs sind 2–20 Kleinbuchstaben/Ziffern, beginnen mit einem Buchstaben und enthalten keine Bindestriche. Änderungen wirken erst beim nächsten Lauf; aktive Läufe behalten Definitionen und Prompts. Ungültige manuelle Einträge werden übersprungen und unter Agents sowie in `doctor` gemeldet. API-Details: [CONTROL.md](docs/CONTROL.md).

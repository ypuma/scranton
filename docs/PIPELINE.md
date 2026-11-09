# Pipeline-Chats in der Desktop-App

Stand: implementierter Quellcode vom 9. November 2026. Dieses Dokument beschreibt die Registry-/Weboberfläche, die auch die Tauri-App verwendet. [CLI/Installation](../engine/README.md) · [Architektur und Sicherheitsdetails](../engine/docs/ARCHITECTURE.md).

## Pipeline oder Team?

Ein Chat hat eine feste Engine: `engine:"pipeline"` in seinen Metadaten; fehlt das Feld, bleibt er ein **Team**-Chat mit pi-Orchestrator, Meilensteininstanzen und Hive. Die Engine eines vorhandenen Chats wird nicht umgeschaltet. Für einen Vergleich einen neuen Chat anlegen.

Pipeline benutzt einen festen Python/LangGraph-Ablauf: Snapshot, Baseline, Plan, Freigabe, sequenzielle Edits/Checks, Review, Lieferung. Sie hat keine Team-Mailboxen, keine frei steuerbaren Agenteninstanzen und keinen Team-Circuit-Breaker. Eigene Team-Gates und deren globale Prompts sind nicht die Pipeline-Rollen. Der Lauf behält private Checkpoints und kann an Gates oder nach Suspend in einem neuen Python-Prozess fortgesetzt werden. Folgeaufträge sind neue Läufe; der Python-Runner bekommt keine automatische vollständige frühere Chat-/Agentenhistorie.

Tauri selbst bekommt dafür keine neue Python-IPC-Schicht: Der vorhandene Node-Appserver startet die CLI und bedient HTTP. Ein separater dauerhafter Python-Webserver, LangGraph.js-Port oder zweiter Rust-Supervisor ist nicht Teil dieser Integration.

## Einen Lauf starten

1. Projektordner wählen und **New run** öffnen. Bei einem neuen Chat **Pipeline** statt **Team** wählen. Die Engine-Verfügbarkeit wird mit `version` geprüft. Bei Fehler ist die Auswahl deaktiviert und zeigt den Grund; bestehende Pipeline-Chats zeigen weiterhin ihre Daten, aber keinen startbaren Lauf.
2. Aufgabe formulieren (maximal 32.768 UTF-8-Bytes). Pipeline-Folgeauftrag im vorhandenen Chat verwendet dieselbe Form, Engine fest.
3. **Checks** prüfen. Vorschläge aus Projektdateien werden vorbelegt, nicht als richtig bewiesen. Pro Zeile ID, Kategorie, Befehl und `required` wählen; höchstens zwölf Checks. Für Checks und Setup gilt durchgängig `^[A-Za-z0-9_-]{1,64}$` aus `config.py:COMMAND_ID_PATTERN` (gleiche Regel in Node/UI, keine Punkte). Validierungsfehler nennen das Feld, z. B. `checks[1].id`; die Form zeigt ID-/Befehlsfehler an der betroffenen Zeile. Leere Checkliste ist über die Integration möglich, wird aber als „nichts automatisch verifiziert“ im Bericht genannt.
4. **Docker** mit lokal vorhandenem Image (Default `scranton-sandbox:1.5.0`) oder **Trusted host** wählen. Host verlangt die ausdrückliche Checkbox „ohne OS-Isolation“. Der Snapshot bleibt privat, aber ausgeführter Code besitzt dann die Rechte deines Benutzerkontos. Image nicht mit dem abweichenden Team-Default `...-r2` verwechseln.
5. Planner-, Implementer- und Reviewer-Modell auswählen; „use for all roles“ kopiert die Plannerauswahl. Aktuelle Kontounterstützung steht unten. Kein implizites `pi default` bei fehlender Auswahl.
6. Planfreigabe `always` oder `auto_low_risk` und Liefermodus wählen. Default der Desktopintegration ist `apply`; ein tatsächlicher Schreibzugriff verlangt später trotzdem die Lieferfreigabe. Unter **Setup** lassen sich bis zu vier Rezepte mit ID, Befehl und **needs network** bearbeiten oder hinzufügen. `detect` schlägt `npm ci` mit Netzbedarf vor, wenn `package-lock.json` und ein verfügbares npm vorhanden sind; ausgeführt wird erst beim Start im privaten Workspace. Netzfreigabe betrifft im Dockermodus nur Setup, nicht Checks; Hostmodus erzwingt keine Netzsperre. Timeout-/Scope-/Review-off-Editoren gibt es weiterhin nicht; die HTTP-API kann diese Optionen ausdrücken.
7. Alternativ **Demo run (sample project, no model)**: erzeugt ein eigenes kleines kaputtes Rechnerprojekt und scripted Antworten, benötigt weder Konten noch Docker. Aufgabe/Checks/Modelle/Sandbox werden dabei durch die Fixture ersetzt; Liefermodus bleibt wirksam. Die Demo verändert nicht den gewählten Projektordner.

Start legt zuerst einen Pipeline-Chat an und dann den Lauf. Ein HTTP-202 bestätigt den **Startversuch**, nicht schon einen erfolgreichen Pythonlauf. Endet die Engine ohne neuen Status, persistiert der Supervisor `{code,message}` unter `requests/<runId>.error.json` und liefert `launchError`. Fehlt auch das Runverzeichnis, antwortet die Detailroute mit `status:null`, `live:false`; die Liste führt den Startversuch als `failed`. Die UI zeigt die Ursache invertiert statt dauerhaft „Starting…“, ohne erfundene Statuspille/Phasenanzeige. Eine fehlgeschlagene Gateinvokation gibt die Entscheidung wieder frei; eine spätere erfolgreiche Invokation entfernt den alten Fehler. Das ist kein terminaler Python-Abschlussbericht.

## Plan, Checks und Lieferung

Die Ansicht zeigt Laufstatus, Phase, Schritte/Versuche und Usage, darunter nur befüllte Bereiche: Plan, Checks, Review, Changes, Result, Activity. Sie pollt während `live`/`running` nach einer Sekunde, sonst nach fünf Sekunden; beim Verlassen des Chats stoppt das Polling. Runselector zeigt frühere Läufe. Die Sidebar meldet wartende Gates als `needs_human`, Suspend als `stopped`.

**Plan-Gate:** Plan mit Kriterien, Dateien, Annahmen, Risiken und maschinellen Flags lesen. **Approve plan** setzt fort; **Reject plan** beendet als `rejected`. Optionaler Kommentar wird mit der Entscheidung gespeichert. Bei `auto_low_risk` darf Python nur ohne Risikoflag automatisch freigeben. Flags: Manifeständerung, Löschung, >10 Dateien, CI-/Buildkonfiguration, rote Pflichtbaseline. Keine Flags bedeutet nicht „sicher“.

**Checks:** Status, Kategorie, Pflicht/optional und Dauer. Bei nicht bestandenen Checks mit Ausgabe öffnet **Output** den redigierten Tail auf Wunsch; der aufgeklappte Zustand bleibt bei Aktualisierungen erhalten. `RunStatus.checks[*].output_tail` enthält dafür höchstens die letzten 4096 Zeichen nach Redaktion, bei bestandenen Checks `""`. Ausführlichere Ergebnisse stehen im lesbaren Markdown-/JSON-Abschlussbericht und begrenzte Logs lokal unter `artifacts/logs`; „Engine output“ zeigt stderr, nicht automatisch jeden Checklog. Fehlende optionale Checks verhindern einen Erfolg nicht. Eine rote Pflichtbaseline ist Planungsevidenz; sie wird nach Implementierung nicht als Erfolg akzeptiert.

**Liefer-Gate:** Bei `apply` erscheint nach Checks/Review der kumulative Diff. **Apply to <Ordner>** nennt das tatsächliche Quellziel; **Keep as patch only** lässt es unverändert und beendet trotzdem `succeeded`. Bei `patch` wird das Gate nicht angeboten. Diffanzeige maximal 4000 Zeilen, HTTP-Artefakte maximal 1 MiB mit Kürzungskennzeichnung; vollständige Datei lokal prüfen. Erfolg bedeutet nicht automatisch `delivery.applied:true`. Nach Fehler/Ablehnung/Abbruch verweist das benannte `diff`-Artefakt stattdessen auf `status.artifacts.diff` (`partial.diff`); die UI nennt es **Changes up to the last passing step**. Es zeigt den letzten als grün gespeicherten Stand (vor dem ersten grünen Schritt die Basis), nicht die letzten fehlgeschlagenen Edits. Ein fehlgeschlagener Artefaktabruf wird erst bei geändertem Statuszeitstempel erneut versucht.

### Was „Apply“ schreibt

Nur die validierten erzeugten/ersetzten/gelöschten Dateien des privaten Workspace-Commits werden in den Projektordner übertragen. Quell-Git-HEAD, Index und Historie werden nicht geändert. Vorbedingungen: richtige Gate-/Digestentscheidung, unverändertes Lieferartefakt, erlaubte Pfade, bestehende Änderungs-/Löschziele haben noch ihren Snapshot-SHA-256; neue Ziele existieren nicht. Bei Konflikt wird die Übernahme verweigert; keine automatische Konfliktauflösung oder Mergeentscheidung durch ein Modell. Originale werden gesichert, Fortschritt journalisiert, I/O-Fehler führen zum Rollbackversuch. Kein allgemeiner Transaktionslock gegen fremde Editoren: während der Übernahme nicht parallel im Ziel schreiben.

**Cancel run** fordert kooperativen Abbruch an, kann laufende Checks stoppen, aber unterbricht keinen bereits laufenden Quellübernahmeschritt und macht schon angewandte Änderungen nicht rückgängig. Ein direkter HTTP-Modellaufruf kann bis zu seiner Deadline warten; der Commandprovider berücksichtigt das Stop-Signal im Prozessadapter. **Resume** gibt es nur bei `suspended`; am Gate stattdessen die Entscheidungsschaltflächen verwenden. Server-/Appende schließt Parent-stdin und fordert Suspend an, auch während eines Command-Modellaufrufs (Exit 5, Cleanup, anschließend Resume); nach fünf Sekunden darf der Supervisor den Baum beenden. Checkpoints ermöglichen Wiederaufnahme, nicht die Garantie, dass jedes externe Modell nur einmal abgerechnet wurde.

## Daten und Engine-Auflösung

```text
<dataDir>/projects/<projectId>/chats/<chatId>/
  chat.json
  pipeline/
    requests/<runId>.json                 generierte Operator-Konfiguration
    requests/<runId>.json.launch.json     Modellwahl, Trust, Workspace-Root, Demo
    requests/<runId>.json.task.txt        Aufgabe bei echten Läufen
    requests/<runId>.error.json           Aufruffehler ohne neuen Runstatus, falls vorhanden
    runs/<runId>/                        Python-Runverzeichnis
```

Run enthält `status.json`, Events, Usage, SQLite-Checkpoints, Plan/Reviews/Logs, externe Gitmetadaten in `git/` mit leerem `git-hooks/` sowie `delivery/` mit Diff/Bericht/Backups. Diese Gitmetadaten liegen nicht im Workspace oder dessen Docker-Mount. Workspace separat: `SCRANTON_PIPELINE_WORKSPACE_ROOT`, sonst Windows `%LOCALAPPDATA%\Scranton\pipeline`, sonst `<dataDir>/pipeline-workspaces`; darunter `<runId>`. Kurze Pfade vermeiden Windows-Pfadlängenprobleme. Laufkonfiguration wird beim Resume aus der Kopie gelesen und per Digest geprüft. Sensible Aufgabe-/Code-/Checkdaten bleiben lokal in diesen Dateien; sie nicht veröffentlichen.

Engine-Auflösung in `src/core/pipeline-command.js`, erster Treffer:

1. `SCRANTON_PIPELINE_COMMAND` als JSON-argv-Liste, z. B. `["C:\\Pfad\\python.exe","-m","scranton_pipeline"]`.
2. Gebündelt: `<PACKAGE_ROOT>/engine-runtime/python/python.exe`.
3. Entwicklercheckout: `<PACKAGE_ROOT>/.scratch/pipeline/venv/Scripts/python.exe`.

Probe `version` maximal 15 Sekunden; erfolgreicher Probe wird pro argv gecacht, fehlgeschlagener nicht. Das Vorhandensein eines Pfads allein bedeutet noch keine Importfähigkeit. Python/Git/Containerumgebung müssen getrennt funktionieren. Pipeline unterstützt hier Registry-Chats, nicht das implizite Single-Hive-Chatmodell.

Pro Chat höchstens ein nichtterminaler Lauf, auch `suspended` und `awaiting_approval` blockieren einen neuen. Live Pythonprozesse zählen zum Appserver-`maxConcurrentRuns`; Gatewartezeit ohne Kindprozess zählt nicht als laufender Slot. Chatentfernung räumt Pipeline-Daten und Workspaces auf, sofern deren gespeicherter Root dem aktuell konfigurierten Root entspricht; bei verändertem Root nicht von vollständiger Bereinigung ausgehen. Entfernen ist bei nichtterminalem Lauf gesperrt. Projektentfernung löscht Pipelinehistorie nur mit `deleteHistory`.

## Modelle und Konten: direkter Zugriff oder pi-Bridge

`pipeline-supervisor.js:modelCatalog` bestimmt den tatsächlichen Weg; `GET /api/pipeline` meldet je Provider `via:"direct"|"pi"`. Die frühere Einschränkung auf kompatible API-Key-Konten gilt nur für den **direkten** Weg, nicht mehr für alle Pipeline-Modelle:

| Weg | Exakte Auswahl im Supervisor | Authentifizierung |
|---|---|---|
| `direct` | Konto `kind:"api_key"`, `status:"signed_in"` und entweder Provider-ID `openai` oder eigener Provider mit `custom:true`, `api:"openai-completions"` | OpenAI: `https://api.openai.com/v1`; Custom: dessen `baseUrl`. Key serverseitig auflösen und als `SCRANTON_PIPELINE_KEY_PLANNER`, `_IMPLEMENTER`, `_REVIEWER` an Python geben; Konfiguration nennt nur Variablennamen. |
| `pi` | Alle übrigen Einträge mit mindestens einem von pi als verfügbar gelieferten Modell, einschließlich Subscription-/OAuth-Konten und nicht direkt kompatiblen Providern | `provider:"command"` mit Node und `tools/pipeline-pi-complete.js`; pi liest seinen eigenen Credentialstore; bei env-basierten Konten reicht der Supervisor ausschließlich die Namen der gewählten Provider aus `PROVIDER_ENV_NAMES` an die Engine weiter. Commandprovider/Helper erben diese Werte; Check-/Setupumgebungen filtern sie weiterhin aus. |
| nicht auswählbar | Kein verfügbares pi-Modell im Katalog | `supported:false`, Grund `No available Pi models`. |

Der direkte Built-in-Allowlist-Eintrag ist derzeit **nur `openai`**, keine pauschale Liste aller OpenAI-kompatiblen Anbieter. Das Commandprotokoll erhält System-/Usertext als private Dateien, startet einen tool-/sessionlosen pi-Turn und extrahiert Antwort/Usage. Timeout/Stop beendet den besessenen Prozessbaum; temporäre Promptdateien werden gelöscht. Die Providerintegration läuft auf dem Host, nicht im Checkcontainer. Andere frei konfigurierte Completionbefehle benötigen entsprechendes Betreibervertrauen.

Die automatisierten Bridgeprüfungen verwenden ausschließlich Fake-pi bzw. lokale Completionprozesse. Ein echter Lauf wurde am **2026-11-09 um 22:37** über die Desktop-HTTP-API auf dem Drei-Dateien-Projekt `.scratch/pipeline/real-smoke/project` ausgeführt: alle drei Rollen `openai/gpt-6.1-sol` **via pi**, ChatGPT-Subscription des Benutzers, Trusted-Host-Sandbox. Planner: 2 Aufrufe (ein Kontextzug), Implementer: 1, Reviewer: 1; pi meldete **7647 Input-/601 Outputtokens**. Baselinecheck rot, finaler Check grün, Ein-Zeilen-Diff; die Quelldatei änderte sich erst nach Lieferfreigabe; Abschluss **`succeeded`**. Dieser eine Lauf belegt **nicht** andere Provider, größere Repositories, Reparatur-/Revisionsschleifen mit echten Modellen oder Dockerbetrieb mit echten Modellen. Unterstützt im Katalog bedeutet nicht nachgewiesene Providerkompatibilität. Die Modellauswahl kennzeichnet Bridgegruppen mit **via pi**; bei leerem Katalog verweist sie auf Anmeldung oder Provider unter Accounts, nicht mehr ausschließlich auf API-Keys.

## HTTP-API für Entwickler

Alle folgenden Registry-Routen durchlaufen `registry-router.js:authorize`: echte Loopbackverbindung, lokaler Host, Header **`X-Scranton-Client: 1` auch bei GET**, und bei vorhandenem Origin exakte lokale Origin. POST braucht JSON; unbekannte Bodyfelder werden abgewiesen. Keine CORS-/Fernzugriffsfreigabe. Fehlerform `{ "error": "..." }`.

Abkürzungen: `P=/api/projects/:p`, `C=P/chats/:c`, `R=C/pipeline/runs/:runId`.

| Methode/Pfad | Body/Parameter | Antwort |
|---|---|---|
| GET `/api/pipeline` | – | `{available,reason,version,source,sandbox:{dockerImage},models:[...]}` |
| POST `P/pipeline/detect` | `{}` | `{git,languages,checks:[{id,kind,command,reason}],setup:[{id,command,network,reason}]}`; feste, hostverfügbare Vorschläge, keine Ausführung |
| POST `P/chats` | `{title?,engine:"pipeline"}` | neuer Chat; sonst Team wie bisher |
| GET `C/pipeline` | – | `{active,runs:[{runId,status,phase,task,createdAt,updatedAt}]}`, älteste zuerst |
| POST `C/pipeline/runs` | unten beschriebene Startparameter | 202 `{ok:true,runId}` |
| GET `R?after=N` | nichtnegative sichere Sequenzzahl | `{status,launchError,live,events,lastSeq,plan,review,stderrTail}`; `status:RunStatus\|null`, `launchError:{code:number\|null,message:string}\|null`; höchstens 500 vollständige Events mit `seq>N` |
| GET `R/artifacts/:name` | `plan\|diff\|report\|report-json` | `{name,content,truncated}`, höchstens 1 MiB Text; `diff` folgt `status.artifacts.diff`, auch bei Fehlern; `report` ist Markdown |
| POST `R/decision` | `{gate:"plan"\|"delivery",decision:"approve"\|"reject",digest,comment?}` | 202 `{ok:true}`; Digest muss zum wartenden Gate passen |
| POST `R/resume` | `{}` | 202 `{ok:true}`, nur `suspended` |
| POST `R/cancel` | `{}` | 202 `{ok:true}`, nichtterminal |
| GET `/api/control` | – | aggregiert `{v,enabled,scenarios,defaults,running,pendingHuman,chats}`; `scenarios` auch ohne Teamchat verfügbar, Pipeline-Gates zählen in `pendingHuman` |

Startbody: `task` erforderlich (1..32768 Bytes), optional `demo:boolean`, `delivery:"apply"|"patch"`, `sandbox:{mode:"docker"|"host",image?,trustHost?}`, `models:{planner:{provider,model},implementer:{provider,model},reviewer:{provider,model}}`, `approvals:{plan:"always"|"auto_low_risk"}`, `review:boolean`. Maximal zwölf Checks `{id,kind,command,timeoutSec?,required?,scope?}`, maximal vier Setuprezepte `{id,command,timeoutSec?,network?}`. IDs je Liste eindeutig nach `^[A-Za-z0-9_-]{1,64}$`; Fehler benennen etwa `setup[0].command` oder `checks[1].timeoutSec`. Checkscope `step|final`, Kategorien `syntax|lint|typecheck|test|security|other`; Timeout ganzzahlig 1..3600, Default 600. Setupnetz Default false; Checks erlauben kein Netzopt-in. Bei leerer Checkliste setzt der Supervisor explizit `allow_no_checks:true`. Gatekommentare werden als einzelnes `--comment=<text>`-Argument übergeben, auch bei führendem `-`. Ein parsebarer schema-1-RunStatus wird unabhängig vom Prozess-Exitcode akzeptiert: `status` endet etwa am Gate mit 3 und bei Suspend mit 5.

`command` wird in höchstens 64 argv-Tokens zerlegt: einfache/doppelte Quotes, keine Variablenexpansion, keine Shellpipeline. Für Demo werden neben der nichtleeren Aufgabenvalidierung nur Demo/Liefermodus praktisch genutzt. Modell-/Sandbox-/Checkoptionen braucht die Fixture nicht.

Fehler: 400 Eingabe/Optionen, 403 Zugriff/Pfad, 404 fehlendes Artefakt, 409 nichtterminale Konkurrenz/falsche Engine/fehlendes Hostvertrauen/veraltetes Gate, 429 `too_many_runs`, 503 Engine/Detection nicht verfügbar. Pipeline-Routen auf Teamchats → 409 `This chat does not use the pipeline engine`; alte POST-Steuerpfade auf Pipelinechats → 409 `This chat uses the pipeline engine`. Kein Übersetzen von Pipeline-Gates in Hive-HITL-Dateien.

## Sicherheit und Grenzen

Modellvorschläge bekommen keine Dateitools oder Shell. Python validiert JSON, Pfade, Scope und Syntax; Schutzmuster/Manifestnamen werden case-insensitiv geprüft. Edits dürfen keinen neuen `[REDACTED]`-Marker einführen, Reviewer-Findingpfade sind reine Anzeigedaten. Betreibercheckrezepte bleiben mächtig. Nach Baseline und Verify werden getrackte Checkänderungen restauriert und mit Warnung/Reportgrenze gemeldet; Index und Checks laufen weiterhin parallel, ohne read-only Mount. Snapshot und Digestgates verhindern nicht alle Race Conditions oder Prompt-Injection; Hostmodus schützt nicht vor bösartigem ausgeführtem Code. Schutzlisten/Secretredaktion sind Best effort, kein vollständiger Geheimnisscanner. Quellübernahme nur nach zweitem Gate; niemals automatisch Commit/Push. Externe Modelle erhalten den ausgewählten, begrenzten Repositorykontext: auch bei lokal gespeicherten Artefakten ist ein Cloudmodell kein lokaler Datenverarbeiter.

Hier verifiziert: scripted Python-Demo in getrennten Prozessen durch beide Gates, Sourceapply nach Freigabe. Das ist vom oben dokumentierten einzelnen realen Modelllauf zu unterscheiden; weiterhin nicht verifiziert sind Betrieb außerhalb Windows und der komplette installierte Desktop-Lifecycle. Separat wurde der opt-in lokale Dockertest (`SCRANTON_PIPELINE_DOCKER_TEST=1`, Image `scranton-sandbox:1.5.0`) am 09.11.2026 einmal erfolgreich protokolliert: Befehl mit überschriebenem `--entrypoint`, kein externes Netzinterface, keine Gitmetadaten im Mount, Timeout/Cleanup des eigenen Containers. Hier nicht wiederholt; keine vollständige Sandbox-Freigabe. Die [Architektur](../engine/docs/ARCHITECTURE.md) benennt Timeoutthread-, Journaling-, Race- und Produktionsgrenzen. Keine Neuplanung oder parallele Schrittentwicklung.

## Fehlerdiagnose

| Symptom | Prüfung/Maßnahme |
|---|---|
| „Pipeline engine is not available“ | `GET /api/pipeline` mit Clientheader, Override-argv und `python -m scranton_pipeline version` prüfen; venv/Paket oder gebündelte Runtime vorhanden? Kein automatischer Download. |
| Engine startet, Check nicht | Checkexecutable muss im Host-PATH bzw. Dockerimage liegen. Windows-`.cmd`/`.bat` (auch per PATH aufgelöst) laufen über `cmd.exe /d /s /c` nur mit einfachen allowlist-konformen Argumenten. Bei `unsafe_shim_arguments` Leerraum/Quotes/Metazeichen entfernen oder ein natives Executable mit argv verwenden; kein frei gebautes `cmd /c` als Umgehung. Diagnose in Check-Output/Failure bzw. `launchError` lesen. |
| Vorschlag `npm test` scheitert auf Windows | `detect` bietet nur auf dem Host auffindbare Executables an; `npm test`/`npm ci` sind mit sicheren Shimargumenten erlaubt. Das beweist weder installierte Projektabhängigkeiten noch Verfügbarkeit im Dockerimage. Für komplexe Argumente natives Node plus npm-CLI verwenden, z. B. `"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" test` im Befehlseingabefeld mit den tatsächlichen lokalen Pfaden. |
| Check-ID wird abgewiesen | In Engine, Node und UI gilt dieselbe Regel `[A-Za-z0-9_-]{1,64}` für Check-/Setup-IDs. Das benannte Feld prüfen, Punkt entfernen und IDs je Liste eindeutig halten. |
| 202, aber Lauf startet nicht | `launchError.code/message` im Detailabruf und `requests/<runId>.error.json` prüfen; bei `status:null` existiert noch kein Python-Runstatus. Anzeige/Listeneintrag nicht mit einem erfolgreichen Start verwechseln. |
| `awaiting_approval`, exit 3 | Erwarteter Halt; Plan oder Diff lesen und aktuelle Digestentscheidung senden. |
| 409 stale gate/digest | Ansicht neu laden; niemals alten Digest erzwingen. Python bindet zusätzlich an Checkpoint und Artefakthash. |
| `suspended` nach Schließen/Absturz/Providerstörung | Ursache beheben und Resume; kein zweiter Run im selben Chat. Kosten eines wiederholten Provideraufrufs möglich. |
| `source_conflict` | Nutzeränderung seit Snapshot oder Übernahmeproblem; Backups/Journal/Report prüfen, keine fremde Änderung überschreiben. Neuer Lauf nach bewusster Konfliktklärung. |
| Docker nicht erreichbar/Image fehlt | Engine/Image bewusst separat bereitstellen; kein stiller Hostfallback. |
| Checks fehlen/keine Details | Prüfrezept hinzufügen; bei nicht bestandenen Checks **Output** aufklappen (Tail, kein vollständiger Log). Logs lokal unter `artifacts/logs`, Ergebnisse im Markdown-/JSON-Bericht; kein separater Checklog-Endpunkt. |
| Cancel scheint langsam | Modellaufruf kann bis Deadline weiterlaufen; Quellübernahme wird nicht mitten im Schreiben abgebrochen. Status/Eventfortschritt prüfen, keine fremden Prozesse anhand einer alten PID beenden. |

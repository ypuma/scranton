# Scranton Pipeline – Betrieb und Erweiterung

Python-Engine 0.1.0: feste LangGraph-Zustandsmaschine mit Planner, Implementer und optionalem Reviewer, privaten Snapshot-Dateien und menschlicher Plan-/Lieferfreigabe. Sie ist eigenständig per CLI nutzbar. [Architektur](docs/ARCHITECTURE.md) · [Desktop/HTTP](../docs/PIPELINE.md) · [Projekt](../README.md).

## Voraussetzungen und Installation (Windows cmd)

Paketanforderung: Python >=3.12; geprüft wurde hier die vorhandene Windows-Python-3.14-Umgebung. Git muss als ausführbares Programm auf PATH liegen; für Dockerchecks zusätzlich eine erreichbare Linux-Docker-Engine und das **bereits lokal vorhandene** konfigurierte Image. Die Engine installiert weder Docker noch Git und baut/lädt kein Image. Keine echten Provider sind für die Demo nötig.

Abhängigkeiten: LangGraph/Checkpoint/SQLite, LangChain Core/OpenAI und Pydantic, exakt gepinnt in `pyproject.toml`; pytest/Ruff/mypy als Extra `dev`. Das `langchain`-Metapaket ist nicht erforderlich. `requirements.lock` beschreibt die hashgesperrte Runtime-Closure; die editierbare Entwicklerinstallation unten ist nicht gleichbedeutend mit einem vollständig reproduzierten Desktoppaket.

Vom Projektroot, Beispielpfad dieses Checkouts (für eine andere Installation `ROOT` anpassen):

```cmd
set "ROOT=C:\Users\pumas\Documents\Project_Scranton"
mkdir "%ROOT%\.scratch\pipeline\tmp"
set "TEMP=%ROOT%\.scratch\pipeline\tmp"
set "TMP=%TEMP%"
set "TMPDIR=%TEMP%"
set "PIP_CACHE_DIR=%ROOT%\.scratch\pipeline\pip-cache"
set "PYTHONPYCACHEPREFIX=%ROOT%\.scratch\pipeline\bytecode"
py -3.14 -m venv "%ROOT%\.scratch\pipeline\venv"
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m pip install -e "%ROOT%\engine[dev]"
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline version
```

`py -3.14` setzt einen separat installierten Interpreter voraus; es installiert ihn nicht. Eine vorhandene gemeinsam benutzte venv nicht während anderer Läufe neu anlegen. Die nachfolgenden Beispiele verwenden dieselbe cmd-Sitzung mit `ROOT`/TEMP gesetzt. `PYTHONPYCACHEPREFIX` nicht auf einen Pfad im bearbeiteten Quellprojekt setzen.

## Demo: echter CLI-Ablauf ohne echten Modellaufruf

Vom Root:

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline demo --run-root "%ROOT%\.scratch\pipeline\lane-docs\runs2" --run-id de44237f3966 --delivery apply
```

Das erzeugt `de44237f3966/demo-source` mit einer fehlerhaften Addition und eigenen scripted Antworten. **Exit 3 ist am Plan-Gate erwartet**, kein Installationsfehler. Für Wiederholungen eine neue ID verwenden; bestehende Runverzeichnisse werden nicht überschrieben. `demo` impliziert Hostvertrauen ausschließlich für diese mitgelieferte Fixture, nicht für den Projektordner. Ein eingegebener Desktop-Demotext ersetzt ihre feste Aufgabe nicht.

Den Digest aus `pending.digest` übernehmen, Plan lesen, dann:

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline resume --run-dir "%ROOT%\.scratch\pipeline\lane-docs\runs2\de44237f3966" --gate plan --decision approve --digest ff554422a3552982f65266a863895e83251f891337f70865957d985860d6c6a3
```

Wieder exit 3, jetzt am Liefer-Gate. Den Diff prüfen, dann:

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline resume --run-dir "%ROOT%\.scratch\pipeline\lane-docs\runs2\de44237f3966" --gate delivery --decision approve --digest bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261
```

Exit 0; erst jetzt steht `a + b` im Demo-Quellordner. Diese Digests stammen vom unten protokollierten Lauf; bei anderen Aufgaben niemals blind wiederverwenden. `--decision reject` am Plan beendet als `rejected`; am Liefer-Gate bedeutet es „nur Patch behalten“, also `succeeded` ohne Quelländerung.

### Tatsächlich aufgezeichnete stdout-Zeilen

Ausführung dieses Dokumentationslaufs am 9. November 2026, drei getrennte Python-Prozesse, Exitcodes **3, 3, 0**. Die folgenden Statusobjekte sind vollständig, für die Darstellung neu serialisiert (Werte unverändert); Zeiten und absolute Pfade sind Beispiele, keine stabilen Testwerte. Die Demo meldet je scripted Antwort 100 Input-/100 Outputtokens; das ist Fixtureusage, keine Modellmessung.

```json
{"schema":1,"run_id":"de44237f3966","status":"awaiting_approval","phase":"approve_plan","node":"approve_plan","task":"Fix addition so the unit test passes.","source_dir":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\demo-source","delivery_mode":"apply","progress":{"step_index":-1,"step_count":1,"step_title":"","attempt":0,"review_round":0},"pending":{"gate":"plan","digest":"ff554422a3552982f65266a863895e83251f891337f70865957d985860d6c6a3","risk_flags":["baseline_red"],"path":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\artifacts\\plan.json"},"failure":null,"resumable":true,"usage":{"calls":1,"input_tokens":100,"output_tokens":100,"estimated_cost":null},"checks":[{"id":"unit","kind":"test","status":"failed","required":true,"duration_s":0.1658995000034338,"output_tail":"======================================================================\r\nFAIL: test_add (test_calculator.Addition.test_add)\r\n----------------------------------------------------------------------\r\nTraceback (most recent call last):\r\n  File \"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\workspace\\test_calculator.py\", line 6, in test_add\r\n    self.assertEqual(add(2, 3), 5)\r\n    ~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^\r\nAssertionError: -1 != 5\r\n\r\n----------------------------------------------------------------------\r\nRan 1 test in 0.001s\r\n\r\nFAILED (failures=1)\r\n"}],"delivery":null,"artifacts":{"plan":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\artifacts\\plan.json","diff":null,"report_md":null,"report_json":null},"sandbox":{"mode":"host","isolated":false},"pid":null,"created_at":"2026-11-09T21:38:42.587522+00:00","updated_at":"2026-11-09T21:38:43.451544+00:00","engine_version":"0.1.0"}
{"schema":1,"run_id":"de44237f3966","status":"awaiting_approval","phase":"deliver","node":"approve_delivery","task":"Fix addition so the unit test passes.","source_dir":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\demo-source","delivery_mode":"apply","progress":{"step_index":0,"step_count":1,"step_title":"Correct addition","attempt":1,"review_round":0},"pending":{"gate":"delivery","digest":"bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261","files":[{"path":"calculator.py","action":"modify","added":1,"removed":1}],"path":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\candidate.diff"},"failure":null,"resumable":true,"usage":{"calls":3,"input_tokens":300,"output_tokens":300,"estimated_cost":null},"checks":[{"id":"unit","kind":"test","status":"passed","required":true,"duration_s":0.16686559999652673,"output_tail":""}],"delivery":{"applied":false,"diff_sha256":"bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261","files":1,"conflicts":[]},"artifacts":{"plan":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\artifacts\\plan.json","diff":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\candidate.diff","report_md":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\report.md","report_json":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\report.json"},"sandbox":{"mode":"host","isolated":false},"pid":null,"created_at":"2026-11-09T21:38:42.587522+00:00","updated_at":"2026-11-09T21:38:45.965206+00:00","engine_version":"0.1.0"}
{"schema":1,"run_id":"de44237f3966","status":"succeeded","phase":"done","node":"finalize","task":"Fix addition so the unit test passes.","source_dir":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\demo-source","delivery_mode":"apply","progress":{"step_index":0,"step_count":1,"step_title":"Correct addition","attempt":1,"review_round":0},"pending":null,"failure":null,"resumable":false,"usage":{"calls":3,"input_tokens":300,"output_tokens":300,"estimated_cost":null},"checks":[{"id":"unit","kind":"test","status":"passed","required":true,"duration_s":0.16686559999652673,"output_tail":""}],"delivery":{"applied":true,"diff_sha256":"bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261","files":1,"conflicts":[]},"artifacts":{"plan":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\artifacts\\plan.json","diff":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\candidate.diff","report_md":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\report.md","report_json":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\report.json"},"sandbox":{"mode":"host","isolated":false},"pid":null,"created_at":"2026-11-09T21:38:42.587522+00:00","updated_at":"2026-11-09T21:38:47.550125+00:00","engine_version":"0.1.0"}
```

### Tatsächlich erzeugtes `report.md`

Vollständiger englischer Markdownbericht desselben Laufs, ohne Modell generiert; Zeitwerte, Commit und lokale Pfade sind laufabhängig. `report.json` enthält dieselben redigierten Daten in Maschinenform. Die Baseline war absichtlich rot, der finale Check grün.

````markdown
# Pipeline report

## Outcome

Status: succeeded

## Task

Fix addition so the unit test passes.

## Plan

Fix addition

### Acceptance criteria

| ID | Criterion | Verification | Assessment | Evidence |
| --- | --- | --- | --- | --- |
| sum | add(2, 3) returns 5 and tests pass | checks | met | Unit tests pass |

## Steps

| Step | Attempts | Commit |
| --- | --- | --- |
| step:fix | 1 | 32683a83cccd44acca22c7a17f4911f2fdbf93a3 |

## Changed files

| Path | Action | Added | Removed | Scope |
| --- | --- | --- | --- | --- |
| calculator.py | modify | 1 | 1 | declared |

## Checks

| Stage | ID | Kind | Required | Status | Seconds |
| --- | --- | --- | --- | --- | --- |
| baseline | unit | test | True | failed | 0.166 |
| final | unit | test | True | passed | 0.167 |

### baseline: unit output

    ======================================================================
    FAIL: test_add (test_calculator.Addition.test_add)
    ----------------------------------------------------------------------
    Traceback (most recent call last):
      File "C:\Users\pumas\Documents\Project_Scranton\.scratch\pipeline\lane-docs\runs2\de44237f3966\workspace\test_calculator.py", line 6, in test_add
        self.assertEqual(add(2, 3), 5)
        ~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^
    AssertionError: -1 != 5
    
    ----------------------------------------------------------------------
    Ran 1 test in 0.001s
    
    FAILED (failures=1)

## Review

Verdict: approve

Addition corrected and verified

## Usage

- calls: 3
- input_tokens: 300
- output_tokens: 300
- estimated_cost: —

## Timeline

| Node | Seconds |
| --- | --- |
| prepare_workspace | 0.478 |
| index_repo | 0.016 |
| baseline_checks | 0.233 |
| plan | 0.025 |
| approve_plan | 0.011 |
| select_step | 0.006 |
| implement | 0.017 |
| apply_edits | 0.35 |
| verify | 0.297 |
| select_step | 0.003 |
| review | 0.193 |
| package | 0.187 |
| approve_delivery | 0.011 |
| apply_to_source | 0.219 |

## Delivery

- mode: apply
- applied: True
- diff_sha256: bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261
- diff_path: C:\Users\pumas\Documents\Project_Scranton\.scratch\pipeline\lane-docs\runs2\de44237f3966\delivery\candidate.diff

## Limitations

- Outgoing context redaction is best effort.
- Trusted host checks have no OS isolation.
- Baseline checks were red.
````

## Eigene Aufgabe starten

Konfiguration zuerst passend zum Zielprojekt bearbeiten. `examples/config.openai.json` und `examples/config.local-endpoint.json` sind **Vorlagen**, keine für jedes Repository geeigneten Prüfrezepturen. Sie starten `python -m unittest -q`; fehlende Tests können damit unbemerkt zu wenig prüfen. Bei Docker muss `python` im Image existieren; im Hostmodus muss es auf PATH der Checkumgebung auf den richtigen Interpreter zeigen. `.cmd`/`.bat` dürfen unter Windows auch über PATH auflösen; sie laufen dann über `cmd.exe /d /s /c` nur mit einfachen Argumenten gemäß `[A-Za-z0-9_./:=+,@\\-]+`. Leerraum, Quotes, leere Argumente, Steuer-/Shellzeichen werden als `unsafe_shim_arguments` verweigert; komplexe Argumente an ein natives Executable übergeben.

Beispielaufgabe: „Korrigiere die Addition und ergänze einen Regressionstest, ohne öffentliche Funktionsnamen zu ändern.“ Für ein echtes Projekt Runroot/Workspace **außerhalb** des Quellordners wählen:

```cmd
set "OPENAI_API_KEY=DEIN_LOKALER_KEY"
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline detect --source C:\Projekte\Rechner
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline run --source C:\Projekte\Rechner --task "Fix addition and add a regression test." --config "%ROOT%\engine\examples\config.openai.json" --run-root "%ROOT%\.scratch\pipeline\lane-docs\project-runs" --workspace-root "%ROOT%\.scratch\pipeline\lane-docs\workspaces" --delivery apply
```

Das ist eine **Anleitung für einen bewusst gestarteten echten Providerlauf**, kein hier ausgeführter Test. Key nur lokal setzen, nicht in Konfiguration, Git oder Logs übernehmen. Für die Hostvorlage zusätzlich `--trust-host` beim Start und bei jeder Wiederaufnahme setzen; Hostvertrauen gibt Modellcode in Checks die Rechte des Benutzerkontos. Die lokale Vorlage verlangt auch dann `LOCAL_MODEL_API_KEY`, wenn der lokale Server lediglich einen nichtleeren Platzhalter erwartet.

### Konfigurationsfelder der beiden Beispiele

| Feld | Bedeutung |
|---|---|
| `schema:1` | Drahtformatversion; in Python `schema_version` |
| `models.planner`, `.implementer`, `.reviewer` | Je eine Rollenkonfiguration, auch bei deaktiviertem Review im Schema erforderlich |
| `provider:openai_compatible` | Direkter LangChain-OpenAI-kompatibler Adapter, kein pi-Agent |
| `model` | Beim Endpunkt verfügbare Modell-ID: Vorlage `gpt-4.1` bzw. anzupassendes `local-model`; Verfügbarkeit nicht live geprüft |
| `base_url` | Lokal `http://127.0.0.1:1234/v1`; ohne Angabe `https://api.openai.com/v1`; HTTPS erforderlich außer Loopback, keine Credentials/Query/Fragmente |
| `api_key_env` | **Name** der Umgebungsvariablen `OPENAI_API_KEY` bzw. `LOCAL_MODEL_API_KEY`, nicht ihr Wert |
| `structured_output` | `json_schema` im OpenAI-Beispiel; `json_text` lokal mit Schema im Prompt und JSON-Extraktion; alternativ `function_calling` |
| `sandbox.mode` | `docker` oder bewusst freigegebener `host` |
| `sandbox.docker.image` | Vorhandenes `scranton-sandbox:1.5.0`; kein automatisches Pull/Build |
| `checks[].id` | Eindeutiges Rezeptlabel `tests`; für Checks/Setup gilt `config.py:COMMAND_ID_PATTERN` = `^[A-Za-z0-9_-]{1,64}$`, ebenso in Node/UI |
| `checks[].kind` | Ergebnis-Kategorie `test`; kein automatisch gewählter Befehl |
| `checks[].argv` | Betreiberargumentliste `python`, `-m`, `unittest`, `-q`; keine Shellsyntax/Expansion |
| `checks[].timeout_s` | 120 Sekunden in beiden Vorlagen |
| `approvals.plan` | `always`: menschliche Freigabe; alternativ `auto_low_risk` nur ohne Python-Risikoflag |

Nicht gesetzte Werte stammen aus `config.py`: Review an; Check `required:true`, `scope:"step"`, Netzwerk aus; Modelltemperatur 0, maximal 8192 Outputtokens, 180 Sekunden Deadline. Docker: 2 CPUs, 2048 MB, 256 PIDs. CLI-Liefermodus standardmäßig `patch`, Desktop standardmäßig `apply`. Kein verstecktes Setup oder automatische Installation von Projektabhängigkeiten. `detect` liefert neben `checks` auch `setup` als Vorschläge: z. B. `npm ci` mit `network:true` bei `package-lock.json`, sofern npm auf dem Host auffindbar ist. Die Desktopform bietet dafür editierbare Setupzeilen; der Betreiber entscheidet über ihre Übernahme.

Weitere Operatorfelder: `setup` (bis 4 argv-Rezepte mit `id`, `timeout_s`, `network`), `checks` (bis 12, Kategorien `syntax|lint|typecheck|test|security|other`; `scope:final` erst beim letzten Schritt und Revisionen, Baseline führt alle aus), `allow_no_checks:true` für bewusst leere Checklisten. `review.enabled` schaltet Modellreview aus. `policy.protected_paths`/`write_protected_paths` ergänzen Defaults, `scope:strict` verbietet undeclarierte Dateien; Standard `plan_plus_flagged` erlaubt `max_undeclared_files:2`. `sandbox.env_passthrough` ergänzt die Allowlist, hebt das Credentialverbot nicht auf. `pricing` ordnet Modell-IDs `input_per_mtok`/`output_per_mtok` zu; Kosten sind Schätzungen, bei fehlendem Preis null. `limits` überschreibt begrenzte Defaults; vollständige Feld-/Grenzenliste ist `config.py:Limits`, Wirkung und Verdrahtungsgrenzen siehe Architektur.

### CLI und Exitcodes

| Kommando | Zweck |
|---|---|
| `run --source ... (--task ... \| --task-file ...) --config ... --run-root ...` | Neuer Lauf; optional `--workspace-root`, `--run-id`, `--delivery patch\|apply`, `--trust-host` |
| `resume --run-dir ...` | Suspendierten Lauf fortsetzen; bei Gate zusätzlich `--gate`, `--decision`, `--digest`, optional `--comment` |
| `status --run-dir ...` | Status lesen; toten Owner mit `running` nach `suspended` normalisieren |
| `cancel --run-dir ...` | Sentinel setzen; ohne aktiven Owner selbst ohne Modelle zum Abbruchabschluss fortsetzen |
| `detect --source ...` | `{git,languages,checks,setup}` mit festen, auf dem Host auffindbaren Rezepten; Vorschläge werden nicht automatisch ausgeführt und beweisen keine Toolverfügbarkeit im Dockerimage |
| `graph --format mermaid` | Aus kompiliertem Graphen erzeugte Mermaid-Ausgabe |
| `demo --run-root ...` | Eigene Fixture/scripted Modelle; dieselben Gates |
| `version` | Engine-/Python-/LangGraph-Version als JSON |

`--parent-guard` bei run/demo/resume/cancel ist für Supervisoren: stdin bleibt offen; EOF oder `stop` fordert Suspend an. Interaktives `resume` nicht unnötig damit starten. stdout liefert pro erfolgreicher Statusoperation genau eine JSON-Zeile; `graph` liefert Text, argparse-Hilfe ist ebenfalls keine Statuszeile. Diagnosen gehen nach stderr.

| Exit | Bedeutung |
|---|---|
| 0 | Erfolg; Status-/Detect-/Graph-/Versionabfrage erfolgreich; auch bewusster Patch-only-Abschluss |
| 2 | Ungültige Eingabe/Konfiguration, aktiver Owner, veralteter Digest oder unzugängliche Eingabedateien |
| 3 | `awaiting_approval`, Gateentscheidung erforderlich |
| 4 | `failed`, terminaler Laufbericht |
| 5 | Suspendierter Lauf, oder unerwarteter CLI-Infrastrukturfehler; JSONstatus und Dateien prüfen |
| 6 | `rejected` oder `cancelled` |

Eine erfolgreiche `status`-Abfrage verwendet den Exitcode des gemeldeten Laufstatus, nicht zwingend 0. Ein Live-Cancel kann noch `running` melden; bis zum tatsächlichen Abschluss weiter abfragen. Terminales Resume ohne Gate liefert den vorhandenen Status, startet keinen neuen Lauf.

## Laufverzeichnis und Wiederaufnahme

`<run-root>/<run-id>` wird exklusiv angelegt (`[a-z0-9]{8,32}`, sonst zufällige 12 Hexzeichen). Dort: `run.json`, `config.json`, `status.json`, `events.jsonl`, `usage.jsonl`, `checkpoints.sqlite`, `git/` (private Gitmetadaten außerhalb des Workspace), `git-hooks/` (leerer engine-eigener Hookordner), `lock`, bei Cancel `cancel.requested`; `artifacts/{plan.json,repo_index.json,source_manifest.json,review-<n>.json,logs/}` und `delivery/{candidate.diff,report.md,report.json,apply-journal.json,backups/}`. Fehl-/Abbruchabschluss erzeugt `partial.diff`. Workspace standardmäßig `workspace/`, bei `--workspace-root W` stattdessen `W/<run-id>`. Demo ergänzt `demo-source/` und scripted Antwortdateien. `tmp/provider/call-*/` enthält nur während eines Command-Modellaufrufs Request/Response und gegebenenfalls Bridge-Promptdateien; danach Cleanup. `RunStatus.checks[*].output_tail` liefert nach Redaktion maximal 4096 Zeichen bei nicht bestandenen Checks, sonst `""`; Status-Schritt/Versuch bezieht sich auch am Liefer-Gate auf den letzten tatsächlichen Planschritt.

Konfigurationskopie/Digest, Gateartefakte, Manifest und Checkpoints nicht manuell ändern. Status `suspended` bedeutet, dass der nächste noch nicht abgeschlossene Knoten erneut laufen kann. Die privaten Dateien und Logs sichern, bevor man defekte Läufe untersucht; niemals die Owner-Sperre eines aktiven Prozesses löschen. Quellkonflikte nicht mit blindem Resume „lösen“: sie sind terminal; Konflikt bewusst lösen und einen frischen Lauf starten. Ein erneuter Provideraufruf ist nicht Exactly-once gegenüber dem Modellservice.

## Prüfungen und Qualitätsgates

Aus `engine\`, TEMP wie oben setzen. Alle neuen temporären Dateien/Caches bleiben unter `.scratch/pipeline/`; Tests benutzen nicht den echten Hive. Die eigene Projekt-Testumgebung nicht als Quellprojekt eines Modelllaufs verwenden.

```cmd
..\.scratch\pipeline\venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider --basetemp ../.scratch/pipeline/lane-docs/pytest
..\.scratch\pipeline\venv\Scripts\python.exe -m ruff check src tests --cache-dir ../.scratch/pipeline/lane-docs/ruff
..\.scratch\pipeline\venv\Scripts\python.exe -m mypy src --cache-dir ../.scratch/pipeline/lane-docs/mypy
```

Nacheinander ausführen, nicht konkurrierend mit anderen Vollsuiten. `-p no:cacheprovider` vermeidet pytest-Cacheprobleme bei `..`-Pfaden. Ein kurzer Gate-/Graphnachweis ist `-m pytest tests/flow/test_graph.py -q -p no:cacheprovider --basetemp ../.scratch/pipeline/lane-docs/pytest-graph`. Die Demo oben prüft die zwei tatsächlichen CLI-Gates in getrennten Prozessen. Tests verwenden scripted Modelle, lokale Completionprozesse/Fake-pi bzw. Offline-HTTP-Mocks; echte Provider werden in diesen automatisierten Tests nicht aufgerufen. Der separat durchgeführte reale Lauf ist unten beschrieben. Der Opt-in-Test `tests/unit/test_fix1.py:test_opt_in_docker_network_timeout_and_no_git_mount` läuft nur mit `SCRANTON_PIPELINE_DOCKER_TEST=1` gegen das bereits lokale `scranton-sandbox:1.5.0`; er prüft einen echten Befehl, Netzinterfacebeschränkung, fehlende Gitmetadaten im Mount und Timeout/Cleanup des eigenen Containers. Ein erfolgreicher Lauf ist am 09.11.2026 protokolliert; hier nicht erneut ausgeführt, kein umfassender Sandbox-Nachweis. Docker setzt dafür `--entrypoint` auf das konfigurierte Executable, statt den pi-Entrypoint des Images zu übernehmen.

Gesamtprüfstand **2026-11-09 abends** aus den abgeschlossenen Codegates, keine hier erneut ausgeführte Vollsuite: Engine **272 bestanden, 1 Skip** (Opt-in-Docker), Ruff sauber, mypy strict sauber auf **33 Quelldateien**; Node Server **128**, Core **415 bestanden + 1 Skip**, Visualizer **400**, Packaging **6**. Die Engine meldete 13 LangSmith-Deprecationwarnungen zu `asyncio.iscoroutinefunction`. Der neue Dokumentationslauf belegt separat die Demo mit **3 → 3 → 0** und den oben wiedergegebenen Markdownbericht.

## Erweiterung

- **Neuer Check:** Betreiberrezept in `checks` ergänzen; kein Graphumbau. `tools/repo_index.py:detect_checks` nur ändern, wenn es als Vorschlag angeboten werden soll. Tests/Timeout/required/scope bewusst wählen.
- **Neuer Provider:** Konfigurationsvalidierung und Fabrik in `agents/providers.py` ergänzen, `BaseChatModel`/Usage-/Fehlervertrag erfüllen und offline testen; gegebenenfalls Runner-Vorabvalidierung anpassen. Der Graph bleibt unverändert. Ein nativer Structured-Output-Provider braucht `with_structured_output`; nur `json_text` zu unterstützen ist eine explizite Alternative.
- **Reviewlinsen:** Bewertungsschwerpunkte in `build_reviewer_prompt` und bestehenden Finding-Kategorien schärfen, ohne Kanten zu ändern. Getrennte Security-/QA-Agenten oder parallele Linsen gibt es nicht; dafür wären neue Schemas/Nodes/Join-/Budgettests nötig. Eigenes Agentenregister des Team-Engines gilt hier nicht.
- **Neuer Knoten/Kante:** Funktion mit Stateupdate und Dependencies, Ownership/Reducer, Instrumentierung, explizite `path_map`, reine Routertests und alle Grenzen ergänzen; `recursion_limit` neu begründen. `graph --format mermaid` nach `docs/graph.mmd` übernehmen und hier im Architekturtext identisch aktualisieren. Nicht nur ein Promptwort hinzufügen.

## Modelle und Provider

`ModelConfig.provider` kennt aktuell drei Adapter; der Graph bleibt für alle gleich:

| Provider | Eingaben und Verhalten | Prüfstand |
|---|---|---|
| `openai_compatible` | `model`, HTTPS-`base_url` (HTTP nur Loopback), `api_key_env`; `json_text`, `json_schema` oder `function_calling`. `ChatOpenAI` mit `max_retries=0`: Retries gehören dem Graphen. | Offline-HTTP-Mocks; keine echte Provideranfrage in diesem Dokumentationslauf. |
| `scripted` | `script_path` auf JSON-Array mit Rollenoutputs, nur `json_text`. Cursor aus `usage.jsonl`, auch über Prozesswechsel. `{"__error__":"transient"}` simuliert Transportfehler. | Demo/Tests ohne Modellnetzwerk. |
| `command` | `command` als argv-Liste (bis 32 nichtleere Argumente), nur `json_text`, kein `script_path`. Pro Aufruf werden absolute Request-/Responsepfade angehängt. | Lokale Testprozesse/Fake-pi automatisiert; ein separater realer Lauf ist unten dokumentiert. |

Commandprotokoll v1: Request `{"v":1,"role":"planner","model":"MODEL_ID","system":"...","user":"...","max_output_tokens":8192,"temperature":0}`; Response `{"text":"<JSON-Modellantwort als String>","usage":{"input_tokens":10,"output_tokens":20}}`. `usage:null` erlaubt Schätzung. Die pi-Bridge liefert bei ausschließlich Nullusage `null`; Input umfasst `input + cacheRead + cacheWrite` (ohne erneute Addition des Teilwerts `cacheWrite1h`). Parent-EOF/Stop während des Aufrufs → `suspended` (Exit 5), nach Cleanup wiederaufnehmbar. Exit 75 oder Prozessdeadline → transienter Retry; anderer Exit, fehlende/ungültige Response → `provider_rejected`. Promptdateien liegen nur während des Aufrufs unter `<run-dir>/tmp/provider/call-*/` und werden danach entfernt. Der Befehl erhält die Engineumgebung ohne `SCRANTON_PIPELINE_KEY_*`; er ist eine vertrauenswürdige Hostintegration, kein untrusted Check.

Die Desktopintegration verwendet diesen Adapter mit `node` und `tools/pipeline-pi-complete.js --provider P --model M`. Die Bridge startet pi ohne Tools, Sessions, Extensions, MCP, Skills oder Projektkontext und liest dessen Authprofil. Bei env-basierten Konten reicht der Supervisor nur die Variablen der gewählten pi-Provider aus `PROVIDER_ENV_NAMES` weiter; Check-/Setupprozesse erhalten diese Credentials nicht. Damit können auch im pi-Katalog verfügbare Subscriptionmodelle angeboten werden; nur der direkte HTTP-Weg bleibt auf verifizierte kompatible API-Key-Endpunkte beschränkt. Details und exakte Auswahlregeln: [Desktop/Konten](../docs/PIPELINE.md#modelle-und-konten-direkter-zugriff-oder-pi-bridge). Die Beispielkonfigurationen verwenden weiterhin den direkten Adapter, nicht die Bridge.

## Separater realer pi-Bridge-Lauf

Ein echter Lauf wurde am **2026-11-09 um 22:37** über die Desktop-HTTP-API auf dem Drei-Dateien-Projekt `.scratch/pipeline/real-smoke/project` ausgeführt: alle drei Rollen `openai/gpt-6.1-sol` **via pi**, ChatGPT-Subscription des Benutzers, Trusted-Host-Sandbox. Planner: 2 Aufrufe (ein Kontextzug), Implementer: 1, Reviewer: 1; pi meldete **7647 Input-/601 Outputtokens**. Baselinecheck rot, finaler Check grün, Ein-Zeilen-Diff; die Quelldatei änderte sich erst nach Lieferfreigabe; Abschluss **`succeeded`**. Dieser eine Lauf belegt **nicht** andere Provider, größere Repositories, Reparatur-/Revisionsschleifen mit echten Modellen oder Dockerbetrieb mit echten Modellen.

# Scranton Pipeline – Betrieb und Erweiterung

Python-Engine 0.1.0: feste LangGraph-Zustandsmaschine mit Planner, Implementer und optionalem Reviewer, privaten Snapshot-Dateien und menschlicher Plan-/Lieferfreigabe. Sie ist eigenständig per CLI nutzbar. [Architektur](docs/ARCHITECTURE.md) · [Desktop/HTTP](../docs/PIPELINE.md) · [Projekt](../README.md).

## AGENTS.md

Auch eigenständige Engine-Läufe lesen `AGENTS.md` einmal aus dem anfänglichen Workspace-Snapshot: derselbe Anweisungsstand für Planner, Implementer und Reviewer. Die Rootdatei wird bis **32 KiB (32768 Bytes)** mit UTF-8-sicherem Kürzungshinweis eingebunden; bei Dateien über **1 MiB** werden nur die ersten 32 KiB gelesen, nie die vollständige Datei. Verschachtelte Dateien werden nicht eingebunden, sondern als höchstens **50** sortierte relative POSIX-Pfade gelistet (weitere: `(+N more)`); Snapshot-Ausschlüsse gelten. Nur reguläre, workspace-interne UTF-8-Dateien ohne NUL zählen, eine führende BOM wird entfernt. Warnungsgründe: `escape`, `not_regular`, `binary`, `invalid_utf8`, `read_error`.

Repositoryanweisungen stehen unter Rollen-, Tool-, Sandbox- und Freigaberegeln und können keine Rechte erteilen. Sie sind verpflichtende Anweisungen außerhalb des beratenden Kontextbudgets. Opt-out: `agentsMd:false` / `SCRANTON_AGENTS_MD=0`. Das additive Schema-1-Feld `RunStatus.instructions` (`status.json` und CLI-Ausgabe) und die Events melden nur die Zusammenfassung: `{file:"AGENTS.md",bytes,sha256,truncated,nested}` bei Rootdatei, `{file:null,nested:n}` bei ausschließlich verschachtelten Dateien, sonst `null`. `bytes` und `sha256` (kleingeschriebener Hex-Hash) beziehen sich auf den eingebundenen Roottext nach BOM-Entfernung und 32-KiB-Kürzung, ohne Hinweiszeile; `nested` ist die Gesamtzahl verschachtelter Dateien. Ältere Statusdateien dürfen das Feld auslassen. Anweisungstext wird nicht in Events veröffentlicht. Die aktuelle Vorschau in `scranton context show` und im Context-Panel ist vom Run-Snapshot getrennt. [Desktopintegration](../docs/PIPELINE.md#agentsmd) · [Ereignisvertrag](../docs/EVENTS.md#repository-instructions-additive-v1).

## Voraussetzungen und Installation (Windows cmd; POSIX unten)

Paketanforderung: Python >=3.12; geprüft wurde hier die vorhandene Windows-Python-3.14-Umgebung. Git muss als ausführbares Programm auf PATH liegen; für Dockerchecks zusätzlich eine erreichbare Linux-Docker-Engine und das **bereits lokal vorhandene** konfigurierte Image. Die Engine installiert weder Docker noch Git. `sandbox build` baut das paketierte Image ausdrücklich auf Anforderung; beim normalen Lauf wird kein Image gebaut oder gepullt. Keine echten Provider sind für die Demo nötig.

Abhängigkeiten: LangGraph/Checkpoint/SQLite, LangChain Core/OpenAI und Pydantic, exakt gepinnt in `pyproject.toml`; pytest/Ruff/mypy als Extra `dev`. Das `langchain`-Metapaket ist nicht erforderlich. Die plattformspezifischen Requirements-Locks beschreiben die hashgesperrte Runtime-Closure (Windows weiterhin `requirements.lock`); die editierbare Entwicklerinstallation unten ist nicht gleichbedeutend mit einem vollständig reproduzierten Desktoppaket.

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

`demo` unterstützt `--scenario basic|replan|parallel|evidence` (Default `basic`), `--sandbox host|docker` (Default `host`) und optional `--image NAME`, außerdem `--grounding enforce|observe` (Default `enforce`) und `--guidance true|false` (Default `false`). `basic` korrigiert einen Fehler; `replan` blockiert zunächst und verlangt danach die Freigabe eines revidierten Plans; `parallel` bearbeitet zwei unabhängige Dateien mit zwei Lanes. Jedes wartende Gate wird mit dem jeweils aktuellen Digest fortgesetzt. Docker verwendet dieselbe Fixture ohne echte Provider, benötigt aber das lokale Image.

Das Beispiel erzeugt `de44237f3966/demo-source` mit einer fehlerhaften Addition und eigenen scripted Antworten. **Exit 3 ist am Plan-Gate erwartet**, kein Installationsfehler. Für Wiederholungen eine neue ID verwenden; bestehende Runverzeichnisse werden nicht überschrieben. `demo` impliziert Hostvertrauen ausschließlich für diese mitgelieferte Fixture, nicht für den Projektordner. Ein eingegebener Desktop-Demotext ersetzt ihre feste Aufgabe nicht.

Den Digest aus `pending.digest` übernehmen, Plan lesen, dann:

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline resume --run-dir "%ROOT%\.scratch\pipeline\lane-docs\runs2\de44237f3966" --gate plan --decision approve --digest ff554422a3552982f65266a863895e83251f891337f70865957d985860d6c6a3
```

Wieder exit 3, jetzt am Liefer-Gate. Den Diff prüfen, dann:

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline resume --run-dir "%ROOT%\.scratch\pipeline\lane-docs\runs2\de44237f3966" --gate delivery --decision approve --digest bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261
```

Exit 0; erst jetzt steht `a + b` im Demo-Quellordner. Diese Digests stammen vom unten protokollierten Lauf; bei anderen Aufgaben niemals blind wiederverwenden. `--decision reject` am Plan beendet als `rejected`; am Liefer-Gate bedeutet es „nur Patch behalten“, also `succeeded` ohne Quelländerung.

### Evidence-Demo: abgewiesen, repariert, trotzdem erfolgreich

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline demo --run-root "%ROOT%\.scratch\pipeline\evidence-docs" --scenario evidence --delivery apply
```

Das Szenario benötigt `enforce`: `--grounding observe` endet vor Runanlage mit Exit 2 (`invalid_demo_grounding`), die HTTP-API mit `demoScenario:"evidence"` und `grounding:"observe"` antwortet 400. Es verwendet scripted Antworten, keine echten Modelle:

1. Der Planner plant blind; Python verwirft den Plan mit `unseen_target`, liefert den Read und nimmt den reparierten Plan an. Am Plan-Gate (Exit 3) den aktuellen Digest prüfen und wie oben freigeben.
2. Der Implementer behauptet, das Symbol `add` fehle. Python widerlegt den Claim mit dem Treffer `calculator.py:1` (`false_absence`, Event `absence_refuted` mit `hits`), verwirft den Output und nimmt anschließend den korrigierten Edit an.
3. Der Unitcheck wechselt von rot zu grün: Kriterium `sum` wird `demonstrated`, `by:"baseline"`. Der schon vorher grüne Syntaxcheck ergibt für `syntax` nur `met_not_demonstrated`, `by:"none"`.
4. Das Liefer-Gate (Exit 3) trägt `criteria_not_demonstrated`, aber **nicht** `grounding_violations`: Beide Verstöße wurden unter `enforce` abgewiesen und repariert. Diff und Evidence prüfen und mit dem aktuellen Lieferdigest freigeben; danach `succeeded` (Exit 0).

Reale Messwerte des aufgezeichneten scripted R9-Laufs vom 10.11.2026, nicht in diesem Dokumentationspass neu ausgeführt: **answer 1.0, trajectory 0.3889, unadjusted 0.6944, violation rate 0.4, adjusted 0.25, tier `failing`, 5 outputs, violations `false_absence: 1`, `unseen_target: 1`**. Bei nur wenigen Modelloutputs pro Lauf verschiebt bereits ein einzelner verworfener Output das Tier (2 von 5 ergeben `failing`): Es beschreibt die Evidenzdisziplin der Modelle, nicht die fachliche Güte der gelieferten Änderung; unter `enforce` wurde jeder solche Output abgewiesen und repariert.

### Tatsächlich aufgezeichnete stdout-Zeilen

Ausführung dieses Dokumentationslaufs am 9. November 2026, drei getrennte Python-Prozesse, Exitcodes **3, 3, 0**. Historische Ausgabe vor Grounding/Guidance, den additiven Feldern für Neuplanung/Lanes und der erweiterten Sandboxbeschreibung; die Statusobjekte waren damals vollständig, für die Darstellung neu serialisiert (Werte unverändert); Zeiten und absolute Pfade sind Beispiele, keine stabilen Testwerte. Die Demo meldet je scripted Antwort 100 Input-/100 Outputtokens; das ist Fixtureusage, keine Modellmessung.

```json
{"schema":1,"run_id":"de44237f3966","status":"awaiting_approval","phase":"approve_plan","node":"approve_plan","task":"Fix addition so the unit test passes.","source_dir":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\demo-source","delivery_mode":"apply","progress":{"step_index":-1,"step_count":1,"step_title":"","attempt":0,"review_round":0},"pending":{"gate":"plan","digest":"ff554422a3552982f65266a863895e83251f891337f70865957d985860d6c6a3","risk_flags":["baseline_red"],"path":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\artifacts\\plan.json"},"failure":null,"resumable":true,"usage":{"calls":1,"input_tokens":100,"output_tokens":100,"estimated_cost":null},"checks":[{"id":"unit","kind":"test","status":"failed","required":true,"duration_s":0.1658995000034338,"output_tail":"======================================================================\r\nFAIL: test_add (test_calculator.Addition.test_add)\r\n----------------------------------------------------------------------\r\nTraceback (most recent call last):\r\n  File \"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\workspace\\test_calculator.py\", line 6, in test_add\r\n    self.assertEqual(add(2, 3), 5)\r\n    ~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^\r\nAssertionError: -1 != 5\r\n\r\n----------------------------------------------------------------------\r\nRan 1 test in 0.001s\r\n\r\nFAILED (failures=1)\r\n"}],"delivery":null,"artifacts":{"plan":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\artifacts\\plan.json","diff":null,"report_md":null,"report_json":null},"sandbox":{"mode":"host","isolated":false},"pid":null,"created_at":"2026-11-09T21:38:42.587522+00:00","updated_at":"2026-11-09T21:38:43.451544+00:00","engine_version":"0.1.0"}
{"schema":1,"run_id":"de44237f3966","status":"awaiting_approval","phase":"deliver","node":"approve_delivery","task":"Fix addition so the unit test passes.","source_dir":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\demo-source","delivery_mode":"apply","progress":{"step_index":0,"step_count":1,"step_title":"Correct addition","attempt":1,"review_round":0},"pending":{"gate":"delivery","digest":"bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261","files":[{"path":"calculator.py","action":"modify","added":1,"removed":1}],"path":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\candidate.diff"},"failure":null,"resumable":true,"usage":{"calls":3,"input_tokens":300,"output_tokens":300,"estimated_cost":null},"checks":[{"id":"unit","kind":"test","status":"passed","required":true,"duration_s":0.16686559999652673,"output_tail":""}],"delivery":{"applied":false,"diff_sha256":"bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261","files":1,"conflicts":[]},"artifacts":{"plan":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\artifacts\\plan.json","diff":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\candidate.diff","report_md":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\report.md","report_json":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\report.json"},"sandbox":{"mode":"host","isolated":false},"pid":null,"created_at":"2026-11-09T21:38:42.587522+00:00","updated_at":"2026-11-09T21:38:45.965206+00:00","engine_version":"0.1.0"}
{"schema":1,"run_id":"de44237f3966","status":"succeeded","phase":"done","node":"finalize","task":"Fix addition so the unit test passes.","source_dir":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\demo-source","delivery_mode":"apply","progress":{"step_index":0,"step_count":1,"step_title":"Correct addition","attempt":1,"review_round":0},"pending":null,"failure":null,"resumable":false,"usage":{"calls":3,"input_tokens":300,"output_tokens":300,"estimated_cost":null},"checks":[{"id":"unit","kind":"test","status":"passed","required":true,"duration_s":0.16686559999652673,"output_tail":""}],"delivery":{"applied":true,"diff_sha256":"bc6b90f72f1b97b14cb8696fef0f75747c7efea74ea78988be2e1ba331ce4261","files":1,"conflicts":[]},"artifacts":{"plan":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\artifacts\\plan.json","diff":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\candidate.diff","report_md":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\report.md","report_json":"C:\\Users\\pumas\\Documents\\Project_Scranton\\.scratch\\pipeline\\lane-docs\\runs2\\de44237f3966\\delivery\\report.json"},"sandbox":{"mode":"host","isolated":false},"pid":null,"created_at":"2026-11-09T21:38:42.587522+00:00","updated_at":"2026-11-09T21:38:47.550125+00:00","engine_version":"0.1.0"}
```

### Tatsächlich erzeugtes `report.md`

Historischer vollständiger englischer Markdownbericht desselben Laufs, ohne Modell generiert; aktuelle Berichte ergänzen Planrevisionen und Grounding mit Python-Kriterienentscheidung statt Reviewerbewertung aller Kriterien; Zeitwerte, Commit und lokale Pfade sind laufabhängig. `report.json` enthält dieselben redigierten Daten in Maschinenform. Die Baseline war absichtlich rot, der finale Check grün.

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
| `models.refiner` | Optional, gleiche `ModelConfig`; nur Offline-`evolve` benutzt diese Rolle, nicht normale Runs |
| `provider:openai_compatible` | Direkter LangChain-OpenAI-kompatibler Adapter, kein Agentenloop |
| `model` | Beim Endpunkt verfügbare Modell-ID: Vorlage `gpt-4.1` bzw. anzupassendes `local-model`; Verfügbarkeit nicht live geprüft |
| `base_url` | Lokal `http://127.0.0.1:1234/v1`; ohne Angabe `https://api.openai.com/v1`; HTTPS erforderlich außer Loopback, keine Credentials/Query/Fragmente |
| `api_key_env` | **Name** der Umgebungsvariablen `OPENAI_API_KEY` bzw. `LOCAL_MODEL_API_KEY`, nicht ihr Wert |
| `structured_output` | `json_schema` im OpenAI-Beispiel; `json_text` lokal mit Schema im Prompt und JSON-Extraktion; alternativ `function_calling` |
| `sandbox.mode` | `docker` oder bewusst freigegebener `host` |
| `sandbox.docker.image` | Optional; ohne Angabe bzw. bei `null` `scranton-pipeline-sandbox:<engine version>` (aktuell `0.1.0`); anderes lokales Image erlaubt, kein stilles Pull/Build |
| `sandbox.docker.tmpfs_mb` | `/tmp`-tmpfs in MiB, Default 512, Bereich 64..4096 |
| `limits.max_replans` | Neuplanungen für Restarbeit, Default 1, Bereich 0..3; 0 = aus; jede Revision braucht Freigabe |
| `execution.max_parallel_steps` | Gleichzeitig ausgewählte unabhängige Schritte, Default 1, Bereich 1..4; 1 = sequenziell |
| `execution.max_lane_workspace_bytes` | Grenze je vollständiger Lane-Workspacekopie, Default 536870912 Bytes (512 MiB), mindestens 1; Überschreitung/Links führen mit Warnung zum sequenziellen Pfad |
| `checks[].id` | Eindeutiges Rezeptlabel `tests`; für Checks/Setup gilt `config.py:COMMAND_ID_PATTERN` = `^[A-Za-z0-9_-]{1,64}$`, ebenso in Node/UI |
| `checks[].kind` | Ergebnis-Kategorie `test`; kein automatisch gewählter Befehl |
| `checks[].argv` | Betreiberargumentliste `python`, `-m`, `unittest`, `-q`; keine Shellsyntax/Expansion |
| `checks[].timeout_s` | 120 Sekunden in beiden Vorlagen |
| `approvals.plan` | `always`: menschliche Freigabe; alternativ `auto_low_risk` nur ohne Python-Risikoflag |

Die vorhandene Docker-Beispieldatei setzt noch ausdrücklich `scranton-sandbox:1.5.0`; vor Nutzung des neuen Pipelineimages `sandbox.docker.image` auf `scranton-pipeline-sandbox:0.1.0` ändern oder das Feld entfernen. Ein explizites altes Image wird nicht automatisch ersetzt.

Nicht gesetzte Werte stammen aus `config.py`: Sandbox `host` (keine OS-Isolation; direkte CLI-Läufe und Resume benötigen weiterhin `--trust-host`), Review an; Check `required:true`, `scope:"step"`, Netzwerk aus; Modelltemperatur 0, maximal 8192 Outputtokens, 180 Sekunden Deadline. Docker: 2 CPUs, 2048 MB, 256 PIDs, 512 MiB tmpfs. Das Standardimage enthält Python/pip/venv/pytest, Node.js/npm und Git; die Basisimages sind per Digest gepinnt. CLI-Liefermodus standardmäßig `patch`, Desktop standardmäßig `apply`. Kein verstecktes Setup oder automatische Installation von Projektabhängigkeiten. `detect` liefert neben `checks` auch `setup` als Vorschläge, nur aus Manifesten im Wurzelverzeichnis (ein `pyproject.toml` unter `engine/` oder `Cargo.toml` unter `src-tauri/` schlägt nichts vor): z. B. `npm ci` mit `network:true` bei `package-lock.json`, sofern npm auf dem Host auffindbar ist. Die Desktopform bietet dafür editierbare Setupzeilen; der Betreiber entscheidet über ihre Übernahme.

Weitere Operatorfelder: `setup` (bis 4 argv-Rezepte mit `id`, `timeout_s`, `network`), `checks` (bis 12, Kategorien `syntax|lint|typecheck|test|security|other`; `scope:final` erst beim letzten Schritt, bei abgeschlossener Waveintegration und Reviewrevisionen, Baseline führt alle aus), `allow_no_checks:true` für bewusst leere Checklisten. `review.enabled` schaltet Modellreview aus. `policy.protected_paths`/`write_protected_paths` ergänzen Defaults, `scope:strict` verbietet undeclarierte Dateien; Standard `plan_plus_flagged` erlaubt `max_undeclared_files:2`. `sandbox.env_passthrough` ergänzt die Allowlist, hebt das Credentialverbot nicht auf. `pricing` ordnet Modell-IDs `input_per_mtok`/`output_per_mtok` zu; Kosten sind Schätzungen, bei fehlendem Preis null. `limits` überschreibt begrenzte Defaults; vollständige Feld-/Grenzenliste ist `config.py:Limits`, Wirkung und Verdrahtungsgrenzen siehe Architektur.

### Grounding und experimentelle Guidance konfigurieren

Diese Abschnitte sind optional; weggelassen gelten folgende Defaults:

```json
{
  "grounding": {
    "mode": "enforce",
    "counterfactual": "auto",
    "test_globs": ["tests/**", "test/**", "**/test_*.py", "**/*_test.*", "**/*.test.*", "**/*.spec.*"],
    "weights": {"answer": 0.5, "trajectory": 0.5}
  },
  "procedure": {"enabled": false, "graph": null, "hops": 2, "max_bytes": 1500}
}
```

| Feld | Bedeutung / Grenzen |
|---|---|
| `grounding.mode` | `enforce` weist ungeerdete Outputs über das vorhandene `max_output_repairs`-Budget ab; `observe` protokolliert/bewertet nur. Schema-, Pfad-, Check- und Budgetregeln bleiben aktiv. |
| `grounding.counterfactual` | `auto` verlangt in derselben privaten Kopie zuerst bestandene zugeordnete Testchecks mit der Änderung, dann einen Fehlcheck mit restaurierten Nichttestdateien; fehlschlagende Kontrolle → `inconclusive`. `off` deaktiviert die Probe. Nur `kind:test`, geänderte Test- und Nichttestdateien; auch ein Importfehler ohne neu hinzugefügten Code zählt als Fehlschlag. |
| `grounding.test_globs` | Höchstens 100 Muster zur Zuordnung der geänderten Testdateien; Defaults oben. |
| `grounding.weights` | `answer`, `trajectory` jeweils endlich 0..1, Summe 1; Details der vierstelligen Bewertung in der Architektur. |
| `procedure.enabled` | Default false; nur beratender Prompttext, keine neuen Tools oder Kanten. Der Paketdefault ist ein unvalidierter handgeschriebener Prior. |
| `procedure.graph` | Dateipfad oder `null` für den Paketdefault; bei Aktivierung vor Start validiert, nach `artifacts/procedure.json` kopiert und in `run.json.procedure` per Name/Digest gepinnt. Resume verwendet diese Kopie, nicht eine geänderte externe Datei. |
| `procedure.hops` | 0..2 ausgehende Nachbarschaftsschritte. |
| `procedure.max_bytes` | Eigene UTF-8-Zulage zusätzlich zu `limits.max_prompt_bytes`, 1..2000000; Default 1500. Auch der abschließende Gateway-Cap berücksichtigt die tatsächlich gerenderten Guidancebytes dieses Prompts innerhalb dieser Zulage; Evidenz und Abschlussdelimiter bleiben erhalten. |

Bei aktivierter Guidance muss der Graph das [Graphschema und die Validierungsregeln](docs/ARCHITECTURE.md#format-validierung-und-lokalisierung) erfüllen; ungültiger Graph → Exit 2. `models.refiner` ist optional und wird nur für `evolve --models config` benötigt; Modell-/Provider-/Timeoutfelder entsprechen den übrigen Rollen. Mit scripted Evolution kommt der Refiner aus `refiner.json` im Pack.

### Outputfelder der Modelle

- `Criterion.checks: list[Short]` (Default `[]`, höchstens 12): bei `verified_by:"checks"` konfigurierte Check-IDs, leer = alle Pflichtchecks. Python entscheidet diese Kriterien am aktuellen Commit und zeigt sie dem Reviewer mit State, Check-IDs und K-IDs als entschiedene Fakten; der Reviewer bewertet genau die `verified_by:"review"`-Kriterien, nicht jedes Kriterium. Ein `approve` trotz eigener `not_met`-Assessments oder eigener `blocking`-Findings ist ungültig und nutzt die begrenzte Outputreparatur. Nur ein ansonsten konsistentes `approve` trotz eines durch Python als nicht erfüllt entschiedenen Checkkriteriums wird zu `request_changes` mit Python-Finding (Kriterium, fehlgeschlagener Check, Outputtail), im normalen Revisionspfad bis `max_review_rounds`, nicht als ungültiger Output.
- `CriterionAssessment.citations` und `Finding.citations` (Default `[]`, höchstens 100): IDs im Format `^[EKH]-[0-9a-f]{10}$`. Für `met` bei Reviewkriterien und für `major`-/`blocking`-Findings ist mindestens eine H-/K-ID aus genau dem aktuellen Prompt erforderlich. Jeder Findingpfad muss eine geänderte Datei benennen. Eine verfügbare ID beweist nicht automatisch die inhaltliche Stützung.
- `ImplementerTurn.blocked_claim` (Default null), neben `blocked_reason`: `{"kind":"missing_file"|"missing_symbol","subject":"...","paths":[]}`. `paths` schränkt die policy-lesbare Suche per Globs ein. Globs und `missing_file`-Subjects werden normalisiert (Slashes, führendes `./`, case-insensitiver Vergleich); ungültige Pfade gehen in die normale Outputreparatur. `missing_file` vergleicht nur Namen, liest keine Inhalte und erkennt auch vorhandene Verzeichnisse als Treffer; Nichttextdateien sind nur von der Symbol-Inhaltssuche ausgeschlossen. Geschützte Pfade liegen außerhalb des Suchraums: Verifiziert wird nur „not found in the files models may read“. Eine Suche mit null erfassten Dateien bleibt `unverifiable`. Erstmals widerlegtes `blocked` wird unter `enforce` repariert; wiederholtes Blockieren folgt dem vorhandenen Neuplanungs-/Fehlerpfad. Ohne Claim bleibt die Abwesenheit `unverifiable`.
- `Plan.absent` (Default `[]`, höchstens 100) enthält dieselben Abwesenheitsclaims; widerlegte Aussagen zählen als `false_absence`. Vor `modify`/`delete` müssen Plannerziele und Implementeredits tatsächlich gelesene, im finalen Prompt erhaltene Dateien verwenden; vollständiges Überschreiben (`modify` mit `content`) verlangt immer einen aktuellen, ungekürzten Vollread, sonst `unseen_edit` mit dem Hinweis auf `replacements`. Für `replacements` und `delete` genügt ein aktueller, wenigstens teilweise gezeigter Read. Erfolgreiche gespeicherte Reads werden nur bei geändertem Dateihash erneut gelesen, jeweils mit eigenem Itembudget; Such-/Listrequests und fehlgeschlagene Reads werden erneut erfüllt. Reparaturreads und Reads für Reviewrevisionen sind Pythons Aufgabe: Die Ausnahme für nicht vollständig lieferbare Python-Reads gilt bei Edits nur für `replacements` und `delete` mit wenigstens teilweise gezeigter aktueller Datei, niemals für vollständiges Überschreiben oder ganz fehlende Reads. `unverifiable_target` protokolliert die nicht vollständig verfügbaren Python-Reads. Modellangeforderte Reads werden bei Budgetkürzung vor Python-eigenen entfernt; deren Herkunft bleibt bei Deduplizierung erhalten.

### CLI und Exitcodes

| Kommando | Zweck |
|---|---|
| `run --source ... (--task ... \| --task-file ...) --config ... --run-root ...` | Neuer Lauf; optional `--workspace-root`, `--run-id`, `--delivery patch\|apply`, `--trust-host` |
| `resume --run-dir ...` | Suspendierten Lauf fortsetzen; bei Gate zusätzlich `--gate`, `--decision`, `--digest`, optional `--comment` |
| `status --run-dir ...` | Status lesen; toten Owner mit `running` nach `suspended` normalisieren |
| `cancel --run-dir ...` | Sentinel setzen; ohne aktiven Owner selbst ohne Modelle zum Abbruchabschluss fortsetzen |
| `detect --source ...` | `{git,languages,checks,setup}` mit festen, auf dem Host auffindbaren Rezepten; Vorschläge werden nicht automatisch ausgeführt und beweisen keine Toolverfügbarkeit im Dockerimage |
| `graph --format mermaid` | Aus kompiliertem Graphen erzeugte Mermaid-Ausgabe |
| `demo --run-root ... [--scenario basic\|replan\|parallel\|evidence] [--sandbox host\|docker] [--image NAME] [--grounding enforce\|observe] [--guidance true\|false]` | Eigene Fixture/scripted Modelle; optional `--workspace-root`, `--run-id`, `--delivery patch\|apply`, `--parent-guard`; Defaults `basic`/`host`/`enforce`/`false`, normale Gates |
| `score --run-dir DIR` | Groundingscore aus dem Trace neu berechnen, eine JSON-Zeile; Exit 0, ungültige Eingabe 2 |
| `eval --pack DIR\|core [--config FILE] [--graph FILE\|default\|skeleton] [--tasks a,b] [--split train\|val\|all] [--models scripted\|config] [--out DIR] [--real-calls] [--trust-host]` | Judge-freie Regression; Defaults `all`, `scripted`, `eval-output`, ohne Graph Guidance aus; Exit 0 bei passenden Erwartungen, 4 bei Abweichung, 2 bei ungültiger Eingabe |
| `evolve --pack DIR\|core --graph FILE\|default\|skeleton --out DIR [--rounds K] [--max-seconds N] [--config FILE] [--models scripted\|config] [--real-calls] [--trust-host]` | Offline-Guidanceverfeinerung; Defaults 3 Runden (1..20), 3600 Sekunden (positiv/endlich), `scripted`; Exit 0 auch bei verworfenen Kandidaten, 2 bei ungültiger Eingabe |
| `sandbox check [--image NAME]` | JSON `{docker:{available,version,reason},image:{name,present},default_image}`; auch fehlendes Docker/Image ist ein beantworteter Probe, Exit 0 |
| `sandbox build [--image NAME]` | Paketierten Dockerfile bauen; nur `scranton-pipeline-sandbox:<tag>`; Buildlogs stderr, eine JSON-Zeile `{built,image,reason}` stdout; Exit 0 oder 5 |
| `version` | Engine-/Python-/LangGraph-Version als JSON |

`--parent-guard` bei run/demo/resume/cancel ist für Supervisoren: stdin bleibt offen; EOF oder `stop` fordert Suspend an. Interaktives `resume` nicht unnötig damit starten. stdout liefert pro erfolgreicher Statusoperation genau eine JSON-Zeile; `graph` liefert Text, argparse-Hilfe ist ebenfalls keine Statuszeile. Diagnosen gehen nach stderr.

| Exit | Bedeutung |
|---|---|
| 0 | Erfolg; Detect-/Graph-/Version-/Scoreabfrage, beantwortetes `sandbox check`, erfolgreicher `sandbox build`; auch Patch-only-Abschluss, passende Eval-Erwartungen oder abgeschlossenes `evolve` (nicht zwingend eine Verbesserung) |
| 2 | Ungültige Eingabe/Konfiguration, aktiver Owner, veralteter Digest oder unzugängliche Eingabedateien |
| 3 | `awaiting_approval`, Gateentscheidung erforderlich |
| 4 | `failed`, terminaler Laufbericht; bei `eval` mindestens eine Erwartungsabweichung |
| 5 | Suspendierter Lauf, fehlgeschlagener/zeitüberschrittener `sandbox build` oder unerwarteter CLI-Infrastrukturfehler; JSONstatus und Dateien prüfen |
| 6 | `rejected` oder `cancelled` |

Eine erfolgreiche `status`-Abfrage verwendet den Exitcode des gemeldeten Laufstatus, nicht zwingend 0. Ein Live-Cancel kann noch `running` melden; bis zum tatsächlichen Abschluss weiter abfragen. Terminales Resume ohne Gate liefert den vorhandenen Status, startet keinen neuen Lauf.

## Laufverzeichnis und Wiederaufnahme

`<run-root>/<run-id>` wird exklusiv angelegt (`[a-z0-9]{8,32}`, sonst zufällige 12 Hexzeichen). Dort: `run.json`, `config.json`, `status.json`, `events.jsonl`, `usage.jsonl`, `evidence.jsonl`, `grounding.jsonl`, `checkpoints.sqlite`, `git/` (private Gitmetadaten außerhalb des Workspace), `git-hooks/` (leerer engine-eigener Hookordner), `lock`, bei Cancel `cancel.requested`; `artifacts/{plan.json,plan-r<rev>.json,wave-<n>.json,repo_index.json,source_manifest.json,review-<n>.json,grounding.json,procedure.json,logs/}` und `delivery/{candidate.diff,report.md,report.json,apply-journal.json,backups/}`. Fehl-/Abbruchabschluss erzeugt `partial.diff`. Workspace standardmäßig `workspace/`, bei `--workspace-root W` stattdessen `W/<run-id>`. Demo ergänzt `demo-source/` und scripted Antwortdateien. `tmp/provider/call-*/` enthält nur während eines Command-Modellaufrufs Request/Response und gegebenenfalls Bridge-Promptdateien; danach Cleanup. `RunStatus.checks[*].output_tail` liefert nach Redaktion maximal 4096 Zeichen bei nicht bestandenen Checks, sonst `""`; Status-Schritt/Versuch bezieht sich auch am Liefer-Gate auf den letzten tatsächlichen Planschritt.

`evidence.jsonl` enthält IDs und Locator-/Hashmetadaten ohne Inhalt. `grounding.jsonl` beginnt einmal bei Anlage mit `settings {mode,weights}`, danach folgen ausgewertete `output`- und Kriterien-/Probezeilen; verworfene Outputs bleiben erhalten. `artifacts/grounding.json` ist der identitätsgebundene Receipt; `artifacts/procedure.json` entsteht nur bei aktivierter Guidance. `score` liest nur den Groundingtrace, nicht erneut Workspace oder Modelle; die erste `settings`-Zeile liefert Modus und Gewichte, eine Konfigurationsdatei ist dafür nicht nötig.

Konfigurationskopie/Digest, Gateartefakte, Manifest und Checkpoints nicht manuell ändern. Status `suspended` bedeutet, dass der nächste noch nicht abgeschlossene Knoten erneut laufen kann. Das `warning`-Event mit Code `suspended` und stderr nennen Exceptiontyp, redigierte Nachricht mit laufrelativem Pfad (externe Pfade maskiert), `errno`/`winerror` und den innersten Engineframe (`Modul:Funktion`). Atomare Dateiersetzungen warten bei Windows-`PermissionError` mit WinError 5/32/33 höchstens 40-mal je 50 ms (2 Sekunden Wartezeit, maximal 41 Versuche); bleibt der Fehler bestehen, wird die ursprüngliche Exception weitergereicht. Die privaten Dateien und Logs sichern, bevor man defekte Läufe untersucht; niemals die Owner-Sperre eines aktiven Prozesses löschen. Quellkonflikte nicht mit blindem Resume „lösen“: sie sind terminal; Konflikt bewusst lösen und einen frischen Lauf starten. Bereits abgeschlossene Lanes werden bei Crash/Resume nicht erneut ausgeführt; unvollständige innere Knoten können wiederholt werden. Der Merge verwendet einen dauerhaften Wave-Receipt und entfernt anschließend die Laneverzeichnisse. Ein erneuter Provideraufruf ist nicht Exactly-once gegenüber dem Modellservice.

### Status, Events und Sandboxbetrieb

Schema bleibt 1. `status.grounding` enthält `mode`, `answer`, `trajectory`, `unadjusted`, `violation_rate`, `adjusted`, `tier`, `outputs`, `violations` (Zahlen je Art), `criteria:[{id,verified_by,state,by,checks}]`, `probe:{status,checks?}`. Das Objekt existiert schon ohne Output mit `outputs:0`, `criteria:[]`; Kriterien sind erst nach `ground` entschieden. States: `demonstrated`, `met_not_demonstrated`, `attested`, `not_met`, `unclear`, `undecided`; `by:baseline|probe|review|none`; Probe `not_needed|demonstrated|not_demonstrated|inconclusive|off`. Scores sind vierstellig gerundet; ein gleicher Trace ergibt denselben Score, und `score` muss für abgeschlossene Läufe mit `status.grounding` übereinstimmen.

`pending.grounding` am Liefer-Gate enthält dieselbe Zusammenfassung; `pending.risk_flags` nennt `criteria_not_demonstrated` bei einem weiterhin `met_not_demonstrated`-Kriterium und `grounding_violations` nur bei angenommenem Output mit Verstoß. Repariert verworfene Antworten senken den Score und bleiben in den Verstoßzahlen, lösen aber dieses zweite Flag nicht aus; unter `enforce` bleibt es aus, unter `observe` kennzeichnet es angenommene Verstöße. Der Liefer-Digest bindet jetzt Diffhash, Grounding und Flags; `delivery.diff_sha256` bleibt der reine Diffhash. `ground` ist ein zusätzlicher fester Pythonknoten in Phase `review` vor `package`. Berichte ergänzen `grounding` bzw. **Grounding** mit Score, Verstoßarten, Kriterien/Entscheidungsmethode und Probe.

`status.procedure` ist `{enabled,name,digest,situation}`; deaktiviert `{enabled:false,name:null,digest:null,situation:null}`. Der Digest identifiziert die gepinnte Graphkopie, `situation` die letzte durable Lokalisierung, nicht einen neuen Ausführungsknoten.

| Neues Event | `data` |
|---|---|
| `grounding` | `role,scope,accepted,violations:[kind],cited,shown`, optional `lane`; die letzten zwei Felder sind Anzahlen |
| `absence_verified` | `kind,subject,files_searched,meaning`; `meaning:"not found in the files models may read"` |
| `absence_refuted` | `kind,subject,hits:[{path,line}]`; Treffer widerlegen den Claim |
| `criteria_decided` | `states:{state:n}` |
| `probe_finished` | `status,checks:[id]` |
| `procedure` | `role,scope,situation,matched`, optional `lane` |


Tracezeilen und `grounding`-/`procedure`-Events verwenden `plan:r<revision>` für den Planner, `review:<round>` für den Reviewer und `step:<id>`, `rev:<round>` bzw. `int:<wave>` für den Implementer.

`RunStatus.progress` ergänzt `plan_revision` (0 = ursprünglicher Plan), `replans_left`, `steps_done` und `lanes:[{step_id,title,state,attempt}]`. Die Laneliste ist außerhalb einer Wave leer; sichtbare Zustände sind `running`, `passed`, `failed`, `merged` (bei Abbruch auch `cancelled`). Das Plan-Gate ergänzt `pending.revision` und `pending.replan_reason`; `replan` ist ein zwingendes Risikoflag. Berichte enthalten `plan_revisions` und `waves`. Neue Events: `replan_requested {code,message,scope}`, `replanned {revision}`, `wave_started {wave,steps}`, `lane_started {lane}`, `lane_finished {lane,status}`, `wave_merged {wave,merged,failed}`; Lanezuordnung steht in `data.lane`. Routegründe ergänzen `replan_requested`, `replanned`, `parallel_wave`, `wave_merged`, `integration_failed`.

`sandbox` im Status enthält `mode`, `isolated`, `image`, `isolation`, `setup_network`. Dockerchecks laufen ohne Netz, als UID 10001, mit read-only Root und begrenztem tmpfs/Ressourcen. Der Workspace bleibt schreibbar. Der Installationszustand liegt einmal pro Lauf im von der Engine angelegten `<run-dir>/sandbox-state` außerhalb des Workspace; nur dieses Verzeichnis wird nach `/workspace/.pipeline` gemountet: read-write für Setup, read-only für Checks und alle Lanes, die denselben Laufzustand verwenden. Der Mountpunkt im schreibbaren Workspace bleibt geschützt, git-ausgeschlossen und aus Snapshot, Diff, Modellkontext und Modelledits ausgeschlossen. Userinstallationen nutzen `.pipeline/python` bzw. `.pipeline/npm`; ignorierte Setupausgaben bleiben zwischen Versuchen bestehen. Setup mit `network:true` darf über Bridge Internet und Hostdienste (`host.docker.internal`, auch die lokale Control-API) erreichen. Ein Control-API-Token ist ein offener Folgepunkt. Docker teilt den VM-Kernel, Hostmodus bietet keine OS-Isolation; Redaktion bleibt Best effort. Details: [Architektur](docs/ARCHITECTURE.md#docker-sandbox).

Docker Desktop mit Linux-Engine zuerst selbst starten. Dann in derselben cmd-Sitzung:

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline sandbox check
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline sandbox build
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline demo --run-root "%ROOT%\.scratch\pipeline\lane-docs\docker-runs" --scenario parallel --sandbox docker --delivery apply
```

Der bewusste Build braucht Netzwerk für Basisimages/Pakete und erzeugte lokal rund 530 MiB Imagegröße (keine feste Downloadgröße). Er überschreibt keine fremden Imagetags: nur `scranton-pipeline-sandbox:<tag>` ist als Buildziel erlaubt; `sandbox check`/Run dürfen auch andere lokale Images prüfen/verwenden. Containers laufen mit `--log-driver none`, Run-/Deadline-Labels; abgelaufene gelabelte Reste werden beim Start von run/resume/demo bzw. sandbox check Best effort entfernt, eigene Runcontainer zusätzlich im Lebenszyklus. Kein pauschales Docker-Prune.

## Prüfungen und Qualitätsgates

Aus `engine\`, TEMP wie oben setzen. Alle neuen temporären Dateien/Caches bleiben unter `.scratch/pipeline/`; Tests benutzen nicht den echten Hive. Die eigene Projekt-Testumgebung nicht als Quellprojekt eines Modelllaufs verwenden.

```cmd
..\.scratch\pipeline\venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider --basetemp ../.scratch/pipeline/lane-docs/pytest
..\.scratch\pipeline\venv\Scripts\python.exe -m ruff check src tests --cache-dir ../.scratch/pipeline/lane-docs/ruff
..\.scratch\pipeline\venv\Scripts\python.exe -m mypy src --cache-dir ../.scratch/pipeline/lane-docs/mypy
```

Nacheinander ausführen, nicht konkurrierend mit anderen Vollsuiten. `-p no:cacheprovider` vermeidet pytest-Cacheprobleme bei `..`-Pfaden. Ein kurzer Gate-/Graphnachweis ist `-m pytest tests/flow/test_graph.py -q -p no:cacheprovider --basetemp ../.scratch/pipeline/lane-docs/pytest-graph`. Die Demo oben prüft die zwei tatsächlichen CLI-Gates in getrennten Prozessen. Tests verwenden scripted Modelle, lokale scripted Completionprozesse bzw. Offline-HTTP-Mocks; echte Provider werden in diesen automatisierten Tests nicht aufgerufen. Der separat durchgeführte reale Lauf ist unten beschrieben. Die Liveprüfungen unter `tests/docker/` laufen nur mit `SCRANTON_PIPELINE_DOCKER_TEST=1` gegen das bereits gebaute `scranton-pipeline-sandbox:0.1.0`; sie bauen/pullen kein Image. Sie prüfen Rootfs/User/Netz, Workspace und lokale Installationen über Befehlsgrenzen, Timeout/Cleanup sowie scripted Dockerdemos durch die Gates einschließlich paralleler Lanes. Nach dem bewussten Build:

```cmd
set "SCRANTON_PIPELINE_DOCKER_TEST=1"
..\.scratch\pipeline\venv\Scripts\python.exe -m pytest tests/docker -q -p no:cacheprovider --basetemp ../.scratch/pipeline/lane-docs/pytest-docker
set "SCRANTON_PIPELINE_DOCKER_TEST="
```

Die Implementierungsnachweise vom 10.11.2026 dokumentieren erfolgreiche lokale Dockerprüfungen; in diesem Dokumentationspass nicht neu ausgeführt, keine umfassende Sandbox-Zertifizierung. Neuplanung und parallele Modellarbeit wurden scripted geprüft, nicht mit echten Modellen; der frühere reale Einzellauf unten war sequenziell.

Historischer Gesamtprüfstand **2026-11-09 abends** aus den abgeschlossenen Codegates, keine hier erneut ausgeführte Vollsuite: Engine **272 bestanden, 1 Skip** (Opt-in-Docker), Ruff sauber, mypy strict sauber auf **33 Quelldateien**; Node Server **128**, Core **415 bestanden + 1 Skip**, Visualizer **400**, Packaging **6**. Die Engine meldete 13 LangSmith-Deprecationwarnungen zu `asyncio.iscoroutinefunction`. Der neue Dokumentationslauf belegt separat die Demo mit **3 → 3 → 0** und den oben wiedergegebenen Markdownbericht.

**Historisch, vor dem Runtimewechsel:** Erster echter Modelllauf mit Grounding (10.11.2026, `enforce`, `gpt-6.1-sol` über pi): in der Planung gescheitert (`output_invalid`), weil eine projektweite Suche oder Liste (leerer Pfad) fälschlich als `protected_request` abgelehnt wurde; behoben (ein leerer Pfad ist für `list` und `search` gültig, Pfade werden einmal normalisiert, die Rückmeldung nennt die betroffene Anfrage). Mit einem echten Modell seither nicht wiederholt.

Aktueller Engine-Prüfstand vom **10.11.2026**, gemessen nach dieser Korrektur: **949 bestanden, 12 übersprungen**. Der Stand davor, nach den Paket-Korrekturen am eingebauten Eval-Pack: **910 bestanden, 12 übersprungen** (11 Opt-in-Dockertests, 1 Symlinktest mit erforderlichem Windows-Privileg); Ruff und mypy strict ohne Befund. Der Stand nach R9 davor: 894 bestanden, 12 übersprungen. Das eingebaute Pack läuft auch mit dem ausgelieferten Interpreter der Desktop-App (`eval --pack core`: 9 von 9 Erwartungen, identische Scores).

### Regression ohne Judge ausführen

Vom Projektroot, nach der oben beschriebenen TEMP-/Cachekonfiguration, mit einem neuen oder leeren Outputordner:

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline eval --pack core --out "%ROOT%\.scratch\pipeline\eval-docs-01"
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline score --run-dir PFAD_ZUM_ABGESCHLOSSENEN_RUN
```

`core` enthält neun scripted Tasks mit festgeschriebenen Scores, einschließlich widerlegter Abwesenheit, ungelesener Ziele/Edits, ungültiger Citations, unbelegtem Assessment, bereits grünen Tests, erfolgreicher Gegenprobe und verstecktem fachlichem Fehler. [Tasktabelle und Packformat](docs/ARCHITECTURE.md#judge-freie-eval-suite). Exit 0 bedeutet **Erwartungen** erfüllt, nicht jeder Task fachlich richtig: `hidden_failure` hat absichtlich `answer:0`. stdout enthält nur den deterministischen scored Teil; `eval.json` zusätzlich `meta` mit Laufpfaden, Zeiten und Hidden-Checkdiagnosen. Nichtleere Outputs und Überschneidung mit dem Pack werden verweigert.

Eigene Packs mit Hostrezepten benötigen `--trust-host`. `--models config` verlangt `--config`; nicht-scripted Rollen außerdem ausdrücklich `--real-calls` (bei Evolution einschließlich Refiner). Das kann kostenpflichtige Aufrufe starten und gehört nicht zum automatischen Regressiongate. Scripted Determinismus misst die Harnessmechanik, nicht die Qualität echter Modelle; mit echten Modellen wird keine Reproduzierbarkeit versprochen.

### Einen Guidancegraphen entwickeln und bewusst aktivieren

1. Scripted Offline-Evolution starten (keine Aktivierung, kein Modellnetzwerk):

   ```cmd
   "%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline evolve --pack core --graph skeleton --out "%ROOT%\.scratch\pipeline\evolve-docs-01" --rounds 3 --max-seconds 3600
   ```

2. `evolution.jsonl` und `rejected.jsonl` lesen. Nach anfänglichem `val`-Rollout folgen `train`-Traces, Refiner-Editset und für gültige Kandidaten `val`. Angenommen wird nur bei nicht kleinerem mittlerem `adjusted` (Gleichstand erlaubt); ungültige oder schlechtere Kandidaten bleiben vollständig mit Grund, Scores, Edit, Kandidat/Digest und Diagnose in `rejected.jsonl` und `evolution.jsonl`. Nur die Kopie im Refinerprompt wird auf höchstens 2048 Bytes je Ablehnungszeile kompaktiert. Der Refiner sieht dabei auch Validierungsscores abgelehnter Kandidaten; viele Runden können den `val`-Split überanpassen. `best.json` ist der letzte angenommene Stand, `graph-r<K>.json` hält angenommene Runden. `usage.jsonl`, Events und private Rollouts liegen ebenfalls unter dem Outputordner. Das Zeitbudget ist kooperativ, keine harte Unterbrechung beliebiger Python-I/O.
3. `best.json` prüfen, separat evaluieren, etwa `eval --pack core --graph PFAD_ZU_best.json --out NEUER_LEERER_ORDNER`. Bei scripted Modellen erzielt jeder gültige Kandidat Gleichstand und wird angenommen, sofern das Zeitbudget reicht: Das demonstriert den Mechanismus, keine Verbesserung.
4. Erst für einen **neuen** Run die eigene Konfiguration um `"procedure":{"enabled":true,"graph":"C:/Pfad/best.json","hops":2,"max_bytes":1500}` ergänzen (Beispielpfad ersetzen). `run --config ...` lädt und pinnt den Graphen. Ein bestehender Run verwendet beim Resume unverändert seine Laufkopie. Die Desktopform bietet nur das experimentelle Paketdefault-Opt-in, keinen Graphdateieditor.

Grounding, Guidance und Evolution sind bislang ausschließlich mit scripted Modellen geprüft; kein reales Modell hat damit gearbeitet. Ob Guidance hilft, ist ungemessen. Die gültige Citation belegt Verfügbarkeit, nicht Stützung einer Aussage; Abwesenheit ist nur im policy-lesbaren Suchraum verifiziert und die Gegenprobe deckt nur Kriterien mit Testchecks ab. Der historische reale Bridgelauf unten ist kein Nachweis dieser Erweiterungen.

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
| `command` | `command` als argv-Liste (bis 32 nichtleere Argumente), nur `json_text`, kein `script_path`. Pro Aufruf werden absolute Request-/Responsepfade angehängt. | Lokale scripted Testprozesse automatisiert; ein separater realer Lauf ist unten dokumentiert. |

Commandprotokoll v1: Request `{"v":1,"role":"planner","model":"MODEL_ID","system":"...","user":"...","max_output_tokens":8192,"temperature":0}`; Response `{"text":"<JSON-Modellantwort als String>","usage":{"input_tokens":10,"output_tokens":20}}`. `usage:null` erlaubt Schätzung. Die Scranton-Bridge liefert bei ausschließlich Nullusage `null`; Input umfasst `input + cacheRead + cacheWrite` (ohne erneute Addition des Teilwerts `cacheWrite1h`). Parent-EOF/Stop während des Aufrufs → `suspended` (Exit 5), nach Cleanup wiederaufnehmbar. Exit 75 oder Prozessdeadline → transienter Retry; anderer Exit, fehlende/ungültige Response → `provider_rejected`. Promptdateien liegen nur während des Aufrufs unter `<run-dir>/tmp/provider/call-*/` und werden danach entfernt. Der Befehl erhält die Engineumgebung ohne `SCRANTON_PIPELINE_KEY_*`; er ist eine vertrauenswürdige Hostintegration, kein untrusted Check.

Die Host-Bridge `tools/pipeline-complete.js --provider P --model M [--thinking T] <request.json> <response.json>` verwendet Scrantons eigene LLM-Clients und Credentialstore für eine Completion mit `tools:[]`, ohne Agentensession. Der Supervisor meldet `via:"bridge"` und konfiguriert `provider:"command"`. Kompatible API-Key-Konten können weiterhin `via:"direct"` verwenden. Modellaufrufe laufen auf dem Host, unabhängig von der Pipeline-Check-Sandbox. Automatisierte Tests nutzen lokale/scripted Provider; historische Pi-Smokes sind kein Nachweis des neuen Transports.

## Historischer Pi-Bridge-Lauf (kein Nachweis der eigenen Bridge)

**Historisch, vor dem Runtimewechsel:** Ein echter Lauf wurde am **2026-11-09 um 22:37** über die Desktop-HTTP-API auf dem Drei-Dateien-Projekt `.scratch/pipeline/real-smoke/project` ausgeführt: alle drei Rollen `openai/gpt-6.1-sol` **via pi**, ChatGPT-Subscription des Benutzers, Trusted-Host-Sandbox. Planner: 2 Aufrufe (ein Kontextzug), Implementer: 1, Reviewer: 1; pi meldete **7647 Input-/601 Outputtokens**. Baselinecheck rot, finaler Check grün, Ein-Zeilen-Diff; die Quelldatei änderte sich erst nach Lieferfreigabe; Abschluss **`succeeded`**. Dieser eine Lauf belegt **nicht** andere Provider, größere Repositories, Reparatur-/Revisionsschleifen mit echten Modellen oder Dockerbetrieb mit echten Modellen.

## Conversation-Modus (opt-in)

`EngineConfig.conversation` ist ein striktes Boolean am Konfigurationsroot, Default **false**. Aktivierung: `{"conversation":true,...}` in der Operator-Konfiguration oder `run --conversation` zusätzlich zu den bisherigen Argumenten. Die CLI-Option aktiviert denselben Schalter; `resume` verwendet ausschließlich die gepinnte Konfigurationskopie. Ohne Aktivierung bleiben Plannerprompt/-schema, Events, Statusfelder und Dateimenge unverändert; `answer` ist dann kein gültiger Plannerturn. Auch die Core-Evals bleiben standardmäßig im bisherigen Modus.

```cmd
"%ROOT%\.scratch\pipeline\venv\Scripts\python.exe" -m scranton_pipeline demo --run-root "%ROOT%\.scratch\pipeline\chat\demo" --scenario answer --conversation
```

`answer` liest `calculator.py` und beantwortet die Frage nach `add(a,b)`, ohne Plan-/Liefer-Gate oder Edits (Exit 0, `succeeded`, `delivery:null`). Ohne `--conversation` wird dieses neue Szenario vor Runanlage mit Exit 2 (`conversation_required`) verweigert. Auch `basic|replan|parallel|evidence` lassen sich mit `--conversation` starten; ihre normalen Freigaben bleiben bestehen.

Aktiviert emittiert nur ein nach semantischer Validierung und Grounding angenommener Rollenoutput ein `agent_message` in `events.jsonl`: `data:{role,text,context,final:true,truncated:boolean}`. Grundlage sind Planzusammenfassung/Kontextrationale, Implementerzusammenfassung/Blockadegrund und Reviewzusammenfassung, niemals Rohcompletion oder Editinhalt. Redaktion erfolgt vor dem 16.000-Zeichen-Cap; leere Texte werden unterdrückt. Abgewiesene Outputs erscheinen nur in bestehenden Validierungs-/Groundingereignissen; Python-Reparaturfeedback ist keine Rollenmessage. Lanes behalten `data.lane`. Es gibt **kein** `messages.jsonl`.

Der Planner kann `kind:"answer",answer:{text,citations:[],summary:""}` liefern. `text` hat das bisherige Textbudget (32.768 Zeichen, nicht leer), `summary` höchstens 1.024, `citations` höchstens 100 E-/K-/H-IDs. Vorherige begrenzte Kontextzüge sind erlaubt. Jede Citation muss im tatsächlich gezeigten Prompt vorkommen: `enforce` repariert innerhalb von `max_output_repairs`, `observe` zeichnet Verstöße nur auf. Der Router geht mit Grund `direct_answer` direkt nach `finalize`; alle nachgelagerten Gates, Schreib-, Verifikations-, Review-, Groundingabschluss- und Lieferknoten entfallen. Snapshot, Setup und Baseline **vor** der Planung bleiben bestehen; Betreiberrezepte und Trusted host sind deshalb weiterhin eine Vertrauensentscheidung, keine allgemeine read-only Sandbox.

Jeder terminale Run bekommt ohne weiteren Modellaufruf eine Antwort mit exakt `{from:"pipeline",kind:"answer"|"result",text,citations:[],truncated:boolean}`: in `status.json.reply`, `delivery/reply.json` und als `run_reply` direkt vor `run_finished`. Erfolgreiche direkte Antworten verwenden Plannertext/Citations; sonst beschreibt `result` deterministisch Outcome, Grund bei Fehler/Ablehnung/Abbruch, Schritte, Dateien, finale Checks, Review und Lieferung. Antworttext maximal 16.000 Zeichen nach Redaktion. `running`, `awaiting_approval` und `suspended` erhalten noch keine Antwort. Vor terminalem Status werden ein interner Abschlussreceipt (`delivery/final-status.json`), die Replydatei und die beiden Abschlussereignisse geschrieben. Resume und wiederholtes Finalisieren ergänzen fehlende Kopien aus Receipt/Event, ohne ein zweites `run_reply` zu emittieren. Andere Rollen-/Nodeereignisse können bei Replay weiterhin wiederholt werden; keine globale Exactly-once-Zusage. Multi-Run-Historie wird nicht automatisch als Promptkontext importiert.

Die Node-/UI-Anbindung dieses Schalters folgt separat; der aktuelle Engine-Code allein fügt der Desktopform keine Chatansicht hinzu. Der Supervisor muss bei echten Runs das Requestboolean `conversation` in das gleichnamige Rootfeld der generierten Konfiguration schreiben, bei Demos `--conversation` übergeben.

Direkte Antworten sind nur in der initialen Planungsrunde möglich: Planrevision 0, noch kein abgeschlossener oder versuchter Schritt, keine Neuplanung. Kontextzüge und Outputreparaturen dieser initialen Runde bleiben möglich. Spätere Plannerprompts und -schemas bieten `answer` nicht an; trotzdem zurückgegebene Antworten nutzen die normale begrenzte Outputreparatur. **Citations sind optional**, auch wenn Evidenz gezeigt wurde; jede angegebene ID wird gegen genau den erzeugenden Prompt geprüft. Das garantiert keine inhaltliche Stützung der Aussage.

## macOS/Linux-Entwicklung und portable Desktop-Runtime

Native Buildziele sind macOS arm64 und x64 sowie Linux **glibc** arm64 und x64, zusätzlich zu Windows x64. Dies ist kein Nachweis ausgeführter macOS-/Linux-Releases; native CI und separater installierter Lifecycle müssen die jeweiligen Artefakte noch bestätigen. Keine musl-/Universal-/Cross-Builds. [Native Desktopmatrix, Abhängigkeiten und Artefakte](../docs/DESKTOP.md#native-builds-und-ci-matrix).

Die eigenständige Entwicklerinstallation verlangt weiterhin selbst bereitgestelltes Python und Git. Beispiel auf einem nativen POSIX-Host mit Python 3.14, vom Repositoryroot (eine vorhandene venv nicht während anderer Läufe ersetzen):

```sh
mkdir -p .scratch/pipeline/tmp .scratch/pipeline/pip-cache
export TMPDIR="$PWD/.scratch/pipeline/tmp"
export PIP_CACHE_DIR="$PWD/.scratch/pipeline/pip-cache"
export PYTHONPYCACHEPREFIX="$PWD/.scratch/pipeline/bytecode"
python3.14 -m venv .scratch/pipeline/venv
.scratch/pipeline/venv/bin/python -m pip install -e 'engine[dev]'
.scratch/pipeline/venv/bin/python -m scranton_pipeline version
.scratch/pipeline/venv/bin/python -m scranton_pipeline demo --run-root "$PWD/.scratch/pipeline/posix-demo" --delivery patch
```

Am Plan-Gate ist **Exit 3 erwartet**. Den aktuellen Digest lesen und `resume` wie in den Windows-Beispielen mit demselben nativen Interpreter aufrufen; keine fremden Beispieldigests übernehmen. Tests seriell vom Ordner `engine`:

```sh
../.scratch/pipeline/venv/bin/python -m pytest tests -q -p no:cacheprovider --basetemp ../.scratch/pipeline/pytest-posix
../.scratch/pipeline/venv/bin/python -m ruff check src tests --cache-dir ../.scratch/pipeline/ruff-posix
../.scratch/pipeline/venv/bin/python -m mypy src --cache-dir ../.scratch/pipeline/mypy-posix
```

Diese editable Installation ist **nicht** die Endnutzerinstallation. Das Desktoppaket liefert Windows-Embed-CPython 3.14.8 beziehungsweise Astral python-build-standalone **3.14.10, Release 20261110**, plus plattformspezifisch hashgesperrte Wheels unter privaten `engine-runtime/site-packages`. Die Lockauswahl steht in `scripts/desktop-runtime.mjs`; Windows behält `requirements.lock`/`runtime-lock.json`, POSIX hat getrennte Locks. Keine Installation in System-Sitepakete, kein pip für Endnutzer erforderlich.

`engine-runtime/launch.json`: Schema 1, native `platform`/`arch`, `executable:"python/python.exe"` (Windows) oder `"python/bin/python3"` (POSIX), `args:["-I","-B","bootstrap.py"]`. Der Node-Resolver macht den Bootstrappfad absolut; der Bootstrap lädt die privaten Sitepakete. Ein Manifestfehler ist kein stiller Fallback. Windows-Legacypakete ohne Manifest dürfen weiter ihren bisherigen Embed-`-m scranton_pipeline`-Pfad nutzen. Entwicklungsvenv-Auflösung: `Scripts/python.exe` unter Windows, `bin/python` unter POSIX; ein Endnutzer bekommt keine zufällige Systemruntime. Runtime-/Wheelfloors können über Nodes macOS-13.5-/glibc-2.28-Komponentenuntergrenze liegen; keine ungemessene Mindest-OS-Kompatibilität behaupten.

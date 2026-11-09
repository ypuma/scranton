import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor

from scranton_pipeline.config import CheckConfig, SandboxConfig
from scranton_pipeline.models import RunStatus
from scranton_pipeline.observability import (
    EventLog,
    UsageLedger,
    configure_logging,
    read_status,
    write_status,
)
from scranton_pipeline.tools.checks import run_checks
from scranton_pipeline.tools.process import run_process, scrubbed_env
from scranton_pipeline.tools.sandbox import build_sandbox
from scranton_pipeline.tools.secrets import Redactor


def test_event_sequence_continues_across_threads_instances_and_processes(tmp_path):
    path = tmp_path / "events.jsonl"
    redactor = Redactor(["never-print-this"])
    logs = [EventLog(path, "abcdefgh", redactor), EventLog(path, "abcdefgh", redactor)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda n: logs[n % 2].emit("warning", message="never-print-this"), range(20)))
    script = tmp_path / "append.py"
    script.write_text("from pathlib import Path\nfrom scranton_pipeline.observability import EventLog\nfrom scranton_pipeline.tools.secrets import Redactor\nEventLog(Path('events.jsonl'), 'abcdefgh', Redactor()).emit('run_resumed')\n")
    result = run_process([sys.executable, str(script)], cwd=tmp_path, env=scrubbed_env(os.environ, []), timeout_s=10)
    assert result.exit_code == 0, result.output_tail
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert [row["seq"] for row in rows] == list(range(1, 22))
    assert "never-print-this" not in path.read_text()


def test_usage_ledger_is_durable_and_failed_calls_count(tmp_path):
    path = tmp_path / "usage.jsonl"
    ledger = UsageLedger(path)
    ledger.record(role="planner", model="fake", input_tokens=10, output_tokens=2, ok=True, duration_s=0.1)
    ledger.record(role="planner", model="fake", input_tokens=4, output_tokens=0, ok=False, duration_s=0.1)
    restored = UsageLedger(path)
    assert restored.totals().model_dump() == {"calls": 2, "input_tokens": 14, "output_tokens": 2}
    assert restored.calls_for("planner") == 2
    assert restored.calls_for("reviewer") == 0


def test_status_and_json_logs_redact_registered_values(tmp_path, capsys):
    Redactor(["status-secret"])
    status = RunStatus(run_id="abcdefgh", status="failed", phase="done", task="status-secret")
    write_status(tmp_path, status)
    assert read_status(tmp_path).task == "[REDACTED]"
    assert json.loads((tmp_path / "status.json").read_text())["schema"] == 1
    configure_logging()
    logging.getLogger(__name__).warning("status-secret password=another-secret")
    record = json.loads(capsys.readouterr().err)
    assert "status-secret" not in record["message"] and "another-secret" not in record["message"]
    logging.getLogger().handlers.clear()


def test_real_checks_order_fail_fast_timeout_and_missing_executable(tmp_path):
    sandbox = build_sandbox(SandboxConfig(mode="host"), workspace=tmp_path, run_id="abcdefgh", trust_host=True)
    checks = [CheckConfig(id="fail", argv=[sys.executable, "-c", "raise SystemExit(1)"]),
              CheckConfig(id="pass", argv=[sys.executable, "-c", "print('ok')"])]
    results = run_checks(checks, sandbox=sandbox, log_dir=tmp_path / "logs", label="baseline", stop=None)
    assert [r.id for r in results] == ["fail"]
    assert results[0].status == "failed"
    results = run_checks(checks, sandbox=sandbox, log_dir=tmp_path / "logs", label="verify", stop=None, fail_fast=False)
    assert [r.status for r in results] == ["failed", "passed"]
    results = run_checks([CheckConfig(id="slow", argv=[sys.executable, "-c", "import time; time.sleep(60)"], timeout_s=0.2)], sandbox=sandbox, log_dir=tmp_path / "logs", label="timeout", stop=None)
    assert results[0].status == "timed_out"
    results = run_checks([CheckConfig(id="missing", argv=["missing-command-scranton-991"])], sandbox=sandbox, log_dir=tmp_path / "logs", label="missing", stop=None)
    assert results[0].status == "error"

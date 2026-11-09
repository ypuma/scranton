"""Real child interpreters, real Git/checks. Guard references are recorded per test."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scranton_pipeline.demo.fixture import EDIT, PLAN, REVIEW

from .conftest import begin, cli, decision, script


def test_success_separate_process_gates(case):
    # Guards: runner Command(resume=...), apply_to_source gate, durability='sync'.
    code, status = begin(case, delivery="apply")
    assert code == 3, status
    assert status["pending"]["gate"] == "plan"
    assert "a - b" in (case["source"] / "calculator.py").read_text()
    code, status = decision(case, status)
    assert code == 3, status
    assert status["pending"]["gate"] == "delivery"
    assert "a - b" in (case["source"] / "calculator.py").read_text()
    code, status = decision(case, status)
    assert code == 0, status
    assert status["status"] == "succeeded" and status["delivery"]["applied"]
    assert "a + b" in (case["source"] / "calculator.py").read_text()
    report = json.loads(Path(status["artifacts"]["report_json"]).read_text())
    assert report["assessments"] and report["timeline"] and report["changed_files"]
    assert cli("status", "--run-dir", case["root"] / "test0001")[1]["status"] == "succeeded"


def test_stale_digest_no_state_change(case):
    begin(case)
    run_dir = case["root"] / "test0001"
    before = (run_dir / "checkpoints.sqlite").read_bytes()
    code, result = cli("resume", "--run-dir", run_dir, "--gate", "plan", "--decision", "approve", "--digest", "bad", "--trust-host")
    assert code == 2 and result["failure"]["code"] == "stale_digest"
    assert (run_dir / "checkpoints.sqlite").read_bytes() == before


@pytest.mark.parametrize("change", ["id", "task", "trust", "overlap"])
def test_invalid_before_creation(case, change):
    args = ["run", "--source", case["source"], "--task", "Fix", "--config", case["config"],
            "--run-root", case["root"], "--run-id", "test0001", "--trust-host"]
    if change == "id": args[args.index("--run-id") + 1] = "../invalid"
    if change == "task": args[args.index("--task") + 1] = ""
    if change == "trust": args.remove("--trust-host")
    if change == "overlap": args[args.index("--run-root") + 1] = case["source"] / "runs"
    assert cli(*args)[0] == 2
    assert not (case["root"] / "test0001").exists()


@pytest.mark.parametrize("turns,expected", [(["bad", PLAN], 3), (["bad"] * 3, 4)])
def test_output_repairs(case, turns, expected):
    # Guard: invalid() repair-counter comparison and plan self-edge.
    script(case, "planner", turns)
    code, status = begin(case)
    assert code == expected, status
    if expected == 4:
        assert status["failure"]["failure_class"] == "llm_output"


@pytest.mark.parametrize("persistent", [False, True])
def test_transient_retry_and_resume(case, persistent):
    # Guard: RetryPolicy(retry_on=TransientError); ledger cursor on replay.
    script(case, "planner", [{"__error__": "transient"}] * (3 if persistent else 1) + [PLAN])
    code, status = begin(case)
    assert code == (5 if persistent else 3), status
    if persistent:
        code, status = cli("resume", "--run-dir", case["root"] / "test0001", "--trust-host")
        assert code == 3, status
    assert status["usage"]["calls"] == (4 if persistent else 2)


def test_checks_repair(case):
    wrong = {"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify", "content": "def add(a, b):\n    return 0\n"}]}
    right = {"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify", "content": "def add(a, b):\n    return a + b\n"}]}
    script(case, "implementer", [wrong, right])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    assert status["usage"]["calls"] == 4


def test_checks_exhaustion(case):
    wrong = [{"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify", "content": f"def add(a, b):\n    return {n}\n"}]} for n in (0, 1, 2)]
    script(case, "implementer", wrong)
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 4 and status["failure"]["failure_class"] == "checks_failed", status
    assert Path(status["artifacts"]["report_json"]).exists()


@pytest.mark.parametrize("exhaust", [False, True])
def test_review_revision(case, exhaust):
    changes = {"verdict": "request_changes", "summary": "Add a comment", "criteria": [{"id": "sum", "status": "met"}],
               "findings": [{"severity": "minor", "category": "maintainability", "description": "Explain addition"}]}
    script(case, "reviewer", [changes] * (3 if exhaust else 1) + [REVIEW])
    script(case, "implementer", [EDIT] + [{"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify",
        "content": f"# Addition {n}\ndef add(a, b):\n    return a + b\n"}]} for n in (1, 2)])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == (4 if exhaust else 0), status
    if exhaust: assert status["failure"]["code"] == "review_exhausted"


@pytest.mark.parametrize("limits,code", [({"max_llm_calls": 1}, "llm_budget_exhausted"),
    ({"max_total_tokens": 1}, "llm_budget_exhausted"), ({"max_active_seconds": 0.000001}, "run_time_exhausted")])
def test_limits(case, limits, code):
    case["cfg"]["limits"] = limits
    exit_code, status = begin(case)
    if exit_code == 3: exit_code, status = decision(case, status)
    assert exit_code == 4 and status["failure"]["code"] == code, status


@pytest.mark.parametrize("where", ["plan", "delivery"])
def test_cancel_gate_without_models(case, where):
    _, status = begin(case, delivery="apply")
    if where == "delivery": _, status = decision(case, status)
    code, status = cli("cancel", "--run-dir", case["root"] / "test0001")
    assert code == 6 and status["status"] == "cancelled", status
    assert Path(status["artifacts"]["report_json"]).exists()


@pytest.mark.parametrize("path", ["../escape.py", ".env"])
def test_security_edits(case, path):
    script(case, "implementer", [{"kind": "edits", "edits": [{"path": path, "action": "create", "content": "x=1"}]}])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 4 and status["failure"]["failure_class"] == "security", status
    assert "a - b" in (case["source"] / "calculator.py").read_text()
    assert not (case["root"] / "test0001" / "workspace" / ".env").exists()


def test_conflict_does_not_write(case):
    _, status = begin(case, delivery="apply")
    _, status = decision(case, status)
    (case["source"] / "calculator.py").write_text("changed by owner\n")
    code, status = decision(case, status)
    assert code == 4 and status["delivery"]["conflicts"], status
    assert (case["source"] / "calculator.py").read_text() == "changed by owner\n"


def test_reject_plan(case):
    _, status = begin(case)
    code, status = decision(case, status, "reject")
    assert code == 6 and status["status"] == "rejected"


def test_decline_delivery_is_success(case):
    _, status = begin(case, delivery="apply")
    _, status = decision(case, status)
    code, status = decision(case, status, "reject")
    assert code == 0 and not status["delivery"]["applied"]


def test_hard_crash_and_dead_status(case):
    # Test-only child hook: kill inside implementer gateway, never production code.
    hook = case["tmp"] / "crash.py"
    hook.write_text('''import os, sys
from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.cli import main
original = ChatModelGateway.complete
def crash(self, role, **kwargs):
    if role == "implementer": os._exit(91)
    return original(self, role, **kwargs)
ChatModelGateway.complete = crash
raise SystemExit(main(sys.argv[1:]))
''')
    _, status = begin(case)
    args = [sys.executable, str(hook), "resume", "--run-dir", str(case["root"] / "test0001"), "--trust-host",
            "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]]
    proc = subprocess.run(args, check=False, capture_output=True, env=os.environ, timeout=60)
    assert proc.returncode == 91, proc.stderr
    _, status = cli("status", "--run-dir", case["root"] / "test0001")
    assert status["status"] == "suspended" and status["resumable"]
    code, status = cli("resume", "--run-dir", case["root"] / "test0001", "--trust-host")
    assert code == 0, status
    events = [json.loads(s) for s in (case["root"] / "test0001" / "events.jsonl").read_text().splitlines()]
    assert sum(e["type"] == "node_finished" and e["node"] == "prepare_workspace" for e in events) == 1
    assert sum(e["type"] == "node_finished" and e["node"] == "plan" for e in events) == 1


def test_parent_guard_eof_suspends_before_work(case):
    case["config"].write_text(json.dumps(case["cfg"]))
    code, status = cli("run", "--source", case["source"], "--task", "Fix", "--config", case["config"],
        "--run-root", case["root"], "--run-id", "test0001", "--trust-host", "--parent-guard", stdin=subprocess.DEVNULL)
    assert code == 5 and status["resumable"], status
    code, status = cli("resume", "--run-dir", case["root"] / "test0001", "--trust-host")
    assert code == 3, status


def test_cancel_before_next_node(case):
    # Guard: wrapper cancel check precedes failure budgets and model invocation.
    _, status = begin(case)
    run_dir = case["root"] / "test0001"
    (run_dir / "cancel.requested").touch()
    code, status = decision(case, status)
    assert code == 6 and status["status"] == "cancelled"
    assert status["usage"]["calls"] == 1


def test_single_owner_refused(case):
    _, status = begin(case)
    from scranton_pipeline.runner import owner
    with owner(case["root"] / "test0001"):
        code, result = decision(case, status)
    assert code == 2 and result["failure"]["code"] == "run_active"


def test_cancel_running_check(case):
    import time
    marker = case["tmp"] / "check.started"
    case["cfg"]["checks"][0].update(argv=[sys.executable, "-c",
        f"from pathlib import Path; import time; Path({str(marker)!r}).write_text('started'); time.sleep(60)"], timeout_s=65)
    case["config"].write_text(json.dumps(case["cfg"]))
    process = subprocess.Popen([sys.executable, "-m", "scranton_pipeline", "run", "--source", str(case["source"]),
        "--task", "Fix", "--config", str(case["config"]), "--run-root", str(case["root"]), "--run-id", "test0001", "--trust-host"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 20
        while not marker.exists() and time.monotonic() < deadline and process.poll() is None:
            time.sleep(0.05)
        assert marker.exists()
        cli("cancel", "--run-dir", case["root"] / "test0001")
        stdout, stderr = process.communicate(timeout=20)
        status = json.loads(stdout)
        assert process.returncode == 6 and status["status"] == "cancelled", (stdout, stderr)
        assert status["usage"]["calls"] == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()

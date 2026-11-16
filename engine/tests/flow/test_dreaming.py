"""Authoritative hooks in real scripted runs, not final-status inference."""
import json

import pytest

from .conftest import begin, decision, script
from .test_replan import REJECTED, RIGHT, WRONG, setup_replan


def attempts(case):
    events = [json.loads(s) for s in (case["root"] / "test0001" / "events.jsonl").read_text().splitlines()]
    return [e["data"] for e in events if e["type"] == "dream_attempt"]


@pytest.mark.parametrize("first", [REJECTED, WRONG])
def test_rejected_and_failed_then_passed_chain(case, first):
    script(case, "implementer", [first, RIGHT])
    _, status = begin(case, delivery="apply")
    assert attempts(case) == []  # Baseline and plan approval are not attempts.
    code, status = decision(case, status)
    assert code == 3 and status["pending"]["gate"] == "delivery", status
    rows = attempts(case)
    assert [(r["ordinal"], r["result"], r["quality"]) for r in rows] == [(1, "failed", 0), (2, "passed", 1)]
    assert len({r["scope"] for r in rows}) == 1
    assert all(set(r) == {"schema", "scope", "ordinal", "result", "quality", "plan_revision", "retry_ceiling"} for r in rows)
    code, status = decision(case, status, "reject")
    assert code == 0 and attempts(case) == rows
    assert "return a - b" in (case["source"] / "calculator.py").read_text()


@pytest.mark.parametrize("trigger", [REJECTED, WRONG])
def test_replanned_attempts_distinct_and_failed_changes_not_delivered(case, trigger):
    setup_replan(case, [trigger, RIGHT])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 3
    code, status = decision(case, status)
    assert code == 0, status
    rows = attempts(case)
    assert [(r["plan_revision"], r["ordinal"], r["quality"]) for r in rows] == [(0, 1, 0), (1, 1, 1)]
    assert rows[0]["scope"] != rows[1]["scope"]
    diff = (case["root"] / "test0001" / "delivery" / "candidate.diff").read_text()
    assert "FAILED ATTEMPT" not in diff
    assert all("delivered" not in r for r in rows)


def test_no_checks_does_not_emit_success(case):
    case["cfg"].update(checks=[], allow_no_checks=True)
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    assert attempts(case) == []


def test_memory_only_history_through_existing_cli(case):
    path = case["tmp"] / "project-memory.json"
    path.write_text(json.dumps({"schema": 1, "runs": [], "truncated": False,
        "project_memory": [{"id": "memory:one", "text": "Historical check failure, not delivered changes.",
                            "sources": ["projects/project/events.jsonl"]}]}))
    from .conftest import cli
    code, status = cli("run", "--source", case["source"], "--task", "Fix addition",
        "--config", case["config"], "--run-root", case["root"], "--run-id", "test0001",
        "--history-file", path, "--trust-host")
    assert code == 3 and status["pending"]["gate"] == "plan", status
    saved = json.loads((case["root"] / "test0001" / "run.json").read_text())
    assert saved["cross_run_history"]["runs"] == []
    assert saved["cross_run_history"]["project_memory"][0]["id"] == "memory:one"
    assert attempts(case) == []


def test_parallel_lanes_exclude_integration_checks(tmp_path):
    from .conftest import cli
    root = tmp_path / "parallel"
    code, status = cli("demo", "--scenario", "parallel", "--run-root", root, "--run-id", "dream001")
    assert code == 3, status
    code, status = cli("resume", "--run-dir", root / "dream001", "--gate", "plan",
                       "--decision", "approve", "--digest", status["pending"]["digest"], "--trust-host")
    assert code == 0, status
    events = [json.loads(s) for s in (root / "dream001" / "events.jsonl").read_text().splitlines()]
    rows = [e["data"] for e in events if e["type"] == "dream_attempt"]
    assert len(rows) == 2 and len({r["scope"] for r in rows}) == 2
    assert {r["lane"] for r in rows} == {"fix", "multiply"}
    assert all(r["ordinal"] == 1 and r["quality"] == 1 for r in rows)
    assert all(json.loads(r["scope"])[2] is not None for r in rows)
    assert sum(e["type"] == "check_finished" for e in events) > len(rows)


@pytest.mark.parametrize("remaining", [[RIGHT], [WRONG, RIGHT], [WRONG, REJECTED]])
def test_blocked_replan_reuses_step_with_remaining_budget(case, remaining, monkeypatch):
    import os
    import subprocess
    import sys

    from . import conftest
    from .test_replan import BLOCKED

    # Normal planning renames IDs. Inject a recovered/reused ID, not a fresh budget.
    hook = case["tmp"] / "reused-id.py"
    hook.write_text('''import sys
from scranton_pipeline import graph
from scranton_pipeline.cli import main
original = graph.plan
def reused(state, deps):
    update = original(state, deps)
    if state.get("plan_revision") and update.get("plan"):
        update["plan"]["steps"][0]["id"] = "fix"
    return update
graph.plan = reused
raise SystemExit(main(sys.argv[1:]))
''')
    def recovered_cli(*args, **kwargs):
        process = subprocess.run([sys.executable, str(hook), *map(str, args)],
            env=os.environ, check=False, capture_output=True, text=True, timeout=90)
        assert len(process.stdout.splitlines()) == 1, (process.returncode, process.stdout, process.stderr)
        return process.returncode, json.loads(process.stdout)
    monkeypatch.setattr(conftest, "cli", recovered_cli)
    setup_replan(case, [WRONG, BLOCKED, *remaining])
    case["cfg"]["limits"]["max_step_attempts"] = 3
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 3 and status["pending"]["revision"] == 1, status
    code, status = decision(case, status)
    assert code == (4 if remaining[-1] == REJECTED else 0), status
    rows = attempts(case)
    assert [(r["plan_revision"], r["ordinal"], r["retry_ceiling"]) for r in rows] == [
        (0, 1, 3), *[(1, i + 1, 2) for i in range(len(remaining))]]
    assert json.loads(rows[0]["scope"]) == [0, "step:fix", None]
    assert all(json.loads(r["scope"]) == [1, "step:fix", None] for r in rows[1:])
    if code == 4:
        assert status["failure"]["code"] == "edits_rejected"
    else:
        report = json.loads((case["root"] / "test0001" / "delivery" / "report.json").read_text())
        assert report["steps"][-1]["attempts"] == 1 + len(remaining)


@pytest.mark.parametrize("optional", [False, True])
def test_rejected_edits_without_required_checks_omitted(case, optional):
    setup_replan(case, [REJECTED])
    case["cfg"]["limits"]["max_replans"] = 0
    if optional:
        case["cfg"]["checks"][0]["required"] = False
    else:
        case["cfg"].update(checks=[], allow_no_checks=True)
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 4 and status["failure"]["code"] == "edits_rejected", status
    assert attempts(case) == []


@pytest.mark.parametrize("comment", ["", " ", "Operator feedback"])
def test_resume_metadata_records_validated_choice_without_feedback_text(case, comment):
    from .conftest import cli
    _, status = begin(case)
    directory = case["root"] / "test0001"
    code, status = cli("resume", "--run-dir", directory, "--trust-host", "--gate", "plan",
        "--decision", "approve", "--digest", status["pending"]["digest"], "--comment=" + comment)
    assert code == 0, status
    events = [json.loads(s) for s in (directory / "events.jsonl").read_text().splitlines()]
    resumed = [e["data"] for e in events if e["type"] == "run_resumed"]
    assert resumed == [{"gate": "plan", "decision": "approve", "has_feedback": bool(comment)}]
    assert all("comment" not in r for r in resumed)

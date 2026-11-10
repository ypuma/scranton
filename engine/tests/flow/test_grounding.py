import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scranton_pipeline.demo.fixture import PLAN
from scranton_pipeline.grounding import recompute_summary

from .conftest import begin, cli, decision, script


@pytest.mark.parametrize("scenario", ["basic", "replan", "parallel", "evidence"])
def test_grounded_demos_score_matches_final_status(tmp_path, scenario):
    root = tmp_path / "runs"
    code, status = cli("demo", "--run-root", root, "--run-id", "ground001", "--scenario", scenario, "--delivery", "apply")
    assert code == 3, status
    directory = root / "ground001"
    assert status["grounding"]["mode"] == "enforce"
    assert status["procedure"] == {"enabled": False, "name": None, "digest": None, "situation": None}
    for gate, expected in (("plan", 3), ("delivery", 0)):
        if gate == "delivery":
            assert status["pending"]["grounding"] == status["grounding"]
            assert "risk_flags" in status["pending"]
            if scenario == "evidence":
                assert status["pending"]["risk_flags"] == ["criteria_not_demonstrated"]
        code, status = cli("resume", "--run-dir", directory, "--gate", gate, "--decision", "approve", "--digest", status["pending"]["digest"], "--trust-host")
        if scenario == "replan" and gate == "plan":
            assert status["pending"]["gate"] == "plan"
            code, status = cli("resume", "--run-dir", directory, "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"], "--trust-host")
        assert code == expected, status
    code, score = cli("score", "--run-dir", directory)
    assert code == 0 and score == status["grounding"] == recompute_summary(directory)
    assert score["answer"] == 1
    assert score["violations"] == ({"unseen_target": 1, "false_absence": 1} if scenario == "evidence" else {})
    assert {c["state"] for c in score["criteria"]} == ({"demonstrated", "met_not_demonstrated"} if scenario == "evidence" else {"demonstrated"})
    assert score["criteria"][0]["by"] == "baseline"
    report = json.loads(Path(status["artifacts"]["report_json"]).read_text())
    assert report["grounding"] == score
    assert "## Grounding" in Path(status["artifacts"]["report_md"]).read_text()
    rows = [json.loads(line) for line in (directory / "grounding.jsonl").read_text().splitlines()]
    if scenario == "parallel":
        assert {r["lane"] for r in rows if r["type"] == "output" and r["role"] == "implementer"} == {"fix", "multiply"}
    events = [json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()]
    if scenario == "evidence":
        assert any(r["type"] == "absence_refuted" and r["data"]["hits"] == [{"path": "calculator.py", "line": 1}] for r in events)
    assert {"grounding", "criteria_decided", "probe_finished"} <= {r["type"] for r in events}


@pytest.mark.parametrize("mode", ["enforce", "observe"])
def test_finished_violation_run_rescores_exactly(case, mode):
    case["cfg"]["grounding"] = {"mode": mode}
    script(case, "planner", [PLAN, PLAN])
    _, status = begin(case, delivery="apply")
    code, status = decision(case, status)
    assert code == 3, status
    assert ("grounding_violations" in status["pending"]["risk_flags"]) == (mode == "observe")
    code, status = decision(case, status)
    assert code == 0, status
    directory = case["root"] / "test0001"
    assert cli("score", "--run-dir", directory)[1] == status["grounding"]
    assert status["grounding"]["violations"] == {"unseen_target": 1}
    assert status["grounding"]["outputs"] == (4 if mode == "enforce" else 3)


def test_crash_inside_ground_resume_uses_receipt(case):
    case["cfg"]["grounding"] = {"mode": "enforce"}
    script(case, "planner", [PLAN, PLAN])
    _, status = begin(case)
    directory = case["root"] / "test0001"
    hook = case["tmp"] / "crash_ground.py"
    hook.write_text('''import os, sys
from scranton_pipeline import graph
from scranton_pipeline.cli import main
original = graph.ground
def crash(state, deps):
    original(state, deps)
    os._exit(91)
graph.ground = crash
raise SystemExit(main(sys.argv[1:]))
''')
    proc = subprocess.run([sys.executable, str(hook), "resume", "--run-dir", str(directory), "--trust-host", "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]], env=os.environ, capture_output=True, check=False, timeout=60)
    assert proc.returncode == 91, proc.stderr
    before = recompute_summary(directory)
    code, status = cli("resume", "--run-dir", directory, "--trust-host")
    assert code == 0 and status["grounding"] == before
    assert cli("score", "--run-dir", directory)[1] == before
    assert sum(json.loads(line)["type"] == "criteria" for line in (directory / "grounding.jsonl").read_text().splitlines()) == 1


def test_score_invalid_directory(tmp_path):
    assert cli("score", "--run-dir", tmp_path)[0] == 2


@pytest.mark.parametrize("grounding,guidance", [("observe", "true"), ("enforce", "false")])
def test_demo_wire_options_persist_and_status_mirrors(tmp_path, grounding, guidance):
    code, status = cli("demo", "--run-root", tmp_path / "runs", "--run-id", "wire0001", "--grounding", grounding, "--guidance", guidance)
    assert code == 3, status
    assert status["grounding"]["mode"] == grounding
    assert status["procedure"]["enabled"] == (guidance == "true")
    cfg = json.loads((tmp_path / "runs" / "wire0001" / "config.json").read_text())
    assert cfg["grounding"]["mode"] == grounding and cfg["procedure"]["enabled"] == (guidance == "true")


@pytest.mark.parametrize("option,value", [("--guidance", "yes"), ("--grounding", "off")])
def test_demo_wire_options_invalid(tmp_path, option, value):
    assert cli("demo", "--run-root", tmp_path / "runs", option, value)[0] == 2


def test_zero_output_observe_run_preserves_trace_settings(case):
    case["cfg"]["grounding"] = {"mode": "observe", "weights": {"answer": 0.2, "trajectory": 0.8}}
    case["cfg"]["limits"] = {"max_active_seconds": 1e-9}
    code, status = begin(case)
    assert code == 4 and status["grounding"]["outputs"] == 0, status
    directory = case["root"] / "test0001"
    rows = [json.loads(line) for line in (directory / "grounding.jsonl").read_text().splitlines()]
    assert rows == [{"seq": 1, "type": "settings", "mode": "observe", "weights": {"answer": 0.2, "trajectory": 0.8}}]
    assert status["grounding"]["mode"] == "observe"
    assert status["grounding"]["unadjusted"] == 0.8
    saved = json.loads((directory / "config.json").read_text())
    saved["grounding"] = {"mode": "enforce", "weights": {"answer": 0.9, "trajectory": 0.1}}
    (directory / "config.json").write_text(json.dumps(saved))
    code, score = cli("score", "--run-dir", directory)
    assert code == 0 and score == status["grounding"] == recompute_summary(directory)


def test_evidence_demo_requires_enforce_before_run_creation(tmp_path):
    root = tmp_path / "runs"
    code, result = cli("demo", "--run-root", root, "--scenario", "evidence", "--grounding", "observe")
    assert code == 2 and result["failure"]["code"] == "invalid_demo_grounding"
    assert not root.exists()

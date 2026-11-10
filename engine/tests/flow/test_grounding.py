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
    if scenario == "basic":
        turn = json.loads((directory / "artifacts" / "planner.json").read_text())[0]
        assert {(r["kind"], r["path"]) for r in turn["context_requests"]} >= {("search", ""), ("list", "")}
        registry = [json.loads(line) for line in (directory / "evidence.jsonl").read_text().splitlines()]
        assert {r["query"] for r in registry if r["kind"] == "context" and r["path"] == "" and r["ok"]} >= {"", "add"}
        assert any(r["type"] == "context" and r["data"] == {"requests": 3, "fulfilled": 3} for r in events)
        assert any(r.get("role") == "planner" and r["accepted"] and not r["violations"] for r in rows)
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


def test_project_wide_planner_context_succeeds(case):
    case["cfg"]["grounding"] = {"mode": "enforce"}
    script(case, "planner", [{"kind": "need_context", "context_requests": [
        {"kind": "search", "query": "legacy_tax", "path": ""}, {"kind": "list", "path": ""},
        {"kind": "read", "path": "calculator.py"}]}, PLAN])
    code, status = begin(case)
    assert code == 3, status
    code, status = decision(case, status)
    assert code == 0 and status["status"] == "succeeded", status
    assert status["grounding"]["violations"] == {}


def test_unsafe_context_turn_does_not_fail_run(case):
    mode = "observe"
    case["cfg"]["grounding"] = {"mode": mode}
    turn = {"kind": "need_context", "context_requests": [
        *[{"kind": "read", "path": path} for path in ("../x", "C:/x", "/etc/passwd")],
        {"kind": "read", "path": "calculator.py"}]}
    rounds = 1
    script(case, "planner", [*[turn] * rounds, PLAN])
    code, status = begin(case)
    assert code == 3, status
    code, status = decision(case, status)
    assert code == 0 and status["status"] == "succeeded", status
    assert status["grounding"]["violations"] == {"protected_request": rounds * 3}
    directory = case["root"] / "test0001"
    events = [json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()]
    assert any(r["type"] == "context" and r["data"] == {"requests": 4, "fulfilled": 1} for r in events)
    rows = [json.loads(line) for line in (directory / "grounding.jsonl").read_text().splitlines()]
    unsafe = [r for r in rows if r.get("violations")]
    assert [r["accepted"] for r in unsafe] == [True]


@pytest.mark.parametrize("corrected", [True, False])
def test_enforce_unsafe_context_repairs_or_fails(case, corrected):
    case["cfg"]["grounding"] = {"mode": "enforce"}
    unsafe = {"kind": "need_context", "context_requests": [{"kind": "read", "path": "../x"}]}
    safe = {"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}
    script(case, "planner", [unsafe, safe, PLAN] if corrected else [unsafe] * 3)
    code, status = begin(case, delivery="apply")
    directory = case["root"] / "test0001"
    if corrected:
        assert code == 3, status
        code, status = decision(case, status)
        assert code == 3 and "grounding_violations" not in status["pending"]["risk_flags"], status
        code, status = decision(case, status)
        assert code == 0 and status["status"] == "succeeded", status
    else:
        assert code == 4 and status["status"] == "failed" and not status["resumable"], status
        assert status["failure"] == {"failure_class": "llm_output", "code": "output_invalid", "message": "Output repair budget exhausted", "node": "plan"}
        assert not any(json.loads(line)["type"] == "context" for line in (directory / "events.jsonl").read_text().splitlines())
    assert status["grounding"]["violations"] == {"protected_request": 1 if corrected else 3}
    rows = [json.loads(line) for line in (directory / "grounding.jsonl").read_text().splitlines()]
    assert all(not r["accepted"] for r in rows if r.get("violations"))

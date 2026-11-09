"""Review regressions; each Guard identifies the production reversal that fails it."""
import copy
import json
import sys
from pathlib import Path

import pytest

from scranton_pipeline.agents.prompts import build_planner_prompt
from scranton_pipeline.config import EngineConfig, Limits
from scranton_pipeline.demo.fixture import EDIT, PLAN, REVIEW, config
from scranton_pipeline.limits import recursion_limit
from scranton_pipeline.report import make_status
from scranton_pipeline.runner import dependencies

from .conftest import begin, cli, decision, script


def test_large_repo_prompt_keeps_control_and_evidence(tmp_path):
    # Guard: build_planner_prompt selects/caps overview instead of serializing files/symbols.
    cfg = config(tmp_path)
    repo = {"files": [{"path": f"src/file{i}.py", "size": 1000} for i in range(5000)],
            "symbols": {f"file{i}.py": ["long_function_name"] * 200 for i in range(5000)},
            "tree": "file.py\n" * 5000, "manifests": [{"name": "pyproject.toml"}] * 5000,
            "readme_excerpt": "README" * 10000, "languages": {"Python": 5000}}
    state = {"task": "Fix addition", "repo": repo, "baseline": [{"output_tail": "baseline sentinel"}],
             "feedback": {"message": "feedback sentinel"}, "counters": {"plan_context": 2},
             "plan_evidence": [{"request": {"path": "calculator.py"}, "content": "evidence sentinel"}]}
    system, user = build_planner_prompt(state, cfg)
    assert len((system + user).encode()) <= cfg.limits.max_prompt_bytes
    assert '"context_rounds_left": 1' in user
    assert all(word in user for word in ("baseline sentinel", "feedback sentinel", "evidence sentinel"))
    assert "data tails removed" not in user


def test_step_R1_does_not_spend_revision_budget(case):
    # Guard: scope_id's step:/rev: namespaces; removing them exhausts revision 1 immediately.
    plan = copy.deepcopy(PLAN)
    plan["plan"]["steps"][0]["id"] = "R1"
    script(case, "planner", [plan])
    wrong = lambda n: {"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify",
        "content": f"def add(a, b):\n    return {n}\n"}]}
    right = {"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify",
        "content": "def add(a, b):\n    return a + b\n"}]}
    revision = copy.deepcopy(right)
    revision["edits"][0]["content"] = "# Revision\ndef add(a, b):\n    return a + b\n"
    changes = {**REVIEW, "verdict": "request_changes", "summary": "Add comment"}
    script(case, "implementer", [wrong(0), wrong(1), right, revision])
    script(case, "reviewer", [changes, REVIEW])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    report = json.loads(Path(status["artifacts"]["report_json"]).read_text())
    assert [(s["step_id"], s["attempts"]) for s in report["steps"]] == [("step:R1", 3), ("rev:1", 1)]


def test_reviewer_paths_are_display_only(case):
    # Guard: review sanitizes display strings without PathPolicy.resolve.
    review = {**REVIEW, "findings": [{"severity": "info", "category": "maintainability",
        "path": path, "description": "Informational"} for path in ("calculator.py:2", "src\\a.py", "../display\nonly")]}
    script(case, "reviewer", [review])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    findings = json.loads(Path(status["artifacts"]["report_json"]).read_text())["review"]["findings"]
    assert [f["path"] for f in findings] == ["calculator.py:2", "src/a.py", "../displayonly"]


def test_status_redaction_progress_resume_and_markdown(case, monkeypatch):
    # Guards: make_status redacts before slicing, clamps index; drive uses checkpoint.next on resume.
    code, status = begin(case, delivery="apply")
    run_dir = case["root"] / "test0001"
    assert cli("status", "--run-dir", run_dir)[0] == 3
    code, status = cli("resume", "--run-dir", run_dir, "--gate", "plan", "--decision", "approve",
                       "--digest", status["pending"]["digest"], "--comment=-leading comment", "--trust-host")
    assert code == 3, status
    assert status["progress"]["step_index"] == 0 and status["progress"]["attempt"] == 1
    with dependencies(run_dir, EngineConfig.model_validate(case["cfg"]), trust_host=True) as deps:
        from scranton_pipeline import runner
        from scranton_pipeline.graph import build_graph
        state = build_graph(deps).get_state({"configurable": {"thread_id": "test0001"}}).values
        visible = make_status({**state, "task": "secret:1 " * 60}, deps, node="approve_delivery")
        assert len(visible.task) == 500 and "secret:1" not in visible.task
        assert all(c["output_tail"] == "" for c in visible.checks)
        failed = {**state["checks"][0], "status": "failed", "output_tail": "secret:1 " * 2000}
        tail = make_status({**state, "checks": [failed]}, deps).checks[0]["output_tail"]
        assert len(tail) == 4096 and "secret:1" not in tail and "[REDACTED]" in tail
        captured = []
        original = runner.write_status
        def capture(directory, value):
            captured.append(value)
            original(directory, value)
        monkeypatch.setattr(runner, "write_status", capture)
        runner.drive(deps)
        assert captured[0].node == "approve_delivery" and captured[0].phase == "deliver"
    code, status = decision(case, status)
    assert code == 0 and cli("status", "--run-dir", run_dir)[0] == 0
    markdown = Path(status["artifacts"]["report_md"]).read_text(encoding="utf-8")
    for heading in ("Outcome", "Task", "Plan", "Steps", "Changed files", "Checks", "Review", "Usage", "Timeline", "Delivery", "Limitations"):
        assert f"## {heading}" in markdown
    assert "```json" not in markdown and "| calculator.py | modify |" in markdown
    assert status["progress"]["step_index"] == 0 and status["progress"]["attempt"] == 1


def test_baseline_restores_tracked_files_and_reports_warning(case):
    # Guard: checked() calls restore_tracked for baseline as well as verify.
    case["cfg"]["checks"][0]["argv"] = [sys.executable, "-c",
        "from pathlib import Path; Path('calculator.py').write_text('damaged\\n'); Path('.git').mkdir(exist_ok=True)"]
    _, status = begin(case)
    run_dir = case["root"] / "test0001"
    assert "a - b" in (run_dir / "workspace" / "calculator.py").read_text()
    code, status = decision(case, status)
    assert code == 0, status
    assert "a + b" in (run_dir / "workspace" / "calculator.py").read_text()
    events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]
    assert sum(e["data"].get("code") == "check_modified_tracked" for e in events) == 2
    assert any(e["data"].get("code") == "workspace_git_ignored" for e in events)
    assert "Checks modified tracked files" in Path(status["artifacts"]["report_md"]).read_text()


def test_unstartable_check_reason_reaches_all_outputs(case):
    # Guards: run_checks keeps EngineError text; baseline_checks includes it in failure; report renders tails.
    case["cfg"]["checks"][0]["argv"] = ["scranton-no-such-executable-fix1"]
    code, status = begin(case)
    assert code == 4 and status["failure"]["failure_class"] == "infrastructure"
    for text in (status["checks"][0]["output_tail"], status["failure"]["message"],
                 Path(status["artifacts"]["report_md"]).read_text()):
        assert "scranton-no-such-executable-fix1" in text and "Cannot start" in text


@pytest.mark.parametrize("outcome,expected", [("failed", 4), ("suspended", 5), ("cancelled", 6), ("rejected", 6)])
def test_status_exit_code_matches_printed_status(case, outcome, expected):
    # Guard: CLI returns EXIT[status.status], not unconditional zero for the status subcommand.
    begin(case)
    path = case["root"] / "test0001" / "status.json"
    record = json.loads(path.read_text())
    record.update(status=outcome, pending=None, pid=None, resumable=outcome == "suspended")
    path.write_text(json.dumps(record))
    code, result = cli("status", "--run-dir", path.parent)
    assert code == expected and result["status"] == outcome


def test_recursion_bound_properties():
    # Guard: recursion_limit includes (review_rounds + 1) repair scopes, including the first review.
    for repairs in (0, 2, 10):
        for rounds in (0, 2, 10):
            for steps in (1, 8, 32):
                lim = Limits(max_output_repairs=repairs, max_review_rounds=rounds, max_plan_steps=steps,
                             max_plan_context_rounds=10, max_step_context_rounds=10, max_step_attempts=10)
                # Independently count every legal node visit; fan-out and gates overcount safely.
                visits = (4 + 1 + repairs + 20 + 1 + steps * (1 + repairs + 20 + 30)
                          + rounds * (1 + repairs + 20 + 30) + (rounds + 1) * (1 + repairs) + 5)
                assert recursion_limit(lim) >= visits


@pytest.mark.parametrize("stress", [False, True])
def test_first_review_repairs_auto_approval_and_hard_ceiling_run(case, stress):
    # Guard: missing the initial review's repairs in recursion_limit fails the auto-approved 42-step run.
    case["cfg"].update(checks=[], allow_no_checks=True, approvals={"plan": "auto_low_risk"})
    case["cfg"]["limits"] = {"max_output_repairs": 10, "max_plan_context_rounds": 10,
        "max_step_context_rounds": 10, "max_step_attempts": 10, "max_review_rounds": 10,
        "max_plan_steps": 32, "max_llm_calls": 200, "max_total_tokens": 10000000}
    if stress:
        request = {"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}
        script(case, "planner", ["bad"] * 10 + [request] * 10 + [PLAN])
        rejected = {"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify",
            "replacements": [{"search": "never present", "replace": "nope"}]}]}
        revisions = [{"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify",
            "content": f"# Revision {n}\ndef add(a, b):\n    return a + b\n"}]} for n in range(10)]
        script(case, "implementer", ["bad"] * 10 + [request] * 10 + [rejected] * 9 + [EDIT] + revisions)
        changes = {**REVIEW, "verdict": "request_changes"}
        script(case, "reviewer", (["bad"] * 10 + [changes]) * 10 + ["bad"] * 10 + [REVIEW])
    else:
        case["cfg"]["limits"].update(max_plan_context_rounds=0, max_step_context_rounds=0,
            max_step_attempts=1, max_review_rounds=0, max_plan_steps=1)
        script(case, "planner", ["bad"] * 10 + [PLAN])
        script(case, "implementer", ["bad"] * 10 + [EDIT])
        script(case, "reviewer", ["bad"] * 10 + [REVIEW])
    code, status = begin(case)
    assert code == 0, status
    assert status["usage"]["calls"] == (182 if stress else 33)


def test_mixed_case_manifest_forces_auto_plan_gate(case):
    # Guard: planner.plan uses shared resolved case-insensitive is_dependency_manifest.
    case["cfg"].update(checks=[], allow_no_checks=True, approvals={"plan": "auto_low_risk"})
    (case["source"] / "Package.json").write_text("{}")
    plan = copy.deepcopy(PLAN)
    plan["plan"]["steps"][0]["files"] = [{"path": "Package.json", "action": "modify"}]
    script(case, "planner", [plan])
    code, status = begin(case)
    assert code == 3 and "dependency_manifest_change" in status["pending"]["risk_flags"], status


def test_detect_suggests_host_executable_checks_and_setup(case):
    # Guards: detect includes setup; fixed recipes require shutil.which on this host.
    import shutil
    (case["source"] / "package.json").write_text("{}")
    (case["source"] / "package-lock.json").write_text("{}")
    code, detected = cli("detect", "--source", case["source"])
    assert code == 0 and "setup" in detected
    assert all(shutil.which(c["argv"][0]) for c in [*detected["checks"], *detected["setup"]])
    if shutil.which("npm"):
        assert detected["setup"] == [{"id": "npm-ci", "argv": ["npm", "ci"], "network": True,
                                      "reason": "Detected package-lock.json"}]
        assert any(c["argv"] == ["npm", "test"] for c in detected["checks"])
    else:
        assert detected["setup"] == []

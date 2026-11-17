"""A check that was already red at baseline judges a step by the tests the step newly breaks."""
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_grounding import grounded as grounded  # noqa: PLC0414

from scranton_pipeline import routing
from scranton_pipeline.config import CheckConfig
from scranton_pipeline.nodes import planner, workflow
from scranton_pipeline.tools.checks import compare_with_baseline, failing_tests, run_checks
from scranton_pipeline.tools.repo_index import RepoIndex, detect_checks, detect_setup
from scranton_pipeline.tools.secrets import Redactor

OLD = ["imports the provider", "reads the Python history"]


def node_log(failing, passing=()):
    """node --test spec output: each failure inline, then again with its detail under "failing tests:"."""
    lines = [f"✔ {name} (1.2ms)" for name in passing] + [f"✖ {name} (0.8ms)" for name in failing]
    lines += ["ℹ tests 40", f"ℹ fail {len(failing)}", "", "✖ failing tests:", ""]
    for n, name in enumerate(failing):
        lines += [f"test at test\\x.test.js:{10 + n}:1", f"✖ {name} (0.8ms)", f"  AssertionError [ERR_ASSERTION]: detail of {name}", ""]
    return "\n".join(lines) + "\n"


def row(deps, label, text, status="failed", **updates):
    path = deps.run_dir / "artifacts" / "logs" / f"{label}-unit.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return {"id": "unit", "kind": "test", "required": True, "status": status, "exit_code": 1 if status == "failed" else 0,
            "duration_s": 1.0, "output_tail": text[-2000:], "log_path": str(path), **updates}


def setup(state, deps, monkeypatch, current, *, verified_by="review"):
    state["plan"]["acceptance_criteria"][0]["verified_by"] = verified_by
    state["baseline"] = [row(deps, "baseline", node_log(OLD))]
    monkeypatch.setattr(workflow, "checked", lambda *a, **kw: [current])
    monkeypatch.setattr(workflow, "scope_id", lambda *a: "step:fix")
    monkeypatch.setattr(type(deps), "repo", lambda *a: SimpleNamespace(changed_files=lambda *a: []))


def test_only_failures_already_at_baseline_let_the_step_pass(grounded, monkeypatch):
    state, deps = grounded
    current = row(deps, "verify", node_log(OLD))
    setup(state, deps, monkeypatch, current)
    update = workflow.verify(state, deps)
    assert update["feedback"] is None and update["steps_done"]
    assert routing.after_verify({**state, **update}) != "implement"
    (checked,) = update["checks"]
    assert checked["status"] == "failed" and checked["baseline_unchanged"] is True
    assert checked["baseline_comparison"] == {"new": [], "fixed": [], "still": 2}


def test_a_new_failure_blocks_and_the_feedback_leads_with_it(grounded, monkeypatch):
    state, deps = grounded
    current = row(deps, "verify", node_log([*OLD, "Chat rules stay in the chat view section"]))
    setup(state, deps, monkeypatch, current)
    update = workflow.verify(state, deps)
    assert routing.after_verify({**state, **update}) == "implement"
    text = "\n".join(update["feedback"]["details"])
    assert "did not fail at baseline (1): Chat rules stay in the chat view section" in text
    assert "still failing: 2" in text
    detail = text.split("detail of the first newly failing test")[1].split("output tail")[0]
    assert "test at test\\x.test.js:12:1" in detail and "detail of Chat rules stay" in detail
    assert "detail of imports the provider" not in detail
    assert "previous attempt" in update["feedback"]["message"]
    assert update["checks"][0]["baseline_unchanged"] is False


def test_a_criterion_verified_by_the_check_still_needs_it_to_pass(grounded, monkeypatch):
    state, deps = grounded
    current = row(deps, "verify", node_log(OLD))
    setup(state, deps, monkeypatch, current, verified_by="checks")
    update = workflow.verify(state, deps)
    assert routing.after_verify({**state, **update}) == "implement"
    assert update["checks"][0]["baseline_unchanged"] is False


@pytest.mark.parametrize("case", ["passed_baseline", "no_test_names", "log_at_cap", "missing_log", "timed_out"])
def test_no_comparison_without_two_complete_test_level_logs(grounded, case):
    _, deps = grounded
    base = row(deps, "baseline", node_log(OLD), status="passed" if case == "passed_baseline" else "failed")
    current = row(deps, "verify", "npm ERR! something broke\n" if case == "no_test_names" else node_log(OLD),
                  status="timed_out" if case == "timed_out" else "failed")
    limit = 5000000
    if case == "log_at_cap":
        limit = len(Path(current["log_path"]).read_bytes())
    if case == "missing_log":
        Path(base["log_path"]).unlink()
    assert compare_with_baseline(current, [base], run_dir=deps.run_dir, redactor=Redactor(), max_log_bytes=limit) is None


def test_runner_failure_lines_are_recognised_and_summaries_are_not():
    lines = [
        "✖ failing tests:", "✖ spec test (3.2ms)", "  ✖ nested subtest (0.1ms)", "not ok 3 - tap test # time=1",
        "FAILED tests/test_a.py::test_x - AssertionError", "ERROR tests/test_b.py - ImportError", "FAILED (failures=1)",
        "test parser::reads ... FAILED", "--- FAIL: TestSum (0.00s)", "  ● Suite › case"]
    text = "\n".join(lines)
    assert failing_tests(text) == {"spec test", "nested subtest", "tap test", "tests/test_a.py::test_x", "tests/test_b.py",
                                   "parser::reads", "TestSum", "Suite › case"}


def test_a_failure_already_at_baseline_does_not_stop_the_later_checks(tmp_path):
    ran = []

    class Box:
        def run(self, argv, **kw):
            ran.append(argv[0])
            return SimpleNamespace(timed_out=False, stopped=False, exit_code=1, duration_s=0.1, output_tail="")

    checks = [CheckConfig(id=i, argv=[i]) for i in ("first", "second", "third")]
    run_checks(checks, sandbox=Box(), log_dir=tmp_path, label="t", stop=None, tolerated={"first"})
    assert ran == ["first", "second"]
    ran.clear()
    run_checks(checks, sandbox=Box(), log_dir=tmp_path, label="t", stop=None)
    assert ran == ["first"]


def test_an_invalid_turn_keeps_the_feedback_it_was_answering(grounded):
    state, deps = grounded
    checks = {"kind": "checks_failed", "message": "Required checks failed", "details": ["unit: new failure X"]}
    first = planner.invalid({**state, "feedback": checks}, deps, "implement", "repairs:step:fix", "kind and payload disagree")
    assert first["feedback"]["kind"] == "output_invalid" and first["feedback"]["prior"] == checks
    second = planner.invalid({**state, "feedback": first["feedback"], "counters": {"repairs:step:fix": 1}}, deps, "implement",
                             "repairs:step:fix", "still invalid")
    assert second["feedback"]["prior"] == checks
    assert "prior" not in planner.invalid(state, deps, "plan", "repairs:plan", "bad")["feedback"]


def test_checks_are_suggested_only_for_manifests_in_the_root(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: name)
    manifests = [{"path": "package.json", "name": "package.json"}, {"path": "package-lock.json", "name": "package-lock.json"},
                 {"path": "engine/pyproject.toml", "name": "pyproject.toml"}, {"path": "src-tauri/Cargo.toml", "name": "Cargo.toml"}]
    index = RepoIndex(files=[], languages={}, manifests=manifests, symbols={}, readme_excerpt="", truncated=False)
    assert [c["id"] for c in detect_checks(index)] == ["npm-test"]
    assert [c["id"] for c in detect_setup(index)] == ["npm-ci"]

"""Check feedback is diagnostic data, never a check verdict or command."""
import json
from pathlib import Path

import pytest
from test_grounding import grounded as grounded  # noqa: PLC0414

from scranton_pipeline import routing
from scranton_pipeline.nodes import workflow
from scranton_pipeline.tools.secrets import Redactor


def result(deps, status="failed", **updates):
    path = deps.run_dir / "artifacts" / "logs" / "verify-unit.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    return {"id": "unit", "kind": "test", "required": True, "status": status,
            "exit_code": 1 if status == "failed" else None, "duration_s": 1.25,
            "output_tail": "progress\n" * 1024, "log_path": str(path), **updates}


def verify(state, deps, monkeypatch, row):
    monkeypatch.setattr(workflow, "checked", lambda *a, **kw: [row])
    update = workflow.verify(state, deps)
    assert update["checks"] == [row]
    assert "workspace" not in update and "steps_done" not in update
    assert routing.after_verify({**state, **update}) == "implement"
    text = "\n".join(update["feedback"]["details"])
    assert len(text.encode()) <= 24000
    text.encode().decode("utf-8")
    return text


@pytest.mark.parametrize("status", ["failed", "timed_out"])
@pytest.mark.parametrize("baseline", ["passed", "failed", "timed_out", None])
def test_current_and_matching_baseline_are_explicit_without_equivalence(grounded, monkeypatch, status, baseline):
    state, deps = grounded
    row = result(deps, status)
    state["baseline"] = [{"id": "other", "status": "passed"}]
    if baseline:
        state["baseline"].append({**row, "status": baseline})
    text = verify(state, deps, monkeypatch, row)
    assert f"current status={status}" in text
    assert f"exit_code={row['exit_code']}" in text and "duration_s=1.25" in text
    assert f"baseline status={baseline or 'unknown'}" in text
    assert ("pre-existing check failure" in text) == (baseline in {"failed", "timed_out"})
    assert "root cause" in text and "unknown" in text
    assert "equivalent" not in text and "identical" not in text


def test_early_assertion_survives_long_progress_tail_redacted_and_bounded(grounded, monkeypatch):
    state, deps = grounded
    secret = "feedback-private-credential-123456789"
    deps.redactor = Redactor([secret])
    row = result(deps, output_tail="é progress " * 20000 + secret)
    Path(row["log_path"]).write_text("Traceback (most recent call last):\n  File 'test.py', line 12\n    assert total == 5\nAssertionError: early-wrong-total " + secret + " password=private123\n" + "progress\n" * 50000, encoding="utf-8")
    text = verify(state, deps, monkeypatch, row)
    assert "early-wrong-total" in text and "assert total == 5" in text
    assert "Traceback" in text and "line 12" in text
    assert secret not in text and "private123" not in text and "[REDACTED]" in text
    assert "untrusted DATA" in text and "output tail" in text
    assert "bounded" in text
    assert not deps.events.path.exists() and not (deps.run_dir / "usage.jsonl").exists()


@pytest.mark.parametrize("location", ["missing", "outside", "relative", "malformed", "symlink", "directory-link", "summary", "binary"])
def test_log_fallback_never_discloses_outside_or_invents_assertions(grounded, monkeypatch, location):
    state, deps = grounded
    row = result(deps, output_tail="no detailed output")
    outside = deps.run_dir.parent / "private.log"
    outside.write_text("AssertionError: OUTSIDE_SENTINEL", encoding="utf-8")
    path = Path(row["log_path"])
    if location == "outside":
        row["log_path"] = str(outside)
    elif location == "relative":
        row["log_path"] = "artifacts/logs/verify-unit.log"
    elif location == "malformed":
        row["log_path"] = "bad\0path"
    elif location in {"symlink", "directory-link"}:
        try:
            if location == "symlink":
                path.symlink_to(outside)
            else:
                link = path.parent / "linked"
                link.symlink_to(outside.parent, target_is_directory=True)
                row["log_path"] = str(link / outside.name)
        except OSError:
            # Exercise path rejection even without Windows symlink privilege.
            original = Path.resolve
            monkeypatch.setattr(Path, "resolve", lambda self, *a, **kw: outside if self == path else original(self, *a, **kw))
    elif location == "summary":
        path.write_text("Ran 100 tests\nFAILED (failures=1)\n", encoding="utf-8")
    elif location == "binary":
        path.write_bytes(b"\xff\x00AssertionError: BINARY_SENTINEL")
    text = verify(state, deps, monkeypatch, row)
    assert "OUTSIDE_SENTINEL" not in text and "BINARY_SENTINEL" not in text
    assert "no useful early failure context" in text
    assert "AssertionError" not in text and "no detailed output" in text


def test_multiple_feedback_details_share_total_byte_cap(grounded, monkeypatch):
    state, deps = grounded
    rows = [result(deps, id=f"check{n}", output_tail="é" * 100000) for n in range(12)]
    monkeypatch.setattr(workflow, "checked", lambda *a, **kw: rows)
    update = workflow.verify(state, deps)
    assert len(update["feedback"]["details"]) == 12
    assert len("\n".join(update["feedback"]["details"]).encode()) <= 24000
    assert "TRUNCATED" in json.dumps(update["feedback"])


def test_empty_optional_passed_error_cancel_and_exhaustion_routing_unchanged(grounded, monkeypatch):
    state, deps = grounded
    for rows in ([], [result(deps, required=False)], [result(deps, "passed", exit_code=0)]):
        monkeypatch.setattr(workflow, "checked", lambda *a, rows=rows, **kw: rows)
        monkeypatch.setattr(workflow, "scope_id", lambda *a: "step:fix")
        monkeypatch.setattr(type(deps), "repo", lambda *a: type("Repo", (), {"changed_files": lambda *a: []})())
        assert workflow.verify(state, deps)["feedback"] is None
    row = result(deps, "error")
    monkeypatch.setattr(workflow, "checked", lambda *a, **kw: [row])
    assert workflow.verify(state, deps)["failure"]["code"] == "check_error"
    (deps.run_dir / "cancel").touch()
    assert workflow.verify(state, deps)["outcome"] == "cancelled"
    (deps.run_dir / "cancel").unlink()
    monkeypatch.setattr(workflow, "checked", lambda *a, **kw: [result(deps)])
    state["counters"] = {"attempts:step:fix": deps.cfg.limits.max_step_attempts}
    assert workflow.verify(state, deps)["replan_request"]["code"] == "checks_exhausted"


@pytest.mark.parametrize("missing", [False, True])
@pytest.mark.parametrize("line", ["--- FAIL TestSum: got 4 want 5", "  Expected 5, received 4 in sum.test.js"])
def test_fallback_uses_remaining_budget_for_ordinary_go_jest_tail(grounded, monkeypatch, missing, line):
    state, deps = grounded
    tail = "EARLIER_TAIL_DETAIL\n" + (line + "\n") * 100
    assert 2000 < len(tail.encode()) < 5000
    row = result(deps, output_tail=tail)
    if not missing:
        Path(row["log_path"]).write_text(tail, encoding="utf-8")
    text = verify(state, deps, monkeypatch, row)
    assert "no useful early failure context" in text
    assert "EARLIER_TAIL_DETAIL" in text and tail in text
    assert "current status=failed" in text and "baseline status=unknown" in text
    assert len(text.encode()) <= 6000


@pytest.mark.parametrize("cap", [-100, -1, 0, 1, 2, 3, 7, 10, 11, 12, 13, 31, 100])
@pytest.mark.parametrize("tail", [False, True])
@pytest.mark.parametrize("text", ["", "plain ASCII text that needs clipping", "é漢🙂" * 10])
def test_clip_strict_utf8_byte_bound(cap, tail, text):
    from scranton_pipeline.tools.checks import _clip

    clipped = _clip(text, cap, tail=tail)
    assert len(clipped.encode()) <= max(0, cap)
    assert clipped.encode().decode("utf-8") == clipped
    assert clipped == _clip(text, cap, tail=tail)
    if cap >= len(text.encode()):
        assert clipped == text


@pytest.mark.parametrize("count", [2000, 24000, 24001])
def test_extreme_check_counts_stay_bounded_and_deterministic(grounded, count):
    from scranton_pipeline.tools.checks import failure_feedback

    _, deps = grounded
    row = result(deps)
    rows = [row] * count
    kwargs = {"run_dir": deps.run_dir, "redactor": deps.redactor, "tail_bytes": 8192}
    details = failure_feedback(rows, [], **kwargs)
    assert len("\n".join(details).encode()) <= 24000
    assert details == failure_feedback(rows, [], **kwargs)
    if count > 24000:
        assert str(count) in details[0] and "omitted" in details[0]

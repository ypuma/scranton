"""R5 regression guards; production reversions are listed in r5/CHANGES.md."""
import copy
import json
from types import SimpleNamespace

import pytest

from scranton_pipeline import graph, routing, runner
from scranton_pipeline.demo.fixture import PLAN, config
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.nodes import parallel, workflow
from scranton_pipeline.nodes.common import Dependencies, cleanup_provider
from scranton_pipeline.observability import EventLog, UsageLedger
from scranton_pipeline.tools.fs import PathPolicy
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.process import StopSignal
from scranton_pipeline.tools.secrets import Redactor
from scranton_pipeline.waves import wave


def deps_at(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    workspace = run / "workspace"
    workspace.mkdir()
    return Dependencies(config(tmp_path), run, workspace, None, UsageLedger(run / "usage.jsonl"),
        EventLog(run / "events.jsonl", "test0001", Redactor()), StopSignal(run / "cancel"), Redactor(), trust_host=True)


def rows(deps):
    return [json.loads(s) for s in deps.events.path.read_text().splitlines()] if deps.events.path.exists() else []


def test_lane_inherits_deadline_and_does_not_sum_durations(tmp_path, monkeypatch):
    deps = deps_at(tmp_path)
    deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_active_seconds": 10})})
    monkeypatch.setattr(parallel, "lane_dependencies", lambda s, d: d)
    times = iter([100., 102., 102., 102., 102., 102.])
    monkeypatch.setattr(graph.time, "monotonic", lambda: next(times))
    state = {"plan": PLAN["plan"], "wave": {"number": 1, "indices": [0]}, "active_seconds": 9., "workspace": {}}
    # Dispatch epoch=100; lane entry=102 must include queue/wave wall time.
    monkeypatch.setattr(deps, "repo", lambda: SimpleNamespace(git_dir=tmp_path / "git"))
    lane = graph.lane_sends(state, deps)[0].arg
    result = graph.instrument("implement", lambda s, d: pytest.fail("Deadline was ignored"), deps)(lane)
    assert result["failure"]["code"] == "run_time_exhausted"
    assert "active_seconds" not in graph.LaneOutput.__annotations__


def test_cleanup_retries_and_warns_without_raising(tmp_path, monkeypatch):
    deps = deps_at(tmp_path)
    attempts = []
    def locked(path):
        attempts.append(path)
        raise PermissionError("locked")
    monkeypatch.setattr(parallel, "remove_lane", locked)
    monkeypatch.setattr(parallel.time, "sleep", lambda _: None)
    parallel.cleanup_lanes({"wave": {"number": 1, "indices": [0]}}, deps)
    assert len(attempts) == 6
    assert [e["data"]["code"] for e in rows(deps)] == ["cleanup_failed"] * 2


def test_link_fallback(tmp_path, monkeypatch):
    deps = deps_at(tmp_path)
    def links(_):
        raise EngineError(FailureClass.SECURITY, "lane_link", "contains links")
    monkeypatch.setattr(parallel, "workspace_bytes", links)
    assert not parallel.parallel_available(deps)
    assert [e["data"]["code"] for e in rows(deps)] == ["parallel_unavailable"]


def test_lane_baseline_tracks_only_parent_tree(tmp_path):
    deps = deps_at(tmp_path)
    (deps.workspace / "tracked.py").write_text("VALUE = 1\n")
    parent = deps.repo()
    WorkspaceRepo.init(deps.workspace, parent.git_dir)
    base = parent.commit_all("baseline")
    cache = deps.workspace / "__pycache__"
    cache.mkdir()
    (cache / "tracked.pyc").write_bytes(b"generated")
    state = {"lane": {"wave": 1, "slot": 0, "step_id": "x", "source_workspace": str(deps.workspace),
        "source_git_dir": str(parent.git_dir)}, "workspace": {"head_commit": base}}
    lane_deps = parallel.lane_dependencies(state, deps)
    result = parallel.lane_prepare(state, lane_deps)
    assert (lane_deps.workspace / "__pycache__" / "tracked.pyc").read_bytes() == b"generated"
    assert lane_deps.repo()._run(["ls-tree", "-r", "--name-only", result["workspace"]["base_commit"]]).strip() == "tracked.py"


def test_wave_case_aliases_and_dot_paths_already_rejected(tmp_path):
    from scranton_pipeline.models import PlanStep
    first = PlanStep.model_validate({**PLAN["plan"]["steps"][0], "depends_on": []})
    other = first.model_copy(update={"id": "other", "files": [first.files[0].model_copy(update={"path": "CALCULATOR.py"})]})
    assert wave([first, other], [], 2) == [0]
    with pytest.raises(EngineError, match="Invalid relative path"):
        PathPolicy(tmp_path, (), ()).normalize("./calculator.py")


def test_all_environment_credentials_registered(tmp_path, monkeypatch):
    deps = deps_at(tmp_path)
    (deps.run_dir / "run.json").write_text(json.dumps({"workspace": str(deps.workspace)}))
    secrets = {name: "opaque-value-" + str(i) for i, name in enumerate([
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OTHER_TOKEN", "OTHER_SECRET", "OTHER_PASSWORD"])}
    for name, value in secrets.items():
        monkeypatch.setenv(name, value)
    with runner.dependencies(deps.run_dir, deps.cfg, trust_host=True, models=False) as actual:
        text = " ".join(secrets.values())
        actual.events.emit("warning", message=text)
        assert all(v not in actual.redactor.redact(text) for v in secrets.values())
        assert all(v not in actual.events.path.read_text() for v in secrets.values())
        import logging

        from scranton_pipeline.observability import _JsonFormatter, write_status
        from scranton_pipeline.report import make_status, write_report
        state = {"run_id": "test0001", "task": text, "source_dir": str(tmp_path), "delivery_mode": "patch",
            "failure": EngineError(FailureClass.IMPLEMENTATION, "step_blocked", text).to_failure("implement")}
        write_status(actual.run_dir, make_status(state, actual))
        write_report(state, actual, status="failed")
        output = (actual.run_dir / "status.json").read_text() + (actual.run_dir / "delivery" / "report.json").read_text()
        output += (actual.run_dir / "delivery" / "report.md").read_text()
        output += _JsonFormatter().format(logging.makeLogRecord({"msg": text}))
        assert all(v not in output for v in secrets.values())


def test_provider_cleanup_only_call_directories(tmp_path):
    deps = deps_at(tmp_path)
    provider = deps.run_dir / "tmp" / "provider"
    stale = provider / "call-stale"
    stale.mkdir(parents=True)
    (stale / "request.json").write_text("private prompt")
    keep = provider / "keep"
    keep.mkdir()
    cleanup_provider(deps)
    assert not stale.exists() and keep.exists()


@pytest.mark.parametrize("lane", [False, True])
@pytest.mark.parametrize("budget,spent", [(0, 0), (1, 1)])
def test_no_replan_event_without_budget_and_failure_event(tmp_path, lane, budget, spent):
    deps = deps_at(tmp_path)
    deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_replans": budget})})
    state = {"mode": "step", "plan": PLAN["plan"], "step_index": 0,
        **({"lane": {"replans": spent}} if lane else {"counters": {"replans": spent}})}
    result = workflow.request_replan(state, deps, EngineError(FailureClass.IMPLEMENTATION, "step_blocked", "blocked"), "implement")
    assert result["failure"]["code"] == "step_blocked"
    assert [e["type"] for e in rows(deps)] == ([] if lane else ["failure"])


def test_replan_request_carries_failed_step_and_checks(tmp_path):
    deps = deps_at(tmp_path)
    checks = [{"id": "failed-lane-check", "status": "failed"}]
    state = {"mode": "step", "plan": PLAN["plan"], "step_index": 0, "checks": checks}
    request = workflow.request_replan(state, deps, EngineError(FailureClass.CHECKS_FAILED, "checks_exhausted", "lane check"), "verify")["replan_request"]
    assert request["scope"] == "step:fix"
    assert request["failed_step"]["id"] == "fix" and request["checks"] == checks


@pytest.mark.parametrize("deferred", [{"failure": {"code": "step_blocked"}}, {"replan_request": {"code": "step_blocked"}}, {"outcome": "cancelled"}])
def test_merge_defers_failed_lane_until_integration(deferred):
    state = {"mode": "integration", "wave": {"records": [{"step_id": "step:x"}], "deferred": deferred}}
    before = copy.deepcopy(state)
    assert routing.decision(routing.after_merge, state) == ("verify", "wave_merged")
    update = parallel.finish_integration(state)
    assert update["steps_done"] == state["wave"]["records"]
    assert not update["wave"]["records"]
    assert routing.after_verify({**state, **update}) == ("replan" if "replan_request" in deferred else "finalize")
    assert state == before


def test_usage_torn_tail_tolerated_in_status_and_report(tmp_path):
    from scranton_pipeline.report import make_status, write_report
    deps = deps_at(tmp_path)
    deps.ledger.record(role="planner", model="fake", input_tokens=1, output_tokens=2, ok=True, duration_s=0.)
    with deps.ledger.path.open("a") as stream:
        stream.write('{"partial":')
    state = {"run_id": "test0001", "task": "test", "source_dir": str(tmp_path), "delivery_mode": "patch"}
    assert make_status(state, deps).usage["calls"] == 1
    write_report(state, deps, status="failed")
    assert json.loads((deps.run_dir / "delivery" / "report.json").read_text())["usage"]["calls"] == 1


def test_merge_adds_wave_max_not_lane_sum(tmp_path, monkeypatch):
    deps = deps_at(tmp_path)
    monkeypatch.setattr(deps, "repo", lambda: SimpleNamespace(reset_hard=lambda _: None))
    state = {"wave": {"number": 1, "indices": []}, "plan": PLAN["plan"],
        "workspace": {"head_commit": "head", "green_commit": "green"},
        "lanes": {"a": {"active_seconds": 2.}, "b": {"active_seconds": 3.}}}
    result = parallel.merge_wave(state, deps)
    assert result["active_seconds"] == 3.
    assert result["workspace"]["green_commit"] == "green"
    assert not result.get("steps_done")


def test_integration_rollback_keeps_previous_done_steps(tmp_path):
    deps = deps_at(tmp_path)
    (deps.workspace / "x.txt").write_text("green")
    repo = WorkspaceRepo.init(deps.workspace, deps.repo().git_dir)
    green = repo.commit_all("green")
    (deps.workspace / "x.txt").write_text("unverified")
    head = repo.commit_paths(["x.txt"], "unverified")
    state = {"workspace": {"green_commit": green, "head_commit": head},
        "steps_done": [{"step_id": "step:previous"}], "wave": {"records": [{"step_id": "step:x"}]},
        "lanes": {"x": {"state": "merged"}}}
    update = parallel.rollback_integration(state, deps)
    assert update["workspace"]["head_commit"] == green
    assert (deps.workspace / "x.txt").read_text() == "green"
    assert update["lanes"]["x"]["state"] == "failed" and not update["wave"]["records"]
    assert "steps_done" not in update


def test_finalize_cleans_provider_and_survives_locked_lanes(tmp_path, monkeypatch):
    from scranton_pipeline.report import finalize_out_of_band
    deps = deps_at(tmp_path)
    stale = deps.run_dir / "tmp" / "provider" / "call-finalize"
    stale.mkdir(parents=True)
    (stale / "request.json").write_text("private prompt")
    def locked(path):
        raise PermissionError("locked")
    monkeypatch.setattr(parallel, "remove_lane", locked)
    monkeypatch.setattr(parallel.time, "sleep", lambda _: None)
    state = {"run_id": "test0001", "task": "test", "source_dir": str(tmp_path), "delivery_mode": "patch",
        "wave": {"number": 1, "indices": [0]}}
    assert finalize_out_of_band(state, deps)["outcome"] == "succeeded"
    assert json.loads((deps.run_dir / "status.json").read_text())["status"] == "succeeded"
    assert not stale.exists()
    assert sum(e["type"] == "warning" and e["data"].get("code") == "cleanup_failed" for e in rows(deps)) == 2

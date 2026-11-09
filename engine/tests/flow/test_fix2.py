"""Final review regressions; each Guard names the production line to revert."""
import json
import os
import subprocess
import sys
import time
from dataclasses import replace

import pytest

from scranton_pipeline import routing
from scranton_pipeline.agents.gateway import ChatModelGateway, json_system
from scranton_pipeline.agents.prompts import (
    build_implementer_prompt,
    build_planner_prompt,
    build_reviewer_prompt,
)
from scranton_pipeline.config import EngineConfig
from scranton_pipeline.demo.fixture import PLAN
from scranton_pipeline.errors import EngineError, SuspendRequested
from scranton_pipeline.models import PlannerTurn
from scranton_pipeline.nodes.common import Dependencies
from scranton_pipeline.observability import EventLog
from scranton_pipeline.tools.process import StopSignal, run_process, scrubbed_env
from scranton_pipeline.tools.secrets import Redactor

from .conftest import cli, decision
from .test_command_provider import model


def test_gateway_preserves_command_suspend(tmp_path):
    # Guard A: gateway.complete except tuple includes SuspendRequested.
    stop = StopSignal(tmp_path / "cancel")
    stop.request_suspend()
    chat, cfg, _, ledger = model(tmp_path, "timeout", stop=stop)
    engine = EngineConfig(models={r: cfg for r in ("planner", "implementer", "reviewer")}, allow_no_checks=True)
    gateway = ChatModelGateway({"planner": chat}, engine, ledger, EventLog(tmp_path / "events", "suspend1", Redactor()))
    with pytest.raises(SuspendRequested):
        gateway.complete("planner", system="s", user="u", schema=PlannerTurn)
    assert ledger.totals().calls == 1
    assert not list((tmp_path / "tmp/provider").iterdir())


def test_parent_eof_during_command_resumes(case):
    # Guard A: removing SuspendRequested from gateway.complete turns exit 5 into failed/exit 4.
    provider, marker = case["tmp"] / "slow.py", case["tmp"] / "started"
    provider.write_text('''import json, sys, time
from pathlib import Path
marker = Path(sys.argv[1])
if not marker.exists():
    marker.touch()
    time.sleep(60)
Path(sys.argv[-1]).write_text(json.dumps({"text": sys.argv[2], "usage": None}))
''')
    case["cfg"]["models"]["planner"] = {"provider": "command", "model": "test", "command":
        [sys.executable, str(provider), str(marker), json.dumps(PLAN)]}
    case["config"].write_text(json.dumps(case["cfg"]))
    proc = subprocess.Popen([sys.executable, "-m", "scranton_pipeline", "run", "--source", str(case["source"]),
        "--task", "Fix addition", "--config", str(case["config"]), "--run-root", str(case["root"]),
        "--run-id", "test0001", "--trust-host", "--parent-guard"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 30
        while not marker.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert marker.exists(), "provider was never entered"
        proc.stdin.close()
        proc.stdin = None
        stdout, stderr = proc.communicate(timeout=20)
        status = json.loads(stdout)
        assert proc.returncode == 5 and status["status"] == "suspended" and status["resumable"], (stdout, stderr)
        assert not list((case["root"] / "test0001/tmp/provider").iterdir())
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
    code, status = cli("resume", "--run-dir", case["root"] / "test0001", "--trust-host")
    assert code == 3 and status["pending"]["gate"] == "plan", status
    code, status = decision(case, status)
    assert code == 0 and status["status"] == "succeeded", status
    routes = [json.loads(line) for line in (case["root"] / "test0001/events.jsonl").read_text().splitlines()
              if json.loads(line)["type"] == "route"]
    assert routes and all(row["data"]["reason"] != "state" for row in routes)


@pytest.mark.parametrize("text", ["Authorization: Basic dXNlcjpwYXNz", "password=x;", "api_key=x&"])
def test_redactor_terminators_and_basic(text):
    # Guard D: authorization scheme+credential pattern and ;/& credential terminators.
    assert Redactor().redact(text) in ("[REDACTED]", "[REDACTED];", "[REDACTED]&")
    assert Redactor().redact("password = get_password() and self.token.value") == "password = get_password() and self.token.value"


@pytest.mark.parametrize("builder", [build_planner_prompt, build_implementer_prompt, build_reviewer_prompt])
def test_prompt_controls_precede_bulk_and_schema_is_budgeted(case, builder):
    # Guard E: bounded controls-first ordering, capped check tails and json_system before cap.
    case["cfg"]["limits"] = {"max_prompt_bytes": 16000}
    cfg = EngineConfig.model_validate(case["cfg"])
    state = {"task": "bulk" * 100000, "plan": PLAN["plan"], "step_index": 0,
             "feedback": {"kind": "output_invalid", "message": "CONTROL_SENTINEL"},
             "baseline": [{"output_tail": "TAIL" * 100000}], "checks": [{"output_tail": "TAIL" * 100000}]}
    system, user = builder(state, cfg)
    assert "CONTROL_SENTINEL" in user
    if builder is not build_reviewer_prompt:
        assert '"context_rounds_left"' in user
    else:
        assert '"criteria"' in user
    assert "TRUNCATED" in user
    assert len((system + user).encode()) <= cfg.limits.max_prompt_bytes
    assert "Return one JSON object matching:" in system
    assert system.count("Return one JSON object matching:") == 1


def test_gateway_schema_part_of_actual_wire_budget(tmp_path):
    # Guard E: complete uses json_system, caps user and estimates the actual schema-bearing input.
    chat, cfg, observed, ledger = model(tmp_path, "no_usage")
    engine = EngineConfig(models={r: cfg for r in ("planner", "implementer", "reviewer")}, allow_no_checks=True,
                          limits={"max_prompt_bytes": 10000})
    gateway = ChatModelGateway({"planner": chat}, engine, ledger, EventLog(tmp_path / "events", "budget01", Redactor()))
    gateway.complete("planner", system="rules", user="x" * 10000, schema=PlannerTurn)
    request = json.loads(observed.read_text())["request"]
    assert len((request["system"] + request["user"]).encode()) <= 10000
    assert request["system"] == json_system("rules", PlannerTurn)
    assert ledger.totals().input_tokens == 2500


@pytest.mark.skipif(os.name != "nt", reason="Windows shim aliases")
@pytest.mark.parametrize("suffix", [".", " ", ". "])
def test_windows_shim_alias_cannot_bypass_allowlist(tmp_path, suffix):
    # Guard F: run_process normalises name before which/suffix classification.
    shim = tmp_path / "safe.cmd"
    shim.write_text("@echo off\necho ok\n")
    with pytest.raises(EngineError) as error:
        run_process([str(shim) + suffix, "a&b"], cwd=tmp_path, env=scrubbed_env(os.environ, []), timeout_s=2)
    assert error.value.code == "unsafe_shim_arguments"
    assert run_process([str(shim) + suffix, "safe"], cwd=tmp_path, env=scrubbed_env(os.environ, []), timeout_s=2).exit_code == 0


def test_git_timeout_and_warning_once_across_dependencies(case, monkeypatch):
    # Guards F/G: Dependencies.repo warning dedupe and timeout_s; WorkspaceRepo.init forwards timeout.
    from scranton_pipeline.tools import git
    from scranton_pipeline.tools.process import ProcResult
    chat, cfg, _, ledger = model(case["tmp"])
    engine = EngineConfig(models={r: cfg for r in ("planner", "implementer", "reviewer")}, allow_no_checks=True,
                          limits={"git_timeout_s": 1.25})
    events = EventLog(case["tmp"] / "events", "warning1", Redactor())
    deps = Dependencies(engine, case["tmp"], case["source"], chat, ledger, events, StopSignal(case["tmp"] / "cancel"), Redactor())
    (case["source"] / ".git").mkdir()
    calls = []
    def run(*args, **kwargs):
        calls.append(kwargs["timeout_s"])
        return ProcResult(0, False, False, 0, "", 0, None)
    monkeypatch.setattr(git, "run_process", run)
    deps.repo().head()
    deps.repo().head()
    replace(deps, git_warning_emitted=False).repo().head()
    git.WorkspaceRepo.init(case["tmp"] / "other", timeout_s=1.25).head()
    assert calls == [1.25] * 5
    assert events.path.read_text().count('"workspace_git_ignored"') == 1


def test_workflow_configured_git_and_check_limits(case, monkeypatch):
    # Guards G: prepare_workspace init timeout and checked -> run_checks -> sandbox -> run_process bounds.
    from scranton_pipeline.nodes import workflow
    from scranton_pipeline.runner import start
    from scranton_pipeline.tools import git
    calls = []
    original = git.run_process
    def capture(*args, **kwargs):
        calls.append(kwargs["timeout_s"])
        return original(*args, **kwargs)
    monkeypatch.setattr(git, "run_process", capture)
    case["cfg"]["limits"] = {"git_timeout_s": 1.5, "max_output_tail_bytes": 23, "max_log_bytes": 37}
    case["cfg"]["checks"][0]["argv"] = [sys.executable, "-c", "print('z'*10000); raise SystemExit(1)"]
    cfg = EngineConfig.model_validate(case["cfg"])
    # The real baseline executes through every layer; no fake sandbox hides dropped kwargs.
    status = start(source=case["source"], task="Fix", cfg=cfg, run_root=case["root"], run_id="bounds01", trust_host=True)
    assert status.status == "awaiting_approval"
    assert calls and all(t == 1.5 for t in calls)
    log = case["root"] / "bounds01/artifacts/logs/baseline-unit.log"
    assert log.stat().st_size <= 37
    assert len(status.checks[0]["output_tail"].encode()) <= 23
    assert workflow.checked


ROUTES = [
    (routing.after_prepare, {}, ["index_repo", "baseline_checks"], "workspace_ready"),
    (routing.after_plan, {"plan_requests": [{}]}, "plan_context", "need_context"),
    (routing.after_plan, {}, "plan", "output_invalid"),
    (routing.after_plan, {"plan": {"summary": "x"}}, "approve_plan", "plan_valid"),
    (routing.after_approve_plan, {}, "select_step", "approved"),
    (routing.after_select, {"step_index": 0, "plan": {"steps": [{}]}}, "implement", "next_step"),
    (routing.after_select, {"step_index": 0}, "review", "all_steps_done"),
    (routing.after_select, {"step_index": 0, "review": {"verdict": "disabled"}}, "package", "all_steps_done"),
    (routing.after_implement, {"step_requests": [{}]}, "implement_context", "need_context"),
    (routing.after_implement, {"pending_edits": {"kind": "edits"}}, "apply_edits", "edits"),
    (routing.after_implement, {}, "implement", "output_invalid"),
    (routing.after_apply, {"feedback": {"kind": "edits_rejected"}}, "implement", "edits_rejected"),
    (routing.after_apply, {}, "verify", "edits_applied"),
    (routing.after_verify, {"feedback": {"kind": "checks_failed"}}, "implement", "checks_failed"),
    (routing.after_verify, {"mode": "revision"}, "review", "checks_passed"),
    (routing.after_verify, {}, "select_step", "checks_passed"),
    (routing.after_review, {}, "review", "output_invalid"),
    (routing.after_review, {"review": {"verdict": "approve"}}, "package", "review_approved"),
    (routing.after_review, {"review": {"verdict": "request_changes"}}, "implement", "changes_requested"),
    (routing.after_package, {"delivery_mode": "apply"}, "approve_delivery", "delivery_apply"),
    (routing.after_package, {}, "finalize", "delivery_patch"),
    (routing.after_delivery, {"delivery_approval": {"decision": "approve"}}, "apply_to_source", "approved"),
    (routing.after_delivery, {}, "finalize", "declined"),
]


@pytest.mark.parametrize("route,state,target,reason", ROUTES)
def test_route_target_reason_pair(route, state, target, reason):
    # Guard G: decision() returns target and deciding fact together; graph uses this pair, not reason='state'.
    assert routing.decision(route, state) == (target, reason)
    assert route(state) == target
    for control, why in [("failure", "failure"), ("cancelled", "cancelled"), ("rejected", "rejected")]:
        terminal = {**state, **({"failure": {"code": "x"}} if control == "failure" else {"outcome": control})}
        assert routing.decision(route, terminal) == ("finalize", why)

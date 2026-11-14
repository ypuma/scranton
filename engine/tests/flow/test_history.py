"""Real runner, checkpoints and separate-process resumes; scripted providers only."""
import json

import pytest

from scranton_pipeline import runner
from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.config import EngineConfig, load_config
from scranton_pipeline.demo.fixture import PLAN
from scranton_pipeline.graph import build_graph

from .conftest import cli, script


def history(case):
    value = {"schema": 1, "runs": [{"run_id": "failed001", "status": "failed", "task": "Build visualization", "plan": "Read tests before implementing visualization", "outcome": "Unread existing test after attempts. delivery applied=false; no delivered edits. token=oldprivate123"}, {"run_id": "answer001", "status": "succeeded", "task": "What failed?", "plan": "", "outcome": "Informational reply only; previous task not completed."}], "truncated": False}
    path = case["tmp"] / "history.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def checkpoint(directory):
    with runner.dependencies(directory, load_config(directory / "config.json"), trust_host=True, models=False) as deps:
        return build_graph(deps).get_state({"configurable": {"thread_id": directory.name}}).values


@pytest.mark.parametrize("data", ["{", " " * 32769, '{"schema":1,"runs":[],"truncated":false}', '{"schema":1,"runs":[],"truncated":false,"approval":true}'])
def test_cli_rejects_history_before_creating_run_or_workspace(case, data):
    path = case["tmp"] / "history.json"
    path.write_text(data, encoding="utf-8")
    workspace = case["tmp"] / "workspaces"
    code, result = cli("run", "--source", case["source"], "--task", "continue", "--config", case["config"],
                       "--run-root", case["root"], "--workspace-root", workspace, "--run-id", "history1",
                       "--history-file", path, "--trust-host")
    assert code == 2 and result["failure"]["code"] == "invalid_history"
    assert not case["root"].exists() and not workspace.exists()


def test_followup_handoff_fresh_reads_fresh_gate_and_restart(case, monkeypatch):
    path = history(case)
    case["cfg"]["grounding"] = {"mode": "enforce"}
    script(case, "planner", [{"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}, PLAN])
    seen = []
    original = ChatModelGateway.complete
    def capture(self, role, **kwargs):
        seen.append((role, kwargs["user"]))
        return original(self, role, **kwargs)
    monkeypatch.setattr(ChatModelGateway, "complete", capture)
    status = runner.start(source=case["source"], task="continue", cfg=EngineConfig.model_validate(case["cfg"]),
                          run_root=case["root"], run_id="history1", trust_host=True, history_file=path)
    assert status.status == "awaiting_approval", status
    assert status.pending["gate"] == "plan"
    directory = case["root"] / "history1"
    saved = json.loads((directory / "run.json").read_text())
    assert saved["task"] == "continue" and "oldprivate123" not in json.dumps(saved)
    assert saved["cross_run_history"]["runs"][0]["task"] == "Build visualization"
    for role, text in seen:
        assert role == "planner"
        assert "Build visualization" in text and "Unread existing test" in text
        assert "Informational reply only" in text and "fresh file reads" in text
        assert '"task": "continue"' in text and '"previous_plan": null' in text
    state = checkpoint(directory)
    assert state["cross_run_history"] == saved["cross_run_history"]
    assert state["steps_done"] == [] and not state.get("plan_approval")
    assert not state.get("delivery_approval") and not state.get("previous_plan")
    assert state["plan_evidence"] and all(r["evidence_id"].startswith("E-") for r in state["plan_evidence"])
    assert not (directory / "delivery/candidate.diff").exists()
    path.unlink()
    code, result = cli("resume", "--run-dir", directory, "--gate", "plan", "--decision", "approve",
                       "--digest", status.pending["digest"], "--trust-host")
    assert code == 0 and result["status"] == "succeeded", result
    assert checkpoint(directory)["cross_run_history"] == saved["cross_run_history"]
    assert "return a - b" in (case["source"] / "calculator.py").read_text()


def test_suspended_planner_keeps_snapshot_after_external_file_removed(case, monkeypatch):
    path = history(case)
    case["cfg"]["limits"]["max_transient_attempts"] = 1
    script(case, "planner", [{"__error__": "transient"}, PLAN])
    case["config"].write_text(json.dumps(case["cfg"]))
    code, status = cli("run", "--source", case["source"], "--task", "continue", "--config", case["config"],
                       "--run-root", case["root"], "--run-id", "restart1", "--history-file", path, "--trust-host")
    assert code == 5 and status["status"] == "suspended", status
    path.unlink()
    captured = []
    original = ChatModelGateway.complete
    def capture(self, role, **kwargs):
        captured.append(kwargs["user"])
        return original(self, role, **kwargs)
    monkeypatch.setattr(ChatModelGateway, "complete", capture)
    directory = case["root"] / "restart1"
    status = runner.resume(directory, trust_host=True)
    assert status.status == "awaiting_approval", status
    assert captured and all("Build visualization" in p and "Unread existing test" in p for p in captured)
    assert checkpoint(directory)["cross_run_history"]["runs"][0]["run_id"] == "failed001"


def test_legacy_no_history_cli_and_resume_stay_clean(case):
    # An unrelated new run does not discover neighbouring snapshots itself.
    history(case)
    code, status = cli("run", "--source", case["source"], "--task", "Fix addition", "--config", case["config"],
                       "--run-root", case["root"], "--run-id", "legacy01", "--trust-host")
    assert code == 3
    directory = case["root"] / "legacy01"
    assert "cross_run_history" not in json.loads((directory / "run.json").read_text())
    assert not checkpoint(directory).get("cross_run_history")
    code, status = cli("resume", "--run-dir", directory, "--gate", "plan", "--decision", "reject",
                       "--digest", status["pending"]["digest"], "--trust-host")
    assert code == 6 and status["status"] == "rejected"

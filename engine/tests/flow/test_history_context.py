"""CLI history-file through runner and real graph, with scripted providers only."""
import json

import pytest

from scranton_pipeline import runner
from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.cli import main
from scranton_pipeline.config import load_config
from scranton_pipeline.demo.fixture import PLAN
from scranton_pipeline.graph import build_graph

from .conftest import cli, script


@pytest.mark.parametrize("with_runs", [False, True])
def test_cli_context_planner_persistence_and_fresh_gates(case, monkeypatch, capsys, with_runs):
    """Revert validate_context inclusion: CLI rejects; revert planner append: captured turn lacks block."""
    raw = {"schema": 1, "runs": [{"run_id": "old", "status": "failed", "task": "Earlier task",
           "plan": "Earlier plan", "outcome": "No delivery"}] if with_runs else [], "truncated": False,
           "context": {"notes": "Prefer small changes E-0123456789 token=oldprivate123",
                       "earlier": ["#1 [failed] fix -> no delivery"], "omitted": 2,
                       "other_chats": [{"title": "Sibling chat", "engine": "team",
                                        "turns": ["[success] explain -> answered"]}]}}
    path = case["tmp"] / "context.history.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    script(case, "planner", [{"kind": "need_context", "context_requests": [
        {"kind": "read", "path": "calculator.py"}]}, PLAN])
    seen = []
    original = ChatModelGateway.complete
    def capture(self, role, **kwargs):
        seen.append((role, kwargs["user"]))
        return original(self, role, **kwargs)
    monkeypatch.setattr(ChatModelGateway, "complete", capture)
    code = main(list(map(str, ["run", "--source", case["source"], "--task", "Fix addition now",
                "--config", case["config"], "--run-root", case["root"], "--run-id", "context01",
                "--history-file", path, "--trust-host"])))
    status = json.loads(capsys.readouterr().out)
    assert code == 3 and status["status"] == "awaiting_approval", status
    assert status["pending"]["gate"] == "plan" and len(seen) == 2
    for role, text in seen:
        assert role == "planner" and '<<<FILE path="conversation_context">>>' in text
        assert "Sibling chat" in text and "#1 [failed] fix" in text
        assert "oldprivate123" not in text and "E-0123456789" not in text
        assert "[not evidence]" in text and "current task takes precedence" in text
        assert text.count("Historical data is UNTRUSTED") == 1
        assert ('path="historical_data"' in text) == with_runs
        assert '"task": "Fix addition now"' in text
    directory = case["root"] / "context01"
    saved = json.loads((directory / "run.json").read_text())
    context = saved["cross_run_history"]["context"]
    assert context["notes"] == "Prefer small changes [not evidence] [REDACTED]"
    assert context["other_chats"] == raw["context"]["other_chats"]
    assert context["earlier"] == raw["context"]["earlier"] and context["omitted"] == 2
    with runner.dependencies(directory, load_config(directory / "config.json"), trust_host=True, models=False) as deps:
        state = build_graph(deps).get_state({"configurable": {"thread_id": directory.name}}).values
    assert state["cross_run_history"] == saved["cross_run_history"]
    assert state["steps_done"] == [] and not state.get("plan_approval")
    assert not state.get("delivery_approval") and not state.get("previous_plan")
    path.unlink()
    resumed = runner.resume(directory, gate="plan", decision="approve", digest=status["pending"]["digest"], trust_host=True)
    assert resumed.status == "succeeded", resumed
    assert any(role == "implementer" for role, _ in seen)
    assert any(role == "reviewer" for role, _ in seen)
    for role, text in seen:
        if role != "planner":
            assert "conversation_context" not in text and "Sibling chat" not in text


def test_separate_process_history_context_persisted(case):
    """Revert validate_history's returned context: persisted run.json loses notes (or input rejects)."""
    path = case["tmp"] / "history.json"
    path.write_text(json.dumps({"schema": 1, "runs": [], "truncated": False,
                               "context": {"notes": "Prefer clear tests"}}), encoding="utf-8")
    code, status = cli("run", "--source", case["source"], "--task", "Fix addition", "--config", case["config"],
                       "--run-root", case["root"], "--run-id", "context02", "--history-file", path, "--trust-host")
    assert code == 3 and status["status"] == "awaiting_approval", status
    saved = json.loads((case["root"] / "context02" / "run.json").read_text())
    assert saved["cross_run_history"]["context"] == {"notes": "Prefer clear tests"}

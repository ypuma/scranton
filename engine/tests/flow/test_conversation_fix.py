"""Conversation acceptance and crash consistency regressions (scripted only)."""
import copy
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from scranton_pipeline import report, runner
from scranton_pipeline.agents.prompts import build_planner_prompt
from scranton_pipeline.config import EngineConfig
from scranton_pipeline.graph import build_graph
from scranton_pipeline.models import PlannerTurn
from scranton_pipeline.nodes import planner, workflow
from scranton_pipeline.observability import _rows, read_status

from .conftest import begin, cli, decision, script
from .test_conversation import answer_turn, reply
from .test_replan import WRONG, setup_replan


@pytest.mark.parametrize("state", [
    {"plan_revision": 1}, {"steps_done": [{"step_id": "step:old"}]},
    {"step_index": 0}, {"counters": {"attempts:step:fix": 1}},
    {"counters": {"replans": 1}}, {"history": [{"node": "implement"}]},
])
def test_later_planner_never_offers_answer(case, state):
    cfg = EngineConfig.model_validate({**case["cfg"], "conversation": True})
    system = build_planner_prompt({"task": "Fix", **state}, cfg).system
    assert "kind answer" not in system
    assert '"ConversationPlannerTurn"' not in system
    seen = []
    def complete(role, **kw):
        seen.append(kw["schema"])
        return SimpleNamespace(parsed=kw["schema"].model_validate({"kind": "answer", "answer": {"text": "No edits"}}))
    deps = SimpleNamespace(cfg=cfg, procedure=None, gateway=SimpleNamespace(complete=complete), procedure_event=lambda *a: None)
    update = planner.plan({"task": "Fix", **state}, deps)
    assert seen == [PlannerTurn]
    assert update["feedback"]["kind"] == "output_invalid" and "answer" not in update


def test_failed_step_replanner_answer_keeps_legacy_partial(case):
    projections = []
    for conversation in (False, True):
        case["root"] = case["tmp"] / ("on" if conversation else "off")
        case["cfg"]["conversation"] = conversation
        setup_replan(case, [WRONG], first_green=True)
        path = Path(case["cfg"]["models"]["planner"]["script_path"])
        original = json.loads(path.read_text())[0]
        answer = {"kind": "answer", "answer": {"text": "Pretend success"}}
        script(case, "planner", [original, answer, answer, answer])
        _, status = begin(case)
        code, status = decision(case, status)
        assert code == 4 and status["status"] == "failed", status
        assert status["failure"]["code"] == "output_invalid"
        directory = case["root"] / "test0001"
        diff = (directory / "delivery/partial.diff").read_bytes()
        assert b"+GREEN" in diff and b"FAILED ATTEMPT" not in diff
        assert status["progress"]["steps_done"] == 1
        record = json.loads((directory / "delivery/report.json").read_text())
        assert len(record["steps"]) == 1
        projections.append((diff, status["delivery"]["files"], record["changed_files"]))
        if conversation:
            reply(directory, status, "result")
            assert not any(e["data"].get("text") == "Pretend success" for e in _rows(directory / "events.jsonl"))
    assert projections[0] == projections[1]


@pytest.mark.parametrize("context", [False, True])
def test_answer_citations_optional_even_with_evidence(case, context):
    case["cfg"].update(conversation=True, grounding={"mode": "enforce"})
    read, answer = answer_turn(case)
    answer["answer"]["citations"] = []
    script(case, "planner", [read, answer] if context else [answer])
    code, status = begin(case)
    assert code == 0, status
    directory = case["root"] / "test0001"
    assert reply(directory, status, "answer")["citations"] == []
    outputs = [r for r in _rows(directory / "grounding.jsonl") if r.get("type") == "output"]
    assert outputs[-1]["accepted"] and outputs[-1]["violations"] == []
    assert any(i.startswith("E-") for i in outputs[-1]["shown"]) == context


@pytest.mark.parametrize("role,reason", [
    ("planner", "grounding"), ("planner", "semantic"), ("planner", "budget"),
    ("implementer", "grounding"), ("implementer", "budget"),
    ("reviewer", "grounding"), ("reviewer", "semantic"),
])
def test_rejected_turns_are_not_messages(case, role, reason):
    case["cfg"]["conversation"] = True
    begin(case)
    directory = case["root"] / "test0001"
    cfg = EngineConfig.model_validate(case["cfg"])
    cfg = cfg.model_copy(update={"grounding": cfg.grounding.model_copy(update={"mode": "enforce"})})
    with runner.dependencies(directory, cfg, trust_host=True, models=False) as deps:
        state = build_graph(deps).get_state({"configurable": {"thread_id": directory.name}}).values
        state = {**state, "step_index": 0, "plan_revision": 0}
        raw = {"kind": "need_context", "context_requests": [{"kind": "read", "path": ".env"}]}
        if reason == "budget":
            raw["context_requests"][0]["path"] = "calculator.py"
            state["counters"] = {"plan_context:r0" if role == "planner" else "context:step:fix": 10}
        if role == "planner" and reason == "semantic":
            raw = {"kind": "plan", "plan": copy.deepcopy(state["plan"])}
            raw["plan"]["steps"].append(copy.deepcopy(raw["plan"]["steps"][0]))
        if role == "reviewer":
            state["plan"]["acceptance_criteria"][0]["verified_by"] = "review"
            raw = {"verdict": "approve", "summary": "Rejected reviewer", "criteria": []}
            if reason == "grounding":
                raw["criteria"] = [{"id": "sum", "status": "met", "citations": ["H-0000000000"]}]
        deps.gateway = SimpleNamespace(complete=lambda *a, **kw: SimpleNamespace(parsed=kw["schema"].model_validate(raw)))
        before = sum(e["type"] == "agent_message" for e in _rows(directory / "events.jsonl"))
        node = {"planner": planner.plan, "implementer": workflow.implement, "reviewer": workflow.review}[role]
        update = node(state, deps)
        assert update.get("feedback", {}).get("kind") == "output_invalid", update
        after = sum(e["type"] == "agent_message" for e in _rows(directory / "events.jsonl"))
        assert after == before, "Rejected turn emitted an accepted role message"


@pytest.mark.parametrize("point", ["receipt", "file", "reply", "finished", "status"])
def test_finalize_crash_resume_converges(case, point):
    case["cfg"]["conversation"] = True
    _, status = begin(case)
    directory = case["root"] / "test0001"
    hook = case["tmp"] / "crash-finalize.py"
    hook.write_text('''import os, sys
from scranton_pipeline import report
from scranton_pipeline.observability import EventLog
from scranton_pipeline.cli import main
point = sys.argv[1]
write = report.write_bytes_atomic
emit = EventLog.emit
def crash_write(path, data):
    write(path, data)
    if (point == "receipt" and path.name == "final-status.json") or (point == "file" and path.name == "reply.json"):
        os._exit(91)
def crash_emit(self, event_type, **kw):
    result = emit(self, event_type, **kw)
    if (point == "reply" and event_type == "run_reply") or (point == "finished" and event_type == "run_finished"):
        os._exit(91)
    return result
from scranton_pipeline import observability
original_status = observability.write_status
def crash_status(run_dir, status):
    original_status(run_dir, status)
    if point == "status" and status.status in {"succeeded", "failed", "rejected", "cancelled"}:
        os._exit(91)
report.write_bytes_atomic = crash_write
EventLog.emit = crash_emit
observability.write_status = crash_status
raise SystemExit(main(sys.argv[2:]))
''')
    proc = subprocess.run([sys.executable, str(hook), point, "resume", "--run-dir", str(directory), "--trust-host",
        "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]],
        check=False, capture_output=True, env=os.environ, timeout=60)
    assert proc.returncode == 91, proc.stderr
    if point != "status":
        assert read_status(directory).status not in runner.TERMINAL
    code, status = cli("resume", "--run-dir", directory, "--trust-host")
    assert code == 0, status
    value = reply(directory, status, "result")
    calls = status["usage"]["calls"]
    (directory / "delivery/reply.json").unlink()
    status = resume_terminal(directory)
    assert reply(directory, status.model_dump(), "result") == value
    assert status.usage["calls"] == calls
    with runner.dependencies(directory, EngineConfig.model_validate(case["cfg"]), trust_host=True, models=False) as deps:
        state = build_graph(deps).get_state({"configurable": {"thread_id": directory.name}}).values
        report.finalize_out_of_band(state, deps)
    assert reply(directory, read_status(directory).model_dump(), "result") == value


def resume_terminal(directory):
    return runner.resume(directory, trust_host=True)


def test_docs_state_optional_citations():
    engine = Path(__file__).resolve().parents[2]
    for path in (engine / "README.md", engine / "docs/ARCHITECTURE.md"):
        assert "Citations sind optional" in path.read_text(encoding="utf-8"), path

"""Scripted conversation protocol; legacy projections plus typed dreaming events."""
import hashlib
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from scranton_pipeline.agents.prompts import build_planner_prompt
from scranton_pipeline.conversation import agent_message, terminal_reply
from scranton_pipeline.demo.fixture import config, run_demo
from scranton_pipeline.grounding import context_id
from scranton_pipeline.models import ContextRequest, ConversationPlannerTurn, PlannerTurn
from scranton_pipeline.observability import EventLog, _rows
from scranton_pipeline.runner import resume
from scranton_pipeline.tools.fs import read_text, sha256_file
from scranton_pipeline.tools.secrets import Redactor

from .conftest import begin, cli, decision, script


def reply(run_dir, status, kind):
    events = _rows(run_dir / "events.jsonl")
    finished = [i for i, e in enumerate(events) if e["type"] == "run_finished"]
    assert len(finished) == 1
    assert sum(e["type"] == "run_reply" for e in events) == 1
    assert events[finished[0] - 1]["type"] == "run_reply"
    value = events[finished[0] - 1]["data"]
    assert value == status["reply"] == json.loads((run_dir / "delivery/reply.json").read_text())
    assert value["kind"] == kind and value["from"] == "pipeline"
    assert len(value["text"]) <= 16000 and isinstance(value["truncated"], bool)
    assert not (run_dir / "messages.jsonl").exists()
    return value


def test_legacy_prompt_schema_and_config():
    cfg = config(Path("fixture"))
    assert not cfg.conversation and "conversation" not in cfg.model_dump()
    prompt = build_planner_prompt({"task": "Explain addition"}, cfg)
    assert hashlib.sha256((prompt.system + "\0" + prompt.user).encode()).hexdigest() == "58ea4b5ca28faff6e1f00df76b01b9a883731796f8a5d5bd7bbaad1619b50c55"
    assert hashlib.sha256(json.dumps(PlannerTurn.model_json_schema(), sort_keys=True).encode()).hexdigest() == "f0b3c584551024d537769ba9398421835fdf5185093a71b18689a093ccbd3be9"
    with pytest.raises(ValidationError):
        PlannerTurn.model_validate({"kind": "answer", "answer": {"text": "No edits"}})
    for value in ("true", 1, None):
        with pytest.raises(ValidationError):
            type(cfg).model_validate({**cfg.model_dump(), "conversation": value})
    assert "kind answer" in build_planner_prompt({"task": "Explain addition"}, cfg.model_copy(update={"conversation": True})).system


@pytest.mark.parametrize("scenario", ["basic", "replan", "parallel", "evidence"])
def test_legacy_run_projection(tmp_path, scenario):
    golden = json.loads((Path(__file__).parent / "fixtures/conversation_legacy.json").read_text())[scenario]
    status = run_demo(tmp_path, run_id="base" + scenario, scenario=scenario)
    run_dir = tmp_path / ("base" + scenario)
    while status.pending:
        status = resume(run_dir, gate=status.pending["gate"], decision="approve", digest=status.pending["digest"])
    assert status.status == "succeeded"
    files = sorted(p.relative_to(run_dir).as_posix() for p in run_dir.rglob("*") if p.is_file() and not any(x in p.relative_to(run_dir).parts for x in ("git", "git-hooks", ".git", "demo-source.git", "__pycache__", "sandbox-state")) and not p.name.endswith((".pyc", "-wal", "-shm")))
    assert json.loads((run_dir / "artifacts/instructions.json").read_text()) == {"block": "", "summary": None}
    assert [p for p in files if p != "artifacts/instructions.json"] == golden["files"]
    legacy = status.model_dump(by_alias=True)
    assert legacy.pop("instructions") is None
    assert legacy_status(legacy, run_dir) == golden["status"]
    assert sorted(legacy) == golden["status_keys"]
    assert sorted(status.progress) == golden["progress_keys"]
    events = _rows(run_dir / "events.jsonl")
    assert [e["data"] for e in events if e["type"] == "instructions"] == [{"instructions": None}]
    assert [e["data"] for e in events if e["type"] == "run_started"] == [{}]
    # Independent prepare and lane events have no total-order guarantee.
    projection = [[e["type"], e["node"]] for e in events if e["node"] not in ("index_repo", "baseline_checks") and e["type"] not in {"check_finished", "instructions"}]
    if scenario == "parallel":
        from collections import Counter
        assert Counter(map(tuple, projection)) == Counter(map(tuple, golden["events"]))
    else:
        assert projection == golden["events"]
    assert not any(e["type"] in {"agent_message", "run_reply"} for e in events)


def answer_turn(case, *, unknown=False, text="The function subtracts b from a."):
    request = ContextRequest(kind="read", path="calculator.py").model_dump(mode="json")
    ident = context_id({"request": request, "sha256": sha256_file(case["source"] / "calculator.py"), "content": read_text(case["source"] / "calculator.py", 1000000)[0], "ok": True, "truncated": False})
    return {"kind": "need_context", "rationale": "Read the implementation", "context_requests": [request]}, {"kind": "answer", "answer": {"text": text, "citations": ["E-0000000000" if unknown else ident]}}


def test_answer_context_route_and_source_untouched(case):
    case["cfg"]["conversation"] = True
    case["cfg"]["grounding"] = {"mode": "enforce"}
    turns = answer_turn(case)
    script(case, "planner", turns)
    before = {p.name: p.read_bytes() for p in case["source"].glob("*.py")}
    code, status = begin(case, delivery="apply")
    assert code == 0 and status["status"] == "succeeded", status
    run_dir = case["root"] / "test0001"
    value = reply(run_dir, status, "answer")
    assert value["text"] == turns[1]["answer"]["text"] and value["citations"] == turns[1]["answer"]["citations"]
    assert {p.name: p.read_bytes() for p in case["source"].glob("*.py")} == before
    events = _rows(run_dir / "events.jsonl")
    nodes = [e["node"] for e in events if e["type"] == "node_started"]
    assert set(nodes) == {"prepare_workspace", "index_repo", "baseline_checks", "plan", "plan_context", "finalize"}
    assert any(e["type"] == "route" and e["data"] == {"from": "plan", "to": "finalize", "reason": "direct_answer"} for e in events)
    assert len([e for e in events if e["type"] == "agent_message"]) == 2
    assert not (run_dir / "delivery/candidate.diff").exists()
    assert status["delivery"] is None and status["progress"]["step_count"] == 0


@pytest.mark.parametrize("mode", ["enforce", "observe"])
def test_unknown_answer_citation(case, mode):
    case["cfg"].update(conversation=True, grounding={"mode": mode})
    read, answer = answer_turn(case, unknown=True)
    script(case, "planner", [read, answer, answer, answer])
    code, status = begin(case)
    assert code == (4 if mode == "enforce" else 0), status
    run_dir = case["root"] / "test0001"
    trace = [r for r in _rows(run_dir / "grounding.jsonl") if r.get("type") == "output" and r["violations"]]
    assert len(trace) == (3 if mode == "enforce" else 1)
    assert all(r["violations"][0]["kind"] == "unknown_citation" and r["accepted"] == (mode == "observe") for r in trace)
    reply(run_dir, status, "result" if mode == "enforce" else "answer")


def test_answer_rejected_when_off(case):
    _, answer = answer_turn(case)
    script(case, "planner", [answer] * 3)
    code, status = begin(case)
    assert code == 4 and status["failure"]["code"] == "output_invalid"
    assert "reply" not in status
    assert not any(e["type"] == "agent_message" for e in _rows(case["root"] / "test0001/events.jsonl"))


@pytest.mark.parametrize("scenario", ["basic", "replan", "parallel", "evidence", "answer"])
def test_conversation_demos(tmp_path, scenario):
    status = run_demo(tmp_path, run_id="chat" + scenario, scenario=scenario, conversation=True)
    run_dir = tmp_path / ("chat" + scenario)
    while status.pending:
        assert "reply" not in status.model_dump() and not (run_dir / "delivery/reply.json").exists()
        status = resume(run_dir, gate=status.pending["gate"], decision="approve", digest=status.pending["digest"])
    assert status.status == "succeeded", status
    reply(run_dir, status.model_dump(), "answer" if scenario == "answer" else "result")
    events = _rows(run_dir / "events.jsonl")
    messages = [e for e in events if e["type"] == "agent_message"]
    accepted = [r for r in _rows(run_dir / "grounding.jsonl") if r.get("type") == "output" and r["accepted"]]
    assert len(messages) == len(accepted)
    assert {e["data"]["role"] for e in messages} == ({"planner"} if scenario == "answer" else {"planner", "implementer", "reviewer"})
    assert all(e["data"]["final"] and e["data"]["text"].strip() for e in messages)


@pytest.mark.parametrize("outcome", ["failed", "rejected", "cancelled"])
def test_terminal_result_reasons(case, outcome):
    case["cfg"]["conversation"] = True
    if outcome == "failed":
        script(case, "planner", ["bad"] * 3)
    _, status = begin(case)
    if outcome == "rejected":
        _, status = decision(case, status, "reject")
    elif outcome == "cancelled":
        _, status = cli("cancel", "--run-dir", case["root"] / "test0001")
    assert status["status"] == outcome
    assert "Reason:" in reply(case["root"] / "test0001", status, "result")["text"]


def test_suspend_then_reply(case):
    case["cfg"]["conversation"] = True
    read, answer = answer_turn(case)
    script(case, "planner", [{"__error__": "transient"}] * 3 + [read, answer])
    _, status = begin(case)
    assert status["status"] == "suspended" and "reply" not in status
    run_dir = case["root"] / "test0001"
    assert not (run_dir / "delivery/reply.json").exists()
    code, status = cli("resume", "--run-dir", run_dir, "--trust-host")
    assert code == 0, status
    reply(run_dir, status, "answer")


@pytest.mark.parametrize("role,turn", [("planner", {"kind": "plan", "plan": {"summary": "x" * 17000}}), ("implementer", {"kind": "blocked", "blocked_reason": "x" * 17000}), ("reviewer", {"summary": "x" * 17000})])
def test_message_cap_redaction_and_no_raw_edits(tmp_path, role, turn):
    deps = SimpleNamespace(cfg=SimpleNamespace(conversation=True), redactor=Redactor(["private-value"]), events=EventLog(tmp_path / "events.jsonl", "test0001", Redactor(["private-value"])))
    agent_message({}, deps, role, turn)
    value = _rows(tmp_path / "events.jsonl")[-1]["data"]
    assert len(value["text"]) == 16000 and value["truncated"]
    agent_message({}, deps, "implementer", {"kind": "edits", "summary": "private-value corrected", "edits": [{"content": "RAW CONTENT"}]})
    assert _rows(tmp_path / "events.jsonl")[-1]["data"]["text"] == "[REDACTED] corrected"
    result = terminal_reply({"answer": {"text": "private-value " + "x" * 17000, "citations": []}}, deps, "succeeded")
    assert len(result["text"]) == 16000 and result["truncated"] and result["text"].startswith("[REDACTED]")
    count = len(_rows(tmp_path / "events.jsonl"))
    agent_message({}, deps, "reviewer", {"summary": "   "})
    assert len(_rows(tmp_path / "events.jsonl")) == count


@pytest.mark.parametrize("raw", [{"kind": "answer"}, {"kind": "answer", "answer": {"text": " "}}, {"kind": "answer", "answer": {"text": "ok"}, "context_requests": [{"kind": "list"}]}, {"kind": "need_context", "answer": {"text": "ok"}, "context_requests": [{"kind": "list"}]}])
def test_answer_payload_agreement(raw):
    with pytest.raises(ValidationError):
        ConversationPlannerTurn.model_validate(raw)


def test_role_messages_include_context_check_repair_and_review_revision(case):
    from scranton_pipeline.demo.fixture import REVIEW
    case["cfg"]["conversation"] = True
    script(case, "implementer", [
        {"kind": "need_context", "summary": "Check the test", "context_requests": [{"kind": "read", "path": "test_calculator.py"}]},
        {"kind": "edits", "summary": "First attempt", "edits": [{"path": "calculator.py", "action": "modify", "replacements": [{"search": "return a - b", "replace": "return a + b + 1"}]}]},
        {"kind": "edits", "summary": "Repair the failing check", "edits": [{"path": "calculator.py", "action": "modify", "replacements": [{"search": "return a + b + 1", "replace": "return a + b"}]}]},
        {"kind": "edits", "summary": "Address review", "edits": [{"path": "calculator.py", "action": "modify", "replacements": [{"search": "return a + b", "replace": "return (a + b)"}]}]},
    ])
    script(case, "reviewer", [{"verdict": "request_changes", "summary": "Use parentheses", "criteria": [], "findings": []}, REVIEW])
    _, status = begin(case)
    _, status = decision(case, status)
    assert status["status"] == "succeeded", status
    run_dir = case["root"] / "test0001"
    messages = [e["data"] for e in _rows(run_dir / "events.jsonl") if e["type"] == "agent_message"]
    assert [m["text"] for m in messages if m["role"] == "implementer"] == ["Check the test", "First attempt", "Repair the failing check", "Address review"]
    assert [m["context"] for m in messages if m["role"] == "reviewer"] == ["Round 0", "Round 1"]
    assert len(messages) == status["usage"]["calls"]
    assert "unit passed" in reply(run_dir, status, "result")["text"]


def legacy_status(value, run_dir):
    if isinstance(value, dict):
        return {k: 0 if k == "duration_s" else "<time>" if k in {"created_at", "updated_at"} else legacy_status(v, run_dir) for k, v in value.items()}
    if isinstance(value, list):
        return [legacy_status(v, run_dir) for v in value]
    if isinstance(value, str):
        value = value.replace(str(run_dir), "<run>")
        return re.sub(r"Ran (\d+) tests? in [\d.]+s", r"Ran \1 tests in <time>s", value)
    return value

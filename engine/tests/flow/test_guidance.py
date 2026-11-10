import copy
import json
import os
import subprocess
import sys

import pytest

from scranton_pipeline import runner
from scranton_pipeline.config import EngineConfig
from scranton_pipeline.demo.fixture import EDIT, PLAN, REVIEW
from scranton_pipeline.errors import EngineError
from scranton_pipeline.observability import _rows
from scranton_pipeline.procedure import digest, load, skeleton

from .conftest import begin, decision, script
from .test_parallel import edit, setup
from .test_replan import BLOCKED, REJECTED, WRONG

REQUEST = {"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}


@pytest.mark.parametrize("path,expected", [
    ("context", ["plan.start", "plan.context", "implement.start", "implement.context", "review.start"]),
    ("invalid", ["plan.start", "plan.repair", "implement.start", "implement.repair", "review.start", "review.repair"]),
    ("ungrounded", ["plan.start", "plan.repair", "implement.start", "implement.repair", "review.start", "review.repair"]),
    ("rejected", ["plan.start", "implement.start", "implement.edits_rejected", "review.start"]),
    ("checks", ["plan.start", "implement.start", "implement.checks_failed", "review.start"]),
    ("review", ["plan.start", "implement.start", "review.start", "implement.review_changes", "review.recheck"]),
    ("replan", ["plan.start", "implement.start", "plan.replan", "implement.start", "review.start"]),
    ("repair_context", ["plan.start", "plan.repair", "plan.context", "implement.start", "implement.repair", "implement.context", "review.start"]),
])
def test_real_graph_situation_paths(case, path, expected):
    case["cfg"]["procedure"] = {"enabled": True}
    planners, implementers, reviewers = [PLAN], [EDIT], [REVIEW]
    if path == "context":
        planners, implementers = [REQUEST, PLAN], [REQUEST, EDIT]
    elif path in {"invalid", "repair_context"}:
        planners, implementers, reviewers = ["bad", PLAN], ["bad", EDIT], ["bad", REVIEW]
        if path == "repair_context":
            planners, implementers, reviewers = ["bad", REQUEST, PLAN], ["bad", REQUEST, EDIT], [REVIEW]
    elif path == "ungrounded":
        case["cfg"]["grounding"] = {"mode": "enforce"}
        planners = [PLAN, PLAN]
        implementers = [{"kind": "need_context", "context_requests": [{"kind": "read", "path": ".env"}]}, EDIT]
        bad = copy.deepcopy(REVIEW)
        bad["criteria"][0]["citations"] = ["H-0000000000"]
        reviewers = [bad, REVIEW]
    elif path == "rejected":
        implementers = [REJECTED, EDIT]
    elif path == "checks":
        implementers = [WRONG, edit("calculator.py", "def add(a,b): return a+b\n")]
    elif path == "review":
        implementers = [EDIT, edit("calculator.py", "# reviewed\ndef add(a,b): return a+b\n")]
        reviewers = [{**REVIEW, "verdict": "request_changes"}, REVIEW]
    elif path == "replan":
        planners, implementers = [PLAN, PLAN], [BLOCKED, EDIT]
    for role, turns in (("planner", planners), ("implementer", implementers), ("reviewer", reviewers)):
        script(case, role, turns)
    _, status = begin(case)
    for _ in range(3):
        if status["status"] != "awaiting_approval":
            break
        code, status = decision(case, status)
    assert code == 0, status
    directory = case["root"] / "test0001"
    events = _rows(directory / "events.jsonl")
    rows = [r["data"] for r in events if r["type"] == "procedure"]
    assert [r["situation"] for r in rows] == expected
    assert all(r["matched"] and r["scope"] for r in rows)
    assert len(rows) == len([r for r in events if r["type"] == "llm_call"])
    assert status["procedure"] == {"enabled": True, "name": load(None).name, "digest": digest(load(None)), "situation": expected[-1]}


def test_parallel_integration_uses_pinned_graph(case):
    setup(case)
    case["cfg"]["limits"]["max_step_attempts"] = 2
    graph_path = case["tmp"] / "advice.json"
    graph_path.write_text(load(None).model_dump_json(by_alias=True))
    case["cfg"]["procedure"] = {"enabled": True, "graph": str(graph_path)}
    case["cfg"]["checks"].append({"id": "coupled", "kind": "test", "scope": "final", "argv": [sys.executable, "-c", "from other import VALUE; assert VALUE == 2"]})
    script(case, "implementer", {"step:fix": [EDIT], "step:other": [edit("other.py", "VALUE = 1\n")], "int:1": [edit("other.py", "VALUE = 2\n")]})
    _, status = begin(case)
    graph_path.unlink()
    code, status = decision(case, status)
    assert code == 0, status
    rows = [r["data"] for r in _rows(case["root"] / "test0001" / "events.jsonl") if r["type"] == "procedure"]
    assert rows[0]["situation"] == "plan.start" and rows[-1]["situation"] == "review.start"
    assert sorted((r["lane"], r["situation"], r["matched"]) for r in rows if "lane" in r) == [("fix", "implement.start", True), ("other", "implement.start", True)]
    assert [(r["scope"], r["situation"]) for r in rows if r["scope"].startswith("int:")] == [("int:1", "implement.integration")]
    assert status["procedure"]["digest"] == digest(load(None))


@pytest.mark.parametrize("enabled", [False, True])
def test_identity_disabled_no_load_and_tampered_copy_refused(case, enabled):
    graph_path = case["tmp"] / "advice.json"
    graph_path.write_text(skeleton().model_dump_json(by_alias=True) if enabled else "invalid")
    case["cfg"]["procedure"] = {"enabled": enabled, "graph": str(graph_path)}
    _, status = begin(case)
    assert status["status"] == "awaiting_approval", status
    directory = case["root"] / "test0001"
    metadata = json.loads((directory / "run.json").read_text())
    if not enabled:
        assert not (directory / "artifacts" / "procedure.json").exists() and "procedure" not in metadata
        assert status["procedure"] == {"enabled": False, "name": None, "digest": None, "situation": None}
        return
    assert metadata["procedure"] == {"enabled": True, "name": "skeleton", "digest": digest(skeleton())}
    (directory / "artifacts" / "procedure.json").write_text(load(None).model_dump_json(by_alias=True))
    before = (directory / "events.jsonl").read_bytes()
    code, result = decision(case, status)
    assert code == 2 and "digest" in result["failure"]["message"]
    assert (directory / "events.jsonl").read_bytes() == before


def test_invalid_graph_fails_before_any_run_side_effect(case):
    graph = case["tmp"] / "bad.json"
    graph.write_text('{"schema":1}')
    case["cfg"]["procedure"] = {"enabled": True, "graph": str(graph)}
    code, result = begin(case)
    assert code == 2 and result["failure"]["code"] == "invalid_procedure"
    assert not case["root"].exists()


@pytest.mark.parametrize("by", [None, "eval"])
def test_gate_decider_record_and_event(case, by):
    case["cfg"]["models"]["refiner"] = {"provider": "scripted", "script_path": "refiner-is-not-part-of-a-run.json"}
    _, status = begin(case, delivery="apply")
    directory = case["root"] / "test0001"
    kwargs = {} if by is None else {"by": by}
    for gate in ("plan", "delivery"):
        status = runner.resume(directory, gate=gate, digest=status["pending"]["digest"], decision="approve", trust_host=True, **kwargs).model_dump()
    assert status["status"] == "succeeded"
    events = [r["data"] for r in _rows(directory / "events.jsonl") if r["type"] == "gate_decided"]
    assert [(r["gate"], r["by"]) for r in events] == [("plan", by or "human"), ("delivery", by or "human")]
    with runner.dependencies(directory, EngineConfig.model_validate(case["cfg"]), trust_host=True, models=False) as deps:
        state = runner.build_graph(deps).get_state({"configurable": {"thread_id": directory.name}}).values
        assert state["plan_approval"]["by"] == state["delivery_approval"]["by"] == (by or "human")
    with pytest.raises(EngineError, match="human or eval"):
        runner.resume(directory, by="auto")


def test_crash_resume_keeps_model_prompt_bytes(case):
    case["cfg"]["procedure"] = {"enabled": True}
    script(case, "implementer", [EDIT, EDIT])
    _, status = begin(case)
    directory = case["root"] / "test0001"
    hook = case["tmp"] / "crash-guidance.py"
    hook.write_text('''import json, os, sys
from pathlib import Path
from scranton_pipeline.agents.providers import ScriptedChatModel
from scranton_pipeline.cli import main
original = ScriptedChatModel._generate
def capture(self, messages, *a, **kw):
    if self.role == "implementer":
        path = Path(sys.argv[1]) / "prompts.jsonl"
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps([m.content for m in messages]) + "\\n")
        if not (Path(sys.argv[1]) / "crashed").exists():
            (Path(sys.argv[1]) / "crashed").touch()
            os._exit(91)
    return original(self, messages, *a, **kw)
ScriptedChatModel._generate = capture
raise SystemExit(main(sys.argv[2:]))
''')
    def process(*args):
        return subprocess.run([sys.executable, str(hook), str(directory), "resume", "--run-dir", str(directory), "--trust-host", *args], env=os.environ, capture_output=True, text=True, timeout=90, check=False)
    crash = process("--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"])
    assert crash.returncode == 91, crash.stderr
    resumed = process()
    assert resumed.returncode == 0, (resumed.stdout, resumed.stderr)
    prompts = [json.loads(s) for s in (directory / "prompts.jsonl").read_text().splitlines()]
    assert len(prompts) == 2 and prompts[0] == prompts[1]
    assert '"guidance": "Procedural guidance' in prompts[0][1]
    traces = [r for r in _rows(directory / "grounding.jsonl") if r.get("role") == "implementer"]
    assert traces and all("guidance" not in str(r["shown"]) for r in traces)

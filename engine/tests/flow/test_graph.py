import json
from pathlib import Path

import pytest

from scranton_pipeline.cli import graph_text
from scranton_pipeline.config import EngineConfig
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.graph import build_graph
from scranton_pipeline.nodes import workflow
from scranton_pipeline.observability import read_status
from scranton_pipeline.runner import dependencies, drive

from .conftest import begin, cli, decision, script

EXPECTED = {"prepare_workspace", "index_repo", "baseline_checks", "plan", "plan_context", "approve_plan",
            "select_step", "implement", "implement_context", "apply_edits", "verify", "review", "ground", "package",
            "approve_delivery", "apply_to_source", "finalize", "replan", "run_lane", "merge_wave"}


def test_graph_shape_and_mermaid():
    from types import SimpleNamespace

    from scranton_pipeline.demo.fixture import config
    graph = build_graph(SimpleNamespace(cfg=config(Path.cwd()), checkpointer=None))
    assert set(graph.builder.nodes) == EXPECTED
    lane = graph.builder.nodes["run_lane"].runnable
    assert set(lane.builder.nodes) == {"lane_prepare", "implement", "implement_context", "apply_edits", "verify", "lane_finish"}
    for branches in lane.builder.branches.values():
        assert all(branch.ends for branch in branches.values())
    for branches in graph.builder.branches.values():
        assert all(branch.ends for branch in branches.values())
    assert Path("docs/graph.mmd").read_text(encoding="utf-8").strip() == graph_text().strip()


@pytest.mark.parametrize("both_fail", [False, True])
def test_parallel_join_and_reducers(case, monkeypatch, both_fail):
    # Guard: add_edge([index_repo, baseline_checks], plan) and failure keep_first reducer.
    from scranton_pipeline.demo.fixture import PLAN
    script(case, "planner", [PLAN, PLAN])
    begin(case)
    run_dir = case["root"] / "test0001"
    cfg = EngineConfig.model_validate(case["cfg"])
    with dependencies(run_dir, cfg, trust_host=True) as deps:
        graph = build_graph(deps)
        runnable = {"configurable": {"thread_id": "parallel"}}
        initial = {"run_id": "test0001", "task": "Parallel", "source_dir": str(case["source"]), "delivery_mode": "patch"}
        # Fresh branch invocation uses a separate private workspace.
        deps.workspace = case["tmp"] / "parallel-workspace"
        if both_fail:
            def fail(state, deps):
                raise EngineError(FailureClass.INFRASTRUCTURE, "branch_failed", "Branch failed")
            monkeypatch.setattr(workflow, "index_repo", fail)
            monkeypatch.setattr(workflow, "baseline_checks", fail)
            graph = build_graph(deps)
        graph.invoke(initial, runnable, durability="sync")
        values = graph.get_state(runnable).values
        if both_fail:
            assert values["failure"]["code"] == "branch_failed"
            assert values["outcome"] == "failed"
        else:
            assert values["repo"] and values["baseline"]
        events = [json.loads(s) for s in (run_dir / "events.jsonl").read_text().splitlines()]
        assert sum(e["type"] == "node_finished" and e["node"] == "plan" for e in events) == (1 if both_fail else 2)
        assert values["active_seconds"] > 0


def test_recursion_backstop(case, monkeypatch):
    # Guard: GraphRecursionError -> finalize_out_of_band rather than suspension.
    begin(case)
    run_dir = case["root"] / "test0001"
    from scranton_pipeline import runner
    monkeypatch.setattr(runner, "recursion_limit", lambda limits: 1)
    with dependencies(run_dir, EngineConfig.model_validate(case["cfg"]), trust_host=True) as deps:
        from langgraph.types import Command
        result = drive(deps, Command(resume={"decision": "approve"}))
        assert result.status == "failed" and result.failure["code"] == "recursion_limit"
        assert read_status(run_dir).status == "failed"


def test_context_edges_and_bounds(case):
    from scranton_pipeline.demo.fixture import EDIT, PLAN
    request = {"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}
    script(case, "planner", [request, PLAN])
    script(case, "implementer", [request, EDIT])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    events = [json.loads(s) for s in (case["root"] / "test0001" / "events.jsonl").read_text().splitlines()]
    assert {"plan_context", "implement_context"} <= {e["node"] for e in events if e["type"] == "node_finished"}


def test_context_exhaustion_is_output_failure(case):
    case["cfg"]["limits"] = {"max_plan_context_rounds": 0, "max_output_repairs": 0}
    script(case, "planner", [{"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}])
    code, status = begin(case)
    assert code == 4 and status["failure"]["failure_class"] == "llm_output"


def test_timeout_exhaustion(case):
    from scranton_pipeline.demo.fixture import EDIT
    case["cfg"]["limits"] = {"max_step_attempts": 1, "max_replans": 0}
    case["cfg"]["checks"][0].update(argv=[__import__("sys").executable, "-c", "import time; time.sleep(2)"], timeout_s=0.05)
    script(case, "implementer", [EDIT])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 4 and status["checks"][0]["status"] == "timed_out", status


def test_demo_both_gates(tmp_path):
    root = tmp_path / "demo-runs"
    code, status = cli("demo", "--run-root", root, "--run-id", "demo0001", "--delivery", "apply")
    assert code == 3, status
    for gate, expected in (("plan", 3), ("delivery", 0)):
        code, status = cli("resume", "--run-dir", root / "demo0001", "--gate", gate, "--decision", "approve", "--digest", status["pending"]["digest"])
        assert code == expected, status
    assert "a + b" in (root / "demo0001" / "demo-source" / "calculator.py").read_text()

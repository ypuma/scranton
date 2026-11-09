"""Fixed graph with visible bounded loops, read-only fan-out and one terminal node."""
import time
from collections.abc import Callable
from typing import Any, cast

from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

from scranton_pipeline import routing
from scranton_pipeline.errors import EngineError, FailureClass, SuspendRequested, TransientError
from scranton_pipeline.nodes import workflow
from scranton_pipeline.nodes.common import Dependencies
from scranton_pipeline.nodes.planner import plan
from scranton_pipeline.observability import write_status
from scranton_pipeline.report import finalize_out_of_band, make_status
from scranton_pipeline.state import PipelineState

Node = Callable[[PipelineState, Dependencies], dict[str, Any]]


def instrument(name: str, fn: Node, deps: Dependencies) -> Callable[[PipelineState], dict[str, Any]]:
    def wrapped(state: PipelineState) -> dict[str, Any]:
        start = time.monotonic()
        deps.events.emit("node_started", node=name)
        try:
            if name not in {"finalize", "apply_to_source"}:
                if state.get("failure") or state.get("outcome"):
                    return {}
                if deps.stop.cancel_requested():
                    return {"outcome": "cancelled"}
                if deps.stop.suspend_requested():
                    raise SuspendRequested()
                if state.get("active_seconds", 0) >= deps.cfg.limits.max_active_seconds:
                    raise EngineError(FailureClass.LIMIT, "run_time_exhausted", "Active run time exhausted")
            try:
                update = fn(state, deps)
            except EngineError as exc:
                update = {"failure": exc.to_failure(name)}
                deps.events.emit("failure", **update["failure"])
        except EngineError as exc:
            update = {"failure": exc.to_failure(name)}
        duration = time.monotonic() - start
        update["active_seconds"] = duration
        update["history"] = [{"node": name, "duration_s": duration}]
        deps.events.emit("node_finished", node=name, duration_s=duration)
        # Parallel branches only write disjoint graph state; their status snapshots are advisory.
        if name != "finalize":
            write_status(deps.run_dir, make_status(cast(PipelineState, {**state, **update}), deps, node=name))
        return update
    return wrapped


def build_graph(deps: Dependencies) -> Any:
    graph = StateGraph(PipelineState)
    nodes: dict[str, Node] = {
        "prepare_workspace": workflow.prepare_workspace, "index_repo": workflow.index_repo,
        "baseline_checks": workflow.baseline_checks, "plan": plan,
        "plan_context": lambda s, d: workflow.context(s, d, planner=True), "approve_plan": workflow.approve_plan,
        "select_step": workflow.select_step, "implement": workflow.implement,
        "implement_context": lambda s, d: workflow.context(s, d, planner=False), "apply_edits": workflow.apply_edits,
        "verify": workflow.verify, "review": workflow.review, "package": workflow.package,
        "approve_delivery": workflow.approve_delivery, "apply_to_source": workflow.apply_to_source,
        "finalize": finalize_out_of_band,
    }
    retry = RetryPolicy(retry_on=TransientError, max_attempts=deps.cfg.limits.max_transient_attempts)
    for name, fn in nodes.items():
        graph.add_node(name, cast(Any, instrument(name, fn, deps)), retry_policy=retry if name in {"plan", "implement", "review"} else None)
    graph.add_edge(START, "prepare_workspace")
    routes = [
        ("prepare_workspace", routing.after_prepare, ["index_repo", "baseline_checks", "finalize"]),
        ("plan", routing.after_plan, ["plan_context", "plan", "approve_plan", "finalize"]),
        ("approve_plan", routing.after_approve_plan, ["select_step", "finalize"]),
        ("select_step", routing.after_select, ["implement", "review", "package", "finalize"]),
        ("implement", routing.after_implement, ["implement_context", "apply_edits", "implement", "finalize"]),
        ("apply_edits", routing.after_apply, ["verify", "implement", "finalize"]),
        ("verify", routing.after_verify, ["select_step", "review", "implement", "finalize"]),
        ("review", routing.after_review, ["package", "implement", "review", "finalize"]),
        ("package", routing.after_package, ["approve_delivery", "finalize"]),
        ("approve_delivery", routing.after_delivery, ["apply_to_source", "finalize"]),
    ]
    for source, route, targets in routes:
        def logged(state: PipelineState, route: Any = route, source: str = source) -> Any:
            target, reason = routing.decision(route, state)
            data: dict[str, Any] = {"from": source, "to": target, "reason": reason}
            deps.events.emit("route", **data)
            return target
        graph.add_conditional_edges(source, logged, path_map=targets)
    graph.add_edge(["index_repo", "baseline_checks"], "plan")
    graph.add_edge("plan_context", "plan")
    graph.add_edge("implement_context", "implement")
    graph.add_edge("apply_to_source", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile(checkpointer=deps.checkpointer)

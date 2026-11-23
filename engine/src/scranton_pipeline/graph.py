"""Fixed graph with visible bounded loops, read-only fan-out and one terminal node."""
import time
from collections.abc import Callable
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy, Send

from scranton_pipeline import routing
from scranton_pipeline.agents.gateway import call_context
from scranton_pipeline.errors import EngineError, FailureClass, SuspendRequested, TransientError
from scranton_pipeline.nodes import parallel, workflow
from scranton_pipeline.nodes.common import Dependencies, scope_id
from scranton_pipeline.nodes.grounding import ground
from scranton_pipeline.nodes.planner import plan
from scranton_pipeline.observability import write_status
from scranton_pipeline.report import finalize_out_of_band, make_status
from scranton_pipeline.state import PipelineState, merge_counters

Node = Callable[[PipelineState, Dependencies], dict[str, Any]]


def instrument(name: str, fn: Node, deps: Dependencies) -> Callable[[PipelineState], dict[str, Any]]:
    parent = deps
    def wrapped(state: PipelineState) -> dict[str, Any]:
        deps = parallel.lane_dependencies(state, parent) if state.get("lane") else parent
        start = time.monotonic()
        clock = parent.wave_clocks.setdefault(state["lane"]["wave"], (start, state.get("active_seconds", 0.0))) if state.get("lane") else None
        elapsed = max(state.get("active_seconds", 0.0), clock[1] + start - clock[0]) if clock else state.get("active_seconds", 0.0)
        deps.events.emit("node_started", node=name)
        try:
            if name not in {"finalize", "apply_to_source", "lane_finish", "merge_wave"}:
                if state.get("failure") or state.get("outcome"):
                    return {}
                if deps.stop.cancel_requested():
                    return {"outcome": "cancelled"}
                if deps.stop.suspend_requested():
                    raise SuspendRequested()
                if elapsed + state.get("lane", {}).get("parent_active_seconds", 0) >= deps.cfg.limits.max_active_seconds:
                    raise EngineError(FailureClass.LIMIT, "run_time_exhausted", "Active run time exhausted")
            try:
                token = call_context.set((scope_id(state), state.get("lane", {}).get("step_id")))
                try:
                    update = fn(state, deps)
                finally:
                    call_context.reset(token)
            except EngineError as exc:
                deps.sandbox_failure(exc, code=exc.code, node=name)
                update = {"failure": exc.to_failure(name)}
                deps.events.emit("failure", **update["failure"])
        except EngineError as exc:
            update = {"failure": exc.to_failure(name)}
        duration = time.monotonic() - start
        if state.get("mode") == "integration" and any(update.get(k) for k in ("failure", "outcome", "replan_request")):
            update = {**parallel.rollback_integration(cast(PipelineState, {**state, **update}), deps), **update}
        update["active_seconds"] = update.get("active_seconds", 0.0) + duration + (elapsed - state.get("active_seconds", 0.0) if clock else 0.0)
        if name == "lane_finish":
            update["lanes"][state["lane"]["step_id"]]["active_seconds"] = elapsed + duration
        update["history"] = [{"node": name, "duration_s": duration}]
        deps.events.emit("node_finished", node=name, duration_s=duration)
        if name != "finalize" and not state.get("lane"):
            visible = cast(PipelineState, {**state, **update,
                "counters": merge_counters(state.get("counters", {}), update.get("counters", {})),
                "steps_done": [*state.get("steps_done", []), *update.get("steps_done", [])]})
            write_status(deps.run_dir, make_status(visible, deps, node=name))
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
        "verify": workflow.verify, "review": workflow.review, "ground": ground, "package": workflow.package,
        "approve_delivery": workflow.approve_delivery, "apply_to_source": workflow.apply_to_source,
        "finalize": finalize_out_of_band, "replan": workflow.replan, "merge_wave": parallel.merge_wave,
    }
    retry = RetryPolicy(retry_on=TransientError, max_attempts=deps.cfg.limits.max_transient_attempts)
    for name, fn in nodes.items():
        graph.add_node(name, cast(Any, instrument(name, fn, deps)), retry_policy=retry if name in {"plan", "implement", "review"} else None)
    graph.add_node("run_lane", build_lane_graph(deps))
    graph.add_edge("run_lane", "merge_wave")
    graph.add_edge(START, "prepare_workspace")
    routes = [
        ("merge_wave", routing.after_merge, ["verify", "replan", "finalize"]),
        ("prepare_workspace", routing.after_prepare, ["index_repo", "baseline_checks", "finalize"]),
        ("replan", routing.after_replan, ["plan", "finalize"]),
        ("plan", routing.after_plan, ["plan_context", "plan", "approve_plan", "finalize"]),
        ("approve_plan", routing.after_approve_plan, ["select_step", "finalize"]),
        ("select_step", routing.after_select, ["implement", "review", "ground", "finalize", "run_lane"]),
        ("implement", routing.after_implement, ["implement_context", "apply_edits", "implement", "finalize", "replan"]),
        ("apply_edits", routing.after_apply, ["verify", "implement", "finalize", "replan"]),
        ("verify", routing.after_verify, ["select_step", "review", "implement", "finalize", "replan"]),
        ("review", routing.after_review, ["ground", "implement", "review", "finalize"]),
        ("package", routing.after_package, ["approve_delivery", "finalize"]),
        ("approve_delivery", routing.after_delivery, ["apply_to_source", "finalize"]),
    ]
    for source, route, targets in routes:
        def logged(state: PipelineState, route: Any = route, source: str = source) -> Any:
            target, reason = routing.decision(route, state)
            data: dict[str, Any] = {"from": source, "to": target, "reason": reason}
            deps.events.emit("route", **data)
            if target == "run_lane":
                return lane_sends(state, deps)
            return target
        graph.add_conditional_edges(source, logged, path_map=targets)
    graph.add_edge(["index_repo", "baseline_checks"], "plan")
    graph.add_edge("plan_context", "plan")
    graph.add_edge("implement_context", "implement")
    graph.add_edge("ground", "package")
    graph.add_edge("apply_to_source", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile(checkpointer=deps.checkpointer)


class LaneOutput(TypedDict):
    lanes: dict[str, Any]
    counters: dict[str, int]
    history: list[dict[str, Any]]


def lane_sends(state: PipelineState, deps: Dependencies) -> list[Send]:
    plan = state["plan"]
    assert plan is not None
    deps.wave_clocks[state["wave"]["number"]] = (time.monotonic(), 0.0)
    return [Send("run_lane", {**state, "lane": {"wave": state["wave"]["number"], "slot": slot,
                "step_id": plan["steps"][index]["id"], "source_workspace": str(deps.workspace), "source_git_dir": str(deps.repo().git_dir),
                "parent_active_seconds": state.get("active_seconds", 0.0), "replans": state.get("counters", {}).get("replans", 0)},
                "step_index": index, "counters": {}, "active_seconds": 0.0, "history": [],
                "steps_done": [], "lanes": {}, "failure": None, "outcome": "", "replan_request": None,
                "step_evidence": [], "step_requests": [], "pending_edits": None, "feedback": None})
            for slot, index in enumerate(state["wave"]["indices"])]


def build_lane_graph(deps: Dependencies) -> Any:
    graph = StateGraph(PipelineState, output_schema=LaneOutput)
    retry = RetryPolicy(retry_on=TransientError, max_attempts=deps.cfg.limits.max_transient_attempts)
    nodes: dict[str, Node] = {"lane_prepare": parallel.lane_prepare, "implement": workflow.implement,
        "implement_context": lambda s, d: workflow.context(s, d, planner=False),
        "apply_edits": workflow.apply_edits, "verify": workflow.verify, "lane_finish": parallel.lane_finish}
    for name, fn in nodes.items():
        graph.add_node(name, cast(Any, instrument(name, fn, deps)), retry_policy=retry if name == "implement" else None)
    graph.add_edge(START, "lane_prepare")
    graph.add_edge("lane_prepare", "implement")
    for source, route, targets in [
        ("implement", routing.after_implement, {"implement_context": "implement_context", "apply_edits": "apply_edits", "implement": "implement", "finalize": "lane_finish", "replan": "lane_finish"}),
        ("apply_edits", routing.after_apply, {"verify": "verify", "implement": "implement", "finalize": "lane_finish", "replan": "lane_finish"}),
        ("verify", routing.after_verify, {"select_step": "lane_finish", "review": "lane_finish", "implement": "implement", "finalize": "lane_finish", "replan": "lane_finish"}),
    ]:
        def logged(state: PipelineState, route: Any = route, source: str = source, targets: Any = targets) -> Any:
            target, reason = routing.decision(route, state)
            data: dict[str, Any] = {"from": source, "to": targets[target], "reason": reason}
            parallel.lane_dependencies(state, deps).events.emit("route", **data)
            return target
        graph.add_conditional_edges(source, logged, path_map=cast(Any, targets))
    graph.add_edge("implement_context", "implement")
    graph.add_edge("lane_finish", END)
    return graph.compile()

"""Pure routing: bounds are enforced by the nodes that spend them."""
from collections.abc import Callable
from typing import Literal

from scranton_pipeline.state import PipelineState


def after_prepare(state: PipelineState) -> Literal["finalize"] | list[str]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    return ["index_repo", "baseline_checks"]


def after_plan(state: PipelineState) -> Literal["finalize", "plan_context", "plan", "approve_plan"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    if state.get("answer"):
        return "finalize"
    if state.get("plan_requests"):
        return "plan_context"
    return "approve_plan" if state.get("plan") else "plan"


def after_approve_plan(state: PipelineState) -> Literal["finalize", "select_step"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    return "select_step"


def after_select(state: PipelineState) -> Literal["finalize", "implement", "review", "ground", "run_lane"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    if state.get("wave"):
        return "run_lane"
    plan = state.get("plan") or {}
    if state.get("step_index", -1) < len(plan.get("steps", [])):
        return "implement"
    return "review" if state.get("review") is None else "ground"


def after_implement(state: PipelineState) -> Literal["replan", "finalize", "implement_context", "apply_edits", "implement"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    if state.get("replan_request"):
        return "replan"
    if state.get("step_requests"):
        return "implement_context"
    return "apply_edits" if state.get("pending_edits") else "implement"


def after_apply(state: PipelineState) -> Literal["replan", "finalize", "implement", "verify"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    if state.get("replan_request"):
        return "replan"
    return "implement" if state.get("feedback") else "verify"


def after_verify(state: PipelineState) -> Literal["replan", "finalize", "implement", "review", "select_step"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    if state.get("replan_request"):
        return "replan"
    if state.get("feedback"):
        return "implement"
    return "review" if state.get("mode") == "revision" else "select_step"


def after_review(state: PipelineState) -> Literal["finalize", "ground", "implement", "review"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    review = state.get("review")
    if not review:
        return "review"
    return "ground" if review["verdict"] == "approve" else "implement"


def after_package(state: PipelineState) -> Literal["finalize", "approve_delivery"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    return "approve_delivery" if state.get("delivery_mode") == "apply" else "finalize"


def after_delivery(state: PipelineState) -> Literal["finalize", "apply_to_source"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    return "apply_to_source" if (state.get("delivery_approval") or {}).get("decision") == "approve" else "finalize"


def after_replan(state: PipelineState) -> Literal["finalize", "plan"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    return "plan"


def decision(route: Callable[[PipelineState], str | list[str]], state: PipelineState) -> tuple[str | list[str], str]:
    target = route(state)
    if route == after_plan and state.get("answer") and not state.get("failure") and not state.get("outcome"):
        return target, "direct_answer"
    if state.get("failure"):
        reason = "failure"
    elif state.get("outcome"):
        reason = state["outcome"]
    elif target == "run_lane":
        reason = "parallel_wave"
    elif route is after_merge:
        reason = "wave_merged" if target == "verify" else "replan_requested"
    elif route is after_verify and state.get("mode") == "integration" and state.get("feedback"):
        reason = "integration_failed"
    elif target == "replan":
        reason = "replan_requested"
    elif route is after_replan:
        reason = "replanned"
    elif target == ["index_repo", "baseline_checks"]:
        reason = "workspace_ready"
    elif target in ("plan_context", "implement_context"):
        reason = "need_context"
    elif target in ("plan", "implement", "review"):
        reason = {
            "after_plan": "output_invalid", "after_select": "all_steps_done",
            "after_implement": "output_invalid", "after_apply": "edits_rejected",
            "after_verify": "checks_failed" if state.get("feedback") else "checks_passed",
            "after_review": "changes_requested" if state.get("review") else "output_invalid",
        }[route.__name__]
    else:
        reason = {
            "after_plan": "plan_valid", "after_approve_plan": "approved",
            "after_select": "all_steps_done", "after_implement": "edits",
            "after_apply": "edits_applied", "after_verify": "checks_passed",
            "after_review": "review_approved", "after_package": "delivery_apply" if target == "approve_delivery" else "delivery_patch",
            "after_delivery": "approved" if target == "apply_to_source" else "declined",
        }[route.__name__]
    if route is after_select and target == "implement":
        reason = "next_step"
    return target, reason


def after_merge(state: PipelineState) -> Literal["finalize", "replan", "verify"]:
    if state.get("failure") or state.get("outcome"):
        return "finalize"
    return "replan" if state.get("replan_request") else "verify"

"""JSON-only graph state and pure reducers."""
import operator
from typing import Annotated, Any, TypedDict

from .models import Plan, PlanStep


def merge_counters(left: dict[str, int], right: dict[str, int]) -> dict[str, int]:
    result = dict(left)
    for key, value in right.items():
        result[key] = result.get(key, 0) + value
    return result


def append_bounded(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return (left + right)[-200:]


def keep_first[T](left: T, right: T) -> T:
    return left if left else right


def merge_lanes(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    return {**left, **right} if right else {}


class PipelineState(TypedDict, total=False):
    wave: dict[str, Any]
    serial_steps: list[str]
    waves: list[dict[str, Any]]
    lanes: Annotated[dict[str, Any], merge_lanes]
    lane: dict[str, Any]
    run_id: str
    task: str
    source_dir: str
    delivery_mode: str
    workspace: dict[str, Any]
    repo: dict[str, Any]
    baseline: list[dict[str, Any]]
    plan_revision: int
    plan_revisions: list[dict[str, Any]]
    previous_plan: dict[str, Any] | None
    replan_request: dict[str, Any] | None
    replan_brief: dict[str, Any] | None
    plan_evidence: list[dict[str, Any]]
    plan_requests: list[dict[str, Any]]
    plan: dict[str, Any] | None
    plan_digest: str
    risk_flags: list[str]
    plan_approval: dict[str, Any] | None
    mode: str
    step_index: int
    step_evidence: list[dict[str, Any]]
    step_requests: list[dict[str, Any]]
    pending_edits: dict[str, Any] | None
    feedback: dict[str, Any] | None
    checks: list[dict[str, Any]]
    steps_done: Annotated[list[dict[str, Any]], operator.add]
    deviations: list[str]
    review: dict[str, Any] | None
    review_round: int
    delivery: dict[str, Any] | None
    delivery_approval: dict[str, Any] | None
    counters: Annotated[dict[str, int], merge_counters]
    active_seconds: Annotated[float, operator.add]
    history: Annotated[list[dict[str, Any]], append_bounded]
    usage: dict[str, int]
    failure: Annotated[dict[str, str] | None, keep_first]
    outcome: Annotated[str, keep_first]


def get_plan(state: PipelineState) -> Plan | None:
    raw = state.get("plan")
    return Plan.model_validate(raw) if raw is not None else None


def current_step(state: PipelineState) -> PlanStep | None:
    plan = get_plan(state)
    index = state.get("step_index", -1)
    return plan.steps[index] if plan is not None and 0 <= index < len(plan.steps) else None


def done_ids(state: PipelineState) -> set[str]:
    return {s["step_id"][5:] for s in state.get("steps_done", []) if s["step_id"].startswith("step:")}


def counter(state: PipelineState, key: str) -> int:
    return state.get("counters", {}).get(key, 0)

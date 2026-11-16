"""Typed attempt observations only; replay and policy scoring belong to Node."""
import json
from typing import Any

from scranton_pipeline.nodes.common import Dependencies, scope_id
from scranton_pipeline.state import PipelineState, counter, current_step, done_ids, get_plan


def attempt_counter_key(state: PipelineState) -> str:
    lane = state.get("lane") or {}
    scope = json.dumps([state.get("plan_revision", 0), scope_id(state),
        [lane.get("wave"), lane.get("slot"), lane.get("step_id")] if lane else None], separators=(",", ":"))
    return "dream_attempts:" + scope


def attempt_observation(state: PipelineState, deps: Dependencies, *, rejected: bool = False,
                        results: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    mode = state.get("mode")
    step = current_step(state)
    revision = state.get("plan_revision", 0)
    lane = state.get("lane") or {}
    if (mode not in {"step", "revision"} or (mode == "step" and step is None)
            or (mode == "revision" and (lane or state.get("review_round", 0) < 1))):
        return None
    if lane and (lane.get("step_id") != step.id if step else True):
        return None
    if lane and any(type(lane.get(k)) is not int or lane[k] < 0 for k in ("wave", "slot")):
        return None
    scoped = counter(state, attempt_counter_key(state))
    spent = counter(state, "attempts:" + scope_id(state))
    ordinal = scoped + int(rejected)
    # Earlier plan scopes may have spent this execution budget; never reset it.
    ceiling = deps.cfg.limits.max_step_attempts - (spent - scoped)
    if not 1 <= ordinal <= ceiling or type(revision) is not int or revision < 0:
        return None
    plan = get_plan(state)
    completed = done_ids(state)
    if step and mode == "step":
        completed.add(step.id)
    final = not lane and plan is not None and (mode == "revision" or all(s.id in completed for s in plan.steps))
    required = {c.id for c in deps.cfg.checks if c.required and (c.scope == "step" or final)}
    if not required:
        return None
    passed = False
    if not rejected:
        rows = results or []
        if not required or any(r.get("id") not in {c.id for c in deps.cfg.checks} for r in rows):
            return None
        observed = [r for r in rows if r.get("id") in required]
        if (len({r["id"] for r in observed}) != len(observed)
                or any(r.get("status") not in {"passed", "failed", "timed_out"} for r in observed)):
            return None
        failed = any(r["status"] in {"failed", "timed_out"} for r in observed)
        passed = {r["id"] for r in observed} == required and all(r["status"] == "passed" for r in observed)
        if not failed and not passed:
            return None
    # JSON tuple encoding prevents model step IDs from colliding with scope separators.
    scope = attempt_counter_key(state).removeprefix("dream_attempts:")
    return {"schema": 1, "scope": scope, "ordinal": ordinal,
            "result": "passed" if passed else "failed", "quality": int(passed),
            "plan_revision": revision, "retry_ceiling": ceiling}


def emit_attempt(state: PipelineState, deps: Dependencies, *, rejected: bool = False,
                 results: list[dict[str, Any]] | None = None) -> None:
    observation = attempt_observation(state, deps, rejected=rejected, results=results)
    if observation is not None:
        deps.events.emit("dream_attempt", node="apply_edits" if rejected else "verify", **observation)

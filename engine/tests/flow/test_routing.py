"""Branch tables. Removing the corresponding routing return/guard breaks each row."""
from copy import deepcopy

import pytest

from scranton_pipeline import routing

CASES = [
    (routing.after_prepare, {}, ["index_repo", "baseline_checks"]),
    (routing.after_plan, {"plan_requests": [{}]}, "plan_context"),
    (routing.after_plan, {}, "plan"),
    (routing.after_plan, {"plan": {"steps": [1]}}, "approve_plan"),
    (routing.after_approve_plan, {}, "select_step"),
    (routing.after_select, {"plan": {"steps": [1]}, "step_index": 0}, "implement"),
    (routing.after_select, {"step_index": 0}, "review"),
    (routing.after_select, {"step_index": 0, "review": {"verdict": "approve"}}, "ground"),
    (routing.after_implement, {"step_requests": [{}]}, "implement_context"),
    (routing.after_implement, {"pending_edits": {"kind": "edits"}}, "apply_edits"),
    (routing.after_implement, {}, "implement"),
    (routing.after_apply, {"feedback": {"kind": "edits_rejected"}}, "implement"),
    (routing.after_apply, {}, "verify"),
    (routing.after_verify, {"feedback": {"kind": "checks_failed"}}, "implement"),
    (routing.after_verify, {"mode": "revision"}, "review"),
    (routing.after_verify, {}, "select_step"),
    (routing.after_merge, {"mode": "integration", "wave": {"records": [{"step_id": "step:a"}], "deferred": {"replan_request": {"code": "step_blocked"}}}}, "verify"),
    (routing.after_merge, {"replan_request": {"code": "step_blocked"}}, "replan"),
    (routing.after_verify, {"mode": "integration", "replan_request": {"code": "step_blocked"}}, "replan"),
    (routing.after_review, {}, "review"),
    (routing.after_review, {"review": {"verdict": "approve"}}, "ground"),
    (routing.after_review, {"review": {"verdict": "request_changes"}}, "implement"),
    (routing.after_package, {"delivery_mode": "apply"}, "approve_delivery"),
    (routing.after_package, {"delivery_mode": "patch"}, "finalize"),
    (routing.after_delivery, {"delivery_approval": {"decision": "approve"}}, "apply_to_source"),
    (routing.after_delivery, {"delivery_approval": {"decision": "reject"}}, "finalize"),
]


@pytest.mark.parametrize("route,state,target", CASES)
def test_routing(route, state, target):
    before = deepcopy(state)
    assert route(state) == target
    assert state == before
    for terminal in ({"failure": {"code": "x"}}, {"outcome": "cancelled"}):
        assert route({**state, **terminal}) == "finalize"


def test_bound_increases():
    from scranton_pipeline.config import Limits
    from scranton_pipeline.limits import recursion_limit
    assert recursion_limit(Limits()) > 100
    assert recursion_limit(Limits(max_plan_steps=1)) < recursion_limit(Limits())

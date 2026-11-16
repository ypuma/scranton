"""Attempt identity and eligibility; no replay implementation lives in Python."""
import copy
from types import SimpleNamespace

import pytest

from scranton_pipeline.demo.fixture import PLAN, config
from scranton_pipeline.dreaming import attempt_counter_key, attempt_observation
from scranton_pipeline.nodes.common import scope_id


def state_for(**extra):
    state = {"mode": "step", "plan": copy.deepcopy(PLAN["plan"]), "step_index": 0,
             "plan_revision": 0, "wave": {"number": 1}, **extra}
    state["counters"] = {"attempts:" + scope_id(state): 1, attempt_counter_key(state): 1}
    return state


def deps_for(tmp_path):
    return SimpleNamespace(cfg=config(tmp_path))


def test_binary_results_and_fail_fast(tmp_path):
    deps = deps_for(tmp_path)
    state = state_for()
    check = deps.cfg.checks[0].id
    for status in ("passed", "failed", "timed_out"):
        row = attempt_observation(state, deps, results=[{"id": check, "status": status}])
        assert row == {"schema": 1, "scope": '[0,"step:fix",null]', "ordinal": 1,
                       "result": "passed" if status == "passed" else "failed",
                       "quality": int(status == "passed"), "plan_revision": 0,
                       "retry_ceiling": deps.cfg.limits.max_step_attempts}
    second = deps.cfg.checks[0].model_copy(update={"id": "second"})
    deps.cfg = deps.cfg.model_copy(update={"checks": [*deps.cfg.checks, second]})
    assert attempt_observation(state, deps, results=[{"id": check, "status": "failed"}])["quality"] == 0
    assert attempt_observation(state, deps, results=[{"id": check, "status": "passed"}]) is None


@pytest.mark.parametrize("rows", [[], [{"id": "unknown", "status": "passed"}],
    [{"id": "unit", "status": "error"}], [{"id": "unit", "status": "unknown"}],
    [{"id": "unit", "status": "passed"}] * 2])
def test_missing_ambiguous_or_infrastructure_results_omitted(tmp_path, rows):
    assert attempt_observation(state_for(), deps_for(tmp_path), results=rows) is None


@pytest.mark.parametrize("mode", ["integration", "baseline", "", "approval"])
def test_non_coding_scopes_omitted(tmp_path, mode):
    assert attempt_observation(state_for(mode=mode), deps_for(tmp_path), rejected=True) is None


def test_no_required_checks_and_invalid_attempt_not_success(tmp_path):
    deps = deps_for(tmp_path)
    state = state_for()
    for checks in ([], [deps.cfg.checks[0].model_copy(update={"required": False})]):
        deps.cfg = deps.cfg.model_copy(update={"checks": checks})
        assert attempt_observation(state, deps, results=[]) is None
        assert attempt_observation(state, deps, rejected=True) is None
    for n in (0, -1, 100):
        state["counters"] = {"attempts:step:fix": n}
        assert attempt_observation(state, deps, results=[]) is None


def test_scope_identity_and_rejected_next_ordinal(tmp_path):
    deps = deps_for(tmp_path)
    states = [state_for(), state_for(plan_revision=1),
              state_for(lane={"wave": 1, "slot": 0, "step_id": "fix"}),
              state_for(lane={"wave": 2, "slot": 0, "step_id": "fix"}),
              state_for(mode="revision", review_round=1),
              state_for(mode="revision", review_round=2)]
    rows = [attempt_observation(s, deps, rejected=True) for s in states]
    assert len({r["scope"] for r in rows}) == len(states)
    assert all(r["ordinal"] == 2 and r["result"] == "failed" and r["quality"] == 0 for r in rows)
    for lane in ({"wave": 1, "slot": 0, "step_id": "wrong"}, {"step_id": "fix"}):
        assert attempt_observation(state_for(lane=lane), deps, rejected=True) is None


def test_final_checks_only_when_eligible(tmp_path):
    deps = deps_for(tmp_path)
    final = deps.cfg.checks[0].model_copy(update={"scope": "final"})
    deps.cfg = deps.cfg.model_copy(update={"checks": [final]})
    state = state_for()
    assert attempt_observation(state, deps, results=[{"id": final.id, "status": "passed"}])["quality"] == 1
    state["lane"] = {"wave": 1, "slot": 0, "step_id": "fix"}
    assert attempt_observation(state, deps, results=[]) is None


@pytest.mark.parametrize("extra", [{}, {"mode": "revision", "review_round": 1},
    {"lane": {"wave": 3, "slot": 1, "step_id": "fix"}}])
def test_scope_counter_does_not_restore_spent_execution_budget(tmp_path, extra):
    state = state_for(plan_revision=1, **extra)
    deps = deps_for(tmp_path)
    state["counters"]["attempts:" + scope_id(state)] = 2
    row = attempt_observation(state, deps, results=[{"id": deps.cfg.checks[0].id, "status": "failed"}])
    assert (row["ordinal"], row["retry_ceiling"]) == (1, 2)
    row = attempt_observation(state, deps, rejected=True)
    assert (row["ordinal"], row["retry_ceiling"]) == (2, 2)
    state["counters"][attempt_counter_key(state)] = 2
    state["counters"]["attempts:" + scope_id(state)] = 3
    assert attempt_observation(state, deps, rejected=True) is None


def test_lane_scope_preserves_long_unicode_and_separator_ids(tmp_path):
    import json
    step_id = '\u03bb"\\:rev:[]' + "x" * 1014
    state = state_for(lane={"wave": 2, "slot": 3, "step_id": step_id})
    state["plan"]["steps"][0]["id"] = step_id
    state["counters"] = {"attempts:" + scope_id(state): 1, attempt_counter_key(state): 1}
    row = attempt_observation(state, deps_for(tmp_path), rejected=True)
    assert json.loads(row["scope"]) == [0, "step:" + step_id, [2, 3, step_id]]

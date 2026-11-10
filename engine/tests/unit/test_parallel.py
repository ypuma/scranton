"""Parallel guards identify the production statement whose reversal breaks them."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from scranton_pipeline.config import Limits
from scranton_pipeline.errors import EngineError
from scranton_pipeline.limits import recursion_limit
from scranton_pipeline.models import PlanStep
from scranton_pipeline.observability import UsageLedger
from scranton_pipeline.waves import dependencies, wave


def step(sid, path, deps=None):
    return PlanStep(id=sid, title=sid, description=sid, files=[{"path": path, "action": "modify"}], depends_on=deps)


@pytest.mark.parametrize("steps,done,cap,expected", [
    ([step("a", "a"), step("b", "b")], [], 2, [0]),
    ([step("a", "a", []), step("b", "b", [])], [], 2, [0, 1]),
    ([step("a", "a", []), step("b", "b", [])], [], 1, [0]),
    ([step("a", "A", []), step("b", "a", []), step("c", "c", [])], [], 4, [0, 2]),
    ([step("a", "a", ["b"]), step("b", "b", [])], [], 2, [1]),
    ([step("a", "a", []), step("b", "b", ["a"])], ["a"], 2, [1]),
    ([step("a", "a", []), step("b", "b", [])], ["a", "b"], 4, []),
])
def test_wave_table(steps, done, cap, expected):
    # Guards waves.wave dependency/occupied/cap predicates.
    assert wave(steps, done, cap) == expected


@pytest.mark.parametrize("steps", [
    [step("a", "a", ["unknown"])], [step("a", "a", ["a"])],
    [step("a", "a", ["b"]), step("b", "b", ["a"])],
    [step("a", "a"), step("a", "b")], [step(" ", "a")],
])
def test_invalid_dependency_graph(steps):
    # Guards dependencies() ID and topological-progress validation.
    with pytest.raises(ValueError):
        dependencies(steps)


def test_atomic_reservation_at_last_call(tmp_path):
    # Guard UsageLedger.reserve: move the budget check outside file_lock -> both pass.
    ledger = UsageLedger(tmp_path / "usage.jsonl")
    barrier = Barrier(2)
    def reserve(_):
        barrier.wait(timeout=5)
        try:
            return ledger.reserve(role="implementer", model="fake", scope="step:a", input_tokens=1,
                                  output_tokens=1, max_calls=1, max_tokens=100)
        except EngineError as exc:
            return exc.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, range(2)))
    assert results.count("llm_budget_exhausted") == 1
    assert ledger.totals().calls == 1


@pytest.mark.parametrize("steps", [2, 8, 32])
@pytest.mark.parametrize("replans", [0, 1, 3])
@pytest.mark.parametrize("repairs", [0, 2, 10])
def test_parallel_recursion_upper_bound(steps, replans, repairs):
    # Guard limits.recursion_limit: remove the second work allowance -> this fails.
    lim = Limits(max_plan_steps=steps, max_replans=replans, max_output_repairs=repairs,
                 max_step_attempts=10, max_step_context_rounds=10, max_plan_context_rounds=10,
                 max_review_rounds=10)
    work = 1 + repairs + 20 + 30
    planning = 1 + repairs + 20
    # Even pessimistically charging an integration repair for EVERY step is covered.
    visits = 4 + (replans + 1) * (planning + steps * (2 * work + 5) + 2) + 10 * work + 11 * (1 + repairs) + 5
    assert recursion_limit(lim) >= visits


def test_integration_repairs_only_merged_paths(tmp_path, monkeypatch):
    # Guard workflow.apply_edits selected filter: removing state == merged exposes failed lane paths.
    from types import SimpleNamespace

    from scranton_pipeline.demo.fixture import config
    from scranton_pipeline.nodes import workflow
    seen = []
    def validate(edits, **kwargs):
        seen.append(kwargs["declared"])
        return SimpleNamespace(ok=True, changed=[], undeclared=[])
    monkeypatch.setattr(workflow, "validate_and_apply", validate)
    repo = SimpleNamespace(reset_hard=lambda head: None, commit_paths=lambda paths, message: "head")
    deps = SimpleNamespace(cfg=config(tmp_path), repo=lambda: repo, workspace=tmp_path,
                           policy=lambda: None, events=SimpleNamespace(emit=lambda *a, **kw: None))
    workflow.apply_edits({"mode": "integration", "wave": {"number": 1, "indices": [0, 1]},
        "lanes": {"a": {"state": "merged"}, "b": {"state": "failed"}},
        "plan": {"summary": "Test", "steps": [step("a", "a.py").model_dump(), step("b", "b.py").model_dump()], "acceptance_criteria": [{"id": "ok", "text": "Works", "verified_by": "checks"}]},
        "workspace": {"head_commit": "head"}, "pending_edits": {"kind": "edits", "edits": [{"path": "a.py", "action": "modify", "content": "ok"}]}}, deps)
    assert seen == [{"a.py"}]

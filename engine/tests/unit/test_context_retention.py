"""Retention at the real fulfil/node/prompt boundaries; no grounding waivers."""
import json

import pytest
from test_grounding import grounded as grounded  # noqa: PLC0414
from test_grounding import kinds

from scranton_pipeline.agents.prompts import build_implementer_prompt, fresh_evidence
from scranton_pipeline.grounding import context_id
from scranton_pipeline.models import ContextRequest
from scranton_pipeline.nodes import grounding, workflow
from scranton_pipeline.tools.context import fulfil


def read(deps, path="calculator.py", **kwargs):
    return fulfil([ContextRequest(kind="read", path=path, **kwargs)], workspace=deps.workspace,
                  policy=deps.policy(), files=[path], limits=deps.cfg.limits,
                  redactor=deps.redactor)[0].model_dump(mode="json")


def large_file(deps):
    text = "".join(f"# line {n:04d} " + "x" * 55 + " é\n" for n in range(1, 601))
    text = text.replace("# line 0520", "# DISTINCTIVE_TAIL_0520")
    (deps.workspace / "calculator.py").write_text(text, encoding="utf-8")
    assert len(text.encode()) > 20000


@pytest.mark.parametrize("stage", ["node", "prompt"])
@pytest.mark.parametrize("automatic_ok", [True, False])
def test_targeted_tail_survives_truncated_or_failed_automatic_read(grounded, stage, automatic_ok):
    state, deps = grounded
    large_file(deps)
    auto = {**read(deps), "python_read": True}
    assert auto["truncated"]
    if not automatic_ok:
        auto.update(ok=False, content="", note="Path unavailable")
        auto["evidence_id"] = context_id(auto)
        # Several failed prereads still must not reserve priority over useful content.
        auto["note"] *= 2000
    state["step_evidence"] = [auto]
    request = ContextRequest(kind="read", path="calculator.py", start_line=480, end_line=570)
    state["step_requests"] = [request.model_dump(mode="json")]
    if stage == "node":
        deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_prompt_bytes": 23000})})
    update = workflow.context(state, deps, planner=False)
    if stage == "node":
        assert len(json.dumps(update["step_evidence"]).encode()) <= 23000
        assert any("DISTINCTIVE_TAIL" in i["content"] for i in update["step_evidence"])
    state.update(update)
    deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_prompt_bytes": 30000})})
    # This is also what implement() appends on every turn.
    state["step_evidence"].append({**read(deps), "python_read": True})
    prompt = build_implementer_prompt(state, deps.cfg)
    assert "DISTINCTIVE_TAIL_0520" in prompt.user
    assert len((prompt.system + prompt.user).encode()) <= 30000
    prompt.user.encode().decode("utf-8")
    assert prompt.shown == sorted(i["evidence_id"] for i in prompt.items)
    assert all(json.dumps(i, ensure_ascii=True) in prompt.user for i in prompt.items)
    target = next(i for i in prompt.items if i["request"].get("start_line") == 480)
    assert target["evidence_id"] == context_id(target)
    assert target["sha256"] == read(deps)["sha256"] and not target["truncated"]
    assert len(target["content"].encode()) <= deps.cfg.limits.max_context_item_bytes
    replace = {"edits": [{"path": "calculator.py", "action": "modify", "replacements": [{"search": "x", "replace": "y"}]}]}
    assert not grounding.evaluate(state, deps, "implementer", prompt, replace).violations
    overwrite = {"edits": [{"path": "calculator.py", "action": "modify", "content": "new"}]}
    assert kinds(grounding.evaluate(state, deps, "implementer", prompt, overwrite)) == {"unseen_edit"}
    replace["edits"][0]["path"] = "unseen.py"
    assert "unseen_edit" in kinds(grounding.evaluate(state, deps, "implementer", prompt, replace))


def test_repeated_explicit_requests_move_to_newest_without_duplicate_prereads(grounded):
    state, deps = grounded
    large_file(deps)
    first = read(deps, start_line=480, end_line=490)
    other = read(deps, start_line=500, end_line=510)
    auto = {**read(deps), "python_read": True}
    state["step_evidence"] = [first, auto, other, first, auto, auto]
    fresh = fresh_evidence(state, deps.cfg, "step_evidence")
    assert len(fresh) == 3
    assert fresh[-1]["evidence_id"] == first["evidence_id"]
    state["step_requests"] = [first["request"]]
    update = workflow.context(state, deps, planner=False)
    assert len(update["step_evidence"]) == 3
    assert update["step_evidence"][-1]["evidence_id"] == first["evidence_id"]


def test_complete_preread_kept_when_it_fits_and_redaction_and_item_caps_hold(grounded):
    state, deps = grounded
    state["step_evidence"] = [{**read(deps), "python_read": True}]
    prompt = build_implementer_prompt(state, deps.cfg)
    assert state["step_evidence"][0]["evidence_id"] in prompt.shown
    assert not grounding.evaluate(state, deps, "implementer", prompt,
        {"edits": [{"path": "calculator.py", "action": "modify", "content": "new"}]}).violations
    (deps.workspace / "calculator.py").write_text("password=hidden\n" + "é" * 30000, encoding="utf-8")
    item = read(deps)
    assert item["truncated"] and "hidden" not in item["content"]
    assert len(item["content"].encode()) <= 20000
    state["step_evidence"] = [item]
    assert fresh_evidence(state, deps.cfg, "step_evidence")[0]["evidence_id"] == context_id(item)


@pytest.mark.parametrize("pressure", [False, True])
def test_select_step_preread_provenance_survives_implement_deduplication(grounded, monkeypatch, pressure):
    from types import SimpleNamespace

    from scranton_pipeline.models import ImplementerTurn
    from scranton_pipeline.tools.context import unique_evidence

    state, deps = grounded
    (deps.workspace / "calculator.py").write_text("# complete preread\n" + "x" * 6000, encoding="utf-8")
    (deps.workspace / "ordinary.txt").write_text("ordinary " * 700, encoding="utf-8")
    state["workspace"]["files"].append("ordinary.txt")
    state.update(workflow.select_step(state, deps))
    preread = state["step_evidence"][0]
    assert preread["ok"] and not preread["truncated"] and not preread.get("python_read")
    ordinary = read(deps, "ordinary.txt")
    state["step_evidence"].append(ordinary)
    merged = unique_evidence([*state["step_evidence"], {**read(deps), "python_read": True}])
    assert [i["evidence_id"] for i in merged] == [preread["evidence_id"], ordinary["evidence_id"]]
    assert not preread.get("python_read")

    captured, rendered = [], []
    original = workflow.build_implementer_prompt

    def capture(*args, **kwargs):
        prompt = original(*args, **kwargs)
        captured.append(prompt)
        return prompt

    def complete(role, **kwargs):
        rendered.append(kwargs["user"])
        return SimpleNamespace(parsed=ImplementerTurn(kind="need_context", context_requests=[ContextRequest(kind="list")]))

    monkeypatch.setattr(workflow, "build_implementer_prompt", capture)
    deps.gateway = SimpleNamespace(complete=complete)
    full = original({**state, "step_evidence": merged}, deps.cfg)
    budget = len(full.system.encode()) + (100 if pressure else 7500)
    deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_prompt_bytes": budget})})
    update = workflow.implement(state, deps)
    assert update["step_requests"] and not update.get("feedback")
    prompt = captured[0]
    assert rendered == [prompt.user]
    assert len((prompt.system + prompt.user).encode()) <= budget
    assert ordinary["evidence_id"] not in prompt.shown
    assert (preread["evidence_id"] in prompt.shown) == (not pressure)
    assert prompt.unverifiable == (["calculator.py"] if pressure else [])
    assert all(json.dumps(i, ensure_ascii=True) in prompt.user for i in prompt.items)
    if not pressure:
        kept = next(i for i in prompt.items if i["evidence_id"] == preread["evidence_id"])
        assert kept["content"] == preread["content"] and kept["python_read"] and not kept["truncated"]


def test_requestless_evidence_keeps_independent_identity_and_order():
    from copy import deepcopy

    from scranton_pipeline.tools.context import unique_evidence

    first = {"evidence_id": "E-0000000001", "content": "first"}
    second = {"evidence_id": "E-0000000002", "content": "second"}
    same_id = {**first, "content": "different content, no known locator"}
    explicit = {"request": {"kind": "list", "path": ""}, "content": "files", "ok": True}
    entries = [first, explicit, second, same_id, first, explicit]
    before = deepcopy(entries)
    result = unique_evidence(entries)
    assert result == [first, second, same_id, first, explicit]
    assert entries == before
    assert all("request" not in i and "python_read" not in i for i in result[:-1])


@pytest.mark.parametrize("planner", [False, True])
@pytest.mark.parametrize("pressure", [False, True])
def test_requestless_context_node_retention_and_eviction(grounded, planner, pressure):
    from copy import deepcopy

    state, deps = grounded
    prefix = "plan" if planner else "step"
    first = {"evidence_id": "E-0000000001", "content": "old " * 3000, "ok": True}
    second = {"evidence_id": "E-0000000002", "content": "new " * 3000, "ok": True}
    before = deepcopy([first, second])
    state[f"{prefix}_evidence"] = [first, second]
    state[f"{prefix}_requests"] = [ContextRequest(kind="list").model_dump(mode="json")]
    cap = 18000 if pressure else 30000
    deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_prompt_bytes": cap})})
    update = workflow.context(state, deps, planner=planner)
    kept = update[f"{prefix}_evidence"]
    assert kept[:1 if pressure else 2] == ([second] if pressure else before)
    assert len(kept) == (2 if pressure else 3)
    assert kept[-1]["request"]["kind"] == "list"
    assert len(json.dumps(kept).encode()) <= cap
    assert [first, second] == before


@pytest.mark.parametrize("role", ["planner", "implementer", "reviewer"])
@pytest.mark.parametrize("pressure", [False, True])
def test_requestless_prompt_retention_and_eviction(grounded, role, pressure):
    from scranton_pipeline.agents.prompts import bounded

    _, deps = grounded
    first = {"evidence_id": "E-0000000001", "content": "old " * 1500}
    second = {"evidence_id": "E-0000000002", "content": "new " * 1500}
    system = bounded(role, {}, [], deps.cfg).system
    cap = len(system.encode()) + (8000 if pressure else 16000)
    cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_prompt_bytes": cap})})
    prompt = bounded(role, {}, [first, second], cfg)
    assert prompt.items == ([second] if pressure else [first, second])
    assert prompt.shown == sorted(i["evidence_id"] for i in prompt.items)
    assert all(json.dumps(i, ensure_ascii=True) in prompt.user for i in prompt.items)
    assert len((prompt.system + prompt.user).encode()) <= cap
    assert prompt.unverifiable == []
    assert "request" not in first and "request" not in second

import copy
import hashlib
import json
from typing import get_args

import pytest

from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.agents.prompts import (
    bounded,
    build_implementer_prompt,
    build_planner_prompt,
    build_reviewer_prompt,
)
from scranton_pipeline.agents.providers import Role, build_chat_model
from scranton_pipeline.config import EngineConfig
from scranton_pipeline.demo.fixture import config
from scranton_pipeline.guidance import situation, text
from scranton_pipeline.observability import EventLog, UsageLedger
from scranton_pipeline.procedure import VOCABULARY, GraphEdit, load, render
from scranton_pipeline.tools.secrets import Redactor


@pytest.mark.parametrize("role,state,expected", [
    ("planner", {}, "plan.start"),
    ("planner", {"plan_revision": 1}, "plan.replan"),
    ("planner", {"counters": {"plan_context:r0": 1}}, "plan.context"),
    ("planner", {"plan_revision": 1, "counters": {"plan_context:r0": 1}}, "plan.replan"),
    ("planner", {"feedback": {"kind": "output_invalid"}}, "plan.repair"),
    ("planner", {"feedback": {"kind": "output_invalid"}, "history": [{"node": "plan_context"}]}, "plan.context"),
    ("implementer", {}, "implement.start"),
    ("implementer", {"feedback": {"kind": "output_invalid"}}, "implement.repair"),
    ("implementer", {"feedback": {"kind": "edits_rejected"}}, "implement.edits_rejected"),
    ("implementer", {"feedback": {"kind": "checks_failed"}}, "implement.checks_failed"),
    ("implementer", {"feedback": {"kind": "review_changes"}}, "implement.review_changes"),
    ("implementer", {"mode": "revision"}, "implement.review_changes"),
    ("implementer", {"mode": "integration", "feedback": {"kind": "checks_failed"}}, "implement.integration"),
    ("implementer", {"history": [{"node": "implement_context"}], "feedback": {"kind": "checks_failed"}}, "implement.context"),
    ("reviewer", {}, "review.start"),
    ("reviewer", {"review_round": 1}, "review.recheck"),
    ("reviewer", {"review_round": 1, "feedback": {"kind": "output_invalid"}}, "review.repair"),
])
def test_situation_pure_total(role, state, expected):
    before = copy.deepcopy(state)
    assert situation(role, state) == expected
    assert expected in VOCABULARY and state == before


@pytest.mark.parametrize("builder", [build_planner_prompt, build_implementer_prompt, build_reviewer_prompt])
def test_disabled_prompt_bytes(builder, tmp_path, monkeypatch):
    from scranton_pipeline import guidance
    cfg = config(tmp_path)
    state = {"task": "Fix", "feedback": {"kind": "output_invalid", "message": "repair"}}
    legacy = builder(state, cfg)
    hashes = {"build_planner_prompt": "23d2de5984421ea3a03b326e064151162f495514efa6abf9d475a6f0766b0270",
        "build_implementer_prompt": "bbe873d689ad2b42482538bee98bfeb5da68484931b2ea49d1966586f0670196",
        "build_reviewer_prompt": "900abb9c14ef8a68acec902ab3d86ca98e75f1341cf29f6e304dfb2da1b17b39"}
    assert hashlib.sha256((legacy.system + legacy.user).encode()).hexdigest() == hashes[builder.__name__]
    monkeypatch.setattr(guidance, "render", lambda *a, **kw: pytest.fail("Disabled guidance rendered"))
    supplied = builder(state, cfg, graph=load(None))
    assert (supplied.system, supplied.user, supplied.shown) == (legacy.system, legacy.user, legacy.shown)
    assert '"guidance"' not in supplied.user


@pytest.mark.parametrize("role", ["planner", "implementer", "reviewer"])
def test_guidance_control_budget_and_shown(role, tmp_path):
    cfg = config(tmp_path)
    cfg = cfg.model_copy(update={"procedure": cfg.procedure.model_copy(update={"enabled": True})})
    graph = load(None)
    guidance = text(graph, role, {}, hops=0, max_bytes=1000)
    data = {"bulk": "x" * 200000, "feedback": {"message": "KEEP FEEDBACK"}, "validation_feedback": "KEEP VALIDATION"}
    evidence = [{"evidence_id": "E-0123456789", "content": "x" * 10000}]
    system = bounded(role, {}, [], cfg).system
    cfg = cfg.model_copy(update={"limits": cfg.limits.model_copy(update={"max_prompt_bytes": len(system.encode()) + 1500})})
    prompt = bounded(role, data, evidence, cfg, guidance=guidance)
    assert len((prompt.system + prompt.user).encode()) <= cfg.limits.max_prompt_bytes + cfg.procedure.max_bytes
    assert json.dumps(guidance) in prompt.user
    assert all(s in prompt.user for s in ("KEEP FEEDBACK", "KEEP VALIDATION"))
    assert prompt.shown == [] and "TRUNCATED" in prompt.user
    # Oversized advice is shortened at whole-edge boundaries, never at the expense of feedback.
    huge = guidance + "\n" + ("edge " * 5000)
    trimmed = bounded(role, data, [], cfg, guidance=huge)
    assert json.dumps(guidance) in trimmed.user and "KEEP VALIDATION" in trimmed.user
    assert len((trimmed.system + trimmed.user).encode()) <= cfg.limits.max_prompt_bytes + cfg.procedure.max_bytes


def test_render_localization_caps_and_no_evidence(tmp_path):
    cfg = config(tmp_path)
    cfg = cfg.model_copy(update={"procedure": cfg.procedure.model_copy(update={"enabled": True, "hops": 0, "max_bytes": 500})})
    graph = load(None)
    prompt = build_planner_prompt({"task": "Fix"}, cfg, graph=graph)
    assert json.dumps(render(graph, "plan.start", hops=0, max_bytes=500)) in prompt.user
    assert "--LEADS_TO-->" not in prompt.user
    sparse = graph.model_copy(update={"nodes": [], "edges": []})
    assert '"guidance"' not in build_planner_prompt({"task": "Fix"}, cfg, graph=sparse).user
    assert '"guidance"' not in build_planner_prompt({"task": "Fix"}, cfg.model_copy(update={"procedure": cfg.procedure.model_copy(update={"max_bytes": 1})}), graph=graph).user
    changed = graph.model_copy(update={"nodes": [n.model_copy(update={"description": "E-0123456789 H-abcdef0123 K-0000000000"}) for n in graph.nodes]})
    sanitized = build_planner_prompt({"task": "Fix"}, cfg, graph=changed)
    assert "[not evidence]" in sanitized.user
    assert "E-0123456789" not in sanitized.user and sanitized.shown == []


def test_optional_refiner_gateway_script_and_ledger(tmp_path):
    cfg = config(tmp_path)
    assert cfg.models.refiner is None and "refiner" not in cfg.model_dump()["models"]
    path = tmp_path / "refiner.json"
    path.write_text(json.dumps([{"rationale": "first"}, {"rationale": "second"}]))
    raw = cfg.model_dump(by_alias=True)
    raw["models"]["refiner"] = {"provider": "scripted", "script_path": str(path)}
    cfg = EngineConfig.model_validate(raw)
    from scranton_pipeline.models import Role as SchemaRole
    assert "refiner" in get_args(Role) and "refiner" in get_args(SchemaRole)
    ledger = UsageLedger(tmp_path / "usage.jsonl")
    for expected in ("first", "second"):
        model = build_chat_model(cfg.models.refiner, {}, ledger=ledger, role="refiner")
        gateway = ChatModelGateway({"refiner": model}, cfg, ledger, EventLog(tmp_path / "events.jsonl", "refiner1", Redactor()))
        assert gateway.complete("refiner", system="Edit advice", user="Graph", schema=GraphEdit).parsed.rationale == expected
    assert ledger.calls_for("refiner") == 2 and ledger.calls_for("planner") == 0

import copy
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from scranton_pipeline.agents.prompts import (
    Prompt,
    bounded,
    build_planner_prompt,
    build_reviewer_prompt,
    fresh_evidence,
)
from scranton_pipeline.demo.fixture import EDIT, PLAN, config
from scranton_pipeline.grounding import (
    append_trace,
    check_id,
    context_id,
    diff_hunks,
    recompute_summary,
    register,
    score_trace,
)
from scranton_pipeline.models import ContextRequest, Plan, Review
from scranton_pipeline.nodes import grounding, planner, workflow
from scranton_pipeline.observability import EventLog, UsageLedger, _rows
from scranton_pipeline.tools.context import fulfil
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.process import StopSignal
from scranton_pipeline.tools.secrets import Redactor


@pytest.fixture
def grounded(tmp_path):
    from scranton_pipeline.nodes.common import Dependencies
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "calculator.py").write_text("def add(a, b):\n    return a - b\n")
    run = tmp_path / "run"
    run.mkdir()
    cfg = config(run, sandbox="host")
    deps = Dependencies(cfg, run, workspace, None, UsageLedger(run / "usage.jsonl"),
        EventLog(run / "events.jsonl", "ground001", Redactor()), StopSignal(run / "cancel"), Redactor(), trust_host=True)
    state = {"task": "Fix addition", "plan": Plan.model_validate(PLAN["plan"]).model_dump(mode="json"),
        "step_index": 0, "mode": "step", "workspace": {"path": str(workspace), "files": ["calculator.py"],
        "head_commit": "head", "base_commit": "base"}, "checks": [], "baseline": []}
    return state, deps


def items(state, deps, **kw):
    return [i.model_dump(mode="json") for i in fulfil([ContextRequest(kind="read", path="calculator.py", **kw)],
        workspace=deps.workspace, policy=deps.policy(), files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)]


def kinds(evaluation):
    return {v["kind"] for v in evaluation.violations}


def test_content_ids_and_stale_refresh(grounded):
    state, deps = grounded
    first = items(state, deps)
    assert first == items(state, deps)
    assert first[0]["evidence_id"] == context_id(first[0])
    state["plan_evidence"] = first
    (deps.workspace / "calculator.py").write_text("def add(a, b): return a + b\n")
    fresh = fresh_evidence(state, deps.cfg, "plan_evidence")
    assert fresh[0]["evidence_id"] != first[0]["evidence_id"]
    assert "a + b" in fresh[0]["content"]
    (deps.workspace / "calculator.py").unlink()
    assert not fresh_evidence(state, deps.cfg, "plan_evidence")[0]["ok"]
    check = {"id": "unit", "status": "passed", "exit_code": 0, "output_tail": "ok"}
    assert check_id(check, "verify", "head") == check_id(check, "verify", "head")
    assert len({check_id(check, stage, commit) for stage, commit in [("verify", "head"), ("baseline", "head"), ("verify", "base")]}) == 3
    assert diff_hunks("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n")[0]["evidence_id"].startswith("H-")


def test_only_final_prompt_items_count_after_fifo_and_hard_slice(grounded):
    state, deps = grounded
    evidence = items(state, deps)
    full = bounded("planner", {}, evidence, deps.cfg)
    assert full.shown == [evidence[0]["evidence_id"]]
    cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_prompt_bytes": len(full.system.encode()) + 100})})
    cut = bounded("planner", {"bulk": "x" * 4000}, evidence, cfg)
    assert not cut.shown
    assert len((cut.system + cut.user).encode()) <= cfg.limits.max_prompt_bytes
    evaluation = grounding.evaluate(state, deps, "planner", cut, PLAN)
    assert kinds(evaluation) == {"unseen_target"}
    assert evaluation.reject(deps)
    assert grounding.repair_evidence(state, deps, evaluation, "plan_evidence")[0]["ok"]


@pytest.mark.parametrize("action,full", [("modify", True), ("modify", False), ("delete", False)])
def test_overwrites_need_full_reads_replacements_allow_ranges(grounded, action, full):
    state, deps = grounded
    edit = {"path": "calculator.py", "action": action}
    if action == "modify":
        edit.update({"content": "new"} if full else {"replacements": [{"search": "a - b", "replace": "a + b"}]})
    raw = {"kind": "edits", "edits": [edit]}
    partial = Prompt("", "", items(state, deps, start_line=2))
    evaluation = grounding.evaluate(state, deps, "implementer", partial, raw)
    assert ("unseen_edit" in kinds(evaluation)) == full
    assert not grounding.evaluate(state, deps, "implementer", Prompt("", "", items(state, deps)), raw).violations


@pytest.mark.parametrize("kind", ["unknown_citation", "unsupported_assessment", "unsupported_finding", "protected_request", "out_of_scope_edit"])
def test_closed_violation_kinds(grounded, kind):
    state, deps = grounded
    state["plan"]["acceptance_criteria"][0]["verified_by"] = "review"
    state["delivery"] = {"files": [{"path": "calculator.py"}]}
    deps.cfg = deps.cfg.model_copy(update={"policy": deps.cfg.policy.model_copy(update={"scope": "strict"})})
    role, raw = "reviewer", {"criteria": [], "findings": []}
    if kind == "unknown_citation":
        raw["criteria"] = [{"id": "sum", "status": "met", "citations": ["H-0000000000"]}]
    elif kind == "unsupported_assessment":
        raw["criteria"] = [{"id": "sum", "status": "met"}]
    elif kind == "unsupported_finding":
        raw["findings"] = [{"path": "calculator.py", "severity": "major"}]
    elif kind == "protected_request":
        role, raw = "planner", {"context_requests": [{"path": ".env", "kind": "read"}]}
    else:
        role, raw = "implementer", {"edits": [{"path": "other.py", "action": "create", "content": "x"}]}
    assert kind in kinds(grounding.evaluate(state, deps, role, Prompt("", "", []), raw))


def test_review_citations_and_check_assessments_ignored(grounded):
    state, deps = grounded
    state["plan"]["acceptance_criteria"][0]["verified_by"] = "review"
    hunk = {"evidence_id": "H-0123456789", "path": "calculator.py", "content": "diff"}
    raw = {"criteria": [{"id": "sum", "status": "met", "citations": [hunk["evidence_id"]]}],
        "findings": [{"path": "calculator.py", "severity": "major", "citations": [hunk["evidence_id"]]}]}
    state["delivery"] = {"files": [{"path": "calculator.py"}]}
    assert not grounding.evaluate(state, deps, "reviewer", Prompt("", "", [hunk]), raw).violations
    state["plan"]["acceptance_criteria"][0]["verified_by"] = "checks"
    assert not grounding.evaluate(state, deps, "reviewer", Prompt("", "", []), {"criteria": [{"id": "sum", "status": "met"}]}).violations
    prompt = build_reviewer_prompt(state, deps.cfg)
    assert '"criteria": []' in prompt.user
    assert '"configured_checks"' in build_planner_prompt(state, deps.cfg).user


@pytest.mark.parametrize("baseline,expected", [("failed", "demonstrated"), ("error", "demonstrated"), ("passed", "met_not_demonstrated")])
def test_python_criteria_baseline_head_and_empty_checks(grounded, baseline, expected):
    state, deps = grounded
    state["plan"]["acceptance_criteria"][0]["checks"] = []
    state["baseline"] = [{"id": "unit", "status": baseline}]
    state["checks"] = [{"id": "unit", "status": "passed", "commit": "head"}]
    assert grounding.decide_criteria(state, deps)[0]["state"] == expected
    state["checks"][0]["commit"] = "stale"
    assert grounding.decide_criteria(state, deps)[0]["state"] == "not_met"
    state["plan"]["acceptance_criteria"][0]["checks"] = ["unknown"]
    with pytest.raises(ValueError, match="Unknown configured check"):
        planner.validate_plan(Plan.model_validate(state["plan"]), deps)


def test_approve_refused_for_check_failure_and_extra_assessment_has_no_effect(grounded, monkeypatch):
    state, deps = grounded
    deps.gateway = SimpleNamespace(complete=lambda *a, **kw: SimpleNamespace(parsed=Review(verdict="approve", summary="ok", criteria=[{"id": "sum", "status": "met"}])))
    monkeypatch.setattr(workflow, "diff_info", lambda *a: ("", []))
    rejected = workflow.review(state, deps)
    assert rejected["mode"] == "revision" and "counters" not in rejected
    assert "sum" in rejected["feedback"]["details"][0]
    state["checks"] = [{"id": "unit", "status": "passed", "commit": "head"}]
    assert workflow.review(state, deps)["review"]["criteria"] == []


def test_absence_refuted_once_verified_and_unverifiable(grounded):
    state, deps = grounded
    prompt = Prompt("", "", items(state, deps))
    raw = {"kind": "blocked", "blocked_claim": {"kind": "missing_symbol", "subject": "add", "paths": ["*.py"]}}
    first = grounding.evaluate(state, deps, "implementer", prompt, raw)
    assert kinds(first) == {"false_absence"} and first.retry_block
    assert grounding.repair_evidence(state, deps, first, "step_evidence")
    assert not grounding.evaluate(state, deps, "implementer", prompt, raw).retry_block
    claim = {"kind": "missing_file", "subject": "CALCULATOR.PY"}
    assert grounding.absence(claim, deps)["status"] == "refuted"
    claim.update(subject="absent.py")
    assert grounding.absence(claim, deps)["status"] == "verified"
    assert grounding.absence({"kind": "missing_symbol", "subject": "ad"}, deps)["status"] == "verified"
    none = grounding.evaluate(state, deps, "implementer", prompt, {"kind": "blocked"})
    assert none.absences == [{"status": "unverifiable"}] and not none.violations


def test_block_refutation_feedback_and_brief(grounded):
    state, deps = grounded
    raw = {"kind": "blocked", "blocked_reason": "Need add", "blocked_claim": {"kind": "missing_symbol", "subject": "add"}}
    from scranton_pipeline.models import ImplementerTurn
    deps.gateway = SimpleNamespace(complete=lambda *a, **kw: SimpleNamespace(parsed=ImplementerTurn.model_validate(raw)))
    first = workflow.implement(state, deps)
    assert first["counters"] == {"repairs:step:fix": 1}
    assert first["step_evidence"] and "false_absence" in first["feedback"]["message"]
    second = workflow.implement({**state, **first}, deps)
    assert second["replan_request"]["absence_refuted"]
    raw["blocked_claim"]["subject"] = "not_here"
    third = workflow.implement(state, deps)
    assert third["replan_request"]["verified_absence"][0]["status"] == "verified"


def test_repair_limit_existing_counter_and_observe(grounded):
    state, deps = grounded
    deps.gateway = SimpleNamespace(complete=lambda *a, **kw: SimpleNamespace(parsed=SimpleNamespace(model_dump=lambda **kw: copy.deepcopy(PLAN))))
    update = planner.plan(state, deps)
    assert update["counters"] == {"plan_repairs:r0": 1}
    state["counters"] = {"plan_repairs:r0": deps.cfg.limits.max_output_repairs}
    assert planner.plan(state, deps)["failure"]["code"] == "output_invalid"
    deps.cfg = deps.cfg.model_copy(update={"grounding": deps.cfg.grounding.model_copy(update={"mode": "observe"})})
    result = grounding.evaluate(state, deps, "planner", Prompt("", "", []), PLAN)
    assert not result.reject(deps) and "unseen_target" in kinds(result)
    assert _rows(deps.run_dir / "grounding.jsonl")[-1]["accepted"]


def test_parallel_trace_and_registry_locking_no_content(grounded):
    state, deps = grounded
    evidence = items(state, deps)
    def write(n):
        lane = {**state, "lane": {"step_id": str(n)}}
        grounding.evaluate(lane, deps, "implementer", Prompt("", "", evidence), EDIT)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(write, range(12)))
    rows = _rows(deps.run_dir / "grounding.jsonl")
    assert [r["seq"] for r in rows] == list(range(1, 13))
    assert {r["lane"] for r in rows} == {str(n) for n in range(12)}
    registry = _rows(deps.run_dir / "evidence.jsonl")
    assert len(registry) == 1 and "content" not in registry[0]
    assert "return a - b" not in (deps.run_dir / "evidence.jsonl").read_text()
    register(deps.run_dir, registry)
    assert len(_rows(deps.run_dir / "evidence.jsonl")) == 1


def test_scores_exact_formula_and_recompute(grounded):
    _, deps = grounded
    rows = [{"type": "output", "shown": ["H-a"], "cited": ["H-a", "H-b"], "targets": {"total": 2, "seen": 1},
        "absence": {"verified": 1, "refuted": 1, "unverifiable": 0}, "violations": [{"kind": "unknown_citation"}]},
        {"type": "output", "shown": [], "violations": []},
        {"type": "criteria", "criteria": [{"id": "c", "state": "met_not_demonstrated"}], "probe": {"status": "off"}}]
    result = score_trace(rows)
    assert (result["answer"], result["trajectory"], result["violation_rate"], result["unadjusted"], result["adjusted"]) == (1, .375, .5, .6875, .1719)
    assert result["tier"] == "failing" and result["violations"] == {"unknown_citation": 1}
    for row in rows:
        append_trace(deps.run_dir, row)
    assert recompute_summary(deps.run_dir) == result
    assert score_trace([])["answer"] == 0 and score_trace([])["trajectory"] == 1


def test_probe_private_copy_demonstrates_and_copy_error_is_inconclusive(grounded, monkeypatch):
    state, deps = grounded
    (deps.workspace / "test_calculator.py").write_text("from calculator import add\nassert add(2, 3) == -1\n")
    repo = WorkspaceRepo.init(deps.workspace, deps.run_dir / "git")
    base = repo.commit_all("base")
    (deps.workspace / "calculator.py").write_text("def add(a, b): return a + b\n")
    (deps.workspace / "test_calculator.py").write_text("from calculator import add\nassert add(2, 3) == 5\n")
    head = repo.commit_all("fixed")
    state["workspace"].update(base_commit=base, head_commit=head)
    deps.cfg = deps.cfg.model_copy(update={"checks": [deps.cfg.checks[0].model_copy(update={"argv": [sys.executable, "test_calculator.py"]})]})
    criterion = [{"id": "sum", "state": "met_not_demonstrated", "checks": ["unit"]}]
    assert grounding.probe(state, deps, criterion)["status"] == "demonstrated"
    assert criterion[0]["by"] == "probe"
    assert "a + b" in (deps.workspace / "calculator.py").read_text()
    assert repo.head() == head
    monkeypatch.setattr(grounding.shutil, "copytree", lambda *a, **kw: (_ for _ in ()).throw(OSError("unavailable")))
    assert grounding.probe(state, deps, [{"state": "met_not_demonstrated", "checks": ["unit"]}])["status"] == "inconclusive"


def test_ground_replay_same_criteria_and_scores(grounded, monkeypatch):
    state, deps = grounded
    state["baseline"] = [{"id": "unit", "status": "failed"}]
    state["checks"] = [{"id": "unit", "status": "passed", "commit": "head"}]
    original = grounding.write_bytes_atomic
    crashed = False
    def crash(path, data):
        nonlocal crashed
        if not crashed:
            crashed = True
            raise OSError("crash after trace before receipt")
        original(path, data)
    monkeypatch.setattr(grounding, "write_bytes_atomic", crash)
    with pytest.raises(OSError):
        grounding.ground(state, deps)
    before = recompute_summary(deps.run_dir)
    grounding.ground(state, deps)
    assert recompute_summary(deps.run_dir) == before
    assert before["criteria"][0]["state"] == "demonstrated"
    grounding.ground(state, deps)
    assert len(_rows(deps.run_dir / "grounding.jsonl")) == 1
    assert json.loads((deps.run_dir / "artifacts" / "grounding.json").read_text())["adjusted"] == before["adjusted"]


def test_procedure_config_section_validated(grounded):
    _, deps = grounded
    from pydantic import ValidationError

    from scranton_pipeline.config import EngineConfig
    raw = deps.cfg.model_dump(mode="json")
    assert raw["procedure"] == {"enabled": False, "graph": None, "hops": 2, "max_bytes": 1500}
    raw["procedure"]["enabled"] = True
    assert EngineConfig.model_validate(raw).procedure.enabled
    raw["procedure"]["hops"] = -1
    with pytest.raises(ValidationError):
        EngineConfig.model_validate(raw)


def test_optional_prompt_collections_and_replan_check_ids(grounded):
    _, deps = grounded
    row = {"id": "unit", "evidence_id": "K-0123456789", "status": "passed"}
    prompt = bounded("planner", {"baseline": None, "checks": None, "replan_checks": [row]}, [], deps.cfg)
    assert prompt.shown == [row["evidence_id"]]
    assert bounded("planner", {"baseline": None, "checks": None}, [], deps.cfg).shown == []


def test_registry_locator_and_absence_subject_redacted(grounded):
    _, deps = grounded
    secret = "g1-private-credential-0123456789"
    deps.redactor = Redactor([secret])
    item = {"evidence_id": "E-0123456789", "request": {"query": secret, "path": secret}, "content": secret}
    from scranton_pipeline.grounding import registry_row
    register(deps.run_dir, [registry_row(item, kind="context")])
    grounding.absence({"kind": "missing_symbol", "subject": secret}, deps)
    for path in (deps.run_dir / "evidence.jsonl", deps.run_dir / "events.jsonl"):
        assert secret not in path.read_text()
    assert "[REDACTED]" in (deps.run_dir / "evidence.jsonl").read_text()


@pytest.mark.parametrize("kind", ["search", "list"])
def test_workspace_context_is_not_a_violation(grounded, kind):
    state, deps = grounded
    raw = {"kind": "need_context", "context_requests": [{"kind": kind, "query": "legacy_tax", "path": ""}]}
    result = grounding.evaluate(state, deps, "planner", Prompt("", "", []), raw)
    assert result.violations == []
    assert not result.reject(deps)


@pytest.mark.parametrize("path,canonical,kind", [
    ("", "", "search"), (".", "", "list"), ("./", "", "list"),
    ("./pricing.py", "pricing.py", "read"), ("pkg/", "pkg", "list"),
    ("pkg\\mod.py", "pkg/mod.py", "read")])
def test_context_forms_share_validation_fulfilment_and_registry(grounded, path, canonical, kind):
    state, deps = grounded
    (deps.workspace / "pricing.py").write_text("legacy_tax = 1\n")
    (deps.workspace / "pkg").mkdir()
    (deps.workspace / "pkg" / "mod.py").write_text("legacy_tax = 2\n")
    state["workspace"]["files"] += ["pricing.py", "pkg/mod.py"]
    request = ContextRequest(kind=kind, path=path, query="legacy_tax")
    raw = {"kind": "need_context", "context_requests": [request.model_dump(mode="json")]}
    assert not grounding.evaluate(state, deps, "planner", Prompt("", "", []), raw).violations
    result = fulfil([request], workspace=deps.workspace, policy=deps.policy(), files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)[0]
    assert result.ok and result.content
    assert result.request.path == canonical
    prompt = Prompt("", "", [result.model_dump(mode="json")])
    grounding.evaluate(state, deps, "planner", prompt, raw)
    assert _rows(deps.run_dir / "evidence.jsonl")[-1]["path"] == canonical
    if kind == "read":
        plan = copy.deepcopy(PLAN)
        plan["plan"]["steps"][0]["files"][0]["path"] = canonical
        state["plan"] = plan["plan"]
        assert not grounding.evaluate(state, deps, "planner", prompt, plan).violations
        edit = {"kind": "edits", "edits": [{"path": canonical, "action": "modify", "content": "new"}]}
        assert not grounding.evaluate(state, deps, "implementer", prompt, edit).violations


@pytest.mark.parametrize("path", ["", ".", "./"])
def test_root_read_is_not_a_violation_but_not_a_file(grounded, path):
    state, deps = grounded
    request = ContextRequest(kind="read", path=path)
    assert not grounding.evaluate(state, deps, "planner", Prompt("", "", []), {"context_requests": [request.model_dump()]}).violations
    item = fulfil([request], workspace=deps.workspace, policy=deps.policy(), files=[], limits=deps.cfg.limits, redactor=deps.redactor)[0]
    assert not item.ok and item.note == "Read requires a file" and item.request.path == ""


@pytest.mark.parametrize("path", ["../x", "/etc/passwd", "C:/x", "bad\0path", ".env", "/", "\\"])
@pytest.mark.parametrize("mode", ["enforce", "observe"])
def test_unsafe_context_is_identified_and_other_requests_survive(grounded, monkeypatch, path, mode):
    from scranton_pipeline.tools import context
    state, deps = grounded
    deps.cfg = deps.cfg.model_copy(update={"grounding": deps.cfg.grounding.model_copy(update={"mode": mode})})
    requests = [ContextRequest(kind="read", path=path), ContextRequest(kind="read", path="calculator.py")]
    raw = {"kind": "need_context", "context_requests": [r.model_dump() for r in requests]}
    evaluation = grounding.evaluate(state, deps, "planner", Prompt("", "", []), raw)
    assert kinds(evaluation) == {"protected_request"}
    detail = evaluation.violations[0]["detail"]
    assert f'read path={json.dumps(path)}' in detail
    assert "relative path inside the project" in detail and "empty path" in detail and len(detail) <= 200
    assert evaluation.reject(deps) == (mode == "enforce")
    read = context.read_text
    opened = []
    def guarded_read(target, cap):
        assert target.is_relative_to(deps.workspace)
        opened.append(target)
        return read(target, cap)
    monkeypatch.setattr(context, "read_text", guarded_read)
    result = fulfil(requests, workspace=deps.workspace, policy=deps.policy(), files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)
    assert [i.ok for i in result] == [False, True]
    assert result[0].note == detail and not result[0].content
    assert opened == [deps.workspace / "calculator.py"]
    assert _rows(deps.run_dir / "grounding.jsonl")[-1]["violations"] == evaluation.violations


@pytest.mark.parametrize("role", ["planner", "implementer"])
def test_context_repair_prompt_names_original_request_and_budget_fails(grounded, role):
    from scranton_pipeline.agents.prompts import build_implementer_prompt
    from scranton_pipeline.models import ImplementerTurn, PlannerTurn
    state, deps = grounded
    raw = {"kind": "need_context", "context_requests": [{"kind": "search", "path": "../x", "query": "tax"}, {"kind": "read", "path": "calculator.py"}]}
    model = PlannerTurn if role == "planner" else ImplementerTurn
    deps.gateway = SimpleNamespace(complete=lambda *a, **kw: SimpleNamespace(parsed=model.model_validate(raw)))
    node = planner.plan if role == "planner" else workflow.implement
    build = build_planner_prompt if role == "planner" else build_implementer_prompt
    key = "plan_repairs:r0" if role == "planner" else "repairs:step:fix"
    update = node(state, deps)
    assert update["counters"] == {key: 1}
    feedback = update["feedback"]["message"]
    assert 'search path="../x"' in feedback and "empty path" in feedback
    assert json.dumps(feedback) in build({**state, **update}, deps.cfg).user
    state["counters"] = {key: deps.cfg.limits.max_output_repairs}
    update = node(state, deps)
    assert update["failure"]["code"] == "output_invalid"
    assert update["failure"]["failure_class"] == "llm_output"
    assert not _rows(deps.run_dir / "grounding.jsonl")[-1]["accepted"]


def test_context_detail_redacts_before_capping(grounded):
    state, deps = grounded
    secret = "credential-private-0123456789"
    deps.redactor = Redactor([secret])
    path = "../" + secret + "x" * 300
    result = grounding.evaluate(state, deps, "planner", Prompt("", "", []), {"context_requests": [{"kind": "list", "path": path}]})
    detail = result.violations[0]["detail"]
    assert 'list path="../[REDACTED]' in detail and secret not in detail
    assert len(detail) <= 200 and "empty path" in detail
    assert secret not in (deps.run_dir / "grounding.jsonl").read_text()
    item = fulfil([ContextRequest(kind="list", path=path)], workspace=deps.workspace, policy=deps.policy(), files=[], limits=deps.cfg.limits, redactor=deps.redactor)[0]
    assert item.note == detail and secret not in item.note and "[REDACTED]" in item.note


@pytest.mark.parametrize("budget", [0, 2])
def test_unsafe_context_rejected_at_repair_limit(grounded, budget):
    state, deps = grounded
    deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_output_repairs": budget})})
    state["counters"] = {"plan_repairs:r0": budget}
    result = grounding.evaluate(state, deps, "planner", Prompt("", "", []), {"kind": "need_context", "context_requests": [{"kind": "read", "path": "../x"}]})
    assert result.reject(deps)
    assert not _rows(deps.run_dir / "grounding.jsonl")[-1]["accepted"]


def test_context_detail_redacts_raw_path_before_json_escape(grounded):
    state, deps = grounded
    secret = 'private\\credential"0123456789'
    deps.redactor = Redactor([secret])
    request = ContextRequest(kind="read", path="../" + secret)
    result = grounding.evaluate(state, deps, "planner", Prompt("", "", []), {"context_requests": [request.model_dump()]})
    item = fulfil([request], workspace=deps.workspace, policy=deps.policy(), files=[], limits=deps.cfg.limits, redactor=deps.redactor)[0]
    assert result.violations[0]["detail"].startswith('read path="../[REDACTED]"')
    assert item.note == result.violations[0]["detail"] and not item.ok
    assert json.dumps(secret)[1:-1] not in item.note


@pytest.mark.parametrize("kind", ["read", "search", "list"])
def test_context_link_escape_evaluated_and_not_fulfilled(grounded, monkeypatch, kind):
    from scranton_pipeline.tools import context
    state, deps = grounded
    outside = deps.workspace.parent / "outside"
    outside.mkdir()
    (outside / "data.txt").write_text("outside-marker-never-read")
    link = deps.workspace / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True, timeout=5, check=False) if os.name == "nt" else None
        if result is None or result.returncode:
            original = Path.resolve
            monkeypatch.setattr(Path, "resolve", lambda self, *a, **kw: outside / self.relative_to(link) if self.is_relative_to(link) else original(self, *a, **kw))
    request = ContextRequest(kind=kind, path="link/data.txt" if kind == "read" else "link", query="outside-marker")
    result = grounding.evaluate(state, deps, "planner", Prompt("", "", []), {"kind": "need_context", "context_requests": [request.model_dump()]})
    assert kinds(result) == {"protected_request"} and result.reject(deps)
    monkeypatch.setattr(context, "read_text", lambda *a: pytest.fail("outside read attempted"))
    item = fulfil([request], workspace=deps.workspace, policy=deps.policy(), files=["link/data.txt"], limits=deps.cfg.limits, redactor=deps.redactor)[0]
    assert not item.ok and item.content == "" and "outside-marker" not in item.note

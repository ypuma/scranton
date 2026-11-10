"""Review regressions: real policy, evidence, node and private-probe boundaries."""
import copy
import json
import sys
from types import SimpleNamespace

import pytest
from test_grounding import grounded as grounded  # noqa: PLC0414 -- pytest fixture re-export
from test_grounding import items, kinds

from scranton_pipeline.agents.prompts import Prompt, bounded, fresh_evidence
from scranton_pipeline.demo.fixture import EDIT, PLAN
from scranton_pipeline.evals.evolve import evolve, prompt
from scranton_pipeline.models import ContextRequest, ImplementerTurn, PlannerTurn, Review
from scranton_pipeline.nodes import grounding, planner, workflow
from scranton_pipeline.observability import _rows
from scranton_pipeline.procedure import GraphEdit, rejection_tail, skeleton
from scranton_pipeline.tools.context import fulfil
from scranton_pipeline.tools.git import WorkspaceRepo


def gateway(deps, raw, schema):
    calls = []
    def complete(*a, **kw):
        calls.append(kw)
        return SimpleNamespace(parsed=schema.model_validate(raw))
    deps.gateway = SimpleNamespace(complete=complete)
    return calls


def test_refresh_several_independent_items(grounded, monkeypatch):
    state, deps = grounded
    evidence = []
    for n in range(6):
        path = f"file{n}.py"
        (deps.workspace / path).write_text("#" + "x" * 21000)
        evidence.extend(i.model_dump(mode="json") for i in fulfil([ContextRequest(kind="read", path=path)], workspace=deps.workspace,
            policy=deps.policy(), files=[path], limits=deps.cfg.limits, redactor=deps.redactor))
    state["plan_evidence"] = [*evidence, *items(state, deps)]
    for n in range(6):
        (deps.workspace / f"file{n}.py").write_text("#" + "y" * 21000)
    refreshed = fresh_evidence(state, deps.cfg, "plan_evidence")
    assert all(i["ok"] for i in refreshed)
    assert all(a["evidence_id"] != b["evidence_id"] for a, b in zip(evidence, refreshed))
    from scranton_pipeline.tools import context
    monkeypatch.setattr(context, "fulfil", lambda *a, **kw: pytest.fail("unchanged file was re-read"))
    state["plan_evidence"] = refreshed
    assert fresh_evidence(state, deps.cfg, "plan_evidence") == refreshed


@pytest.mark.parametrize("role", ["planner", "implementer"])
@pytest.mark.parametrize("pattern,valid", [("./*.py", True), ("..\\*.py", False)])
def test_absence_paths_use_repair_not_security_failure(grounded, role, pattern, valid):
    state, deps = grounded
    claim = {"kind": "missing_symbol", "subject": "nonexistent", "paths": [pattern]}
    raw = copy.deepcopy(PLAN) if role == "planner" else {"kind": "blocked", "blocked_reason": "missing", "blocked_claim": claim}
    if role == "planner":
        raw["plan"]["absent"] = [claim]
        state["plan_evidence"] = items(state, deps)
    gateway(deps, raw, PlannerTurn if role == "planner" else ImplementerTurn)
    result = planner.plan(state, deps) if role == "planner" else workflow.implement(state, deps)
    if valid:
        assert "feedback" not in result or result["feedback"] is None
        assert "plan" in result if role == "planner" else "replan_request" in result
    else:
        assert result["feedback"]["kind"] == "output_invalid"
        assert "Invalid absence path" in result["feedback"]["message"]


def test_binary_and_protected_files_outside_absence_space(grounded):
    _, deps = grounded
    (deps.workspace / "picture.bin").write_bytes(b"\xff\x00")
    (deps.workspace / ".env").write_text("secret_symbol")
    for subject in ("unknown_symbol", "secret_symbol"):
        result = grounding.absence({"kind": "missing_symbol", "subject": subject}, deps)
        assert result["status"] == "verified"
        assert result["meaning"] == "not found in the files models may read"
    assert all(r["data"]["meaning"] == "not found in the files models may read" for r in _rows(deps.events.path) if r["type"] == "absence_verified")


@pytest.mark.parametrize("subject", ["./calculator.py", "CALCULATOR.PY", "src\\a.py", "./SRC/A.PY"])
def test_missing_file_normalizes_subject(grounded, subject):
    _, deps = grounded
    (deps.workspace / "src").mkdir()
    (deps.workspace / "src/a.py").write_text("x = 1")
    assert grounding.absence({"kind": "missing_file", "subject": subject}, deps)["status"] == "refuted"


@pytest.mark.parametrize("subject", ["foo.bar", "my-func", "__init__"])
def test_literal_symbol_boundaries(grounded, subject):
    _, deps = grounded
    (deps.workspace / "symbols.txt").write_text(f"prefix{subject}suffix\n")
    claim = {"kind": "missing_symbol", "subject": subject}
    assert grounding.absence(claim, deps)["status"] == "verified"
    (deps.workspace / "symbols.txt").write_text(f"({subject})\n")
    assert grounding.absence(claim, deps)["status"] == "refuted"


@pytest.mark.parametrize("cause", ["truncated", "linked", "file_count"])
def test_incomplete_absence_is_unverifiable(grounded, cause):
    _, deps = grounded
    if cause == "truncated":
        deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_file_bytes": 10})})
    elif cause == "file_count":
        deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_workspace_files": 0})})
    else:
        try:
            (deps.workspace / "link.py").symlink_to(deps.workspace / "calculator.py")
        except OSError:
            pytest.skip("host cannot create symlinks")
    assert grounding.absence({"kind": "missing_symbol", "subject": "absent"}, deps)["status"] == "unverifiable"


def test_revision_supplies_reads_without_model_repairs(grounded):
    state, deps = grounded
    state.update(mode="revision", review_round=1, step_evidence=[])
    deps.cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_output_repairs": 0})})
    calls = gateway(deps, EDIT, ImplementerTurn)
    result = workflow.implement(state, deps)
    assert result.get("pending_edits"), result
    assert "return a - b" in calls[0]["user"]
    assert not _rows(deps.run_dir / "grounding.jsonl")[-1]["violations"]
    (deps.workspace / "calculator.py").unlink()
    result = workflow.implement(state, deps)
    assert result["failure"]["code"] == "output_invalid", result
    assert {v["kind"] for v in _rows(deps.run_dir / "grounding.jsonl")[-1]["violations"]} == {"unseen_edit"}
    assert _rows(deps.run_dir / "grounding.jsonl")[-1]["unverifiable_target"] == ["calculator.py"]


def test_check_criterion_drives_normal_revision(grounded, monkeypatch):
    state, deps = grounded
    deps.cfg = deps.cfg.model_copy(update={"checks": [deps.cfg.checks[0].model_copy(update={"required": False})]})
    state["checks"] = [{"id": "unit", "status": "failed", "output_tail": "OPTIONAL ASSERTION", "commit": "head", "evidence_id": "K-0123456789"}]
    calls = gateway(deps, {"verdict": "approve", "summary": "ok", "criteria": []}, Review)
    monkeypatch.setattr(workflow, "diff_info", lambda *a: ("", []))
    result = workflow.review(state, deps)
    assert result.get("mode") == "revision", result
    assert "counters" not in result
    assert result["review"]["verdict"] == "request_changes"
    assert all(s in result["feedback"]["details"][0] for s in ("sum", "unit", "OPTIONAL ASSERTION"))
    assert all(s in calls[0]["user"] for s in ("decided_criteria", "not_met", "K-0123456789"))


@pytest.mark.parametrize("role", ["planner", "implementer", "reviewer"])
def test_guidance_cannot_displace_evidence(grounded, role):
    _, deps = grounded
    cfg = deps.cfg.model_copy(update={"procedure": deps.cfg.procedure.model_copy(update={"enabled": True})})
    evidence = [{"evidence_id": "E-0123456789", "content": "x" * 500}]
    full = bounded(role, {}, evidence, cfg)
    cfg = cfg.model_copy(update={"limits": cfg.limits.model_copy(update={"max_prompt_bytes": len((full.system + full.user).encode())})})
    advice = "Procedural guidance (advisory)\nRead existing files."
    without = bounded(role, {}, evidence, cfg)
    with_advice = bounded(role, {}, evidence, cfg, guidance=advice)
    assert with_advice.shown == without.shown == ["E-0123456789"]
    assert with_advice.user.startswith(without.user)
    assert len((with_advice.system + with_advice.user).encode()) <= cfg.limits.max_prompt_bytes + cfg.procedure.max_bytes


@pytest.mark.parametrize("role,scope", [("planner", "plan:r2"), ("reviewer", "review:3"), ("implementer", "step:fix")])
def test_role_scopes_in_trace_and_events(grounded, role, scope):
    state, deps = grounded
    state.update(plan_revision=2, review_round=3)
    deps.procedure_event(role, state)
    grounding.evaluate(state, deps, role, Prompt("", "", []), {})
    assert _rows(deps.run_dir / "grounding.jsonl")[-1]["scope"] == scope
    assert [r["data"]["scope"] for r in _rows(deps.events.path)] == [scope, scope]


def test_rejection_history_survives_large_rows(grounded):
    _, deps = grounded
    large = {"round": 1, "edit": {"rationale": "ä" * 24000}, "reason": "invalid", "diagnostics": ["error" * 9000], "traces": ["x" * 50000]}
    tail = rejection_tail([large], 20000)
    assert tail and len(json.dumps(tail).encode()) <= 2048 + 2
    assert json.loads(prompt(skeleton(), [], [large]))["rejected"]
    seen = []
    def refine(text):
        seen.append(json.loads(text))
        return GraphEdit(delete_nodes=["done"] * 60, rationale="x" * 400)
    evolve(skeleton(), deps.run_dir / "evolution", rollout=lambda *a: [{"adjusted": 1, "trace": {"bulk": "x" * 50000}}], refine=refine, rounds=2)
    rows = _rows(deps.run_dir / "evolution/rejected.jsonl")
    assert rows and all(r["edit"]["delete_nodes"] == ["done"] * 60 for r in rows)
    assert all(len(json.dumps(r).encode()) <= 2048 for r in seen[1]["rejected"])
    assert seen[1]["rejected"]


def test_unchanged_path_finding_unsupported_even_with_valid_citation(grounded):
    state, deps = grounded
    state["delivery"] = {"files": [{"path": "calculator.py"}]}
    raw = {"findings": [{"path": "unchanged.py", "severity": "minor", "citations": ["H-0123456789"]}]}
    assert kinds(grounding.evaluate(state, deps, "reviewer", Prompt("", "", [{"evidence_id": "H-0123456789"}]), raw)) == {"unsupported_finding"}


def probe_case(state, deps, *, action="modify", argv=None):
    path = deps.workspace / "helper.py"
    if action != "create":
        path.write_text("VALUE = 1\n")
    repo = WorkspaceRepo.init(deps.workspace, deps.run_dir / "git")
    base = repo.commit_all("base")
    if action == "delete":
        path.unlink()
        test = "from pathlib import Path\nassert not Path('helper.py').exists()\n"
    else:
        path.write_text("VALUE = 2\n")
        test = "from helper import VALUE\nassert VALUE == 2\n"
    (deps.workspace / "test_new.py").write_text(test)
    head = repo.commit_all("change")
    state["workspace"].update(base_commit=base, head_commit=head)
    deps.cfg = deps.cfg.model_copy(update={"checks": [deps.cfg.checks[0].model_copy(update={"argv": argv or [sys.executable, "test_new.py"]})]})
    return [{"id": "sum", "state": "met_not_demonstrated", "checks": ["unit"]}]


def test_probe_control_failure_is_inconclusive(grounded):
    state, deps = grounded
    criteria = probe_case(state, deps, argv=[sys.executable, "-c", "raise SystemExit(1)"])
    assert grounding.probe(state, deps, criteria)["status"] == "inconclusive"
    assert criteria[0]["state"] == "met_not_demonstrated"
    assert (deps.run_dir / "artifacts/logs/probe-control-unit.log").exists()


@pytest.mark.parametrize("action", ["create", "delete"])
def test_probe_restores_created_and_deleted_code(grounded, action):
    state, deps = grounded
    criteria = probe_case(state, deps, action=action)
    assert grounding.probe(state, deps, criteria)["status"] == "demonstrated"
    assert criteria[0]["by"] == "probe"
    assert (deps.workspace / "helper.py").exists() == (action == "create")
    assert not deps.workspace.with_name("workspace-probe").exists()
    assert not (deps.run_dir / "probe-git").exists()


def test_test_only_change_has_no_probe(grounded, monkeypatch):
    state, deps = grounded
    criteria = probe_case(state, deps)
    (deps.workspace / "helper.py").write_text("VALUE = 1\n")
    state["workspace"]["head_commit"] = deps.repo().commit_all("only tests")
    monkeypatch.setattr(grounding.shutil, "copytree", lambda *a, **kw: pytest.fail("test-only copy"))
    assert grounding.probe(state, deps, criteria)["status"] == "not_needed"


@pytest.mark.parametrize("stop", ["timeout", "cancel"])
def test_probe_interrupted_cleans_copy_and_process(grounded, stop):
    import os
    import threading
    import time

    state, deps = grounded
    marker = deps.run_dir / "pid"
    criteria = probe_case(state, deps, argv=[sys.executable, "-c", f"import os,time; from pathlib import Path; Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(30)"])
    deps.cfg = deps.cfg.model_copy(update={"checks": [deps.cfg.checks[0].model_copy(update={"timeout_s": .5})]})
    def cancel():
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        deps.stop.cancel_file.touch()
    worker = threading.Thread(target=cancel) if stop == "cancel" else None
    if worker:
        worker.start()
    try:
        result = grounding.probe(state, deps, criteria)
    finally:
        if worker:
            worker.join(12)
    assert result["status"] == "inconclusive"
    assert criteria[0]["state"] == "met_not_demonstrated"
    assert not deps.workspace.with_name("workspace-probe").exists()
    assert not (deps.run_dir / "probe-git").exists()
    assert not list((deps.run_dir / "sandbox-state").glob("*.json"))
    assert marker.exists()
    from test_process_git import _assert_dead
    _assert_dead(int(marker.read_text()))
    assert os.getpid() != int(marker.read_text())


@pytest.mark.parametrize("role", ["planner", "implementer"])
def test_python_repair_read_unavailable_is_not_model_violation(grounded, role):
    state, deps = grounded
    evidence = [{**item, "python_read": True} for item in items(state, deps)]
    cfg = deps.cfg.model_copy(update={"limits": deps.cfg.limits.model_copy(update={"max_prompt_bytes": 6000})})
    prompt = bounded(role, {"bulk": "x" * 10000}, evidence, cfg)
    assert not prompt.shown and prompt.unverifiable == ["calculator.py"]
    raw = PLAN if role == "planner" else EDIT
    result = grounding.evaluate(state, deps, role, prompt, raw)
    assert kinds(result) == (set() if role == "planner" else {"unseen_edit"})
    assert _rows(deps.run_dir / "grounding.jsonl")[-1]["unverifiable_target"] == ["calculator.py"]


def test_linked_absence_is_unknown_without_host_symlink_privileges(grounded, monkeypatch):
    from pathlib import Path
    _, deps = grounded
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda p: p == deps.workspace / "calculator.py" or original(p))
    assert grounding.absence({"kind": "missing_symbol", "subject": "absent"}, deps)["status"] == "unverifiable"


def test_verified_absence_brief_preserves_qualified_meaning(grounded):
    state, deps = grounded
    gateway(deps, {"kind": "blocked", "blocked_reason": "Missing", "blocked_claim": {"kind": "missing_symbol", "subject": "nonexistent"}}, ImplementerTurn)
    update = workflow.implement(state, deps)
    assert update["replan_request"]["verified_absence"][0]["meaning"] == "not found in the files models may read"
    state["replan_brief"] = update["replan_request"]
    from scranton_pipeline.agents.prompts import build_planner_prompt
    assert "not found in the files models may read" in build_planner_prompt(state, deps.cfg).user

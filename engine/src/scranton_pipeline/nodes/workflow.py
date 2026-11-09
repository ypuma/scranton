"""The deterministic work nodes and the two remaining bounded model turns."""
import hashlib
import json
from pathlib import Path
from typing import Any

from langgraph.types import interrupt

from scranton_pipeline.agents.prompts import build_implementer_prompt, build_reviewer_prompt
from scranton_pipeline.errors import EngineError, FailureClass, SuspendRequested
from scranton_pipeline.models import ContextRequest, ImplementerTurn, Review
from scranton_pipeline.nodes.common import Dependencies, scope_id
from scranton_pipeline.nodes.planner import invalid
from scranton_pipeline.state import PipelineState, counter, current_step, get_plan
from scranton_pipeline.tools.checks import run_checks
from scranton_pipeline.tools.context import fulfil
from scranton_pipeline.tools.fs import PathPolicy, write_bytes_atomic
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.patches import apply_to_source as source_apply
from scranton_pipeline.tools.patches import validate_and_apply
from scranton_pipeline.tools.repo_index import build_index, detect_checks, render_tree
from scranton_pipeline.tools.sandbox import build_sandbox
from scranton_pipeline.tools.snapshot import snapshot_source


def json_write(path: Path, value: Any) -> None:
    write_bytes_atomic(path, json.dumps(value, ensure_ascii=True, indent=2).encode())


def sandbox(deps: Dependencies) -> Any:
    return build_sandbox(deps.cfg.sandbox, workspace=deps.workspace, run_id=deps.run_dir.name, trust_host=deps.trust_host)


def prepare_workspace(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    manifest = deps.run_dir / "artifacts" / "source_manifest.json"
    # No checkpoint can refer to a partially prepared snapshot: rebuild it on replay.
    if deps.workspace.exists():
        import shutil
        shutil.rmtree(deps.workspace)
    snapshot = snapshot_source(Path(state["source_dir"]), deps.workspace, policy=deps.cfg.policy,
                               limits=deps.cfg.limits, manifest_path=manifest)
    repo = WorkspaceRepo.init(deps.workspace, deps.run_dir / "git", timeout_s=deps.cfg.limits.git_timeout_s)
    base = repo.commit_all("Pipeline snapshot")
    box = sandbox(deps)
    box.preflight()
    for command in deps.cfg.setup:
        result = box.run(command.argv, timeout_s=command.timeout_s, network=command.network,
                         log_path=deps.run_dir / "artifacts" / "logs" / f"setup-{command.id}.log", stop=deps.stop,
                         tail_bytes=deps.cfg.limits.max_output_tail_bytes, max_log_bytes=deps.cfg.limits.max_log_bytes)
        if result.stopped:
            if deps.stop.suspend_requested():
                raise SuspendRequested()
            return {"outcome": "cancelled"}
        if result.exit_code != 0 or result.timed_out:
            raise EngineError(FailureClass.INFRASTRUCTURE, "setup_failed", f"Setup {command.id} failed")
    deps.repo().restore_tracked()
    files = list(json.loads(manifest.read_text(encoding="utf-8")))
    return {"workspace": {"path": str(deps.workspace), "base_commit": base, "head_commit": base,
                           "green_commit": base, "manifest_path": str(manifest), "files": files,
                           "used_git": snapshot.used_git}, "step_index": -1, "mode": "step",
            "review": None if deps.cfg.review.enabled else {"verdict": "disabled"}}


def index_repo(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    index = build_index(deps.workspace, state["workspace"]["files"], limits=deps.cfg.limits)
    path = deps.run_dir / "artifacts" / "repo_index.json"
    json_write(path, index.model_dump(mode="json"))
    return {"repo": {**index.model_dump(mode="json"), "tree": render_tree(index, max_entries=300),
                     "index_path": str(path), "suggested_checks": detect_checks(index)}}


def checked(state: PipelineState, deps: Dependencies, *, baseline: bool = False) -> list[dict[str, Any]]:
    plan = get_plan(state)
    final = plan is not None and (state.get("mode") == "revision" or state.get("step_index", -1) >= len(plan.steps) - 1)
    checks = [c for c in deps.cfg.checks if baseline or c.scope == "step" or final]
    results = run_checks(checks, sandbox=sandbox(deps), log_dir=deps.run_dir / "artifacts" / "logs",
                         label="baseline" if baseline else f"step-{state.get('step_index', 0)}-R{state.get('review_round', 0)}-{counter(state, 'attempts:' + scope_id(state))}",
                         stop=deps.stop, fail_fast=not baseline, tail_bytes=deps.cfg.limits.max_output_tail_bytes,
                         max_log_bytes=deps.cfg.limits.max_log_bytes)
    restored = deps.repo().restore_tracked()
    if restored:
        deps.events.emit("warning", code="check_modified_tracked", message="Checks modified tracked files; restored", paths=restored)
    if deps.stop.suspend_requested():
        raise SuspendRequested()
    for result in results:
        deps.events.emit("check_finished", id=result.id, status=result.status, duration_s=result.duration_s)
    return [r.model_dump(mode="json") for r in results]


def baseline_checks(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    results = checked(state, deps, baseline=True)
    if any(r["required"] and r["status"] == "error" for r in results):
        return {"baseline": results, "failure": EngineError(FailureClass.INFRASTRUCTURE, "check_error", "Baseline check could not execute: " + "; ".join(r["output_tail"] for r in results if r["status"] == "error")).to_failure("baseline_checks")}
    return {"baseline": results}


def context(state: PipelineState, deps: Dependencies, *, planner: bool) -> dict[str, Any]:
    prefix = "plan" if planner else "step"
    key = "plan_context" if planner else f"context:{scope_id(state)}"
    requests = [ContextRequest.model_validate(r) for r in (state.get("plan_requests", []) if planner else state.get("step_requests", []))]
    items = fulfil(requests, workspace=deps.workspace, policy=deps.policy(),
                   files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)
    evidence = [*(state.get("plan_evidence", []) if planner else state.get("step_evidence", [])), *[i.model_dump(mode="json") for i in items]]
    while len(json.dumps(evidence).encode()) > deps.cfg.limits.max_prompt_bytes and evidence:
        evidence.pop(0)
    deps.events.emit("context", requests=len(requests), fulfilled=sum(i.ok for i in items))
    return {f"{prefix}_evidence": evidence, f"{prefix}_requests": [], "counters": {key: 1}}


def approve_plan(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    if deps.cfg.approvals.plan == "auto_low_risk" and not state.get("risk_flags"):
        decision = {"decision": "approve", "by": "auto", "comment": ""}
    else:
        decision = interrupt({"gate": "plan", "digest": state["plan_digest"], "risk_flags": state["risk_flags"],
                              "plan_path": str(deps.run_dir / "artifacts" / "plan.json")})
        decision = {**decision, "by": "human"}
    deps.events.emit("gate_decided", gate="plan", decision=decision["decision"], by=decision["by"])
    return {"plan_approval": decision, **({"outcome": "rejected"} if decision["decision"] == "reject" else {})}


def select_step(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    index = state.get("step_index", -1) + 1
    plan = get_plan(state)
    assert plan is not None
    evidence = []
    if index < len(plan.steps):
        step = plan.steps[index]
        requests = [ContextRequest(kind="read", path=p) for p in dict.fromkeys([f.path for f in step.files if f.action != "create"] + step.context_files)]
        evidence = [i.model_dump(mode="json") for i in fulfil(requests, workspace=deps.workspace, policy=deps.policy(),
                    files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)]
    return {"step_index": index, "step_evidence": evidence, "step_requests": [], "feedback": None, "pending_edits": None}


def implement(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    key = f"repairs:{scope_id(state)}"
    try:
        step = current_step(state)
        if step and state.get("mode") != "revision":
            requests = [ContextRequest(kind="read", path=p) for p in dict.fromkeys([f.path for f in step.files] + step.context_files)]
            fresh = [i.model_dump(mode="json") for i in fulfil(requests, workspace=deps.workspace, policy=deps.policy(), files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)]
            state = {**state, "step_evidence": [*state.get("step_evidence", []), *fresh]}
        system, user = build_implementer_prompt(state, deps.cfg)
        turn = deps.gateway.complete("implementer", system=system, user=user, schema=ImplementerTurn).parsed
        if turn.kind == "blocked":
            raise EngineError(FailureClass.IMPLEMENTATION, "step_blocked", turn.blocked_reason)
        if turn.kind == "need_context":
            if counter(state, f"context:{scope_id(state)}") >= deps.cfg.limits.max_step_context_rounds:
                raise ValueError("No step context rounds remain")
            return {"step_requests": [r.model_dump(mode="json") for r in turn.context_requests], "pending_edits": None}
        return {"pending_edits": turn.model_dump(mode="json"), "feedback": None, "step_requests": []}
    except ValueError as exc:
        return invalid(state, deps, "implement", key, str(exc))
    except EngineError as exc:
        if exc.failure_class != FailureClass.LLM_OUTPUT:
            raise
        return invalid(state, deps, "implement", key, exc.detail or exc.message)


def apply_edits(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    key = f"attempts:{scope_id(state)}"
    if counter(state, key) >= deps.cfg.limits.max_step_attempts:
        raise EngineError(FailureClass.IMPLEMENTATION, "attempts_exhausted", "Edit attempt budget exhausted")
    repo = deps.repo()
    repo.reset_hard(state["workspace"]["head_commit"])
    turn = ImplementerTurn.model_validate(state["pending_edits"])
    plan = get_plan(state)
    assert plan is not None
    step = current_step(state)
    declared = {f.path for s in plan.steps for f in s.files} if state.get("mode") == "revision" else {f.path for f in step.files} if step else set()
    result = validate_and_apply(turn.edits, workspace=deps.workspace, policy=deps.policy(), declared=declared,
                                scope=deps.cfg.policy.scope, undeclared_budget=deps.cfg.policy.max_undeclared_files,
                                limits=deps.cfg.limits)
    update: dict[str, Any] = {"counters": {key: 1}, "pending_edits": None}
    if not result.ok:
        deps.events.emit("edits_rejected", count=len(result.rejected))
        if counter(state, key) + 1 >= deps.cfg.limits.max_step_attempts:
            update["failure"] = EngineError(FailureClass.IMPLEMENTATION, "edits_rejected", "Edit attempts exhausted").to_failure("apply_edits")
        else:
            update["feedback"] = {"kind": "edits_rejected", "message": "Edits rejected", "details": result.rejected}
        return update
    head = repo.commit_paths(result.changed, f"Pipeline {scope_id(state)} attempt {counter(state, key) + 1}")
    update.update(workspace={**state["workspace"], "head_commit": head}, feedback=None,
                  deviations=sorted(set(state.get("deviations", []) + result.undeclared)))
    deps.events.emit("edits_applied", files=result.changed, commit=head)
    return update


def verify(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    results = checked(state, deps)
    if deps.stop.cancel_requested():
        return {"checks": results, "outcome": "cancelled"}
    failed = [r for r in results if r["required"] and r["status"] != "passed"]
    if failed:
        if any(r["status"] == "error" for r in failed):
            return {"checks": results, "failure": EngineError(FailureClass.INFRASTRUCTURE, "check_error",
                "Check could not execute: " + "; ".join(r["output_tail"] for r in failed if r["status"] == "error")).to_failure("verify")}
        if counter(state, f"attempts:{scope_id(state)}") >= deps.cfg.limits.max_step_attempts:
            return {"checks": results, "failure": EngineError(FailureClass.CHECKS_FAILED, "checks_exhausted", "Required checks failed").to_failure("verify")}
        return {"checks": results, "feedback": {"kind": "checks_failed", "message": "Required checks failed",
                                                 "details": [r["id"] + ": " + r["output_tail"] for r in failed]}}
    head = state["workspace"]["head_commit"]
    return {"checks": results, "feedback": None, "workspace": {**state["workspace"], "green_commit": head},
            "steps_done": [{"step_id": scope_id(state), "attempts": counter(state, f"attempts:{scope_id(state)}"),
                            "commit": head, "changed_files": [p for _, p in deps.repo().changed_files(state["workspace"]["base_commit"], head)]}]}


def diff_info(state: PipelineState, deps: Dependencies, *, green: bool = False) -> tuple[str, list[dict[str, Any]]]:
    workspace = state.get("workspace")
    if not workspace:
        return "", []
    repo = deps.repo()
    head = workspace["green_commit" if green else "head_commit"]
    base = workspace["base_commit"]
    stats = {p: (a, r) for a, r, p in repo.numstat(base, head)}
    files = [{"path": p, "action": {"A": "create", "M": "modify", "D": "delete"}.get(a, a),
              "added": stats.get(p, (0, 0))[0], "removed": stats.get(p, (0, 0))[1]} for a, p in repo.changed_files(base, head)]
    return repo.diff(base, head), files


def review(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    key = f"review_repairs:{state.get('review_round', 0)}"
    try:
        diff, files = diff_info(state, deps)
        prompt_state: PipelineState = {**state, "delivery": {"review_diff": deps.redactor.redact(diff), "files": files}}
        system, user = build_reviewer_prompt(prompt_state, deps.cfg)
        result = deps.gateway.complete("reviewer", system=system, user=user, schema=Review).parsed
        plan = get_plan(state)
        assert plan is not None
        if {c.id for c in result.criteria} != {c.id for c in plan.acceptance_criteria} or len(result.criteria) != len(plan.acceptance_criteria):
            raise ValueError("Review must assess every criterion exactly once")
        raw = result.model_dump(mode="json")
        for finding in raw["findings"]:
            finding["path"] = "".join(c for c in finding["path"].replace("\\", "/") if c.isprintable())
        json_write(deps.run_dir / "artifacts" / f"review-{state.get('review_round', 0)}.json", raw)
        if result.verdict == "approve":
            return {"review": raw, "feedback": None}
        if state.get("review_round", 0) >= deps.cfg.limits.max_review_rounds:
            return {"review": raw, "failure": EngineError(FailureClass.IMPLEMENTATION, "review_exhausted", "Review revision budget exhausted").to_failure("review")}
        return {"review": raw, "review_round": state.get("review_round", 0) + 1, "mode": "revision",
                "feedback": {"kind": "review_changes", "message": result.summary, "details": [f.description for f in result.findings]},
                "step_evidence": [], "step_requests": [], "pending_edits": None}
    except ValueError as exc:
        return {**invalid(state, deps, "review", key, str(exc)), "review": None}
    except EngineError as exc:
        if exc.failure_class != FailureClass.LLM_OUTPUT:
            raise
        return {**invalid(state, deps, "review", key, exc.detail or exc.message), "review": None}


def package(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    diff, files = diff_info(state, deps)
    path = deps.run_dir / "delivery" / "candidate.diff"
    write_bytes_atomic(path, diff.encode())
    from scranton_pipeline.report import write_report
    update = {"delivery": {"diff_path": str(path), "diff_sha256": hashlib.sha256(diff.encode()).hexdigest(),
                           "files": files, "applied": False, "conflicts": []}}
    write_report({**state, "delivery": update["delivery"]}, deps, status="draft")
    return update


def approve_delivery(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    delivery = state["delivery"]
    assert delivery is not None
    decision = interrupt({"gate": "delivery", "digest": delivery["diff_sha256"], "files": delivery["files"], "diff_path": delivery["diff_path"]})
    deps.events.emit("gate_decided", gate="delivery", decision=decision["decision"], by="human")
    return {"delivery_approval": {**decision, "by": "human"}}


def apply_to_source(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    delivery = state["delivery"]
    assert delivery is not None
    from scranton_pipeline.tools.fs import sha256_file
    if sha256_file(Path(delivery["diff_path"])) != delivery["diff_sha256"]:
        raise EngineError(FailureClass.SECURITY, "delivery_changed", "Approved delivery artifact changed")
    deps.repo().reset_hard(state["workspace"]["head_commit"])
    changes = deps.repo().changed_files(state["workspace"]["base_commit"], state["workspace"]["head_commit"])
    result = source_apply(workspace=deps.workspace, source=Path(state["source_dir"]), changes=changes,
                          manifest=json.loads(Path(state["workspace"]["manifest_path"]).read_text(encoding="utf-8")),
                          backup_dir=deps.run_dir / "delivery" / "backups", journal_path=deps.run_dir / "delivery" / "apply-journal.json",
                          policy=PathPolicy(Path(state["source_dir"]), deps.policy().protected, deps.policy().write_protected))
    update: dict[str, Any] = {"delivery": {**delivery, "applied": not result.conflicts and not result.rolled_back, "conflicts": result.conflicts}}
    if result.conflicts or result.rolled_back:
        update["failure"] = EngineError(FailureClass.IMPLEMENTATION, "source_conflict", "Source apply refused or rolled back").to_failure("apply_to_source")
    return update

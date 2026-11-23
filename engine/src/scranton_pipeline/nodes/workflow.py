"""The deterministic work nodes and the two remaining bounded model turns."""
import hashlib
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from langgraph.types import interrupt

from scranton_pipeline.agents.prompts import build_implementer_prompt, build_reviewer_prompt
from scranton_pipeline.conversation import agent_message
from scranton_pipeline.dreaming import attempt_counter_key, emit_attempt
from scranton_pipeline.errors import EngineError, FailureClass, SuspendRequested
from scranton_pipeline.grounding import check_id, digest, recompute_summary, register, registry_row
from scranton_pipeline.instructions import discover, regular
from scranton_pipeline.models import ContextRequest, ImplementerTurn, Review
from scranton_pipeline.nodes.common import Dependencies, planning_key, scope_id
from scranton_pipeline.nodes.grounding import decide_criteria, evaluate, repair_evidence
from scranton_pipeline.nodes.planner import invalid
from scranton_pipeline.observability import _rows
from scranton_pipeline.state import PipelineState, counter, current_step, done_ids, get_plan
from scranton_pipeline.tools.checks import (
    check_ok,
    compare_with_baseline,
    failure_feedback,
    run_checks,
)
from scranton_pipeline.tools.context import eviction_index, fulfil, unique_evidence
from scranton_pipeline.tools.fs import PathPolicy, write_bytes_atomic
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.native_sandbox import NativeSandbox
from scranton_pipeline.tools.patches import apply_to_source as source_apply
from scranton_pipeline.tools.patches import validate_and_apply
from scranton_pipeline.tools.repo_index import build_index, detect_checks, render_tree
from scranton_pipeline.tools.sandbox import build_sandbox
from scranton_pipeline.tools.snapshot import snapshot_source


def json_write(path: Path, value: Any) -> None:
    write_bytes_atomic(path, json.dumps(value, ensure_ascii=True, indent=2).encode())


def sandbox(deps: Dependencies) -> Any:
    return build_sandbox(deps.cfg.sandbox, workspace=deps.workspace, run_id=deps.run_dir.name, trust_host=deps.trust_host, name_suffix=deps.lane_suffix, state_dir=deps.run_dir / "sandbox-state", run_dir=deps.run_dir)


def prepare_workspace(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    box = sandbox(deps)
    if not isinstance(box, NativeSandbox):
        box.preflight()
    manifest = deps.run_dir / "artifacts" / "source_manifest.json"
    # No checkpoint can refer to a partially prepared snapshot: rebuild it on replay.
    if deps.workspace.exists():
        from scranton_pipeline.nodes.parallel import remove_lane
        remove_lane(deps.workspace, owned=isinstance(box, NativeSandbox))
    if isinstance(box, NativeSandbox):
        box.allocate()
    snapshot = snapshot_source(Path(state["source_dir"]), deps.workspace, policy=deps.cfg.policy,
                               limits=deps.cfg.limits, manifest_path=manifest, allocated=isinstance(box, NativeSandbox))
    repo = WorkspaceRepo.init(deps.workspace, deps.run_dir / "git", timeout_s=deps.cfg.limits.git_timeout_s)
    base = repo.commit_all("Pipeline snapshot")
    files = list(json.loads(manifest.read_text(encoding="utf-8")))
    receipt = deps.run_dir / "artifacts" / "instructions.json"
    if receipt.exists():
        instructions = json.loads(receipt.read_text(encoding="utf-8"))
    else:
        active = deps.cfg.agents_md
        found = discover(deps.workspace, files, active=active)
        # Oversized files and links are not copied, but root instructions still have their own cap.
        skipped_root = any(row["path"] == "AGENTS.md" and row["reason"] in {"file_too_large", "symlink"} for row in snapshot.skipped)
        source = Path(state["source_dir"])
        reason = regular(source, source / "AGENTS.md") if active and "AGENTS.md" not in files else None
        source_policy = PathPolicy(source, deps.policy().protected, deps.policy().write_protected)
        if active and skipped_root and reason is None and not source_policy.is_protected("AGENTS.md"):
            found = replace(discover(source, [], active=True), nested=found.nested)
        elif reason not in {None, "absent"}:
            found = replace(found, warnings=(reason,))
        instructions = {"block": found.render(), "summary": found.summary()}
        json_write(receipt, instructions)
        for reason in found.warnings:
            deps.events.emit("log", level="warn", reason=reason, file="AGENTS.md")
        deps.events.emit("instructions", instructions=found.summary())
    for command in deps.cfg.setup:
        result = box.run(command.argv, timeout_s=command.timeout_s, network=command.network, writable_state=True,
                         log_path=deps.run_dir / "artifacts" / "logs" / f"setup-{command.id}.log", stop=deps.stop,
                         tail_bytes=deps.cfg.limits.max_output_tail_bytes, max_log_bytes=deps.cfg.limits.max_log_bytes)
        if result.stopped:
            if deps.stop.suspend_requested():
                raise SuspendRequested()
            return {"outcome": "cancelled"}
        if result.exit_code != 0 or result.timed_out:
            raise EngineError(FailureClass.INFRASTRUCTURE, "setup_failed", f"Setup {command.id} failed")
    deps.repo().restore_tracked()
    return {"instructions": instructions, "workspace": {"path": str(deps.workspace), "base_commit": base, "head_commit": base,
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
    deps.repo()._run(["reset", "--hard", state["workspace"]["head_commit"]])
    plan = get_plan(state)
    completed = done_ids(state)
    if state.get("mode") == "integration":
        completed.update(r["step_id"][5:] for r in state.get("wave", {}).get("records", []))
    step = current_step(state)
    if step and state.get("mode") == "step":
        completed.add(step.id)
    final = not state.get("lane") and plan is not None and (state.get("mode") == "revision" or all(s.id in completed for s in plan.steps))
    checks = [c for c in deps.cfg.checks if baseline or c.scope == "step" or final]
    results = run_checks(checks, sandbox=sandbox(deps), log_dir=deps.run_dir / "artifacts" / "logs",
                         label="baseline" if baseline else f"{deps.lane_suffix or ('int-' + str(state.get('wave', {}).get('number', 0)) if state.get('mode') == 'integration' else 'main')}-r{state.get('plan_revision', 0)}-step-{state.get('step_index', 0)}-R{state.get('review_round', 0)}-{counter(state, 'attempts:' + scope_id(state))}",
                         stop=deps.stop, fail_fast=not baseline, tail_bytes=deps.cfg.limits.max_output_tail_bytes,
                         max_log_bytes=deps.cfg.limits.max_log_bytes,
                         tolerated=() if baseline else {r["id"] for r in state.get("baseline", []) if r.get("status") == "failed"})
    restored = deps.repo().restore_tracked()
    if restored:
        deps.events.emit("warning", code="check_modified_tracked", message="Checks modified tracked files; restored", paths=restored)
    if deps.stop.suspend_requested():
        raise SuspendRequested()
    for result in results:
        deps.events.emit("check_finished", id=result.id, status=result.status, duration_s=result.duration_s)
    stage = "baseline" if baseline else "verify"
    commit = state["workspace"]["head_commit"]
    rows = [{**r.model_dump(mode="json"), "evidence_id": check_id(r.model_dump(mode="json"), stage, commit), "commit": commit, "stage": stage} for r in results]
    register(deps.run_dir, [registry_row(r, kind="check", stage=stage, commit=commit) for r in rows])
    return rows


def baseline_checks(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    results = checked(state, deps, baseline=True)
    if any(r["required"] and r["status"] == "error" for r in results):
        return {"baseline": results, "failure": EngineError(FailureClass.INFRASTRUCTURE, "check_error", "Baseline check could not execute: " + "; ".join(r["output_tail"] for r in results if r["status"] == "error")).to_failure("baseline_checks")}
    return {"baseline": results}


def context(state: PipelineState, deps: Dependencies, *, planner: bool) -> dict[str, Any]:
    prefix = "plan" if planner else "step"
    key = planning_key(state, "context") if planner else f"context:{scope_id(state)}"
    requests = [ContextRequest.model_validate(r) for r in (state.get("plan_requests", []) if planner else state.get("step_requests", []))]
    items = fulfil(requests, workspace=deps.workspace, policy=deps.policy(),
                   files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)
    evidence = [*(state.get("plan_evidence", []) if planner else state.get("step_evidence", [])), *[i.model_dump(mode="json") for i in items]]
    evidence = unique_evidence(evidence)
    while len(json.dumps(evidence).encode()) > deps.cfg.limits.max_prompt_bytes and evidence:
        evidence.pop(eviction_index(evidence))
    deps.events.emit("context", requests=len(requests), fulfilled=sum(i.ok for i in items))
    return {f"{prefix}_evidence": evidence, f"{prefix}_requests": [], "counters": {key: 1}}


def approve_plan(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    if deps.cfg.approvals.plan == "auto_low_risk" and not state.get("risk_flags"):
        decision = {"decision": "approve", "by": "auto", "comment": ""}
    else:
        decision = interrupt({"gate": "plan", "digest": state["plan_digest"], "risk_flags": state["risk_flags"],
                              "plan_path": str(deps.run_dir / "artifacts" / "plan.json"),
                              "revision": state.get("plan_revision", 0),
                              "replan_reason": (state.get("replan_brief") or {}).get("reason")})
        decision = {**decision, "by": decision.get("by", "human")}
    deps.events.emit("gate_decided", gate="plan", decision=decision["decision"], by=decision["by"])
    return {"plan_approval": decision, **({"outcome": "rejected"} if decision["decision"] == "reject" else {})}


def select_step(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    from scranton_pipeline.nodes.parallel import parallel_available
    from scranton_pipeline.waves import wave
    plan = get_plan(state)
    assert plan is not None
    indices = wave(plan.steps, done_ids(state), deps.cfg.execution.max_parallel_steps)
    serial = [i for i in indices if plan.steps[i].id in state.get("serial_steps", [])]
    if serial:
        indices = serial[:1]
    if len(indices) > 1 and parallel_available(deps):
        number = counter(state, "waves") + 1
        deps.events.emit("wave_started", wave=number, steps=[plan.steps[i].id for i in indices])
        return {"wave": {"number": number, "indices": indices}, "lanes": {},
                "counters": {"waves": 1}, "mode": "step", "step_index": indices[0],
                "feedback": None, "pending_edits": None}
    index = indices[0] if indices else len(plan.steps)
    evidence = []
    if index < len(plan.steps):
        step = plan.steps[index]
        requests = [ContextRequest(kind="read", path=p) for p in dict.fromkeys([f.path for f in step.files if f.action != "create"] + step.context_files)]
        evidence = [i.model_dump(mode="json") for i in fulfil(requests, workspace=deps.workspace, policy=deps.policy(),
                    files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)]
    return {"step_index": index, "step_evidence": evidence, "step_requests": [], "feedback": None, "pending_edits": None,
            "mode": "step", "wave": {}, "lanes": {}}


def implement(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    key = f"repairs:{scope_id(state)}"
    try:
        step = current_step(state)
        plan = get_plan(state)
        selected = plan.steps if plan and state.get("mode") == "revision" else [step] if step and state.get("mode") != "integration" else []
        if selected:
            requests = [ContextRequest(kind="read", path=p) for p in dict.fromkeys([f.path for s in selected for f in s.files if f.action != "create"] + [p for s in selected for p in s.context_files])]
            fresh = [{**i.model_dump(mode="json"), "python_read": True} for request in requests for i in fulfil([request], workspace=deps.workspace, policy=deps.policy(), files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)]
            state = {**state, "step_evidence": [*state.get("step_evidence", []), *fresh]}
        prompt = build_implementer_prompt(state, deps.cfg, graph=deps.procedure)
        system, user = prompt
        deps.procedure_event("implementer", state)
        turn = deps.gateway.complete("implementer", system=system, user=user, schema=ImplementerTurn, guidance_bytes=prompt.guidance_bytes, instructions_bytes=prompt.instructions_bytes).parsed
        evaluation = evaluate(state, deps, "implementer", prompt, turn.model_dump(mode="json"))
        if evaluation.reject(deps) and (turn.kind != "blocked" or evaluation.retry_block):
            return {**invalid(state, deps, "implement", key, str(evaluation.violations) + " Valid IDs: " + str(prompt.shown)),
                "step_evidence": repair_evidence(state, deps, evaluation, "step_evidence")}
        if turn.kind == "blocked":
            if not evaluation.reject(deps):
                agent_message(state, deps, "implementer", turn.model_dump(mode="json"))
            update = request_replan(state, deps, EngineError(FailureClass.IMPLEMENTATION, "step_blocked", turn.blocked_reason), "implement")
            if update.get("replan_request"):
                prior = [r for r in _rows(deps.run_dir / "grounding.jsonl") if r.get("scope") == scope_id(state) and r.get("lane") == state.get("lane", {}).get("step_id")]
                hits = [v["detail"] for r in prior for v in r.get("violations", []) if v["kind"] == "false_absence"]
                update["replan_request"].update(verified_absence=[a for a in evaluation.absences if a["status"] == "verified"], absence_refuted=hits)
            return update
        if turn.kind == "need_context":
            if counter(state, f"context:{scope_id(state)}") >= deps.cfg.limits.max_step_context_rounds:
                raise ValueError("No step context rounds remain")
            agent_message(state, deps, "implementer", turn.model_dump(mode="json"))
            return {"step_requests": [r.model_dump(mode="json") for r in turn.context_requests], "pending_edits": None}
        agent_message(state, deps, "implementer", turn.model_dump(mode="json"))
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
        return request_replan(state, deps, EngineError(FailureClass.IMPLEMENTATION, "attempts_exhausted", "Edit attempt budget exhausted"), "apply_edits")
    repo = deps.repo()
    repo.reset_hard(state["workspace"]["head_commit"])
    turn = ImplementerTurn.model_validate(state["pending_edits"])
    plan = get_plan(state)
    assert plan is not None
    step = current_step(state)
    selected = [plan.steps[i] for i in state["wave"]["indices"] if state["lanes"].get(plan.steps[i].id, {}).get("state") == "merged"] if state.get("mode") == "integration" else plan.steps if state.get("mode") == "revision" else [step] if step else []
    declared = {f.path for s in selected for f in s.files}
    result = validate_and_apply(turn.edits, workspace=deps.workspace, policy=deps.policy(), declared=declared,
                                scope="strict" if state.get("mode") == "integration" else deps.cfg.policy.scope, undeclared_budget=deps.cfg.policy.max_undeclared_files,
                                limits=deps.cfg.limits)
    update: dict[str, Any] = {"counters": {key: 1, attempt_counter_key(state): 1}, "pending_edits": None}
    if not result.ok:
        deps.events.emit("edits_rejected", count=len(result.rejected))
        emit_attempt(state, deps, rejected=True)
        if counter(state, key) + 1 >= deps.cfg.limits.max_step_attempts:
            update.update(request_replan(state, deps, EngineError(FailureClass.IMPLEMENTATION, "edits_rejected", "Edit attempts exhausted"), "apply_edits"))
        else:
            update["feedback"] = {"kind": "edits_rejected", "message": "Edits rejected", "details": result.rejected}
        return update
    head = repo.commit_paths(result.changed, f"Pipeline {scope_id(state)} attempt {counter(state, key) + 1}")
    update.update(workspace={**state["workspace"], "head_commit": head}, feedback=None,
                  deviations=sorted(set(state.get("deviations", []) + result.undeclared)))
    deps.events.emit("edits_applied", files=result.changed, commit=head)
    return update


def against_baseline(results: list[dict[str, Any]], state: PipelineState, deps: Dependencies) -> list[dict[str, Any]]:
    """Mark each check that failed now and at baseline with the tests that newly fail. One with none
    (baseline_unchanged) does not block the step, since the step is not asked to repair what was broken before
    it, unless an acceptance criterion is verified by that check: then the plan asks for it to pass."""
    plan = get_plan(state)
    required = [c.id for c in deps.cfg.checks if c.required]
    demanded = {i for c in (plan.acceptance_criteria if plan else []) if c.verified_by == "checks" for i in (c.checks or required)}
    rows = []
    for row in results:
        comparison = compare_with_baseline(row, state.get("baseline", []), run_dir=deps.run_dir, redactor=deps.redactor,
                                           max_log_bytes=deps.cfg.limits.max_log_bytes) if row["status"] == "failed" else None
        if comparison is None:
            rows.append(row)
            continue
        rows.append({**row, "baseline_comparison": comparison, "baseline_unchanged": not comparison["new"] and row["id"] not in demanded})
    return rows


def verify(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    results = checked(state, deps)
    if deps.stop.cancel_requested():
        return {"checks": results, "outcome": "cancelled"}
    results = against_baseline(results, state, deps)
    emit_attempt(state, deps, results=results)
    failed = [r for r in results if r["required"] and not check_ok(r)]
    if failed:
        if any(r["status"] == "error" for r in failed):
            return {"checks": results, "failure": EngineError(FailureClass.INFRASTRUCTURE, "check_error",
                "Check could not execute: " + "; ".join(r["output_tail"] for r in failed if r["status"] == "error")).to_failure("verify")}
        if counter(state, f"attempts:{scope_id(state)}") >= deps.cfg.limits.max_step_attempts:
            return {"checks": results, **request_replan({**state, "checks": results}, deps, EngineError(FailureClass.CHECKS_FAILED, "checks_exhausted", "Required checks failed"), "verify")}
        return {"checks": results, "feedback": {"kind": "checks_failed", "message": "Required checks failed. The edits of your previous attempt are"
                                                 " applied in the files you are shown; correct or build on them rather than treating them as done.",
                                                 "details": failure_feedback(failed, state.get("baseline", []), run_dir=deps.run_dir,
                                                     redactor=deps.redactor, tail_bytes=deps.cfg.limits.max_output_tail_bytes)}}
    head = state["workspace"]["head_commit"]
    if state.get("mode") == "integration":
        from scranton_pipeline.nodes.parallel import finish_integration
        return {"checks": results, "feedback": None, "workspace": {**state["workspace"], "green_commit": head},
                **finish_integration(state)}
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
        decided = decide_criteria(state, deps)
        prompt_state: PipelineState = {**state, "delivery": {"review_diff": deps.redactor.redact(diff), "files": files,
            "decided_criteria": [{**c, "evidence": [r.get("evidence_id") for r in state.get("checks", []) if r["id"] in c["checks"] and r.get("commit") == state["workspace"]["head_commit"]]} for c in decided if c["verified_by"] == "checks"]}}
        prompt = build_reviewer_prompt(prompt_state, deps.cfg, graph=deps.procedure)
        system, user = prompt
        deps.procedure_event("reviewer", prompt_state)
        result = deps.gateway.complete("reviewer", system=system, user=user, schema=Review, guidance_bytes=prompt.guidance_bytes, instructions_bytes=prompt.instructions_bytes).parsed
        plan = get_plan(state)
        assert plan is not None
        evaluation = evaluate(prompt_state, deps, "reviewer", prompt, result.model_dump(mode="json"))
        if evaluation.reject(deps):
            raise ValueError(str(evaluation.violations) + " Valid IDs: " + str(prompt.shown))
        required = {c.id for c in plan.acceptance_criteria if c.verified_by == "review"}
        assessments = [c for c in result.criteria if c.id in required]
        if {c.id for c in assessments} != required or len(assessments) != len(required):
            raise ValueError("Review must assess every review criterion exactly once")
        if result.verdict == "approve" and (any(c.status == "not_met" for c in result.criteria) or any(f.severity == "blocking" for f in result.findings)):
            raise ValueError("Approval contradicts findings or criteria")
        raw = {**result.model_dump(mode="json"), "criteria": [c.model_dump(mode="json") for c in assessments]}
        if result.verdict == "approve":
            for criterion in decided:
                if criterion["verified_by"] != "checks" or criterion["state"] != "not_met":
                    continue
                failed = [r for r in state.get("checks", []) if r["id"] in criterion["checks"] and r.get("commit") == state["workspace"]["head_commit"] and not check_ok(r)]
                detail = "; ".join(r["id"] + ": " + r.get("output_tail", "")[-4096:] for r in failed) or "Missing current results: " + ", ".join(criterion["checks"])
                raw["verdict"] = "request_changes"
                raw["findings"].append({"severity": "major", "category": "tests", "path": "", "description": "Criterion " + criterion["id"] + " not met: " + detail, "suggestion": "Satisfy the named checks", "citations": [r["evidence_id"] for r in failed if r.get("evidence_id")]})
        for finding in raw["findings"]:
            finding["path"] = "".join(c for c in finding["path"].replace("\\", "/") if c.isprintable())
        agent_message(state, deps, "reviewer", raw)
        json_write(deps.run_dir / "artifacts" / f"review-{state.get('review_round', 0)}.json", raw)
        if raw["verdict"] == "approve":
            return {"review": raw, "feedback": None}
        if state.get("review_round", 0) >= deps.cfg.limits.max_review_rounds:
            return {"review": raw, "failure": EngineError(FailureClass.IMPLEMENTATION, "review_exhausted", "Review revision budget exhausted").to_failure("review")}
        return {"review": raw, "review_round": state.get("review_round", 0) + 1, "mode": "revision",
                "feedback": {"kind": "review_changes", "message": result.summary, "details": [f["description"] for f in raw["findings"]]},
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
    grounding = recompute_summary(deps.run_dir)
    risks = (["criteria_not_demonstrated"] if any(c["state"] == "met_not_demonstrated" for c in grounding["criteria"]) else []) + (["grounding_violations"] if any(r.get("type") == "output" and r.get("accepted") and r.get("violations") for r in _rows(deps.run_dir / "grounding.jsonl")) else [])
    update = {"delivery": {"grounding": grounding, "risk_flags": risks, "gate_digest": digest({"diff_sha256": hashlib.sha256(diff.encode()).hexdigest(), "grounding": grounding, "risk_flags": risks}), "diff_path": str(path), "diff_sha256": hashlib.sha256(diff.encode()).hexdigest(),
                           "files": files, "applied": False, "conflicts": []}}
    write_report({**state, "delivery": update["delivery"]}, deps, status="draft")
    return update


def approve_delivery(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    delivery = state["delivery"]
    assert delivery is not None
    decision = interrupt({"gate": "delivery", "digest": delivery["gate_digest"], "grounding": delivery["grounding"], "risk_flags": delivery["risk_flags"], "files": delivery["files"], "diff_path": delivery["diff_path"]})
    deps.events.emit("gate_decided", gate="delivery", decision=decision["decision"], by=decision.get("by", "human"))
    return {"delivery_approval": {**decision, "by": decision.get("by", "human")}}


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


def request_replan(state: PipelineState, deps: Dependencies, error: EngineError, node: str) -> dict[str, Any]:
    spent = state.get("lane", {}).get("replans", counter(state, "replans"))
    if state.get("mode") == "revision" or spent >= deps.cfg.limits.max_replans:
        failure = error.to_failure(node)
        if not state.get("lane"):
            deps.events.emit("failure", **failure)
        return {"failure": failure}
    step = current_step(state) if state.get("mode") != "integration" else None
    request = {"code": error.code, "message": error.message, "scope": scope_id(state), "node": node,
               "failed_step": step.model_dump(mode="json") if step else None, "checks": state.get("checks", [])}
    if not state.get("lane"):
        deps.events.emit("replan_requested", code=error.code, message=error.message, scope=scope_id(state))
    return {"replan_request": request}


def replan(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    request = state["replan_request"]
    assert request is not None
    if counter(state, "replans") >= deps.cfg.limits.max_replans:
        kind = FailureClass.CHECKS_FAILED if request["code"] == "checks_exhausted" else FailureClass.IMPLEMENTATION
        return {"failure": EngineError(kind, request["code"], request["message"]).to_failure(request["node"])}
    green = state["workspace"]["green_commit"]
    deps.repo().reset_hard(green)
    _, files = diff_info(state, deps, green=True)
    reason = request["code"] + ": " + request["message"]
    revisions = [{**entry, "replaced_reason": reason} if entry["revision"] == state.get("plan_revision", 0)
                 else entry for entry in state.get("plan_revisions", [])]
    step = current_step(state)
    revision = state.get("plan_revision", 0) + 1
    brief = {"reason": reason, "failed_step": request.get("failed_step", step.model_dump(mode="json") if step else None),
             "completed_steps": [s["step_id"] for s in state.get("steps_done", [])],
             "changed_files": files, "checks": request.get("checks", state.get("checks", [])),
             "verified_absence": request.get("verified_absence", []), "absence_refuted": request.get("absence_refuted", [])}
    deps.events.emit("replanned", revision=revision)
    return {"workspace": {**state["workspace"], "head_commit": green}, "counters": {"replans": 1},
            "plan_revision": revision, "plan_revisions": revisions, "previous_plan": state.get("plan"),
            "replan_brief": brief, "replan_request": None, "plan": None, "plan_digest": "", "risk_flags": [],
            "plan_requests": [], "plan_evidence": [], "plan_approval": None, "step_index": -1,
            "mode": "step", "wave": {}, "serial_steps": [], "lanes": {}, "step_evidence": [], "step_requests": [], "feedback": None, "pending_edits": None,
            "deviations": [p for p in state.get("deviations", []) if p in {f["path"] for f in files}]}


def cleanup_sandbox(deps: Dependencies) -> None:
    try:
        sandbox(deps).cleanup()
    except Exception:  # noqa: BLE001 - cleanup must never replace the actual result
        deps.events.emit("warning", code="cleanup_failed", message="Sandbox cleanup failed")

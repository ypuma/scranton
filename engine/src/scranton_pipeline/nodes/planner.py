"""Planner turn and semantic validation."""
import hashlib
import json
from typing import Any, cast

from scranton_pipeline.agents.prompts import build_planner_prompt
from scranton_pipeline.conversation import agent_message
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.models import ConversationPlannerTurn, Plan, PlannerTurn
from scranton_pipeline.nodes.common import Dependencies, planning_key
from scranton_pipeline.nodes.grounding import evaluate, repair_evidence
from scranton_pipeline.state import PipelineState, counter, initial_planning
from scranton_pipeline.tools.fs import is_dependency_manifest, write_bytes_atomic


def validate_plan(plan: Plan, deps: Dependencies) -> None:
    if len(plan.steps) > deps.cfg.limits.max_plan_steps:
        raise ValueError("Too many plan steps")
    if len({s.id for s in plan.steps}) != len(plan.steps):
        raise ValueError("Duplicate step IDs")
    from scranton_pipeline.waves import dependencies
    dependencies(plan.steps)
    criteria = {c.id for c in plan.acceptance_criteria}
    if len(criteria) != len(plan.acceptance_criteria):
        raise ValueError("Duplicate criteria IDs")
    for criterion in plan.acceptance_criteria:
        if not set(criterion.checks) <= {c.id for c in deps.cfg.checks}:
            raise ValueError("Unknown configured check in criterion")
    files: set[str] = set()
    policy = deps.policy()
    for step in plan.steps:
        if not set(step.criteria) <= criteria:
            raise ValueError("Unknown acceptance criterion")
        for path in step.context_files:
            policy.resolve(path)
            if policy.is_protected(path):
                raise EngineError(FailureClass.SECURITY, "protected_path", "Protected plan context")
        for intent in step.files:
            path = policy.normalize(intent.path)
            target = policy.resolve(path)
            if policy.is_protected(path) or policy.is_write_protected(path):
                raise EngineError(FailureClass.SECURITY, "protected_path", "Protected plan target")
            if (intent.action == "create") == target.exists():
                raise ValueError(f"Plan action disagrees with existing path: {path}")
            files.add(path)
    if len(files) > deps.cfg.limits.max_changed_files:
        raise ValueError("Too many changed files")


def invalid(state: PipelineState, deps: Dependencies, node: str, key: str, error: str) -> dict[str, Any]:
    if counter(state, key) >= deps.cfg.limits.max_output_repairs:
        return {"failure": EngineError(FailureClass.LLM_OUTPUT, "output_invalid", "Output repair budget exhausted").to_failure(node)}
    return {"feedback": {"kind": "output_invalid", "message": error[:2000], "details": []},
            "counters": {key: 1}}


def plan(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    try:
        prompt = build_planner_prompt(state, deps.cfg, graph=deps.procedure)
        system, user = prompt
        deps.procedure_event("planner", state)
        turn = cast(PlannerTurn | ConversationPlannerTurn, deps.gateway.complete("planner", system=system, user=user, schema=ConversationPlannerTurn if deps.cfg.conversation and initial_planning(state) else PlannerTurn, guidance_bytes=prompt.guidance_bytes).parsed)
        evaluation = evaluate(state, deps, "planner", prompt, turn.model_dump(mode="json"))
        if evaluation.reject(deps):
            return {**invalid(state, deps, "plan", planning_key(state, "repairs"), str(evaluation.violations) + " Valid IDs: " + str(prompt.shown)),
                "plan_evidence": repair_evidence(state, deps, evaluation, "plan_evidence")}
        if turn.kind == "need_context":
            if counter(state, planning_key(state, "context")) >= deps.cfg.limits.max_plan_context_rounds:
                raise ValueError("No planner context rounds remain")
            agent_message(state, deps, "planner", turn.model_dump(mode="json"))
            return {"plan_requests": [r.model_dump(mode="json") for r in turn.context_requests], "feedback": None}
        if isinstance(turn, ConversationPlannerTurn) and turn.kind == "answer":
            if not initial_planning(state):
                raise ValueError("Direct answers require initial planning before any step")
            assert turn.answer is not None
            agent_message(state, deps, "planner", turn.model_dump(mode="json"))
            return {"answer": turn.answer.model_dump(mode="json"), "plan_requests": [], "feedback": None}
        assert turn.plan is not None
        validate_plan(turn.plan, deps)
        raw = turn.plan.model_dump(mode="json")
        revision = state.get("plan_revision", 0)
        revisions = list(state.get("plan_revisions", []))
        if revision:
            used = {s["id"] for entry in revisions for s in entry["plan"]["steps"]}
            renamed = {}
            for index, step in enumerate(raw["steps"]):
                candidate = f"r{revision}:s{index + 1}"
                while candidate in used:
                    candidate += "_"
                renamed[step["id"]] = candidate
                step["id"] = candidate
                used.add(candidate)
            for step in raw["steps"]:
                if step["depends_on"] is not None:
                    step["depends_on"] = [renamed[s] for s in step["depends_on"]]
        encoded = json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()
        write_bytes_atomic(deps.run_dir / "artifacts" / "plan.json", encoded)
        write_bytes_atomic(deps.run_dir / "artifacts" / f"plan-r{revision}.json", encoded)
        revisions.append({"revision": revision, "plan": raw, "replaced_reason": None})
        paths = {f.path for s in turn.plan.steps for f in s.files}
        flags = ["replan"] if revision else []
        if any(is_dependency_manifest(deps.policy().resolve(p)) for p in paths):
            flags.append("dependency_manifest_change")
        if any(f.action == "delete" for s in turn.plan.steps for f in s.files):
            flags.append("deletes_files")
        if len(paths) > 10:
            flags.append("many_files")
        if any(p.startswith((".github/", ".gitlab")) or p.split("/")[-1] in {"Makefile", "CMakeLists.txt", "Dockerfile", "pyproject.toml"} for p in paths):
            flags.append("ci_or_build_config")
        if any(c["required"] and c["status"] != "passed" for c in state.get("baseline", [])):
            flags.append("baseline_red")
        agent_message(state, deps, "planner", turn.model_dump(mode="json"))
        return {"plan": raw, "plan_revisions": revisions, "plan_digest": hashlib.sha256(encoded).hexdigest(), "risk_flags": flags,
                "plan_requests": [], "feedback": None}
    except ValueError as exc:
        return invalid(state, deps, "plan", planning_key(state, "repairs"), str(exc))
    except EngineError as exc:
        if exc.failure_class != FailureClass.LLM_OUTPUT:
            raise
        return invalid(state, deps, "plan", planning_key(state, "repairs"), exc.detail or exc.message)

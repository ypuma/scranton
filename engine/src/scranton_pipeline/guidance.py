"""Advisory localization and pinned run identity; never execution policy."""
import json
import re
from pathlib import Path
from typing import Any

from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.observability import _rows
from scranton_pipeline.procedure import Graph, digest, load, render
from scranton_pipeline.state import PipelineState


def situation(role: str, state: PipelineState) -> str:
    feedback = (state.get("feedback") or {}).get("kind")
    counters = state.get("counters", {})
    last = (state.get("history") or [{}])[-1].get("node")
    if role == "planner":
        if last == "plan_context":
            return "plan.context"
        if feedback == "output_invalid":
            return "plan.repair"
        if counters.get(f"plan_context:r{state.get('plan_revision', 0)}", 0):
            return "plan.context"
        return "plan.replan" if state.get("plan_revision", 0) else "plan.start"
    if role == "reviewer":
        if feedback == "output_invalid":
            return "review.repair"
        return "review.recheck" if state.get("review_round", 0) else "review.start"
    if last == "implement_context":
        return "implement.context"
    if feedback in {"output_invalid", "edits_rejected"}:
        return "implement." + ("repair" if feedback == "output_invalid" else feedback)
    if state.get("mode") == "integration":
        return "implement.integration"
    if feedback in {"checks_failed", "review_changes"}:
        return "implement." + str(feedback)
    if state.get("mode") == "revision":
        return "implement.review_changes"
    return "implement.start"


def text(graph: Graph | None, role: str, state: PipelineState, *, hops: int, max_bytes: int) -> str:
    if graph is None:
        return ""
    guidance = render(graph, situation(role, state), hops=hops, max_bytes=max_bytes)
    # Operator-authored advice cannot masquerade as a grounding citation.
    return re.sub(r"[EKH]-[0-9a-f]{10}", "[not evidence]", guidance)


def pinned(run_dir: Path, enabled: bool) -> Graph | None:
    if not enabled:
        return None
    identity = json.loads((run_dir / "run.json").read_text(encoding="utf-8")).get("procedure", {})
    graph = load(run_dir / "artifacts" / "procedure.json")
    if identity != {"enabled": True, "name": graph.name, "digest": digest(graph)}:
        raise EngineError(FailureClass.INVALID_INPUT, "procedure_changed", "Pinned procedure graph digest does not match artifacts/procedure.json")
    return graph


def status(run_dir: Path, enabled: bool, identity: dict[str, Any]) -> dict[str, Any]:
    if not enabled:
        return {"enabled": False, "name": None, "digest": None, "situation": None}
    recent = next((r["data"]["situation"] for r in reversed(_rows(run_dir / "events.jsonl")) if r.get("type") == "procedure"), None)
    return {"enabled": True, "name": identity.get("name"), "digest": identity.get("digest"), "situation": recent}

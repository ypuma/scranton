"""Opt-in projections of validated turns and terminal state, never raw completions."""
from typing import TYPE_CHECKING, Any

from scranton_pipeline.state import PipelineState, counter, current_step

if TYPE_CHECKING:
    from scranton_pipeline.nodes.common import Dependencies

TEXT_CAP = 16000


def bounded_text(text: str, deps: "Dependencies") -> tuple[str, bool]:
    redacted = deps.redactor.redact(text)
    return redacted[:TEXT_CAP], len(redacted) > TEXT_CAP


def agent_message(state: PipelineState, deps: "Dependencies", role: str, turn: dict[str, Any]) -> None:
    if not deps.cfg.conversation:
        return
    kind = turn.get("kind")
    requests = turn.get("context_requests", [])
    request_text = "Context requested: " + "; ".join(r["kind"] + " " + (r.get("path") or "(project)") for r in requests)
    if role == "planner":
        text = (turn.get("answer") or {}).get("text", "") if kind == "answer" else (turn.get("plan") or {}).get("summary", "") if kind == "plan" else turn.get("rationale") or request_text
        context = f"{len(requests)} requests" if kind == "need_context" else f"Revision {state.get('plan_revision', 0)}"
    elif role == "implementer":
        step = current_step(state)
        from scranton_pipeline.nodes.common import scope_id
        text = turn.get("blocked_reason", "") if kind == "blocked" else turn.get("summary") or (request_text if kind == "need_context" else "Implemented step: " + (step.title if step else scope_id(state)))
        context = f"Step {step.id if step else scope_id(state)} (attempt {counter(state, 'attempts:' + scope_id(state)) + 1})"
    else:
        text = turn["summary"]
        context = f"Round {state.get('review_round', 0)}"
    text, truncated = bounded_text(text, deps)
    if text.strip():
        context = deps.redactor.redact(context)[:1024]
        deps.events.emit("agent_message", role=role, text=text, context=context, final=True, truncated=truncated)


def terminal_reply(state: PipelineState, deps: "Dependencies", outcome: str) -> dict[str, Any]:
    answer = state.get("answer") if outcome == "succeeded" else None
    if answer:
        text = answer["text"]
        citations = answer.get("citations", [])
    else:
        delivery = state.get("delivery") or {}
        review = state.get("review") or {}
        failure = state.get("failure") or {}
        reason = failure.get("message") or {"rejected": "The plan was rejected by the operator.", "cancelled": "The run was cancelled."}.get(outcome, "")
        lines = [f"Pipeline {outcome}."]
        if reason:
            lines.append("Reason: " + reason)
        lines.append(f"Completed steps: {len(state.get('steps_done', []))}.")
        files = delivery.get("files", [])
        lines.append(f"Changed files: {len(files)}" + (": " + ", ".join(f["path"] for f in files) if files else "") + ".")
        checks = state.get("checks", [])
        lines.append("Checks: " + (", ".join(c["id"] + " " + c["status"] for c in checks) or "No final checks ran") + ".")
        lines.append("Review: " + review.get("verdict", "not reviewed") + (" — " + review["summary"] if review.get("summary") else "") + ".")
        lines.append("Delivery: " + ("applied to source" if delivery.get("applied") else "patch only" if delivery.get("applied") is False else "not applied") + ".")
        text = "\n".join(lines)
        citations = []
    text, truncated = bounded_text(text, deps)
    return {"from": "pipeline", "kind": "answer" if answer else "result", "text": text,
            "citations": [deps.redactor.redact(c) for c in citations][:100], "truncated": truncated}

"""Grounding validators run inside the role's existing bounded repair path."""
import fnmatch
import json
import re
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from scranton_pipeline.agents.prompts import Prompt
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.grounding import (
    append_trace,
    cited_ids,
    digest,
    recompute_summary,
    register,
    registry_row,
)
from scranton_pipeline.models import ContextRequest
from scranton_pipeline.nodes.common import Dependencies, scope_id
from scranton_pipeline.observability import _rows
from scranton_pipeline.state import PipelineState, current_step, get_plan
from scranton_pipeline.tools.context import fulfil
from scranton_pipeline.tools.fs import read_text, write_bytes_atomic


def matches(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, p) or p.startswith("**/") and fnmatch.fnmatchcase(path, p[3:]) for p in patterns)


def absence(claim: dict[str, Any], deps: Dependencies) -> dict[str, Any]:
    hits, searched, complete = [], 0, True
    subject = claim["subject"]
    policy = deps.policy()
    def normalized(value: str, *, glob: bool = False) -> str:
        value = value.replace("\\", "/")
        while value.startswith("./"):
            value = value[2:]
        try:
            policy.normalize(re.sub(r"\[[^\]]*\]|[?*]", "glob", value) if glob else value)
        except EngineError as exc:
            raise ValueError("Invalid absence path: " + deps.redactor.redact(value)) from exc
        return value
    patterns = [normalized(p, glob=True).casefold() for p in claim.get("paths", [])]
    if claim["kind"] == "missing_file":
        subject = normalized(subject)
    paths = sorted(p.relative_to(deps.workspace).as_posix() for p in deps.workspace.rglob("*") if p.is_file() or claim["kind"] == "missing_file" and p.is_dir())
    if len(paths) > deps.cfg.limits.max_workspace_files:
        return {"status": "unverifiable", "hits": [], "files_searched": 0}
    for rel in paths:
        if patterns and not matches(rel.casefold(), patterns):
            continue
        try:
            local = deps.workspace / rel
            if local.is_symlink() or local.is_junction() or any(p.is_symlink() or p.is_junction() for p in local.parents if p != deps.workspace and p.is_relative_to(deps.workspace)):
                complete = False
                continue
            if policy.is_protected(rel):
                continue
            path = policy.resolve(rel)
            if path.is_symlink() or path.is_junction():
                complete = False
                continue
            if claim["kind"] == "missing_file":
                searched += 1
                if rel.casefold() == subject.casefold() or Path(rel).name.casefold() == subject.casefold():
                    hits.append({"path": rel, "line": 1})
            else:
                text, cut = read_text(path, deps.cfg.limits.max_file_bytes)
                searched += 1
                complete = complete and not cut
                for n, line in enumerate(text.splitlines(), 1):
                    if re.search(r"(?<!\w)" + re.escape(subject) + r"(?!\w)", line):
                        hits.append({"path": rel, "line": n})
                        break
        except EngineError as exc:
            if exc.code != "not_text":
                complete = False
        except OSError:
            complete = False
        if len(hits) >= deps.cfg.limits.max_search_matches:
            break
    status = "refuted" if hits else "verified" if complete and searched else "unverifiable"
    if status == "verified":
        deps.events.emit("absence_verified", kind=claim["kind"], subject=deps.redactor.redact(subject), files_searched=searched, meaning="not found in the files models may read")
    return {"meaning": "not found in the files models may read", "status": status, "kind": claim["kind"], "subject": deps.redactor.redact(subject), "hits": hits, "files_searched": searched}


@dataclass
class Evaluation:
    violations: list[dict[str, str]]
    missing: list[str]
    absences: list[dict[str, Any]]
    retry_block: bool = False

    def reject(self, deps: Dependencies) -> bool:
        return bool(self.violations) and deps.cfg.grounding.mode == "enforce"


def evaluate(state: PipelineState, deps: Dependencies, role: str, prompt: Prompt, raw: dict[str, Any]) -> Evaluation:
    violations: list[dict[str, str]] = []
    missing: list[str] = []
    absences: list[dict[str, Any]] = []
    def violation(kind: str, detail: str) -> None:
        violations.append({"kind": kind, "detail": deps.redactor.redact(detail)})
    shown = prompt.shown
    cited = cited_ids(raw)
    for ident in cited:
        if ident not in shown:
            violation("unknown_citation", ident)
    reads = [i for i in prompt.items if i.get("ok") and i.get("request", {}).get("kind") == "read"]
    total, seen = 0, 0
    plan = get_plan(state)
    if role == "planner" and raw.get("plan"):
        targets = [f for s in raw["plan"]["steps"] for f in s["files"] if f["action"] != "create"]
        for target in targets:
            total += 1
            if any(i["request"]["path"] == target["path"] for i in reads):
                seen += 1
            else:
                missing.append(target["path"])
                if target["path"] not in prompt.unverifiable:
                    violation("unseen_target", target["path"])
        claims = raw["plan"].get("absent", [])
    else:
        claims = [raw["blocked_claim"]] if raw.get("blocked_claim") else []
    if role == "implementer":
        step = current_step(state)
        selected = plan.steps if plan and state.get("mode") == "revision" else [plan.steps[i] for i in state.get("wave", {}).get("indices", [])] if plan and state.get("mode") == "integration" else [step] if step else []
        declared = {f.path for s in selected for f in s.files}
        for edit in raw.get("edits", []):
            path = edit["path"]
            if path not in declared and (deps.cfg.policy.scope == "strict" or state.get("mode") == "integration"):
                violation("out_of_scope_edit", path)
            if edit["action"] == "create":
                continue
            total += 1
            full = edit.get("content") is not None
            if any(i["request"]["path"] == path and (not full or not i["truncated"] and not i["request"].get("start_line") and not i["request"].get("end_line")) for i in reads):
                seen += 1
            else:
                missing.append(path)
                violation("unseen_edit", path + (": full overwrite requires a complete read; use replacements" if full else ""))
    for request in raw.get("context_requests", []):
        try:
            deps.policy().resolve(request["path"])
            if deps.policy().is_protected(request["path"]):
                violation("protected_request", request["path"])
        except EngineError:
            violation("protected_request", "Outside or invalid path")
    for claim in claims:
        result = absence(claim, deps)
        absences.append(result)
        if result["status"] == "refuted":
            violation("false_absence", json.dumps(result["hits"]))
            deps.events.emit("absence_refuted", kind=claim["kind"], subject=deps.redactor.redact(claim["subject"]), hits=result["hits"])
    if role == "implementer" and raw.get("kind") == "blocked" and not claims:
        absences.append({"status": "unverifiable"})
    if role == "reviewer":
        changed = {f["path"] for f in (state.get("delivery") or {}).get("files", [])}
        required = {c.id for c in plan.acceptance_criteria if c.verified_by == "review"} if plan else set()
        for assessment in raw.get("criteria", []):
            if assessment["id"] in required and assessment["status"] == "met" and not any(c in shown and c.startswith(("H-", "K-")) for c in assessment.get("citations", [])):
                violation("unsupported_assessment", assessment["id"])
        for finding in raw.get("findings", []):
            if finding.get("path") not in changed or finding["severity"] in {"major", "blocking"} and not any(c in shown and c.startswith(("H-", "K-")) for c in finding.get("citations", [])):
                violation("unsupported_finding", finding.get("path", ""))
    lane = state.get("lane", {}).get("step_id")
    scope = f"plan:r{state.get('plan_revision', 0)}" if role == "planner" else f"review:{state.get('review_round', 0)}" if role == "reviewer" else scope_id(state)
    previous = [r for r in _rows(deps.run_dir / "grounding.jsonl") if r.get("scope") == scope and r.get("lane") == lane]
    retry_block = raw.get("kind") == "blocked" and any(a["status"] == "refuted" for a in absences) and not any(r.get("absence", {}).get("refuted") for r in previous)
    rejected = bool(violations) and deps.cfg.grounding.mode == "enforce"
    register(deps.run_dir, [registry_row(i, kind="context" if i["evidence_id"].startswith("E-") else "check" if i["evidence_id"].startswith("K-") else "hunk", commit=state.get("workspace", {}).get("head_commit", "")) for i in prompt.items])
    append_trace(deps.run_dir, {"ts": datetime.now(UTC).isoformat(), "type": "output", "role": role, "scope": scope,
        "node": {"planner": "plan", "implementer": "implement", "reviewer": "review"}[role], "lane": lane,
        "mode": deps.cfg.grounding.mode, "weights": deps.cfg.grounding.weights.model_dump(),
        "shown": shown, "cited": cited, "violations": violations,
        "absence": {k: sum(a["status"] == k for a in absences) for k in ("verified", "refuted", "unverifiable")},
        "targets": {"total": total, "seen": seen}, "unverifiable_target": prompt.unverifiable, "accepted": not rejected})
    deps.events.emit("grounding", role=role, scope=scope, accepted=not rejected, violations=[v["kind"] for v in violations], cited=len(cited), shown=len(shown), **({"lane": lane} if lane else {}))
    return Evaluation(violations, missing, absences, retry_block)


def repair_evidence(state: PipelineState, deps: Dependencies, evaluation: Evaluation, key: str) -> list[dict[str, Any]]:
    requests = [ContextRequest(kind="read", path=p) for p in dict.fromkeys([*evaluation.missing, *[h["path"] for a in evaluation.absences for h in a.get("hits", [])]])]
    items = [i for request in requests for i in fulfil([request], workspace=deps.workspace, policy=deps.policy(), files=state["workspace"]["files"], limits=deps.cfg.limits, redactor=deps.redactor)]
    return [*cast(list[dict[str, Any]], state.get(key, [])), *[{**i.model_dump(mode="json"), "python_read": True} for i in items]]


def decide_criteria(state: PipelineState, deps: Dependencies) -> list[dict[str, Any]]:
    plan = get_plan(state)
    if not plan:
        return []
    current = {r["id"]: r for r in state.get("checks", []) if r.get("commit") == state["workspace"]["head_commit"]}
    baseline = {r["id"]: r for r in state.get("baseline", [])}
    assessments = {c["id"]: c for c in (state.get("review") or {}).get("criteria", [])}
    review_rows = [r for r in _rows(deps.run_dir / "grounding.jsonl") if r.get("role") == "reviewer" and r.get("accepted")]
    shown = review_rows[-1]["shown"] if review_rows else []
    result = []
    for c in plan.acceptance_criteria:
        ids = c.checks or [r.id for r in deps.cfg.checks if r.required] if c.verified_by == "checks" else []
        by = "none"
        if c.verified_by == "checks":
            met = all(current.get(i, {}).get("status") == "passed" for i in ids)
            demonstrated = met and any(baseline.get(i, {}).get("status") in {"failed", "timed_out", "error"} for i in ids)
            status = "demonstrated" if demonstrated else "met_not_demonstrated" if met else "not_met"
            by = "baseline" if demonstrated else "none"
        else:
            a = assessments.get(c.id, {})
            valid = any(i in shown and i.startswith(("H-", "K-")) for i in a.get("citations", []))
            status = "attested" if a.get("status") == "met" and valid else "unclear" if a.get("status") in {"met", "unclear"} else "not_met" if a else "undecided"
            by = "review" if a else "none"
        result.append({"id": c.id, "verified_by": c.verified_by, "state": status, "by": by, "checks": ids})
    return result


def probe(state: PipelineState, deps: Dependencies, criteria: list[dict[str, Any]]) -> dict[str, Any]:
    from scranton_pipeline.nodes.parallel import remove_lane, workspace_bytes
    from scranton_pipeline.tools.git import WorkspaceRepo
    from scranton_pipeline.tools.sandbox import build_sandbox
    pending = [c for c in criteria if c["state"] == "met_not_demonstrated"]
    if not pending:
        return {"status": "not_needed"}
    if deps.cfg.grounding.counterfactual == "off":
        return {"status": "off"}
    checks = [c for c in deps.cfg.checks if c.kind == "test" and any(c.id in r["checks"] for r in pending)]
    workspace = deps.workspace.with_name(deps.workspace.name + "-probe")
    try:
        changes = deps.repo().changed_files(state["workspace"]["base_commit"], state["workspace"]["head_commit"])
        tests = [p for _, p in changes if matches(p, deps.cfg.grounding.test_globs)]
        others = [p for _, p in changes if p not in tests]
        if not tests or not others or not checks:
            return {"status": "not_needed"}
        if deps.stop.should_stop():
            return {"status": "inconclusive", "checks": [c.id for c in checks]}
        if workspace_bytes(deps.workspace) > deps.cfg.execution.max_lane_workspace_bytes:
            return {"status": "inconclusive", "checks": [c.id for c in checks]}
        remove_lane(workspace)
        shutil.copytree(deps.workspace, workspace, ignore=lambda _, names: [n for n in names if n.casefold() in {".git", ".pipeline"}])
        repo = deps.repo()
        base = state["workspace"]["base_commit"]
        existing = {p for p in repo._run(["ls-tree", "-rz", "--name-only", base]).split("\0") if p}
        git_dir = deps.run_dir / "probe-git"
        remove_lane(git_dir)
        shutil.copytree(repo.git_dir, git_dir)
        private_repo = WorkspaceRepo(workspace, git_dir, timeout_s=deps.cfg.limits.git_timeout_s)
        box = build_sandbox(deps.cfg.sandbox, workspace=workspace, run_id=deps.run_dir.name, trust_host=deps.trust_host,
            name_suffix="probe", state_dir=deps.run_dir / "sandbox-state")
        start = time.monotonic()
        def execute(control: bool) -> set[str] | None:
            failed: set[str] = set()
            for c in checks:
                remaining = deps.cfg.limits.max_active_seconds - state.get("active_seconds", 0) - (time.monotonic() - start)
                if remaining <= 0 or deps.stop.should_stop():
                    return None
                r = box.run(c.argv, timeout_s=min(c.timeout_s, remaining), stop=deps.stop, writable_state=False,
                    log_path=deps.run_dir / "artifacts" / "logs" / f"probe-{'control' if control else 'restored'}-{c.id}.log",
                    tail_bytes=deps.cfg.limits.max_output_tail_bytes, max_log_bytes=deps.cfg.limits.max_log_bytes)
                if r.timed_out or r.stopped or r.exit_code is None:
                    return None
                if r.exit_code != 0:
                    failed.add(c.id)
            return failed
        if execute(True) != set():
            return {"status": "inconclusive", "checks": [c.id for c in checks]}
        private_repo.reset_hard(state["workspace"]["head_commit"])
        restore = [p for p in others if p in existing]
        if restore:
            spec = deps.run_dir / "probe-pathspec"
            write_bytes_atomic(spec, b"".join(p.encode() + b"\0" for p in restore))
            private_repo._run(["--literal-pathspecs", "restore", "--source=" + base, "--staged", "--worktree", "--pathspec-from-file=" + str(spec), "--pathspec-file-nul"])
            spec.unlink(missing_ok=True)
        for path in others:
            if path not in existing:
                (workspace / path).unlink(missing_ok=True)
        failed = execute(False)
        if failed is None:
            return {"status": "inconclusive", "checks": [c.id for c in checks]}
        for criterion in pending:
            if failed.intersection(criterion["checks"]):
                criterion.update(state="demonstrated", by="probe")
        return {"status": "demonstrated" if failed else "not_demonstrated", "checks": [c.id for c in checks]}
    except Exception:  # noqa: BLE001 - a probe is never a run failure
        return {"status": "inconclusive", "checks": [c.id for c in checks]}
    finally:
        # run() removes its own Docker container; cleanup() would also kill main-run containers.
        try:
            remove_lane(workspace)
            remove_lane(deps.run_dir / "probe-git")
        except OSError:
            pass


def ground(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    identity = digest({"head": state["workspace"]["head_commit"], "plan": state.get("plan_digest"), "review": state.get("review")})
    path = deps.run_dir / "artifacts" / "grounding.json"
    if path.exists():
        receipt = json.loads(path.read_text())
        if receipt.get("identity") == identity:
            return {}
    started = time.monotonic()
    previous = next((r for r in reversed(_rows(deps.run_dir / "grounding.jsonl")) if r.get("identity") == identity), None)
    if previous is None:
        criteria = decide_criteria(state, deps)
        result = probe(state, deps, criteria)
        append_trace(deps.run_dir, {"type": "criteria", "identity": identity, "criteria": criteria, "probe": result,
            "mode": deps.cfg.grounding.mode, "weights": deps.cfg.grounding.weights.model_dump()})
    else:
        criteria, result = previous["criteria"], previous["probe"]
    summary = recompute_summary(deps.run_dir)
    write_bytes_atomic(path, json.dumps({"identity": identity, **summary}).encode())
    deps.events.emit("criteria_decided", states={s: sum(c["state"] == s for c in criteria) for s in sorted({c["state"] for c in criteria})})
    deps.events.emit("probe_finished", status=result["status"], checks=result.get("checks", []))
    if deps.stop.cancel_requested():
        return {"outcome": "cancelled"}
    if state.get("active_seconds", 0) + time.monotonic() - started >= deps.cfg.limits.max_active_seconds:
        raise EngineError(FailureClass.LIMIT, "run_time_exhausted", "Active run time exhausted")
    return {}

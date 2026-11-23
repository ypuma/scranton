"""Bundled, offline addition bug and scripted role responses."""
import sys
import uuid
from pathlib import Path
from typing import Any

from scranton_pipeline.config import EngineConfig
from scranton_pipeline.nodes.workflow import json_write

PLAN = {"kind": "plan", "plan": {"summary": "Fix addition", "acceptance_criteria": [
    {"id": "sum", "text": "add(2, 3) returns 5 and tests pass", "verified_by": "checks", "checks": ["unit"]}],
    "steps": [{"id": "fix", "title": "Correct addition", "description": "Replace subtraction with addition",
               "files": [{"path": "calculator.py", "action": "modify"}], "criteria": ["sum"]}]}}
EDIT = {"kind": "edits", "summary": "Correct arithmetic", "edits": [{"path": "calculator.py", "action": "modify",
        "replacements": [{"search": "return a - b", "replace": "return a + b"}]}]}
REVIEW = {"verdict": "approve", "summary": "Addition corrected and verified", "criteria": [
    {"id": "sum", "status": "met", "evidence": "Unit tests pass"}], "findings": []}


def config(run_dir: Path, *, sandbox: str = "scranton", image: str | None = None, scenario: str = "basic", windows_mode: str = "low") -> EngineConfig:
    return EngineConfig.model_validate({"models": {role: {"provider": "scripted", "model": "demo",
        "script_path": str(run_dir / "artifacts" / f"{role}.json")} for role in ("planner", "implementer", "reviewer")},
        "sandbox": {"mode": sandbox, "windows_mode": windows_mode, "docker": {"image": image}}, "checks": [{"id": "unit", "kind": "test", "argv": ["python" if sandbox == "docker" else sys.executable, "-m", "unittest", "-q"], "timeout_s": 30}],
        "approvals": {"plan": "always"}, "execution": {"max_parallel_steps": 2 if scenario == "parallel" else 1}})


def materialize(run_dir: Path, scenario: str = "basic") -> None:
    source = run_dir / "demo-source"
    source.mkdir()
    (source / "calculator.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
    (source / "test_calculator.py").write_text("import unittest\nfrom calculator import add\n\nclass Addition(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n", encoding="utf-8")
    if scenario == "parallel":
        (source / "multiplier.py").write_text("def multiply(a, b):\n    return a + b\n", encoding="utf-8")
        (source / "test_multiplier.py").write_text("import unittest\nfrom multiplier import multiply\n\nclass Multiplication(unittest.TestCase):\n    def test_multiply(self):\n        self.assertEqual(multiply(2, 3), 6)\n", encoding="utf-8")
    from scranton_pipeline.tools.git import WorkspaceRepo
    WorkspaceRepo.init(source).commit_all("Demo fixture")
    import copy
    plan: Any = copy.deepcopy(PLAN)
    review: Any = copy.deepcopy(REVIEW)
    scripts: dict[str, Any] = {"planner": [plan], "implementer": [EDIT], "reviewer": [review]}
    if scenario == "replan":
        scripts.update(planner=[plan, plan], implementer=[{"kind": "blocked", "blocked_reason": "The initial approach does not account for the arithmetic contract; revise the remaining work."}, EDIT])
    elif scenario == "parallel":
        plan["plan"]["summary"] = "Correct independent addition and multiplication bugs"
        plan["plan"]["steps"][0]["depends_on"] = []
        plan["plan"]["steps"].append({"id": "multiply", "title": "Correct multiplication", "description": "Use multiplication rather than addition", "files": [{"path": "multiplier.py", "action": "modify"}], "criteria": ["product"], "depends_on": []})
        plan["plan"]["acceptance_criteria"].append({"id": "product", "text": "multiply(2, 3) returns 6", "verified_by": "checks", "checks": ["unit"]})
        review["criteria"].append({"id": "product", "status": "met", "evidence": "Final unit tests pass"})
        scripts["implementer"] = {"step:fix": [EDIT], "step:multiply": [{"kind": "edits", "edits": [{"path": "multiplier.py", "action": "modify", "replacements": [{"search": "return a + b", "replace": "return a * b"}]}]}]}
    reads: dict[str, Any] = {"kind": "need_context", "context_requests": [{"kind": "read", "path": f["path"]} for step in plan["plan"]["steps"] for f in step["files"]]}
    if scenario == "basic":
        reads["context_requests"].extend([{"kind": "search", "query": "add", "path": ""}, {"kind": "list", "path": ""}])
    scripts["planner"] = [value for answer in scripts["planner"] for value in (reads, answer)]
    if scenario == "evidence":
        plan["plan"]["acceptance_criteria"].append({"id": "syntax", "text": "Python files compile", "verified_by": "checks", "checks": ["syntax"]})
        plan["plan"]["steps"][0]["criteria"].append("syntax")
        scripts["planner"] = [plan, plan]
        scripts["implementer"] = [{"kind": "blocked", "blocked_reason": "Addition symbol is missing", "blocked_claim": {"kind": "missing_symbol", "subject": "add", "paths": ["calculator.py"]}}, EDIT]
    if scenario == "answer":
        from scranton_pipeline.grounding import context_id
        from scranton_pipeline.models import ContextRequest
        from scranton_pipeline.tools.fs import read_text, sha256_file
        request = ContextRequest(kind="read", path="calculator.py").model_dump(mode="json")
        ident = context_id({"request": request, "sha256": sha256_file(source / "calculator.py"), "content": read_text(source / "calculator.py", 1000000)[0], "ok": True, "truncated": False})
        scripts["planner"] = [{"kind": "need_context", "rationale": "Read the arithmetic implementation.", "context_requests": [request]}, {"kind": "answer", "answer": {"text": "add(a, b) currently returns a - b: it subtracts rather than adds.", "citations": [ident]}}]
    review["criteria"] = []
    for role, responses in scripts.items():
        json_write(run_dir / "artifacts" / f"{role}.json", responses)


def run_demo(run_root: Path, *, run_id: str | None = None, workspace_root: Path | None = None,
             delivery: str = "patch", guarded: bool = False, sandbox: str = "scranton", image: str | None = None, scenario: str = "basic", grounding: str = "enforce", guidance: bool = False, conversation: bool = False, windows_mode: str = "low") -> Any:
    from scranton_pipeline.runner import start
    if scenario == "evidence" and grounding != "enforce":
        from scranton_pipeline.runner import invalid
        raise invalid("invalid_demo_grounding", "Evidence demo requires grounding enforce")
    if scenario == "answer" and not conversation:
        from scranton_pipeline.runner import invalid
        raise invalid("conversation_required", "Answer demo requires conversation mode")
    run_id = run_id or uuid.uuid4().hex[:12]
    run_dir = (run_root / run_id).resolve()
    cfg = config(run_dir, sandbox=sandbox, image=image, scenario=scenario, windows_mode=windows_mode)
    cfg = cfg.model_copy(update={"conversation": conversation, "grounding": cfg.grounding.model_copy(update={"mode": grounding}), "procedure": cfg.procedure.model_copy(update={"enabled": guidance})})
    if scenario == "parallel":
        from scranton_pipeline.config import CheckConfig
        cfg = cfg.model_copy(update={"checks": [CheckConfig(id="syntax", kind="syntax", argv=["python" if sandbox == "docker" else sys.executable, "-m", "compileall", "-q", "."]), cfg.checks[0].model_copy(update={"scope": "final"})]})
    if scenario == "evidence":
        from scranton_pipeline.config import CheckConfig
        cfg = cfg.model_copy(update={"checks": [*cfg.checks, CheckConfig(id="syntax", kind="syntax", argv=["python" if sandbox == "docker" else sys.executable, "-m", "compileall", "-q", "."])]})
    return start(source=run_dir / "demo-source", task="What does add(a, b) currently do?" if scenario == "answer" else "Fix independent arithmetic bugs so the unit tests pass." if scenario == "parallel" else "Fix addition so the unit test passes.", cfg=cfg,
                 run_root=run_root, run_id=run_id, workspace_root=workspace_root, delivery=delivery,
                 trust_host=True, demo=True, demo_scenario=scenario, guarded=guarded)

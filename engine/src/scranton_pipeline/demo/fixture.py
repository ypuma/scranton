"""Bundled, offline addition bug and scripted role responses."""
import sys
import uuid
from pathlib import Path
from typing import Any

from scranton_pipeline.config import EngineConfig
from scranton_pipeline.nodes.workflow import json_write

PLAN = {"kind": "plan", "plan": {"summary": "Fix addition", "acceptance_criteria": [
    {"id": "sum", "text": "add(2, 3) returns 5 and tests pass", "verified_by": "checks"}],
    "steps": [{"id": "fix", "title": "Correct addition", "description": "Replace subtraction with addition",
               "files": [{"path": "calculator.py", "action": "modify"}], "criteria": ["sum"]}]}}
EDIT = {"kind": "edits", "summary": "Correct arithmetic", "edits": [{"path": "calculator.py", "action": "modify",
        "replacements": [{"search": "return a - b", "replace": "return a + b"}]}]}
REVIEW = {"verdict": "approve", "summary": "Addition corrected and verified", "criteria": [
    {"id": "sum", "status": "met", "evidence": "Unit tests pass"}], "findings": []}


def config(run_dir: Path) -> EngineConfig:
    return EngineConfig.model_validate({"models": {role: {"provider": "scripted", "model": "demo",
        "script_path": str(run_dir / "artifacts" / f"{role}.json")} for role in ("planner", "implementer", "reviewer")},
        "sandbox": {"mode": "host"}, "checks": [{"id": "unit", "kind": "test", "argv": [sys.executable, "-m", "unittest", "-q"], "timeout_s": 30}],
        "approvals": {"plan": "always"}})


def materialize(run_dir: Path) -> None:
    source = run_dir / "demo-source"
    source.mkdir()
    (source / "calculator.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
    (source / "test_calculator.py").write_text("import unittest\nfrom calculator import add\n\nclass Addition(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n", encoding="utf-8")
    from scranton_pipeline.tools.git import WorkspaceRepo
    WorkspaceRepo.init(source).commit_all("Demo fixture")
    for role, response in (("planner", PLAN), ("implementer", EDIT), ("reviewer", REVIEW)):
        json_write(run_dir / "artifacts" / f"{role}.json", [response])


def run_demo(run_root: Path, *, run_id: str | None = None, workspace_root: Path | None = None,
             delivery: str = "patch", guarded: bool = False) -> Any:
    from scranton_pipeline.runner import start
    run_id = run_id or uuid.uuid4().hex[:12]
    run_dir = (run_root / run_id).resolve()
    return start(source=run_dir / "demo-source", task="Fix addition so the unit test passes.", cfg=config(run_dir),
                 run_root=run_root, run_id=run_id, workspace_root=workspace_root, delivery=delivery,
                 trust_host=True, demo=True, guarded=guarded)

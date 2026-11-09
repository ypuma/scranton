import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scranton_pipeline.demo.fixture import EDIT, PLAN, REVIEW, config

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def case(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "calculator.py").write_text("def add(a, b):\n    return a - b\n")
    (source / "test_calculator.py").write_text("import unittest\nfrom calculator import add\nclass Check(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n")
    from scranton_pipeline.tools.git import WorkspaceRepo
    WorkspaceRepo.init(source).commit_all("Test fixture")
    scripts = {}
    for role, turn in (("planner", PLAN), ("implementer", EDIT), ("reviewer", REVIEW)):
        path = tmp_path / f"{role}.json"
        path.write_text(json.dumps([turn]))
        scripts[role] = str(path)
    cfg = config(tmp_path).model_dump(mode="json", by_alias=True)
    for role, path in scripts.items():
        cfg["models"][role]["script_path"] = path
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(cfg))
    return {"source": source, "config": cfg_path, "cfg": cfg, "root": tmp_path / "runs", "tmp": tmp_path}


def cli(*args, env=None, stdin=subprocess.DEVNULL):
    environment = {**os.environ, "PYTHONPATH": str(ROOT / "engine" / "src"),
                   "PYTHONPYCACHEPREFIX": str(ROOT / ".scratch" / "pipeline" / "bytecode"),
                   "TEMP": str(ROOT / ".scratch" / "pipeline" / "tmp"),
                   "TMP": str(ROOT / ".scratch" / "pipeline" / "tmp"),
                   "TMPDIR": str(ROOT / ".scratch" / "pipeline" / "tmp"), **(env or {})}
    process = subprocess.run([sys.executable, "-m", "scranton_pipeline", *map(str, args)], env=environment,
                             check=False, capture_output=True, text=True, timeout=90, stdin=stdin)
    assert len(process.stdout.splitlines()) == 1, (process.returncode, process.stdout, process.stderr)
    return process.returncode, json.loads(process.stdout)


def begin(case, *, delivery="patch"):
    case["config"].write_text(json.dumps(case["cfg"]))
    return cli("run", "--source", case["source"], "--task", "Fix addition", "--config", case["config"],
               "--run-root", case["root"], "--run-id", "test0001", "--delivery", delivery, "--trust-host")


def decision(case, status, choice="approve"):
    return cli("resume", "--run-dir", case["root"] / "test0001", "--gate", status["pending"]["gate"],
               "--digest", status["pending"]["digest"], "--decision", choice, "--trust-host")


def script(case, role, turns):
    Path(case["cfg"]["models"][role]["script_path"]).write_text(json.dumps(turns))

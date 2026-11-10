"""R5 full-process recovery and integration ordering regressions."""
import copy
import os
import subprocess
import sys
from pathlib import Path

import pytest

from .conftest import begin, cli, decision, script
from .test_parallel import edit, events, report, setup


def test_crash_mid_merge_then_resume_without_duplicate_commits(case):
    setup(case)
    _, status = begin(case)
    hook = case["tmp"] / "merge-crash.py"
    hook.write_text('''import os,sys
from scranton_pipeline.nodes import parallel
from scranton_pipeline.cli import main
original=parallel.write_bytes_atomic
def crash(path,data):
    original(path,data)
    if path.name == 'other.py': os._exit(91)
parallel.write_bytes_atomic=crash
raise SystemExit(main(sys.argv[1:]))
''')
    directory = case["root"] / "test0001"
    proc = subprocess.run([sys.executable, str(hook), "resume", "--run-dir", str(directory), "--trust-host",
        "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]],
        env=os.environ, capture_output=True, timeout=60, check=False)
    assert proc.returncode == 91, proc.stderr
    assert not (directory / "artifacts" / "wave-1.json").exists()
    code, stopped = cli("status", "--run-dir", directory)
    assert code == 5 and stopped["progress"]["steps_done"] == 0
    code, status = cli("resume", "--run-dir", directory, "--trust-host")
    assert code == 0 and status["progress"]["steps_done"] == 2, status
    from scranton_pipeline.tools.git import WorkspaceRepo
    repo = WorkspaceRepo(directory / "workspace", directory / "git")
    subjects = repo._run(["log", "--format=%s"]).splitlines()
    assert subjects.count("Pipeline merge step:fix") == subjects.count("Pipeline merge step:other") == 1
    assert len(report(status)["steps"]) == 2
    assert not any(e["type"] == "warning" and e["data"].get("code") == "check_modified_tracked" for e in events(case))
    routes = [e["data"] for e in events(case) if e["type"] == "route" and e["data"].get("lane") and e["data"]["from"] == "verify"]
    assert len(routes) == 2 and all(r["to"] == "lane_finish" for r in routes)


@pytest.mark.parametrize("replans", [0, 1])
def test_failed_integration_rolls_back_unverified_steps(case, replans):
    plan = setup(case)
    case["cfg"]["limits"]["max_replans"] = replans
    case["cfg"]["checks"].append({"id": "coupled", "kind": "test", "scope": "final", "argv": [sys.executable, "-c", "from other import VALUE; assert VALUE == 2"]})
    script(case, "planner", [plan, plan])
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a,b):\n    return a+b\n")],
        "step:other": [edit("other.py", "VALUE = 1\n")], "int:1": [edit("other.py", "VALUE = 3\n")]})
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == (3 if replans else 4), status
    assert status["progress"]["steps_done"] == 0
    directory = case["root"] / "test0001"
    assert "a - b" in (directory / "workspace" / "calculator.py").read_text()
    assert (directory / "workspace" / "other.py").read_text() == "VALUE = 0\n"
    if not replans:
        assert Path(status["artifacts"]["diff"]).read_text() == ""
        assert not report(status)["steps"]


def test_partial_wave_integrates_before_replan_and_brief_names_failed_lane(case):
    plan = setup(case, cap=3)
    case["cfg"]["limits"]["max_replans"] = 1
    (case["source"] / "third.py").write_text("VALUE = 0\n")
    plan["plan"]["steps"].append({**copy.deepcopy(plan["plan"]["steps"][1]), "id": "third",
        "files": [{"path": "third.py", "action": "modify"}]})
    revised = copy.deepcopy(plan)
    revised["plan"]["steps"] = [revised["plan"]["steps"][1]]
    script(case, "planner", [plan, revised])
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a,b):\n    return a+b\n")],
        "step:other": [edit("other.py", "VALUE = -1\n")], "step:third": [edit("third.py", "VALUE = 1\n")]})
    probe = "from pathlib import Path; p=Path.cwd(); assert 'VALUE = -1' not in Path('other.py').read_text(), 'FAILED LANE SENTINEL'"
    case["cfg"]["checks"][0]["argv"] = [sys.executable, "-c", probe]
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 3 and status["progress"]["steps_done"] == 2, status
    from scranton_pipeline.config import EngineConfig
    from scranton_pipeline.graph import build_graph
    from scranton_pipeline.runner import dependencies
    directory = case["root"] / "test0001"
    with dependencies(directory, EngineConfig.model_validate(case["cfg"]), trust_host=True, models=False) as deps:
        state = build_graph(deps).get_state({"configurable": {"thread_id": "test0001"}}).values
    brief = state["replan_brief"]
    assert brief["failed_step"]["id"] == "other"
    assert brief["reason"].startswith("checks_exhausted:")
    assert "FAILED LANE SENTINEL" in brief["checks"][0]["output_tail"]
    rows = events(case)
    start = next(i for i, e in enumerate(rows) if e["type"] == "wave_merged")
    end = next(i for i, e in enumerate(rows) if e["type"] == "replanned")
    assert any(e["type"] == "check_finished" and "lane" not in e["data"] for e in rows[start:end])
    requested = [e["data"] for e in rows if e["type"] == "replan_requested" and "lane" not in e["data"]]
    assert requested[-1]["scope"] == "step:other"


def test_workspace_junction_falls_back_to_sequential(case):
    if os.name != "nt":
        pytest.skip("Windows junction regression")
    setup(case)
    # A baseline check may create normal dependency links after the safe snapshot.
    directory = case["root"] / "test0001"
    _, status = begin(case)
    target = case["tmp"] / "dependency"
    target.mkdir()
    link = directory / "workspace" / "dependency-link"
    proc = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, check=False)
    assert proc.returncode == 0, proc.stderr
    code, status = decision(case, status)
    assert code == 0, status
    rows = events(case)
    assert not any(e["type"] == "wave_started" for e in rows)
    assert sum(e["type"] == "warning" and e["data"].get("code") == "parallel_unavailable" for e in rows) == 1


def test_resume_removes_stale_provider_scratch_and_finalize_cleans(case):
    _, status = begin(case)
    directory = case["root"] / "test0001"
    stale = directory / "tmp" / "provider" / "call-old"
    stale.mkdir(parents=True)
    (stale / "request.json").write_text("PRIVATE PROMPT")
    code, status = decision(case, status)
    assert code == 0, status
    assert not stale.exists()

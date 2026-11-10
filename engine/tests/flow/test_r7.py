"""Real Windows-sized Git lists and crash-after-rollback replay."""
import os
import subprocess
import sys

import pytest

from .conftest import begin, cli, decision, script
from .test_parallel import edit, events, setup


def test_parallel_wave_with_2000_long_tracked_names(case):
    setup(case)
    for i in range(2000):
        (case["source"] / (f"file-{i:04}-" + "long-name-" * 6 + ".txt")).write_text("tracked\n")
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0 and status["progress"]["steps_done"] == 2, status
    assert sum(e["type"] == "lane_started" for e in events(case)) == 2


def test_crash_after_integration_reset_checks_recorded_tree_on_resume(case):
    setup(case)
    case["cfg"]["checks"] = [case["cfg"]["checks"][0], {"id": "coupled", "kind": "test", "scope": "final",
        "argv": [sys.executable, "-c", "from pathlib import Path; assert Path('other.py').read_text() == 'VALUE = 0\\n'"]}]
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a,b):\n    return a+b\n")],
        "step:other": [edit("other.py", "VALUE = 1\n")], "int:1": [edit("other.py", "VALUE = 2\n")]})
    _, status = begin(case)
    hook = case["tmp"] / "rollback-crash.py"
    hook.write_text('''import os,sys
from scranton_pipeline.nodes import parallel
from scranton_pipeline.cli import main
original=parallel.rollback_integration
def crash(state,deps):
    result=original(state,deps)
    if result: os._exit(91)
    return result
parallel.rollback_integration=crash
raise SystemExit(main(sys.argv[1:]))
''')
    directory = case["root"] / "test0001"
    proc = subprocess.run([sys.executable, str(hook), "resume", "--run-dir", str(directory), "--trust-host",
        "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]],
        env=os.environ, capture_output=True, timeout=90, check=False)
    assert proc.returncode == 91, proc.stderr
    assert (directory / "workspace" / "other.py").read_text() == "VALUE = 0\n"
    code, status = cli("resume", "--run-dir", directory, "--trust-host")
    assert code == 4 and status["status"] == "failed" and status["progress"]["steps_done"] == 0, status
    assert status["failure"]["code"] == "checks_exhausted"
    assert status["checks"][-1]["status"] == "failed"


@pytest.mark.parametrize("replans", [0, 1])
def test_lane_failure_decision_event_emitted_once(case, replans):
    plan = setup(case)
    case["cfg"]["limits"]["max_replans"] = replans
    script(case, "planner", [plan, plan])
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a,b):\n    return a+b\n")],
        "step:other": [{"kind": "blocked", "blocked_reason": "Need a new plan"}]})
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == (3 if replans else 4), status
    decisions = [e for e in events(case) if e["type"] in {"failure", "replan_requested"}]
    assert len(decisions) == 1 and "lane" not in decisions[0]["data"]
    assert decisions[0]["type"] == ("replan_requested" if replans else "failure")

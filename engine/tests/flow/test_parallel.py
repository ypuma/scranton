"""Real private Git trees, subprocess checks, separate-process gates and crash recovery."""
import copy
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from scranton_pipeline.demo.fixture import PLAN

from .conftest import begin, cli, decision, script


def edit(path, value):
    return {"kind": "edits", "edits": [{"path": path, "action": "modify", "content": value}]}


def setup(case, *, cap=2):
    (case["source"] / "other.py").write_text("VALUE = 0\n")
    plan = copy.deepcopy(PLAN)
    plan["plan"]["steps"][0]["depends_on"] = []
    plan["plan"]["steps"].append({"id": "other", "title": "Fix independent value", "description": "Correct value", "files": [{"path": "other.py", "action": "modify"}], "criteria": ["sum"], "depends_on": []})
    script(case, "planner", [plan])
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a, b):\n    return a + b\n")], "step:other": [edit("other.py", "VALUE = 1\n")]})
    case["cfg"]["execution"] = {"max_parallel_steps": cap}
    case["cfg"]["checks"] = [{"id": "syntax", "kind": "syntax", "argv": [sys.executable, "-m", "compileall", "--invalidation-mode", "checked-hash", "-q", "."]}, {**case["cfg"]["checks"][0], "scope": "final"}]
    case["cfg"]["limits"] = {"max_step_attempts": 1, "max_replans": 0}
    return plan


def events(case):
    return [json.loads(row) for row in (case["root"] / "test0001" / "events.jsonl").read_text().splitlines()]


def report(status):
    return json.loads(Path(status["artifacts"]["report_json"]).read_text())


def test_parallel_overlap_order_integration_and_progress(case):
    # Guards Send fan-out, LaneOutput isolation, parent-only status writes and plan-order merge.
    setup(case)
    marker = case["tmp"] / "overlap"
    marker.mkdir()
    probe = """from pathlib import Path
import time
p=Path.cwd()
if '-l1-' in p.name:
    slot=p.name.rsplit('-',1)[1]
    root=Path(MARKER)
    (root/slot).touch()
    until=time.monotonic()+8
    while not (root/str(1-int(slot))).exists() and time.monotonic()<until: time.sleep(.02)
    assert (root/str(1-int(slot))).exists(), 'lanes did not overlap'
""".replace("MARKER", repr(str(marker)))
    case["cfg"]["checks"][0]["argv"] = [sys.executable, "-c", probe]
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    assert sorted(p.name for p in marker.iterdir()) == ["0", "1"]
    data = report(status)
    assert [s["step_id"] for s in data["steps"]] == ["step:fix", "step:other"]
    assert data["waves"] == [{"number": 1, "merged": ["fix", "other"], "failed": []}]
    assert status["progress"]["steps_done"] == 2 and status["progress"]["lanes"] == []
    diff = Path(status["artifacts"]["diff"]).read_text()
    assert "+VALUE = 1" in diff and "+    return a + b" in diff
    rows = events(case)
    assert {"wave_started", "lane_started", "lane_finished", "wave_merged"} <= {e["type"] for e in rows}
    assert {e["data"]["lane"] for e in rows if e["type"] == "lane_finished"} == {"fix", "other"}
    assert sum(e["node"] == "merge_wave" and e["type"] == "node_finished" for e in rows) == 1
    merged_at = next(i for i, e in enumerate(rows) if e["type"] == "wave_merged")
    review_at = next(i for i, e in enumerate(rows) if e["type"] == "node_started" and e["node"] == "review")
    assert any(e["type"] == "check_finished" and "lane" not in e["data"] for e in rows[merged_at:review_at])
    assert "## Waves" in Path(status["artifacts"]["report_md"]).read_text()
    assert not list((case["root"] / "test0001").glob("workspace-l*"))
    assert "a - b" in (case["source"] / "calculator.py").read_text()


@pytest.mark.parametrize("cap", [1, 2])
def test_cap_one_and_overlapping_files_use_sequential_path(case, cap):
    # Guards select_step len(indices)>1 and wave occupied-file check.
    plan = setup(case, cap=cap)
    if cap == 2:
        plan["plan"]["steps"][1]["files"][0]["path"] = "calculator.py"
        script(case, "planner", [plan])
        second = edit("calculator.py", "# documented\ndef add(a, b):\n    return a + b\n")
        script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a, b):\n    return a + b\n")], "step:other": [second]})
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    assert not any(e["type"] == "wave_started" for e in events(case))
    assert status["progress"]["steps_done"] == 2


@pytest.mark.parametrize("replans", [0, 1])
@pytest.mark.parametrize("failure", ["blocked", "checks", "scope", "security"])
def test_partial_wave_failure_preserves_passed_lane(case, replans, failure):
    # Guards merge_wave passed-first merging, terminal classification, strict lane policy.
    plan = setup(case)
    case["cfg"]["limits"]["max_replans"] = replans
    turn = {"kind": "blocked", "blocked_reason": "Need another plan"}
    if failure == "checks":
        turn = edit("other.py", "VALUE = -1\n")
        case["cfg"]["checks"][0]["argv"] = [sys.executable, "-c", "from pathlib import Path; assert 'VALUE = -1' not in Path('other.py').read_text()"]
    elif failure == "scope":
        turn = edit("calculator.py", "def add(a,b):\n    return 99\n")
    elif failure == "security":
        turn = {"kind": "edits", "edits": [{"path": "../escape.py", "action": "create", "content": "x=1\n"}]}
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a,b):\n    return a + b\n")], "step:other": [turn]})
    revised = copy.deepcopy(plan)
    revised["plan"]["steps"] = [revised["plan"]["steps"][1]]
    script(case, "planner", [plan, revised])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == (3 if replans and failure != "security" else 4), status
    workspace = case["root"] / "test0001" / "workspace"
    assert "a + b" in (workspace / "calculator.py").read_text()
    assert (workspace / "other.py").read_text() == "VALUE = 0\n"
    assert status["progress"]["steps_done"] == 1
    assert not list(workspace.parent.glob("workspace-l*"))
    assert not (workspace.parent / "escape.py").exists()
    if code == 3:
        assert status["progress"]["lanes"] == [] and status["pending"]["revision"] == 1
    else:
        assert status["failure"]["failure_class"] == ("security" if failure == "security" else "checks_failed" if failure == "checks" else "implementation")


@pytest.mark.parametrize("repair,replans", [(True, 0), (False, 0), (False, 1)])
def test_integration_failure_repair_or_replan(case, repair, replans):
    # Guards verify integration scope/counter and apply_edits union-of-wave declared paths.
    plan = setup(case)
    case["cfg"]["limits"]["max_replans"] = replans
    case["cfg"]["checks"].append({"id": "coupled", "kind": "test", "scope": "final", "argv": [sys.executable, "-c", "from other import VALUE; assert VALUE == 2"]})
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a,b):\n    return a+b\n")], "step:other": [edit("other.py", "VALUE = 1\n")], "int:1": [edit("other.py", "VALUE = 2\n" if repair else "VALUE = 3\n")]})
    script(case, "planner", [plan, plan])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == (0 if repair else 3 if replans else 4), status
    assert any(e["type"] == "route" and e["data"]["reason"] == "integration_failed" for e in events(case))
    assert status["progress"]["steps_done"] == (2 if repair else 0)


def test_oversized_workspace_falls_back_once(case):
    # Guard select_step workspace_bytes comparison BEFORE Send dispatch.
    setup(case)
    case["cfg"]["execution"]["max_lane_workspace_bytes"] = 1
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    rows = events(case)
    assert not any(e["type"] == "wave_started" for e in rows)
    assert sum(e["type"] == "warning" and e["data"].get("code") == "lane_workspace_too_large" for e in rows) == 1


@pytest.mark.parametrize("scenario", ["basic", "replan", "parallel", "evidence"])
def test_demo_scenarios_separate_processes(tmp_path, scenario):
    # Guards CLI scenario -> fixture selection, independent steps and scoped scripts.
    root = tmp_path / "demos"
    code, status = cli("demo", "--sandbox", "host", "--scenario", scenario, "--run-root", root, "--run-id", "demo0001")
    assert code == 3, status
    for _ in range(3):
        code, status = cli("resume", "--run-dir", root / "demo0001", "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"], "--trust-host")
        if code != 3:
            break
    assert code == 0 and status["status"] == "succeeded", status


def test_crash_after_peer_finished_resumes_only_unfinished_inner_node(case):
    # Guards compiled subgraph node + inherited checkpointer + sync durability, scoped cursor.
    setup(case)
    _, status = begin(case)
    hook = case["tmp"] / "crash.py"
    hook.write_text('''import os,sys,time,json
from scranton_pipeline.nodes import workflow
from scranton_pipeline.cli import main
original=workflow.implement
def crash(state,deps):
    if state.get('lane',{}).get('step_id') == 'other':
        until=time.monotonic()+20
        while time.monotonic()<until:
            rows=[json.loads(s) for s in deps.events.path.read_text().splitlines()]
            if any(r['type']=='lane_finished' and r['data']['lane']=='fix' for r in rows):
                time.sleep(.5)
                os._exit(91)
            time.sleep(.02)
        raise RuntimeError('peer did not finish')
    return original(state,deps)
workflow.implement=crash
raise SystemExit(main(sys.argv[1:]))
''')
    run_dir = case["root"] / "test0001"
    proc = subprocess.run([sys.executable, str(hook), "resume", "--run-dir", str(run_dir), "--trust-host", "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]], env=os.environ, capture_output=True, timeout=45, check=False)
    assert proc.returncode == 91, proc.stderr
    code, status = cli("status", "--run-dir", run_dir)
    assert status["status"] == "suspended"
    code, status = cli("resume", "--run-dir", run_dir, "--trust-host")
    assert code == 0, status
    rows = events(case)
    assert sum(e["type"] == "lane_started" and e["data"]["lane"] == "other" for e in rows) == 1
    assert sum(e["type"] == "lane_finished" and e["data"]["lane"] == "fix" for e in rows) == 1
    ledger = [json.loads(s) for s in (run_dir / "usage.jsonl").read_text().splitlines()]
    assert sum(r.get("scope") == "step:fix" for r in ledger) == 1


@pytest.mark.parametrize("stop", ["cancel", "eof"])
def test_stop_during_wave_then_cleanup_or_resume(case, stop):
    # Guards StopSignal shared by lanes, parent-only progress, namespace resume and cleanup_lanes.
    setup(case)
    marker = case["tmp"] / "running"
    marker.mkdir()
    probe = f"""from pathlib import Path
import time
p=Path.cwd()
root=Path({str(marker)!r})
if '-l1-' in p.name:
    (root/p.name).touch()
    until=time.monotonic()+20
    while not (root/'release').exists() and time.monotonic()<until: time.sleep(.05)
"""
    case["cfg"]["checks"][0]["argv"] = [sys.executable, "-c", probe]
    _, status = begin(case)
    run_dir = case["root"] / "test0001"
    args = [sys.executable, "-m", "scranton_pipeline", "resume", "--run-dir", str(run_dir), "--trust-host", "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]]
    if stop == "eof":
        args.append("--parent-guard")
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        until = time.monotonic() + 25
        while len(list(marker.iterdir())) < 2 and time.monotonic() < until and proc.poll() is None:
            time.sleep(.05)
        assert len(list(marker.iterdir())) == 2
        public = json.loads((run_dir / "status.json").read_text())
        assert public["node"] == "select_step" and len(public["progress"]["lanes"]) == 2
        if stop == "cancel":
            cli("cancel", "--run-dir", run_dir)
        else:
            proc.stdin.close()
            proc.stdin = None
        stdout, stderr = proc.communicate(timeout=25)
        result = json.loads(stdout)
        assert proc.returncode == (6 if stop == "cancel" else 5), (stdout, stderr)
        assert result["status"] == ("cancelled" if stop == "cancel" else "suspended")
        if stop == "eof":
            (marker / "release").touch()
            code, result = cli("resume", "--run-dir", run_dir, "--trust-host")
            assert code == 0, result
        assert not list(run_dir.glob("workspace-l*"))
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()


def test_replan_after_wave_renames_dependencies_and_completes(case):
    # Guards planner.plan's renamed dependency map and replan's empty wave/lanes.
    original = setup(case)
    case["cfg"]["limits"]["max_replans"] = 1
    (case["source"] / "third.py").write_text("VALUE = 0\n")
    revised = copy.deepcopy(original)
    revised["plan"]["steps"] = [revised["plan"]["steps"][1]]
    revised["plan"]["steps"].append({"id": "third", "title": "Finish dependent change", "description": "After other", "files": [{"path": "third.py", "action": "modify"}], "criteria": ["sum"], "depends_on": ["other"]})
    script(case, "planner", [original, revised])
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a,b):\n    return a+b\n")], "step:other": [{"kind": "blocked", "blocked_reason": "Need dependent follow-up"}], "step:r1:s1": [edit("other.py", "VALUE = 1\n")], "step:r1:s2": [edit("third.py", "VALUE = 2\n")]})
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 3 and status["progress"]["lanes"] == [], status
    accepted = json.loads(Path(status["artifacts"]["plan"]).read_text())
    assert accepted["steps"][1]["depends_on"] == [accepted["steps"][0]["id"]]
    code, status = decision(case, status)
    assert code == 0 and status["progress"]["steps_done"] == 3, status
    assert len(report(status)["waves"]) == 1


def test_defensive_collision_retries_later_step_sequentially(case):
    # Guards merge_wave's serial_steps + discarded-counter delta and select_step's serial override.
    plan = setup(case)
    plan["plan"]["steps"][1]["files"][0]["path"] = "calculator.py"
    script(case, "planner", [plan])
    change = edit("calculator.py", "# second\ndef add(a,b):\n    return a+b\n")
    script(case, "implementer", {"step:fix": [edit("calculator.py", "def add(a,b):\n    return a+b\n")], "step:other": [change, change]})
    _, status = begin(case)
    hook = case["tmp"] / "collision.py"
    hook.write_text('''import sys
from scranton_pipeline import waves
from scranton_pipeline.cli import main
original=waves.wave
def collide(steps,done,cap):
    return [0,1] if not done else original(steps,done,cap)
waves.wave=collide
raise SystemExit(main(sys.argv[1:]))
''')
    proc = subprocess.run([sys.executable, str(hook), "resume", "--run-dir", str(case["root"] / "test0001"), "--trust-host", "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]], env=os.environ, capture_output=True, text=True, timeout=60, check=False)
    assert proc.returncode == 0, (proc.stdout, proc.stderr)
    status = json.loads(proc.stdout)
    assert status["progress"]["steps_done"] == 2
    assert report(status)["waves"][0]["merged"] == ["fix"]
    assert "+# second" in Path(status["artifacts"]["diff"]).read_text()
    rows = events(case)
    assert sum(e["type"] == "wave_started" for e in rows) == 1

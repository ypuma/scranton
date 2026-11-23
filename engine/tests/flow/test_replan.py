"""Section 16 regressions; Guard comments identify the production line each reversal breaks."""
import copy
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from scranton_pipeline import routing
from scranton_pipeline.agents.prompts import build_planner_prompt
from scranton_pipeline.config import EngineConfig, Limits
from scranton_pipeline.demo.fixture import EDIT, PLAN, REVIEW, config
from scranton_pipeline.limits import recursion_limit
from scranton_pipeline.models import RunStatus
from scranton_pipeline.nodes import workflow
from scranton_pipeline.nodes.common import planning_key

from .conftest import begin, cli, decision, script

BLOCKED = {"kind": "blocked", "blocked_reason": "Need another approach"}
WRONG = {"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify",
    "content": "# FAILED ATTEMPT\ndef add(a, b):\n    return 0\n"}]}
REJECTED = {"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify",
    "replacements": [{"search": "NOT IN FILE", "replace": "nope"}]}]}
RIGHT = {"kind": "edits", "edits": [{"path": "calculator.py", "action": "modify",
    "content": "# NEW PLAN\ndef add(a, b):\n    return a + b\n"}]}


def report(status):
    return json.loads(Path(status["artifacts"]["report_json"]).read_text())


def events(case):
    return [json.loads(line) for line in (case["root"] / "test0001" / "events.jsonl").read_text().splitlines()]


def setup_replan(case, turns, *, first_green=False, auto=False):
    case["cfg"]["limits"] = {"max_step_attempts": 1}
    case["cfg"]["review"] = {"enabled": False}
    case["cfg"]["approvals"] = {"plan": "auto_low_risk" if auto else "always"}
    if first_green:
        original = copy.deepcopy(PLAN)
        first = copy.deepcopy(original["plan"]["steps"][0])
        first.update(id="r1:s1", files=[{"path": "kept.txt", "action": "create"}])
        original["plan"]["steps"].insert(0, first)
        turns = [{"kind": "edits", "edits": [{"path": "kept.txt", "action": "create", "content": "GREEN\n"}]}, *turns]
        # The first step is green without fixing the original bug yet.
        case["cfg"]["checks"][0]["argv"] = [sys.executable, "-c",
            "from pathlib import Path; import sys; sys.exit(0 if 'FAILED ATTEMPT' not in Path('calculator.py').read_text() else 1)"]
    else:
        original = PLAN
    script(case, "planner", [original, PLAN])
    script(case, "implementer", turns)


@pytest.mark.parametrize("trigger,code", [(BLOCKED, "step_blocked"), (WRONG, "checks_exhausted"), (REJECTED, "edits_rejected")])
def test_replan_trigger_gate_and_success(case, trigger, code):
    # Guards: implement/apply_edits/verify request_replan instead of terminal failures; replan reset_hard(green).
    setup_replan(case, [trigger, RIGHT])
    _, status = begin(case)
    code_out, status = decision(case, status)
    assert code_out == 3 and status["pending"]["revision"] == 1, status
    assert status["pending"]["risk_flags"] == ["replan"] or "replan" in status["pending"]["risk_flags"]
    assert status["pending"]["replan_reason"].startswith(code + ": ")
    assert status["progress"]["plan_revision"] == 1 and status["progress"]["replans_left"] == 0
    workspace = case["root"] / "test0001" / "workspace"
    assert "FAILED ATTEMPT" not in (workspace / "calculator.py").read_text()
    code_out, status = decision(case, status)
    assert code_out == 0 and status["status"] == "succeeded", status
    assert status["progress"]["steps_done"] == 1
    record = report(status)
    assert [r["revision"] for r in record["plan_revisions"]] == [0, 1]
    assert record["plan_revisions"][0]["replaced_reason"].startswith(code)
    assert record["plan_revisions"][1]["replaced_reason"] is None
    assert "FAILED ATTEMPT" not in Path(status["artifacts"]["diff"]).read_text()
    directory = case["root"] / "test0001" / "artifacts"
    assert json.loads((directory / "plan-r1.json").read_text()) == json.loads((directory / "plan.json").read_text())
    assert (directory / "plan-r0.json").exists()
    assert {"replan_requested", "replanned"} <= {e["type"] for e in events(case)}
    assert {"replan_requested", "replanned"} <= {e["data"].get("reason") for e in events(case) if e["type"] == "route"}
    assert "### Revision 0" in Path(status["artifacts"]["report_md"]).read_text()


@pytest.mark.parametrize("reject", [False, True])
def test_green_steps_kept_collision_and_reject_partial(case, reject):
    # Guards: replan uses green_commit, never head_commit; plan's deterministic rename avoids even r1:s1 collision.
    setup_replan(case, [WRONG, RIGHT], first_green=True)
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 3 and status["progress"]["steps_done"] == 1, status
    directory = case["root"] / "test0001"
    assert (directory / "workspace" / "kept.txt").read_text() == "GREEN\n"
    plan = json.loads((directory / "artifacts" / "plan.json").read_text())
    assert plan["steps"][0]["id"] != "r1:s1"
    code, status = decision(case, status, "reject" if reject else "approve")
    assert code == (6 if reject else 0), status
    assert status["status"] == ("rejected" if reject else "succeeded")
    diff = Path(status["artifacts"]["diff"]).read_text()
    assert "+GREEN" in diff and "FAILED ATTEMPT" not in diff
    assert ("+" + "# NEW PLAN" in diff) is not reject
    steps = report(status)["steps"]
    assert len({s["step_id"] for s in steps}) == len(steps) == (1 if reject else 2)
    assert all(s["attempts"] == 1 for s in steps)
    assert status["progress"]["steps_done"] == len(steps)
    assert "a - b" in (case["source"] / "calculator.py").read_text()


@pytest.mark.parametrize("trigger,kind,code", [(BLOCKED, "implementation", "step_blocked"),
    (REJECTED, "implementation", "edits_rejected"), (WRONG, "checks_failed", "checks_exhausted")])
@pytest.mark.parametrize("replans", [0, 1])
def test_terminal_when_disabled_or_budget_spent(case, trigger, kind, code, replans):
    # Guard: request_replan's counter >= max_replans gate preserves each old failure class/code exactly.
    setup_replan(case, [trigger] * (replans + 1))
    case["cfg"]["limits"]["max_replans"] = replans
    _, status = begin(case)
    result, status = decision(case, status)
    if replans:
        assert result == 3
        result, status = decision(case, status)
    assert result == 4 and status["failure"]["failure_class"] == kind, status
    assert status["failure"]["code"] == code
    assert sum(e["type"] == "replanned" for e in events(case)) == replans


def test_auto_low_risk_stops_at_replan_gate(case):
    # Guard: planner.plan flags = ['replan'] for revision > 0; removing it silently auto-approves the new plan.
    setup_replan(case, [BLOCKED, RIGHT], auto=True)
    case["cfg"].update(checks=[], allow_no_checks=True)
    code, status = begin(case)
    assert code == 3 and status["pending"]["revision"] == 1, status
    assert status["pending"]["risk_flags"] == ["replan"]
    code, status = decision(case, status)
    assert code == 0, status


@pytest.mark.parametrize("trigger,kind", [(BLOCKED, "implementation"), (REJECTED, "implementation"), (WRONG, "checks_failed")])
def test_review_revisions_never_replan(case, trigger, kind):
    # Guard: request_replan mode == revision exclusion (review fixes must stay bounded by review policy).
    setup_replan(case, [EDIT, trigger])
    case["cfg"]["review"] = {"enabled": True}
    script(case, "reviewer", [{**REVIEW, "verdict": "request_changes"}])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 4 and status["failure"]["failure_class"] == kind, status
    assert not any(e["type"] == "replanned" for e in events(case))


def test_planning_context_and_repairs_are_per_revision(case):
    # Guards: planning_key(..., context/repairs) in plan, context, and prompt; a shared key exhausts revision 1.
    setup_replan(case, [BLOCKED, RIGHT])
    case["cfg"]["limits"].update(max_plan_context_rounds=1, max_output_repairs=1)
    request = {"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}
    script(case, "planner", ["bad", request, PLAN, "bad", request, PLAN])
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 3 and status["pending"]["revision"] == 1, status
    code, status = decision(case, status)
    assert code == 0, status
    assert sum(e["node"] == "plan_context" and e["type"] == "node_finished" for e in events(case)) == 2
    assert planning_key({"plan_revision": 1}, "context") == "plan_context:r1"


@pytest.mark.parametrize("node", ["replan", "plan"])
def test_crash_inside_replan_or_replanning_plan_then_resume(case, node):
    # Guards: replan reset is replayable, sync graph checkpoint, revision/plans/steps/counters persisted once.
    setup_replan(case, [WRONG, RIGHT], first_green=True)
    _, status = begin(case)
    hook = case["tmp"] / "crash-replan.py"
    hook.write_text('''import os, sys
from scranton_pipeline.nodes import workflow
from scranton_pipeline import graph
from scranton_pipeline.cli import main
original = workflow.replan if sys.argv[1] == "replan" else graph.plan
def crash(state, deps):
    result = original(state, deps)
    if sys.argv[1] == "replan" or state.get("plan_revision", 0): os._exit(91)
    return result
if sys.argv[1] == "replan": workflow.replan = crash
else: graph.plan = crash
raise SystemExit(main(sys.argv[2:]))
''')
    directory = case["root"] / "test0001"
    proc = subprocess.run([sys.executable, str(hook), node, "resume", "--run-dir", str(directory), "--trust-host",
        "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]],
        check=False, capture_output=True, env=os.environ, timeout=60)
    assert proc.returncode == 91, proc.stderr
    code, status = cli("status", "--run-dir", directory)
    assert code == 5 and status["resumable"], status
    # A completed model call spends its ledger slot even if the surrounding node crashes.
    if node == "plan":
        script(case, "planner", [PLAN, PLAN, PLAN])
    code, status = cli("resume", "--run-dir", directory, "--trust-host")
    assert code == 3 and status["pending"]["revision"] == 1, status
    assert status["progress"]["replans_left"] == 0
    code, status = decision(case, status)
    assert code == 0 and status["progress"]["steps_done"] == 2, status
    assert len(report(status)["plan_revisions"]) == 2
    assert sum(e["type"] == "node_finished" and e["node"] == "prepare_workspace" for e in events(case)) == 1
    assert "FAILED ATTEMPT" not in Path(status["artifacts"]["diff"]).read_text()


@pytest.mark.parametrize("route", [routing.after_implement, routing.after_apply, routing.after_verify, routing.after_replan])
def test_new_routing_targets_reasons_and_precedence(route):
    # Guards: replan_request branches and decision's target/reason coupling; terminal guards always take precedence.
    state = {"replan_request": {"code": "step_blocked"}, "pending_edits": {"kind": "edits"},
        "feedback": {"kind": "checks_failed"}, "step_requests": [{}]}
    before = copy.deepcopy(state)
    assert routing.decision(route, state) == (("plan", "replanned") if route is routing.after_replan else ("replan", "replan_requested"))
    assert state == before
    assert routing.decision(route, {**state, "failure": {"code": "security"}}) == ("finalize", "failure")
    assert routing.decision(route, {**state, "outcome": "cancelled"}) == ("finalize", "cancelled")


def test_direct_attempt_limit_replan_or_terminal():
    # Guard: apply_edits's entry budget check (even a restored checkpoint at the exact limit may not write).
    state = {"mode": "step", "counters": {"attempts:step:unknown": 1}}
    for replans in (0, 1):
        deps = SimpleNamespace(cfg=SimpleNamespace(limits=Limits(max_step_attempts=1, max_replans=replans)),
            events=SimpleNamespace(emit=lambda *a, **kw: None))
        result = workflow.apply_edits(state, deps)
        assert (result.get("replan_request") or result["failure"])["code"] == "attempts_exhausted"
        assert ("replan_request" in result) is bool(replans)


def test_recursion_bound_with_every_replan():
    # Guard: recursion_limit multiplies planning AND every plan's full work allowance, plus replan/gate nodes.
    for replans in range(4):
        for repairs in (0, 2, 10):
            for rounds in (0, 2, 10):
                for steps in (1, 8, 32):
                    lim = Limits(max_replans=replans, max_output_repairs=repairs, max_review_rounds=rounds,
                        max_plan_steps=steps, max_plan_context_rounds=10, max_step_context_rounds=10, max_step_attempts=10)
                    per_plan = 1 + repairs + 20 + 1 + steps * (1 + repairs + 20 + 30)
                    visits = 4 + (replans + 1) * per_plan + replans + rounds * (1 + repairs + 20 + 30) + (rounds + 1) * (1 + repairs) + 5
                    assert recursion_limit(lim) >= visits


def test_replan_prompt_keeps_reason_before_bulk(tmp_path):
    # Guard: bounded control ordering keeps replan_reason/context/feedback before bulk previous-plan/repo text.
    cfg = config(tmp_path, sandbox="host")
    state = {"task": "Fix", "plan_revision": 1, "counters": {"plan_context:r1": 1},
        "feedback": {"message": "REPAIR SENTINEL"}, "previous_plan": {"summary": "OLD PLAN SENTINEL"},
        "replan_brief": {"reason": "REASON SENTINEL", "failed_step": {"id": "FAILED STEP SENTINEL"},
            "completed_steps": ["COMPLETED SENTINEL"], "changed_files": [{"path": "DIFF SENTINEL"}]}}
    _, prompt = build_planner_prompt(state, cfg)
    assert all(s in prompt for s in ("REASON SENTINEL", "FAILED STEP SENTINEL", "COMPLETED SENTINEL", "DIFF SENTINEL", "OLD PLAN SENTINEL"))
    state["previous_plan"]["summary"] *= 100000
    system, prompt = build_planner_prompt(state, cfg)
    assert len((system + prompt).encode()) <= cfg.limits.max_prompt_bytes
    assert all(s in prompt for s in ("REASON SENTINEL", "REPAIR SENTINEL", '"context_rounds_left": 2'))


def test_additive_kernel_defaults_and_bounds(tmp_path):
    # Guards: new config defaults and RunStatus progress/pending validators keep historical JSON valid.
    cfg = EngineConfig.model_validate(config(tmp_path, sandbox="host").model_dump())
    assert cfg.limits.max_replans == 1
    assert cfg.execution.max_parallel_steps == 1 and cfg.execution.max_lane_workspace_bytes == 536870912
    assert cfg.sandbox.docker.tmpfs_mb == 512
    status = RunStatus(run_id="old00001", status="awaiting_approval", phase="approve_plan", progress={"step_index": 0},
        pending={"gate": "plan", "digest": "x"})
    assert status.progress == {"step_index": 0, "plan_revision": 0, "replans_left": 0, "steps_done": 0, "lanes": []}
    assert status.pending["revision"] == 0 and status.pending["replan_reason"] is None
    for field, values in (("limits", [{"max_replans": -1}, {"max_replans": 4}]),
        ("execution", [{"max_parallel_steps": 0}, {"max_parallel_steps": 5}, {"max_lane_workspace_bytes": 0}]),
        ("sandbox", [{"docker": {"tmpfs_mb": 63}}, {"docker": {"tmpfs_mb": 4097}}])):
        for value in values:
            with pytest.raises(ValidationError):
                EngineConfig.model_validate({**cfg.model_dump(), field: value})


def test_instrument_status_merges_progress_deltas(tmp_path, monkeypatch):
    # Guard: instrument's visible counters/steps_done reducer merge; shallow update hides earlier completed steps.
    from scranton_pipeline import graph
    seen = []
    monkeypatch.setattr(graph, "make_status", lambda state, deps, **kw: state)
    monkeypatch.setattr(graph, "write_status", lambda directory, status: seen.append(status))
    deps = SimpleNamespace(run_dir=tmp_path, cfg=config(tmp_path, sandbox="host"),
        events=SimpleNamespace(emit=lambda *a, **kw: None),
        stop=SimpleNamespace(cancel_requested=lambda: False, suspend_requested=lambda: False))
    state = {"counters": {"replans": 1, "attempts:step:x": 2}, "steps_done": [{"step_id": "step:old"}]}
    graph.instrument("verify", lambda s, d: {"steps_done": [{"step_id": "step:new"}]}, deps)(state)
    assert len(seen[-1]["steps_done"]) == 2 and seen[-1]["counters"]["replans"] == 1
    graph.instrument("apply_edits", lambda s, d: {"counters": {"attempts:step:x": 1}}, deps)(state)
    assert seen[-1]["counters"] == {"replans": 1, "attempts:step:x": 3}


def test_preflight_fails_before_snapshot_and_cleanup_never_masks(case, monkeypatch):
    # Guards: prepare_workspace box.preflight() before snapshot_source; cleanup_sandbox catches cleanup errors.
    from scranton_pipeline import runner
    from scranton_pipeline.errors import EngineError, FailureClass
    calls = []
    def preflight():
        calls.append("preflight")
        raise EngineError(FailureClass.INFRASTRUCTURE, "image_missing", "Local image missing")
    def cleanup():
        calls.append("cleanup")
        raise RuntimeError("Cleanup fault")
    monkeypatch.setattr(workflow, "sandbox", lambda deps: SimpleNamespace(preflight=preflight, cleanup=cleanup))
    monkeypatch.setattr(workflow, "snapshot_source", lambda *a, **kw: pytest.fail("Snapshot before preflight"))
    status = runner.start(source=case["source"], task="Fail fast", cfg=EngineConfig.model_validate(case["cfg"]),
        run_root=case["root"], run_id="test0001", trust_host=True)
    assert status.status == "failed" and status.failure["code"] == "image_missing"
    assert calls == ["cleanup", "preflight", "cleanup"]
    assert not (case["root"] / "test0001" / "workspace").exists()
    assert sum(e["data"].get("code") == "cleanup_failed" for e in events(case)) == 2


def test_resume_cleanup_before_graph_and_finalize(case, monkeypatch):
    # Guards: runner.resume cleanup_sandbox before drive, and finalize_out_of_band's cleanup on success.
    from scranton_pipeline import runner
    from scranton_pipeline.tools.sandbox import HostSandbox
    _, status = begin(case)
    calls = []
    monkeypatch.setattr(HostSandbox, "cleanup", lambda self: calls.append("cleanup"))
    original = runner.drive
    def drive(deps, value=None, *, execute=True):
        assert calls == ["cleanup"]
        return original(deps, value, execute=execute)
    monkeypatch.setattr(runner, "drive", drive)
    result = runner.resume(case["root"] / "test0001", gate="plan", decision="approve",
        digest=status["pending"]["digest"], trust_host=True)
    assert result.status == "succeeded" and calls == ["cleanup", "cleanup"]

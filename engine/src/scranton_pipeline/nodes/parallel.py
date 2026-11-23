"""Private lane workspaces and the sole, replay-safe main-tree merger."""
import json
import os
import shutil
import stat
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.nodes import workflow
from scranton_pipeline.nodes.common import Dependencies, scope_id
from scranton_pipeline.observability import EventLog, _rows
from scranton_pipeline.state import PipelineState, counter, get_plan
from scranton_pipeline.tools.fs import ALLOCATION_PREFIX, reserved_sandbox_name, write_bytes_atomic
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.native_sandbox import NativeSandbox


class LaneEvents(EventLog):
    def __init__(self, parent: EventLog, lane: str) -> None:
        super().__init__(parent.path, parent.run_id, parent.redactor)
        self.lane = lane

    def emit(self, type: str, *, node: str | None = None, **data: Any) -> int:
        return super().emit(type, node=node, **{**data, "lane": self.lane})


def lane_paths(deps: Dependencies, number: int, slot: int) -> tuple[Path, Path]:
    suffix = f"{number}-{slot}"
    return deps.workspace.with_name(deps.workspace.name + "-l" + suffix), deps.run_dir / "lanes" / suffix


def lane_dependencies(state: PipelineState, deps: Dependencies) -> Dependencies:
    lane = state["lane"]
    workspace, directory = lane_paths(deps, lane["wave"], lane["slot"])
    cfg = deps.cfg.model_copy(update={"policy": deps.cfg.policy.model_copy(update={"scope": "strict"})})
    return replace(deps, workspace=workspace, git_dir=directory / "git", cfg=cfg,
                   lane_suffix=f"l{lane['wave']}-{lane['slot']}", events=LaneEvents(deps.events, lane["step_id"]))


def workspace_bytes(workspace: Path) -> int:
    total = 0
    for root, dirs, files in os.walk(workspace, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(root) / name
            if path.is_symlink() or path.is_junction():
                raise EngineError(FailureClass.SECURITY, "lane_link", "Lane snapshot cannot contain links")
        dirs[:] = [d for d in dirs if d.casefold() not in {".git", ".pipeline"}]
        total += sum((Path(root) / f).stat().st_size for f in files if f != ".git")
    return total


def parallel_available(deps: Dependencies) -> bool:
    try:
        size = workspace_bytes(deps.workspace)
    except EngineError as exc:
        if exc.code != "lane_link":
            raise
        if not any(e["type"] == "warning" and e["data"].get("code") == "parallel_unavailable" for e in _rows(deps.events.path)):
            deps.events.emit("warning", code="parallel_unavailable", message="Workspace contains links; using sequential execution")
        return False
    if size > deps.cfg.execution.max_lane_workspace_bytes:
        if not any(e["type"] == "warning" and e["data"].get("code") == "lane_workspace_too_large" for e in _rows(deps.events.path)):
            deps.events.emit("warning", code="lane_workspace_too_large", message="Workspace exceeds lane copy limit; using sequential execution")
        return False
    return True


def remove_lane(path: Path, *, owned: bool = False) -> None:
    def writable(fn: Any, name: str, exc: BaseException) -> None:
        if not isinstance(exc, PermissionError):
            raise exc
        os.chmod(name, stat.S_IWRITE | stat.S_IREAD)
        fn(name)
    if path.exists():
        # Git object files are read-only on Windows.
        shutil.rmtree(path, onexc=writable)
    if owned:
        path.with_name(f"{ALLOCATION_PREFIX}{path.name}.json").unlink(missing_ok=True)


def copy_workspace(source: Path, target: Path, box: Any, *, exclude_state: bool = True) -> None:
    allocated = isinstance(box, NativeSandbox)
    if allocated:
        box.allocate()
    shutil.copytree(source, target, dirs_exist_ok=allocated,
                    ignore=lambda _, names: [n for n in names if reserved_sandbox_name(n)
                                             or exclude_state and n.casefold() in {".git", ".pipeline"}])


def lane_prepare(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    # This node has no committed checkpoint until the complete baseline exists.
    lane = state["lane"]
    source = Path(lane["source_workspace"])
    directory = deps.git_dir.parent if deps.git_dir else deps.run_dir / "lanes"
    remove_lane(deps.workspace, owned=deps.cfg.sandbox.mode == "scranton")
    remove_lane(directory)
    workspace_bytes(source)
    copy_workspace(source, deps.workspace, workflow.sandbox(deps))
    repo = WorkspaceRepo.init(deps.workspace, deps.git_dir, timeout_s=deps.cfg.limits.git_timeout_s)
    source_repo = WorkspaceRepo(source, Path(lane["source_git_dir"]), timeout_s=deps.cfg.limits.git_timeout_s)
    tracked = [p for p in source_repo._run(["ls-tree", "-rz", "--name-only", state["workspace"]["head_commit"]]).split("\0") if p]
    if tracked:
        repo.add_paths(tracked, force=True)
    base = repo.commit_paths([], "Pipeline lane baseline")
    deps.events.emit("lane_started")
    return {"workspace": {**state["workspace"], "path": str(deps.workspace), "base_commit": base,
                           "head_commit": base, "green_commit": base}}


def lane_finish(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    failure = state.get("failure")
    status = "cancelled" if state.get("outcome") == "cancelled" else "failed" if failure or state.get("replan_request") else "passed"
    result = {"step_id": state["lane"]["step_id"], "state": status, "failure": failure,
              "replan_request": state.get("replan_request"), "workspace": state.get("workspace"), "checks": state.get("checks", []),
              "slot": state["lane"]["slot"], "attempt": counter(state, "attempts:" + scope_id(state))}
    deps.events.emit("lane_finished", status=status)
    return {"lanes": {result["step_id"]: result}}


def cleanup_lanes(state: PipelineState, deps: Dependencies) -> None:
    for slot, _ in enumerate(state.get("wave", {}).get("indices", [])):
        workspace, directory = lane_paths(deps, state["wave"]["number"], slot)
        for path in (workspace, directory):
            for attempt in range(3):
                try:
                    remove_lane(path, owned=path == workspace and deps.cfg.sandbox.mode == "scranton")
                    break
                except Exception:  # noqa: BLE001 - cleanup must not prevent terminal status
                    if attempt == 2:
                        deps.events.emit("warning", code="cleanup_failed", message="Lane cleanup failed", path=str(path))
                    else:
                        time.sleep(.05 * (attempt + 1))


def rollback_integration(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    wave = state.get("wave", {})
    if not wave.get("records"):
        return {}
    green = state["workspace"]["green_commit"]
    deps.repo().reset_hard(green)
    return {"workspace": {**state["workspace"], "head_commit": green},
            "wave": {**wave, "records": [], "deferred": {}},
            "lanes": {sid: {**lane, "state": "failed"} if lane["state"] == "merged" else lane
                      for sid, lane in state.get("lanes", {}).items()}}


def finish_integration(state: PipelineState) -> dict[str, Any]:
    wave = state["wave"]
    return {"steps_done": wave.get("records", []), "wave": {**wave, "records": [], "deferred": {}},
            **wave.get("deferred", {})}


def merge_wave(state: PipelineState, deps: Dependencies) -> dict[str, Any]:
    wave = state["wave"]
    receipt = deps.run_dir / "artifacts" / f"wave-{wave['number']}.json"
    if receipt.exists():
        update: dict[str, Any] = json.loads(receipt.read_text(encoding="utf-8"))
        deps.repo().reset_hard(update["workspace"]["head_commit"])
        cleanup_lanes(state, deps)
        return update
    plan = get_plan(state)
    assert plan is not None
    for lane in state["lanes"].values():
        failure = lane.get("failure")
        if failure and failure["code"] in {"sandbox_failed", "output_not_closed"}:
            return {"failure": failure}
    repo = deps.repo()
    repo.reset_hard(state["workspace"]["head_commit"])
    merged, failed, records = [], [], []
    serial = list(state.get("serial_steps", []))
    counters: dict[str, int] = {}
    paths_seen: set[str] = set()
    head = state["workspace"]["head_commit"]
    lanes = dict(state["lanes"])
    for index in wave["indices"]:
        step = plan.steps[index]
        lane = lanes[step.id]
        if lane["state"] != "passed":
            failed.append(step.id)
            continue
        workspace, directory = lane_paths(deps, wave["number"], lane["slot"])
        lane_repo = WorkspaceRepo(workspace, directory / "git", timeout_s=deps.cfg.limits.git_timeout_s)
        data = lane["workspace"]
        changes = lane_repo.changed_files(data["base_commit"], data["head_commit"])
        normalized = {deps.policy().normalize(p).casefold() for _, p in changes}
        if normalized & paths_seen:
            serial.append(step.id)
            # The discarded lane did not advance this step's sequential repair loop.
            for prefix in ("attempts:", "context:", "repairs:"):
                key = prefix + "step:" + step.id
                counters[key] = -counter(state, key)
            continue
        declared = {deps.policy().normalize(f.path).casefold() for f in step.files}
        if not normalized <= declared:
            raise EngineError(FailureClass.SECURITY, "lane_scope", "Committed lane files exceed declared scope")
        # Restore committed bytes, never copy uncommitted check output.
        lane_repo.reset_hard(data["head_commit"])
        policy = deps.policy()
        lane_policy = replace(deps, workspace=workspace).policy()
        for action, path in changes:
            target = policy.resolve(path)
            if policy.is_protected(path) or policy.is_write_protected(path):
                raise EngineError(FailureClass.SECURITY, "protected_path", "Protected merge target")
            if action == "D":
                target.unlink(missing_ok=True)
            else:
                source = lane_policy.resolve(path)
                if source.is_symlink() or source.is_junction():
                    raise EngineError(FailureClass.SECURITY, "lane_link", "Committed lane link refused")
                write_bytes_atomic(target, source.read_bytes())
        head = repo.commit_paths([p for _, p in changes], f"Pipeline merge step:{step.id}")
        records.append({"step_id": "step:" + step.id, "attempts": lane["attempt"], "commit": head,
                        "changed_files": [p for _, p in changes]})
        paths_seen |= normalized
        merged.append(step.id)
        lanes[step.id] = {**lane, "state": "merged"}
    update = {"workspace": {**state["workspace"], "head_commit": head},
              "active_seconds": max((r.get("active_seconds", 0.0) for r in lanes.values()), default=0.0), "lanes": lanes, "serial_steps": serial, "counters": counters,
              "mode": "integration", "feedback": None,
              "pending_edits": None, "step_evidence": [], "step_requests": []}
    bad = [lanes[s] for s in failed]
    terminal = next((r["failure"] for r in bad if r.get("failure") and r["failure"]["failure_class"] not in {"implementation", "checks_failed"}), None)
    deferred: dict[str, Any] = {}
    if terminal:
        deferred["failure"] = terminal
    elif any(r["state"] == "cancelled" for r in bad) or deps.stop.cancel_requested():
        deferred["outcome"] = "cancelled"
    elif bad:
        reason = bad[0].get("failure") or bad[0]["replan_request"]
        kind = FailureClass.CHECKS_FAILED if reason["code"] == "checks_exhausted" else FailureClass.IMPLEMENTATION
        index = next(i for i in wave["indices"] if plan.steps[i].id == bad[0]["step_id"])
        deferred.update(workflow.request_replan({**state, "mode": "step", "step_index": index, "checks": bad[0].get("checks", [])}, deps,
            EngineError(kind, reason["code"], reason["message"]), "merge_wave"))
    update["wave"] = {**wave, "records": records, "deferred": deferred}
    if not records:
        update.update(deferred)
    summary = {"number": wave["number"], "merged": merged, "failed": failed}
    update["waves"] = [*state.get("waves", []), summary]
    workflow.json_write(receipt, update)
    cleanup_lanes(state, deps)
    deps.events.emit("wave_merged", wave=wave["number"], merged=merged, failed=failed)
    return update

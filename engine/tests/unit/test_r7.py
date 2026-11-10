"""R7 regression guards; exact reverted statements are in r7/CHANGES.md."""
import json
from dataclasses import replace

import pytest
from test_r5 import deps_at, rows

from scranton_pipeline import report, runner
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.nodes import parallel, workflow
from scranton_pipeline.tools import secrets
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.sandbox import DockerSandbox


def test_many_literal_git_paths_commit_restore_and_diff(tmp_path):
    repo = WorkspaceRepo.init(tmp_path / "workspace", tmp_path / "git")
    names = [f"file-{i:04}-" + "long-name-" * 6 + ".txt" for i in range(2000)]
    names += ["[literal].txt", "unicode-ä.txt"]
    for name in names:
        (repo.workspace / name).write_text("before\n")
    base = repo.commit_paths(names, "base")
    for name in names:
        (repo.workspace / name).write_text("after\n")
    (repo.workspace / names[0]).unlink()
    head = repo.commit_paths(names, "many changes")
    assert len(repo.changed_files(base, head)) == len(names)
    assert len(repo.numstat(base, head)) == len(names) and "after" in repo.diff(base, head)
    for name in names[1:]:
        (repo.workspace / name).write_text("check damage")
    assert len(repo.restore_tracked()) == len(names) - 1
    assert (repo.workspace / names[1]).read_text() == "after\n"
    assert not list(repo.git_dir.glob("tmp*"))


def test_lane_uses_run_state_without_copying_mountpoint(tmp_path):
    deps = deps_at(tmp_path)
    run = deps.run_dir.with_name("test0001")
    run.mkdir()
    deps = replace(deps, run_dir=run)
    repo = WorkspaceRepo.init(deps.workspace, deps.repo().git_dir)
    (deps.workspace / "tracked").write_text("ok")
    head = repo.commit_all("base")
    for name in (".pipeline", ".PIPELINE"):
        path = deps.workspace / name
        path.mkdir(exist_ok=True)
        (path / "poison").write_text("not a dependency")
    state = {"lane": {"wave": 1, "slot": 0, "step_id": "x", "source_workspace": str(deps.workspace),
        "source_git_dir": str(repo.git_dir)}, "workspace": {"head_commit": head}}
    lane = parallel.lane_dependencies(state, deps)
    parallel.lane_prepare(state, lane)
    assert not any(p.name.casefold() == ".pipeline" for p in lane.workspace.iterdir())
    docker_cfg = deps.cfg.model_copy(update={"sandbox": deps.cfg.sandbox.model_copy(update={"mode": "docker"})})
    main_box = workflow.sandbox(replace(deps, cfg=docker_cfg))
    lane_box = workflow.sandbox(replace(lane, cfg=docker_cfg))
    assert isinstance(main_box, DockerSandbox) and isinstance(lane_box, DockerSandbox)
    assert main_box.state_dir == lane_box.state_dir == deps.run_dir / "sandbox-state"


@pytest.mark.parametrize("reason", ["links", "size"])
def test_fallback_warning_once_across_dependencies_and_resume(tmp_path, monkeypatch, reason):
    deps = deps_at(tmp_path)
    def size(_):
        if reason == "links":
            raise EngineError(FailureClass.SECURITY, "lane_link", "links")
        return deps.cfg.execution.max_lane_workspace_bytes + 1
    monkeypatch.setattr(parallel, "workspace_bytes", size)
    for current in (deps, deps, replace(deps)):
        assert not parallel.parallel_available(current)
    assert len(rows(deps)) == 1


def test_finalize_survives_failed_integration_reset(tmp_path, monkeypatch):
    deps = deps_at(tmp_path)
    repo = WorkspaceRepo.init(deps.workspace, deps.repo().git_dir)
    (deps.workspace / "x").write_text("green")
    green = repo.commit_all("base")
    (deps.workspace / "x").write_text("unchecked")
    head = repo.commit_paths(["x"], "bad")
    def fail(*args):
        raise EngineError(FailureClass.INFRASTRUCTURE, "git_failed", "reset failed")
    monkeypatch.setattr(WorkspaceRepo, "reset_hard", fail)
    state = {"run_id": "test0001", "task": "test", "source_dir": str(tmp_path), "delivery_mode": "patch",
        "mode": "integration", "outcome": "cancelled", "workspace": {"base_commit": green, "green_commit": green,
        "head_commit": head}, "wave": {"number": 1, "records": [{"step_id": "step:x"}]}}
    result = report.finalize_out_of_band(state, deps)
    assert result["outcome"] == "cancelled"
    assert json.loads((deps.run_dir / "status.json").read_text())["status"] == "cancelled"
    data = json.loads((deps.run_dir / "delivery" / "report.json").read_text())
    assert any("rollback failed" in text for text in data["limitations"])
    assert (deps.run_dir / "delivery" / "partial.diff").read_text() == ""


def test_environment_heuristics_preserve_code_and_explicit_keys_override(tmp_path, monkeypatch):
    monkeypatch.setattr(secrets, "_KNOWN", set())
    deps = deps_at(tmp_path)
    (deps.run_dir / "run.json").write_text(json.dumps({"workspace": str(deps.workspace)}))
    benign = ["false", "true", "12345678901234567890", "1.234567890123e+30", "development", str(tmp_path)]
    for index, value in enumerate(benign):
        monkeypatch.setenv(f"OTHER_TOKEN_{index}", value)
    monkeypatch.setenv("TOKENIZERS_PARALLELISM", "false")
    monkeypatch.setenv("OPAQUE_SECRET", "opaque-credential-123456")
    with runner.dependencies(deps.run_dir, deps.cfg, trust_host=True, models=False) as actual:
        text = " ".join(benign)
        assert actual.redactor.redact(text) == text
        assert actual.redactor.redact("opaque-credential-123456") == "[REDACTED]"
        actual.events.emit("warning", message="return false")
        assert rows(actual)[-1]["data"]["message"] == "return false"
    monkeypatch.setenv("EXPLICIT_CREDENTIAL", "tiny")
    monkeypatch.setenv("SCRANTON_PIPELINE_KEY_OTHER", "yes")
    cfg = deps.cfg.model_copy(update={"models": deps.cfg.models.model_copy(update={
        "planner": deps.cfg.models.planner.model_copy(update={"api_key_env": "EXPLICIT_CREDENTIAL"})})})
    with runner.dependencies(deps.run_dir, cfg, trust_host=True, models=False) as actual:
        assert actual.redactor.redact("tiny yes") == "[REDACTED] [REDACTED]"

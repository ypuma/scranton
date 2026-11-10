import json
from importlib.resources import files

import pytest

from scranton_pipeline.cli import main
from scranton_pipeline.config import SandboxConfig
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.process import ProcResult
from scranton_pipeline.tools.sandbox import DockerSandbox, HostSandbox, build_sandbox, default_image


def test_preflight_and_cleanup_before_workspace_exists(tmp_path):
    workspace = tmp_path / "not-created"
    calls = []

    def runner(argv, **kwargs):
        assert kwargs["cwd"].is_dir()
        calls.append(list(argv))
        return ProcResult(0, False, False, 0, "", 0, None)

    host = HostSandbox(SandboxConfig(mode="host"), workspace)
    host.preflight()
    host.cleanup()
    sandbox = DockerSandbox(SandboxConfig(), workspace, "12345678", runner)
    sandbox.preflight()
    sandbox.cleanup()
    assert calls[-1] == ["docker", "ps", "-a", "-q", "--filter", "label=scranton.pipeline.run=12345678"]
    assert not workspace.exists()


@pytest.mark.parametrize("failure", ["absent", "daemon", "image", "timeout", "stopped"])
def test_preflight_distinct_codes(tmp_path, failure):
    def runner(argv, **kwargs):
        if failure == "absent":
            raise EngineError(FailureClass.INFRASTRUCTURE, "executable_not_found", "missing")
        failed = failure in ("daemon", "timeout", "stopped") or argv[1] == "image"
        return ProcResult(1 if failed else 0, failure == "timeout", failure == "stopped", 0, "", 0, None)

    sandbox = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner)
    with pytest.raises(EngineError) as raised:
        sandbox.preflight()
    assert raised.value.code == ("image_missing" if failure == "image" else "docker_unavailable")
    assert "python -m scranton_pipeline sandbox build" in str(raised.value)


def test_cleanup_label_only_and_bounded_never_raises(tmp_path):
    calls = []

    def runner(argv, **kwargs):
        assert kwargs["timeout_s"] <= 10
        calls.append(list(argv))
        if argv[1] == "rm":
            raise OSError("daemon stopped")
        return ProcResult(0, False, False, 0, "abcdef123456\nabcdef123457\n", 26, None)

    sandbox = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner)
    sandbox.cleanup()
    assert calls == [["docker", "ps", "-a", "-q", "--filter", "label=scranton.pipeline.run=12345678"],
                     ["docker", "rm", "-f", "abcdef123456", "abcdef123457"]]


def test_names_unique_across_instances_and_suffixes(tmp_path):
    names = []

    def runner(argv, **kwargs):
        if argv[1] == "run":
            names.append(argv[argv.index("--name") + 1])
        return ProcResult(0, False, False, 0, "", 0, None)

    for suffix in ("", "", "lane-1", "lane-2"):
        sandbox = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner, name_suffix=suffix)
        sandbox.run(["true"], timeout_s=1, log_path=tmp_path / "log")
    assert len(set(names)) == 4
    assert "lane-1" in names[2] and "lane-2" in names[3]
    assert isinstance(build_sandbox(SandboxConfig(), workspace=tmp_path, run_id="12345678",
                                   trust_host=False, name_suffix="lane-1"), DockerSandbox)


def test_cli_check_without_docker(monkeypatch, capsys):
    def absent(*args, **kwargs):
        raise OSError("docker absent")

    monkeypatch.setattr(DockerSandbox, "_invoke", absent)
    assert main(["sandbox", "check"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    answer = json.loads(lines[0])
    assert answer["docker"]["available"] is False
    assert answer["image"] == {"name": default_image(), "present": False}
    assert answer["default_image"] == default_image()


def test_cli_build_failure_one_json(monkeypatch, capsys):
    import subprocess

    def absent(*args, **kwargs):
        raise FileNotFoundError("docker")

    monkeypatch.setattr(subprocess, "run", absent)
    assert main(["sandbox", "build"]) == 5
    answer = json.loads(capsys.readouterr().out)
    assert answer["built"] is False and answer["image"] == default_image()


def test_packaged_dockerfile():
    import tomllib
    from pathlib import Path

    root = files("scranton_pipeline").joinpath("sandbox_image")
    assert "USER 10001:10001" in root.joinpath("Dockerfile").read_text()
    assert "ENTRYPOINT" not in root.joinpath("Dockerfile").read_text()
    assert "!Dockerfile" in root.joinpath(".dockerignore").read_text()
    cfg = tomllib.loads((Path(__file__).parents[2] / "pyproject.toml").read_text())
    assert {"sandbox_image/Dockerfile", "sandbox_image/.dockerignore", "procedure/default.json"} <= set(
        cfg["tool"]["setuptools"]["package-data"]["scranton_pipeline"])


def test_pipeline_installs_ignored_and_survive_reset(tmp_path):
    workspace = tmp_path / "workspace"
    repo = WorkspaceRepo.init(workspace, tmp_path / "git")
    (workspace / "tracked").write_text("before")
    base = repo.commit_all("base")
    install = workspace / ".pipeline" / "python"
    install.mkdir(parents=True)
    (install / "installed").write_text("keep")
    (workspace / "tracked").write_text("after")
    head = repo.commit_all("edit")
    assert repo.changed_files(base, head) == [("M", "tracked")]
    assert ".pipeline" not in repo.diff(base, head)
    repo.reset_hard(base)
    assert (install / "installed").read_text() == "keep"


def test_git_programmatic_paths_are_not_redacted(tmp_path):
    workspace = tmp_path / "workspace"
    repo = WorkspaceRepo.init(workspace, tmp_path / "git")
    name = "sk-folding-cube-abcdefghijklmnopqrstuvwxyz.css"
    (workspace / name).write_text("before\n")
    base = repo.commit_all("base")
    assert repo._run(["ls-files", "-z"]) == name + "\0"
    (workspace / name).write_text("after\n")
    head = repo.commit_paths([name], "edit")
    assert repo.changed_files(base, head) == [("M", name)]
    assert repo.numstat(base, head) == [(1, 1, name)]
    (workspace / name).write_text("damage")
    assert repo.restore_tracked() == [name]


@pytest.mark.parametrize("code", [0, 1, 125])
def test_run_cleanup_normal_path_one_exact_name_query(tmp_path, code):
    # Guard: _remove_container's first normal-path query, including Docker errors.
    calls = []
    original = ProcResult(code, False, False, 0, "original", 8, None)

    def runner(argv, **kwargs):
        calls.append((list(argv), kwargs))
        return original if argv[1] == "run" else ProcResult(0, False, False, 0, "", 0, None)

    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner)
    if code == 125:
        with pytest.raises(EngineError, match="original"):
            box.run(["check"], timeout_s=1, log_path=tmp_path / "log")
    else:
        assert box.run(["check"], timeout_s=1, log_path=tmp_path / "log") is original
    name = calls[0][0][calls[0][0].index("--name") + 1]
    assert [argv for argv, _ in calls[1:]] == [
        ["docker", "ps", "-a", "-q", "--filter", f"name=^/{name}$"]]
    assert calls[1][1]["timeout_s"] <= 1
    assert "stop" not in calls[1][1]


@pytest.mark.parametrize("outcome", ["timeout", "stop", "exception"])
def test_run_cleanup_container_appears_after_first_removal(tmp_path, monkeypatch, outcome):
    # Guards: rm -f retry after initial absence; finally also covers stop/exception.
    from scranton_pipeline.tools import sandbox as module

    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    calls = []
    original = ProcResult(None, outcome == "timeout", outcome == "stop", 0, "original", 8, None)
    error = OSError("original exception")
    replies = iter([(0, ""), (0, ""), (1, "removal in progress"),
                    (0, "abcdef123456\n"), (0, "removed"), (0, "")])

    def runner(argv, **kwargs):
        calls.append((list(argv), kwargs))
        if argv[1] == "run":
            if outcome == "exception":
                raise error
            return original
        code, tail = next(replies)
        return ProcResult(code, False, False, 0, tail, len(tail), None)

    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner)
    if outcome == "exception":
        with pytest.raises(OSError) as raised:
            box.run(["check"], timeout_s=1, log_path=tmp_path / "log")
        assert raised.value is error
    else:
        assert box.run(["check"], timeout_s=1, log_path=tmp_path / "log") is original
    name = calls[0][0][calls[0][0].index("--name") + 1]
    pair = [["docker", "rm", "-f", name], ["docker", "ps", "-a", "-q", "--filter", f"name=^/{name}$"]]
    assert [argv for argv, _ in calls[1:]] == pair * 3
    assert clock[0] == pytest.approx(.6)
    assert all(0 < kw["timeout_s"] <= 1 and "stop" not in kw for _, kw in calls[1:])


@pytest.mark.parametrize("failure", ["exit", "timeout", "stopped", "exception"])
def test_run_cleanup_failure_is_bounded_and_preserves_result(tmp_path, monkeypatch, failure):
    # Guards: range(8), deadline checks and per-attempt exception suppression.
    from scranton_pipeline.tools import sandbox as module

    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    calls = []
    original = ProcResult(None, True, False, 0, "original", 8, None)

    def runner(argv, **kwargs):
        calls.append((list(argv), kwargs))
        if argv[1] == "run":
            return original
        if failure == "exception":
            raise OSError("Docker unavailable")
        return ProcResult(1 if failure == "exit" else 0, failure == "timeout", failure == "stopped",
                          0, "", 0, None)

    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner)
    assert box.run(["check"], timeout_s=1, log_path=tmp_path / "log") is original
    name = calls[0][0][calls[0][0].index("--name") + 1]
    removal = ["docker", "rm", "-f", name]
    query = ["docker", "ps", "-a", "-q", "--filter", f"name=^/{name}$"]
    assert [argv for argv, _ in calls[1:]] == ([removal] if failure == "exception" else [removal, query]) * 8
    assert clock[0] == pytest.approx(2.1)
    assert all(0 < kw["timeout_s"] <= 1 for _, kw in calls[1:])


def test_run_cleanup_enforces_total_deadline(tmp_path, monkeypatch):
    # Guard: deadline - monotonic() bounds even repeated slow Docker commands.
    from scranton_pipeline.tools import sandbox as module

    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    calls = []
    original = ProcResult(None, True, False, 0, "", 0, None)

    def runner(argv, **kwargs):
        if argv[1] == "run":
            return original
        calls.append((list(argv), kwargs["timeout_s"]))
        clock[0] += kwargs["timeout_s"]
        return ProcResult(None, True, False, 0, "", 0, None)

    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner)
    assert box.run(["check"], timeout_s=1, log_path=tmp_path / "log") is original
    assert [argv[1] for argv, _ in calls] == ["rm", "ps", "rm", "ps", "rm"]
    assert [timeout for _, timeout in calls] == pytest.approx([1, 1, 1, 1, .4])
    assert clock[0] == 5


def test_run_cleanup_waits_out_initial_absence(tmp_path, monkeypatch):
    # Guard: pending absence needs the two-second observation window, not a single empty ps.
    from scranton_pipeline.tools import sandbox as module

    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    calls = []
    original = ProcResult(None, True, False, 0, "", 0, None)

    def runner(argv, **kwargs):
        calls.append(list(argv))
        if argv[1] == "run":
            return original
        return ProcResult(0, False, False, 0, "", 0, None)

    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner)
    assert box.run(["check"], timeout_s=1, log_path=tmp_path / "log") is original
    name = calls[0][calls[0].index("--name") + 1]
    assert calls[1:] == [["docker", "rm", "-f", name],
                         ["docker", "ps", "-a", "-q", "--filter", f"name=^/{name}$"]] * 8
    assert clock[0] == pytest.approx(2.1)


def test_run_cleanup_normal_survivor_removed_and_rechecked(tmp_path, monkeypatch):
    # Guard: normal completion with a leftover container must also remove and confirm absence.
    from scranton_pipeline.tools import sandbox as module

    monkeypatch.setattr(module.time, "sleep", lambda seconds: None)
    calls = []
    original = ProcResult(0, False, False, 0, "", 0, None)
    replies = iter(["abcdef123456\n", "removed", ""])

    def runner(argv, **kwargs):
        calls.append(list(argv))
        if argv[1] == "run":
            return original
        tail = next(replies)
        return ProcResult(0, False, False, 0, tail, len(tail), None)

    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", runner)
    assert box.run(["check"], timeout_s=1, log_path=tmp_path / "log") is original
    name = calls[0][calls[0].index("--name") + 1]
    query = ["docker", "ps", "-a", "-q", "--filter", f"name=^/{name}$"]
    assert calls[1:] == [query, ["docker", "rm", "-f", name], query]

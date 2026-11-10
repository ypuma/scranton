import ctypes
import os
import sys
import threading

import pytest

from scranton_pipeline.config import SandboxConfig
from scranton_pipeline.errors import EngineError
from scranton_pipeline.tools.git import WorkspaceRepo, list_source_files
from scranton_pipeline.tools.process import ProcResult, StopSignal, run_process, scrubbed_env
from scranton_pipeline.tools.sandbox import DockerSandbox, build_sandbox
from scranton_pipeline.tools.secrets import Redactor


def test_scrubbed_environment_denies_credentials_even_in_extra():
    base = {"PATH": "x", "SYSTEMROOT": "w", "OPENAI_API_KEY": "secret", "TOKEN_NAME": "secret", "MY_SECRET": "secret", "KEEP": "yes", "PYTHONPATH": "unsafe"}
    env = scrubbed_env(base, list(base), {"API_KEY": "still denied", "GIT_CONFIG_NOSYSTEM": "1"})
    assert not any("KEY" in k or "TOKEN" in k or "SECRET" in k for k in env)
    assert env["KEEP"] == "yes" and env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert "PYTHONPATH" not in scrubbed_env(base, [])
    fixed = scrubbed_env({}, [], {"GIT_AUTHOR_NAME": "Pipeline", "GIT_AUTHOR_EMAIL": "pipeline@localhost", "HTTP_AUTHORIZATION": "no", "NPM_AUTH_TOKEN": "no", "OPENAI_API_KEY": "no"})
    assert fixed == {"GIT_AUTHOR_NAME": "Pipeline", "GIT_AUTHOR_EMAIL": "pipeline@localhost"}


def test_real_shell_free_output_cap_and_redacted_log(tmp_path):
    Redactor(["child-secret-value"])
    result = run_process([sys.executable, "-c", "import sys; print('child-secret-value'); print('x'*20000); print('stderr', file=sys.stderr)"],
                         cwd=tmp_path, env=scrubbed_env(os.environ, []), timeout_s=5,
                         tail_bytes=64, max_log_bytes=100, log_path=tmp_path / "check.log")
    assert result.exit_code == 0 and result.output_bytes > 20000
    assert len(result.output_tail.encode()) <= 64
    assert (tmp_path / "check.log").stat().st_size <= 100
    assert "child-secret-value" not in (tmp_path / "check.log").read_text()
    with pytest.raises(EngineError) as raised:
        run_process(["scranton-missing-executable-12345"], cwd=tmp_path, env={}, timeout_s=1)
    assert raised.value.code == "executable_not_found"


def _assert_dead(pid):
    if os.name == "nt":
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        api.OpenProcess.restype = ctypes.c_void_p
        api.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        api.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = api.OpenProcess(0x100000, 0, pid)
        if handle:
            try:
                assert api.WaitForSingleObject(handle, 2000) == 0, f"process {pid} escaped"
            finally:
                api.CloseHandle(handle)
    else:
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


@pytest.mark.parametrize("mode", ["timeout", "suspend", "cancel", "parent_exit"])
def test_owned_tree_kills_child_and_grandchild(tmp_path, mode):
    child = tmp_path / "child.py"
    grand = tmp_path / "grand.py"
    grand.write_text("import os,time\nfrom pathlib import Path\nPath('grand.pid').write_text(str(os.getpid()))\ntime.sleep(60)\n")
    child.write_text("import os,subprocess,sys,time\nfrom pathlib import Path\nPath('child.pid').write_text(str(os.getpid()))\nsubprocess.Popen([sys.executable, 'grand.py'])\nwhile not Path('grand.pid').exists(): time.sleep(0.01)\n" + ("" if mode == "parent_exit" else "time.sleep(60)\n"))
    stop = StopSignal(tmp_path / "cancel")
    timer = (threading.Timer(1, stop.request_suspend) if mode == "suspend" else
             threading.Timer(1, lambda: stop.cancel_file.write_text("cancel")) if mode == "cancel" else None)
    if timer:
        timer.start()
    try:
        result = run_process([sys.executable, str(child)], cwd=tmp_path, env=scrubbed_env(os.environ, []),
                             timeout_s=1 if mode == "timeout" else 10, stop=stop)
    finally:
        if timer:
            timer.cancel()
    assert (tmp_path / "grand.pid").exists()
    assert result.timed_out == (mode == "timeout")
    assert result.stopped == (mode in ("suspend", "cancel"))
    _assert_dead(int((tmp_path / "child.pid").read_text()))
    _assert_dead(int((tmp_path / "grand.pid").read_text()))
    assert result.duration_s < 4


def test_real_git_without_user_identity_and_tracks_deletion(tmp_path, monkeypatch):
    empty = tmp_path / "empty-config"
    empty.write_text("")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty))
    for key in list(os.environ):
        if key.startswith(("GIT_AUTHOR_", "GIT_COMMITTER_")):
            monkeypatch.delenv(key)
    repo_dir = tmp_path / "repo"
    repo = WorkspaceRepo.init(repo_dir)
    (repo_dir / "a.txt").write_bytes(b"before\r\n")
    (repo_dir / "delete.txt").write_text("delete")
    base = repo.commit_all("baseline")
    assert len(base) == 40
    (repo_dir / "a.txt").write_bytes(b"after\r\n")
    (repo_dir / "delete.txt").unlink()
    head = repo.commit_paths(["a.txt", "delete.txt"], "attempt")
    assert sorted(repo.changed_files(base, head)) == [("D", "delete.txt"), ("M", "a.txt")]
    assert "after" in repo.diff(base, head)
    assert repo.numstat(base, head)
    (repo_dir / "a.txt").write_text("check damage")
    assert repo.restore_tracked() == ["a.txt"]
    assert (repo_dir / "a.txt").read_bytes() == b"after\r\n"
    repo.reset_hard(base)
    assert (repo_dir / "delete.txt").exists()
    (repo_dir / "untracked").write_text("new")
    assert list_source_files(repo_dir, timeout_s=5) == (["a.txt", "delete.txt", "untracked"], False)


def test_non_git_inventory_skips_ignored_directories(tmp_path):
    (tmp_path / "file.txt").write_text("x")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "omit").write_text("x")
    assert list_source_files(tmp_path, timeout_s=5) == (["file.txt"], False)


def test_host_requires_trust(tmp_path):
    cfg = SandboxConfig(mode="host")
    with pytest.raises(EngineError) as raised:
        build_sandbox(cfg, workspace=tmp_path, run_id="abcdefgh", trust_host=False)
    assert raised.value.code == "host_trust_required"
    sandbox = build_sandbox(cfg, workspace=tmp_path, run_id="abcdefgh", trust_host=True)
    assert sandbox.describe()["isolated"] is False
    sandbox.preflight()


def test_docker_exact_argv_and_cleanup_without_engine(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from scranton_pipeline.tools import sandbox as module
    monkeypatch.setattr(module.uuid, "uuid4", lambda: SimpleNamespace(hex="0123456789abcdef"))
    monkeypatch.setattr(module.time, "time", lambda: 1000)
    calls = []

    def runner(argv, **kwargs):
        calls.append((list(argv), kwargs))
        return ProcResult(0, False, False, 0, "", 0, kwargs.get("log_path"))

    cfg = SandboxConfig()
    sandbox = DockerSandbox(cfg, tmp_path, "abcdefgh1234", runner=runner)
    sandbox.preflight()
    assert calls[0][0] == ["docker", "info", "--format", "{{.ServerVersion}}"]
    assert calls[1][0] == ["docker", "image", "inspect", "scranton-pipeline-sandbox:0.1.0"]
    sandbox.run(["python", "-m", "pytest"], timeout_s=3, log_path=tmp_path / "docker.log")
    name = f"scranton-pipeline-abcdefgh-{os.getpid()}-0123456789ab-1"
    assert calls[2][0] == ["docker", "run", "--rm", "--pull", "never", "--name", name, "--log-driver", "none", "--network", "none", "--cpus", "2", "--memory", "2048m", "--memory-swap", "2048m", "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m", "--user", "10001:10001", "--label", "scranton.pipeline.run=abcdefgh1234", "--label", "scranton.pipeline.deadline=1033", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--env", "HOME=/tmp", "--env", "LANG=C.UTF-8", "--env", "TMPDIR=/tmp",
        "--env", "XDG_CACHE_HOME=/tmp/cache", "--env", "PIP_CACHE_DIR=/tmp/pip-cache",
        "--env", "PYTHONUSERBASE=/workspace/.pipeline/python", "--env", "PYTHONPYCACHEPREFIX=/tmp/pycache",
        "--env", "PIP_DISABLE_PIP_VERSION_CHECK=1", "--env", "NPM_CONFIG_PREFIX=/workspace/.pipeline/npm",
        "--env", "NPM_CONFIG_CACHE=/tmp/npm-cache", "--env", "NODE_PATH=/workspace/.pipeline/npm/lib/node_modules",
        "--env", "PATH=/workspace/.pipeline/python/bin:/workspace/.pipeline/npm/bin:/usr/local/bin:/usr/bin:/bin", "-v", f"{tmp_path.resolve()}:/workspace", "-v", f"{sandbox.state_dir.resolve()}:/workspace/.pipeline:ro", "-w", "/workspace", "--entrypoint", "python", "scranton-pipeline-sandbox:0.1.0", "-m", "pytest"]
    assert calls[3][0] == ["docker", "ps", "-a", "-q", "--filter", f"name=^/{name}$"]
    sandbox.run(["setup"], timeout_s=3, log_path=tmp_path / "setup.log", network=True, writable_state=True)
    assert calls[4][0][calls[4][0].index("--network") + 1] == "bridge"
    assert f"{sandbox.state_dir.resolve()}:/workspace/.pipeline:rw" in calls[4][0]
    assert all("pull" not in argv[:2] and "build" not in argv[:2] for argv, _ in calls)


def test_shell_metacharacters_are_literal_arguments(tmp_path):
    dangerous = "hello & echo escaped > injected.txt"
    result = run_process([sys.executable, "-c", "import sys; print(sys.argv[1])", dangerous],
                         cwd=tmp_path, env=scrubbed_env(os.environ, []), timeout_s=5)
    assert dangerous in result.output_tail
    assert not (tmp_path / "injected.txt").exists()


def test_windows_batch_resolution_is_refused(tmp_path):
    if os.name != "nt":
        pytest.skip("Windows batch-file execution semantics")
    (tmp_path / "unsafe.cmd").write_text("@echo off\necho unsafe\n")
    env = scrubbed_env(os.environ, [])
    env["PATH"] = str(tmp_path) + os.pathsep + env.get("PATH", "")
    with pytest.raises(EngineError) as raised:
        run_process(["unsafe", "a&b"], cwd=tmp_path, env=env, timeout_s=5)
    assert raised.value.code == "unsafe_shim_arguments"


def test_docker_failure_is_closed_and_timeout_kills_container(tmp_path):
    calls = []

    def unavailable(argv, **kwargs):
        calls.append(list(argv))
        return ProcResult(1, False, False, 0, "unavailable", 11, None)

    sandbox = DockerSandbox(SandboxConfig(), tmp_path, "abcdefgh", runner=unavailable)
    with pytest.raises(EngineError) as raised:
        sandbox.preflight()
    assert raised.value.code == "docker_unavailable"
    calls.clear()

    def timeout(argv, **kwargs):
        calls.append(list(argv))
        return ProcResult(None, True, False, 0, "", 0, None)

    sandbox = DockerSandbox(SandboxConfig(), tmp_path, "abcdefgh", runner=timeout)
    assert sandbox.run(["check"], timeout_s=1, log_path=tmp_path / "log").timed_out
    name = calls[0][calls[0].index("--name") + 1]
    assert calls[1:] == [["docker", "rm", "-f", name],
                         ["docker", "ps", "-a", "-q", "--filter", f"name=^/{name}$"]] * 8

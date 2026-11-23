"""Host identity selection must preserve private bind-mount access without root."""
import pytest

from scranton_pipeline.config import SandboxConfig
from scranton_pipeline.errors import EngineError
from scranton_pipeline.tools import sandbox as module
from scranton_pipeline.tools.process import ProcResult


@pytest.mark.parametrize(("platform", "uid", "gid", "expected"), [
    ("linux", 1000, 1000, "1000:1000"),
    ("linux", 1234, 5678, "1234:5678"),
    ("linux", 10001, 10001, "10001:10001"),
    ("darwin", 501, 20, "501:20"),
    ("win32", 1000, 1000, "10001:10001"),
    ("linux", 0, 0, "10001:10001"),
    ("darwin", 0, 0, "10001:10001"),
    ("linux", 1000, 0, "1000:1000"),
    ("linux", 0, 1000, "10001:1000"),
    ("linux", None, None, "10001:10001"),
    ("win32", None, None, "10001:10001"),
    ("darwin", 501, None, "501:501"),
])
@pytest.mark.parametrize("writable_state", [False, True])
def test_command_uses_non_root_host_identity(monkeypatch, tmp_path, platform, uid, gid,
                                             expected, writable_state):
    workspace = tmp_path / "workspace"
    workspace.mkdir(mode=0o700)
    state = tmp_path / "state"
    calls = []

    def runner(argv, **kwargs):
        calls.append(list(argv))
        return ProcResult(0, False, False, 0, "", 0, None)

    monkeypatch.setattr(module.sys, "platform", platform)
    for name, value in (("getuid", uid), ("getgid", gid)):
        if value is None:
            monkeypatch.delattr(module.os, name, raising=False)
        else:
            monkeypatch.setattr(module.os, name, lambda value=value: value, raising=False)
    box = module.DockerSandbox(SandboxConfig(mode="docker"), workspace, "12345678", runner, state_dir=state)
    box.run(["python", "check.py"], timeout_s=1, log_path=tmp_path / "log",
            writable_state=writable_state)
    command = calls[0]
    assert command[:2] == ["docker", "run"]
    assert command.count("--user") == 1
    assert command[command.index("--user") + 1] == expected
    assert all(int(part) > 0 for part in expected.split(":"))
    for flag, value in (("--pull", "never"), ("--network", "none"), ("--cap-drop", "ALL"),
                        ("--security-opt", "no-new-privileges")):
        assert command[command.index(flag) + 1] == value
    assert "--read-only" in command
    assert f"{workspace.resolve()}:/workspace" in command
    assert f"{state.resolve()}:/workspace/.pipeline:{'rw' if writable_state else 'ro'}" in command
    assert command[-4:] == ["--entrypoint", "python", module.default_image(), "check.py"]


@pytest.mark.parametrize(("uid", "gid"), [(-1, 1000), (1000, -1)])
def test_invalid_identity_fails_before_docker_or_state_creation(monkeypatch, tmp_path, uid, gid):
    monkeypatch.setattr(module.sys, "platform", "linux")
    monkeypatch.setattr(module.os, "getuid", lambda: uid, raising=False)
    monkeypatch.setattr(module.os, "getgid", lambda: gid, raising=False)
    calls = []
    state = tmp_path / "state"
    box = module.DockerSandbox(SandboxConfig(mode="docker"), tmp_path / "workspace", "12345678",
                               lambda *args, **kwargs: calls.append(args), state_dir=state)
    with pytest.raises(EngineError) as raised:
        box.run(["true"], timeout_s=1, log_path=tmp_path / "log")
    assert raised.value.code == "invalid_sandbox_user"
    assert calls == []
    assert not state.exists()

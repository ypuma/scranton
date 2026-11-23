"""Opt-in real Windows gate: the Python Job owns the Node runner and native helper."""
import base64
import ctypes
import json
import os
import shutil
import socket
import sys
import threading
from pathlib import Path

import pytest

from scranton_pipeline.cli import main
from scranton_pipeline.config import SandboxConfig
from scranton_pipeline.errors import EngineError
from scranton_pipeline.tools.native_sandbox import BINDING, NativeSandbox, probe_native
from scranton_pipeline.tools.process import StopSignal
from scranton_pipeline.tools.sandbox import build_sandbox

pytestmark = pytest.mark.skipif(sys.platform != "win32" or os.environ.get("SCRANTON_PIPELINE_NATIVE_TEST") != "1",
                                reason="set SCRANTON_PIPELINE_NATIVE_TEST=1 on Windows to exercise the real runner")
REPO = Path(__file__).resolve().parents[3]


@pytest.fixture
def native_binding(tmp_path, monkeypatch):
    node = shutil.which("node")
    runner = REPO / "tools" / "pipeline-sandbox.js"
    helper = REPO / "src-tauri" / "binaries" / "scranton-sandbox-helper-x86_64-pc-windows-msvc.exe"
    assert node and runner.is_file() and helper.is_file(), "The Windows gate needs the local Node runner and staged helper"
    monkeypatch.setenv(BINDING, json.dumps([str(Path(node).resolve()), str(runner)]))
    monkeypatch.setenv("SCRANTON_SANDBOX_HELPER", str(helper))
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    monkeypatch.setenv("SCRANTON_CREDENTIALS_DIR", str(credentials))
    return tmp_path


def ps(script):
    powershell = Path(os.environ["SYSTEMROOT"]) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    encoded = base64.b64encode(("$ErrorActionPreference='Stop'; " + script).encode("utf-16le")).decode("ascii")
    return [str(powershell), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]


def quote(path):
    return "'" + str(path).replace("'", "''") + "'"


@pytest.fixture(params=["low", "strict"])
def boxes(native_binding, request):
    root = native_binding
    mode = request.param
    run_dir = root / "run"
    run_dir.mkdir()
    work = root / "work"
    box = NativeSandbox(SandboxConfig(windows_mode=mode), work, run_dir)
    box.preflight()
    box.allocate()
    host = build_sandbox(SandboxConfig(mode="host"), workspace=work, run_id="wintest1", trust_host=True)
    yield box, host, root, run_dir, work
    box.cleanup()


def test_writes_stay_in_workspace(boxes):
    box, host, root, run_dir, work = boxes
    source = root / "source"
    source.mkdir()
    targets = [root / "sibling", source / "sentinel", run_dir / "sentinel"]
    for p in targets:
        p.write_bytes(b"unchanged")
    writes = [f"[IO.File]::WriteAllText({quote(path)}, 'changed')" for path in targets]
    positive = host.run(ps("; ".join(writes)), timeout_s=12, log_path=run_dir / "host.log")
    assert positive.exit_code == 0, positive.output_tail
    for p in targets:
        assert p.read_bytes() == b"changed"
        p.write_bytes(b"unchanged")
    cmd = f"[IO.File]::WriteAllText({quote(work / 'inside')}, 'written'); " + "; ".join(
        "try { " + op + "; exit 89 } catch { if ($_.Exception.InnerException -isnot [UnauthorizedAccessException]) { throw } }"
        for op in writes) + "; exit 0"
    observed = box.run(ps(cmd), timeout_s=15, log_path=run_dir / "native.log")
    assert observed.exit_code == 0, observed.output_tail
    assert (work / "inside").read_bytes() == b"written"
    assert all(p.read_bytes() == b"unchanged" for p in targets)


def test_strict_denies_loopback(native_binding):
    root = native_binding
    mode = SandboxConfig(windows_mode="strict")
    box = NativeSandbox(mode, root / "work", root / "run")
    box.preflight()
    box.allocate()
    host = build_sandbox(SandboxConfig(mode="host"), workspace=box.workspace, run_id="wintest1", trust_host=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(2)
        # WFP can reject immediately or drop the attempt. The same driver must
        # connect on host, and strict must reach the socket call and finish itself.
        command = ps(f"$tcp=New-Object Net.Sockets.TcpClient; $state='BLOCKED'; "
                     f"try {{ $connect=$tcp.ConnectAsync('127.0.0.1',{listener.getsockname()[1]}); "
                     "if ($connect.Wait(2000) -and $tcp.Connected) { $state='CONNECTED' } "
                     "} catch { if ($_.Exception.GetBaseException().SocketErrorCode -ne 'AccessDenied') { throw } }; "
                     "[Console]::Out.WriteLine($state); $tcp.Dispose(); exit 0")
        def positive_control():
            observed = host.run(command, timeout_s=10, log_path=root / "host.log")
            assert observed.exit_code == 0 and "CONNECTED" in observed.output_tail.splitlines(), observed.output_tail
            conn, _ = listener.accept()
            conn.close()
        positive_control()
        result = box.run(command, timeout_s=12, log_path=root / "strict.log")
        assert result.exit_code == 0 and "BLOCKED" in result.output_tail.splitlines(), result.output_tail
        listener.settimeout(.3)
        with pytest.raises(TimeoutError):
            listener.accept()
        listener.settimeout(2)
        positive_control()
    box.cleanup()


def assert_process_dead(pid):
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x100000, False, pid)
    if handle:
        try:
            assert kernel.WaitForSingleObject(handle, 500) == 0, f"Descendant {pid} survived"
        finally:
            kernel.CloseHandle(handle)
    else:
        assert ctypes.get_last_error() == 87, "Unable to verify descendant state"


@pytest.mark.parametrize("cancel", [False, True])
def test_stop_kills_grandchild(boxes, cancel):
    box, _, _, run_dir, work = boxes
    pidfile = work / "child.pid"
    stop = StopSignal(run_dir / "cancel")
    ping = Path(os.environ["SYSTEMROOT"]) / "System32" / "ping.exe"
    payload = (f"$info=New-Object Diagnostics.ProcessStartInfo; $info.FileName={quote(ping)}; "
               "$info.Arguments='-t 127.0.0.1'; $info.UseShellExecute=$false; "
               "$p=[Diagnostics.Process]::Start($info); "
               f"[IO.File]::WriteAllText({quote(pidfile)}, [string]$p.Id); Start-Sleep -Seconds 60")
    finished = threading.Event()
    def cancel_on_launch():
        while not finished.wait(.05):
            if pidfile.is_file() and pidfile.stat().st_size:
                stop.cancel_file.touch()
                return
    thread = threading.Thread(target=cancel_on_launch)
    if cancel:
        thread.start()
    try:
        result = box.run(ps(payload), timeout_s=20 if cancel else 8, log_path=run_dir / "tree.log", stop=stop)
    finally:
        finished.set()
        if cancel:
            thread.join()
    assert (result.stopped, result.timed_out) == (cancel, not cancel), result.output_tail
    assert pidfile.is_file(), result.output_tail
    assert_process_dead(int(pidfile.read_text().strip()))


def test_workspace_junction_requires_docker(native_binding):
    root = native_binding
    box = NativeSandbox(SandboxConfig(), root / "work", root / "run")
    box.allocate()
    target = box.workspace / "package"
    target.mkdir()
    result = box.run(ps(f"New-Item -ItemType Junction -Path {quote(box.workspace / 'dependency')} "
                        f"-Target {quote(target)} | Out-Null"), timeout_s=15, log_path=root / "setup.log")
    assert result.exit_code == 0, result.output_tail
    assert (box.workspace / "dependency").is_junction()
    with pytest.raises(EngineError, match="workspace contains a link or junction.*Docker") as caught:
        box.run(ps("exit 0"), timeout_s=15, log_path=root / "check.log")
    assert caught.value.code == "sandbox_failed"
    box.cleanup()


def test_strict_junction_cleanup_warns_without_replacing_exit(native_binding, caplog):
    root = native_binding
    box = NativeSandbox(SandboxConfig(windows_mode="strict"), root / "work", root / "run")
    box.allocate()
    target = box.workspace / "package"
    target.mkdir()
    result = box.run(ps(f"New-Item -ItemType Junction -Path {quote(box.workspace / 'dependency')} "
                        f"-Target {quote(target)} | Out-Null; exit 17"), timeout_s=15, log_path=root / "check.log")
    assert result.exit_code == 17, result.output_tail
    assert "profile was removed, but some workspace permission entries could not be removed safely" in caplog.text
    assert list(box.control.glob("call-*/record.json")) == []
    box.cleanup()


def test_low_demo(native_binding, capsys):
    root = native_binding / "runs"
    assert probe_native("low", native_binding / "probe")["available"]
    assert main(["demo", "--sandbox", "scranton", "--run-root", str(root), "--run-id", "wintest1", "--delivery", "apply"]) == 3
    status = json.loads(capsys.readouterr().out)
    for gate in ("plan", "delivery"):
        assert status["pending"]["gate"] == gate
        assert main(["resume", "--run-dir", str(root / "wintest1"), "--gate", gate, "--decision", "approve",
                     "--digest", status["pending"]["digest"]]) == (3 if gate == "plan" else 0)
        status = json.loads(capsys.readouterr().out)
    assert status["status"] == "succeeded" and status["sandbox"]["backend"] == "low-integrity"

"""Shell-free bounded subprocesses with process-tree ownership."""
import ctypes
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import EngineError, FailureClass
from .fs import write_bytes_atomic
from .secrets import Redactor


class StopSignal:
    def __init__(self, cancel_file: Path) -> None:
        self.cancel_file = cancel_file
        self._suspend = threading.Event()

    def request_suspend(self) -> None:
        self._suspend.set()

    def cancel_requested(self) -> bool:
        return self.cancel_file.exists()

    def suspend_requested(self) -> bool:
        return self._suspend.is_set()

    def should_stop(self) -> bool:
        return self.cancel_requested() or self.suspend_requested()


@dataclass(frozen=True)
class ProcResult:
    exit_code: int | None
    timed_out: bool
    stopped: bool
    duration_s: float
    output_tail: str
    output_bytes: int
    log_path: Path | None


class _Job:
    def __init__(self) -> None:
        from ctypes import wintypes as w

        class Basic(ctypes.Structure):
            _fields_ = [("per_process", ctypes.c_int64), ("per_job", ctypes.c_int64),
                        ("flags", w.DWORD), ("min_ws", ctypes.c_size_t), ("max_ws", ctypes.c_size_t),
                        ("active", w.DWORD), ("affinity", ctypes.c_size_t),
                        ("priority", w.DWORD), ("scheduling", w.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("process_mem", ctypes.c_size_t),
                        ("job_mem", ctypes.c_size_t), ("peak_process", ctypes.c_size_t),
                        ("peak_job", ctypes.c_size_t)]

        self.api: Any = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.api.CreateJobObjectW.restype = w.HANDLE
        self.api.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.api.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        info = Extended()
        info.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE, including surviving descendants.
        if not self.handle or not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            self.close()
            raise OSError("Cannot create process Job Object")

    def assign_resume(self, proc: subprocess.Popen[bytes]) -> None:
        handle = proc._handle  # type: ignore[attr-defined]
        if not self.api.AssignProcessToJobObject(self.handle, int(handle)):
            raise OSError("Cannot assign process to Job Object")
        ntdll: Any = ctypes.WinDLL("ntdll")
        ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]
        ntdll.NtResumeProcess.restype = ctypes.c_long
        if ntdll.NtResumeProcess(int(handle)) < 0:
            raise OSError("Cannot resume owned process")

    def close(self) -> None:
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


def run_process(argv: Sequence[str], *, cwd: Path, env: Mapping[str, str], timeout_s: float,
                log_path: Path | None = None, tail_bytes: int = 8192, max_log_bytes: int = 5000000,
                stop: StopSignal | None = None, redact_output: bool = True) -> ProcResult:
    if not argv or timeout_s <= 0 or tail_bytes < 0 or max_log_bytes < 0:
        raise EngineError(FailureClass.INVALID_INPUT, "invalid_process", "Invalid process bounds")
    name = argv[0].rstrip(" .") if os.name == "nt" else argv[0]
    executable = shutil.which(name, path=env.get("PATH")) or name
    command: Sequence[str] | str = list(argv)
    if os.name == "nt" and Path(executable.rstrip(" .")).suffix.lower() in (".bat", ".cmd"):
        if (any(not re.fullmatch(r"[A-Za-z0-9_./:=+,@\\-]+", arg) for arg in argv[1:])
                or any(c in str(executable) for c in '\"&|<>^%!\r\n')):
            raise EngineError(FailureClass.INVALID_INPUT, "unsafe_shim_arguments",
                              "Windows shims require simple arguments without whitespace, quotes or shell metacharacters; use a native executable for complex arguments")
        comspec = str(Path(os.environ.get("SYSTEMROOT", "C:/Windows")) / "System32" / "cmd.exe")
        command = f'"{comspec}" /d /s /c ""{executable}" {" ".join(argv[1:])}"' 
    started = time.monotonic()
    job = _Job() if os.name == "nt" else None
    proc: subprocess.Popen[bytes] | None = None
    tail = bytearray()
    log = bytearray()
    count = 0
    timed_out = stopped = False
    try:
        try:
            proc = subprocess.Popen(command, cwd=cwd, env=dict(env), shell=False,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, start_new_session=os.name != "nt",
                                    creationflags=0x4 if os.name == "nt" else 0)
            if job:
                job.assign_resume(proc)
        except FileNotFoundError as exc:
            raise EngineError(FailureClass.INFRASTRUCTURE, "executable_not_found", f"Cannot start executable: {argv[0]} ({exc})") from exc
        except OSError as exc:
            raise EngineError(FailureClass.INFRASTRUCTURE, "process_start_failed", f"Cannot start owned process: {argv[0]} ({exc})") from exc
        assert proc.stdout is not None
        output = proc.stdout

        def drain() -> None:
            nonlocal count
            while chunk := output.read(4096):
                count += len(chunk)
                log.extend(chunk[:max(0, max_log_bytes - len(log))])
                tail.extend(chunk)
                if len(tail) > tail_bytes:
                    del tail[:len(tail) - tail_bytes]

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        while proc.poll() is None:
            stopped = stop is not None and stop.should_stop()
            timed_out = time.monotonic() - started >= timeout_s
            if stopped or timed_out:
                break
            time.sleep(0.05)
        # Close ownership even on normal parent exit: a daemon grandchild is not allowed to escape.
        if job:
            job.close()
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # type: ignore[attr-defined]
            except ProcessLookupError:
                pass
        proc.wait(timeout=10)
        reader.join(timeout=10)
        if reader.is_alive():
            raise EngineError(FailureClass.INFRASTRUCTURE, "output_not_closed", "Process output did not close")
        redactor = Redactor()
        text = tail.decode("utf-8", errors="replace")
        if redact_output:
            text = redactor.redact(text)
        text = text.encode("utf-8")[-tail_bytes:].decode("utf-8", errors="ignore") if tail_bytes else ""
        if log_path:
            safe = redactor.redact(log.decode("utf-8", errors="replace")).encode("utf-8")
            write_bytes_atomic(log_path, safe[:max_log_bytes].decode("utf-8", errors="ignore").encode("utf-8"))
        return ProcResult(proc.returncode, timed_out, stopped, time.monotonic() - started,
                          text, count, log_path)
    finally:
        if job:
            job.close()
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            if proc.stdout:
                proc.stdout.close()


def scrubbed_env(base: Mapping[str, str], passthrough: Sequence[str], extra: Mapping[str, str] | None = None) -> dict[str, str]:
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
               "HOME", "USERPROFILE", "LANG", "LC_ALL", "LOCALAPPDATA", "APPDATA", "PYTHONPYCACHEPREFIX"}
    allowed.update(name.upper() for name in passthrough)
    # AUTH is a credential segment, not the prefix of AUTHOR (Git's fixed identity).
    forbidden = re.compile(r"API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:^|_)AUTH(?:_|$)", re.IGNORECASE)
    values = {**base, **(extra or {})}
    return {key: value for key, value in values.items()
            if (key.upper() in allowed or key in (extra or {})) and not forbidden.search(key)}

"""Engine adapter for the trusted Pipeline native sandbox runner (protocol 1)."""
import hashlib
import json
import logging
import math
import os
import shutil
import stat
import sys
import tempfile
import time
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any, Literal

from ..config import SandboxConfig
from ..errors import EngineError, FailureClass
from .fs import SANDBOX_MARKER, write_bytes_atomic
from .process import ProcResult, StopSignal, run_process, scrubbed_env, windows_shim

WindowsMode = Literal["low", "strict"]
BINDING = "SCRANTON_PIPELINE_NATIVE_COMMAND"
WINDOWS_ONLY = "Scranton sandbox for Pipeline is available on Windows only in this version"
RUNNER_MISSING = f"runner_missing: {BINDING} must name the installed runner and its executable as absolute files"
CONTROL_KEYS = frozenset({"SYSTEMROOT", "WINDIR", "PATHEXT", "PATH", "TEMP", "TMP", "USERPROFILE",
                          "LOCALAPPDATA", "APPDATA", "HOME", "SCRANTON_SANDBOX_HELPER", "SCRANTON_CREDENTIALS_DIR"})
PROBE_REASONS = frozenset({
    "Cannot create a private Windows sandbox probe fixture",
    "Windows sandbox probe could not establish its host loopback control",
    "Cannot prepare strict Windows AppContainer; verify the helper and Windows AppContainer support",
    "Strict Windows sandbox canary failed its filesystem or loopback boundary",
    "Cannot prepare Windows Low sandbox; verify the helper and Windows Low integrity support",
    "Windows Low sandbox canary failed its filesystem boundary",
    "Windows sandbox probe cleanup failed",
})
ERROR_MESSAGES = {
    "policy": "Native sandbox policy could not be applied; check the configured Windows mode and workspace.",
    "launch": "Native sandbox could not launch the command; check that the executable is installed and accessible in this Windows mode.",
    "ownership": "Native sandbox refused a workspace or temporary directory it could not verify.",
    "cleanup": "Native sandbox could not clean up a strict profile; recovery will retry.",
    "workspace_link": "The workspace contains a link or junction. Use Docker for projects with links or junctions.",
    "protocol": "Native sandbox runner returned an invalid response; check the Scranton installation.",
}


def _cleanup_warning(value: dict[str, Any]) -> bool:
    if "warning" not in value:
        return False
    if value.pop("warning") != "ace_cleanup_incomplete":
        raise failure()
    return True


def _warn_partial_cleanup() -> None:
    logging.getLogger(__name__).warning("Strict AppContainer profile was removed, but some workspace permission entries could not be removed safely.")


def failure(reason: str = "protocol") -> EngineError:
    return EngineError(FailureClass.INFRASTRUCTURE, "sandbox_failed", ERROR_MESSAGES.get(reason, reason))


def binding() -> list[str] | None:
    try:
        raw = json.loads(os.environ.get(BINDING, "null"))
        if (isinstance(raw, list) and len(raw) == 2 and all(isinstance(arg, str) and "\0" not in arg
                and Path(arg).is_absolute() and Path(arg).is_file() for arg in raw)
                and Path(raw[0]).suffix.casefold() not in {".cmd", ".bat"}):
            return raw
    except (OSError, ValueError, RecursionError):
        pass
    return None


def _json(raw: str) -> dict[str, Any]:
    def unique(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate protocol key")
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        if isinstance(value, dict) and type(value.get("protocol")) is int and value["protocol"] == 1:
            return value
    except (ValueError, RecursionError):
        pass
    raise failure()


def _control_env() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if key.upper() in CONTROL_KEYS}


def _control(verb: str, *flags: str, cwd: Path, timeout: float = 30) -> dict[str, Any]:
    command = binding()
    if command is None:
        raise failure(RUNNER_MISSING)
    try:
        result = run_process([*command, verb, "--protocol", "1", *flags], cwd=cwd, env=_control_env(),
                             timeout_s=timeout, tail_bytes=8192, redact_output=False, control_stdin=True)
    except (OSError, EngineError):
        raise failure() from None
    if result.exit_code != 0 or result.timed_out or result.stopped or result.output_bytes > 8192:
        raise failure()
    return _json(result.output_tail)


def probe_native(mode: WindowsMode, scratch: Path) -> dict[str, Any]:
    unavailable = {"protocol": 1, "available": False, "backend": None, "windows_mode": mode,
                   "check_network": None, "setup_network_allowed": False}
    if sys.platform != "win32":
        return {**unavailable, "reason": WINDOWS_ONLY}
    if binding() is None:
        return {**unavailable, "reason": RUNNER_MISSING}
    try:
        scratch.mkdir(parents=True, exist_ok=True)
        result = _control("probe", "--windows-mode", mode, "--scratch", str(scratch), cwd=scratch)
        expected = {"protocol": 1, "available": True, "backend": "appcontainer" if mode == "strict" else "low-integrity",
                    "windows_mode": mode, "check_network": "none" if mode == "strict" else "allow",
                    "setup_network_allowed": mode == "low", "reason": None}
        if type(result.get("available")) is bool and type(result.get("setup_network_allowed")) is bool:
            if result == expected:
                return result
            reason = result.get("reason")
            if (isinstance(reason, str) and result == {**unavailable, "reason": reason} and reason.strip()):
                # Only relay the runner's fixed diagnostic strings, not arbitrary paths or output.
                return {**unavailable, "reason": reason if reason in PROBE_REASONS else
                        f"Scranton sandbox ({mode}) canary failed; verify the Windows sandbox helper and mode support."}
    except (OSError, EngineError):
        pass
    return {**unavailable, "reason": ERROR_MESSAGES["protocol"]}


def check_native(mode: WindowsMode | None) -> dict[str, Any]:
    modes: tuple[WindowsMode, ...] = (mode,) if mode else ("low", "strict")
    with tempfile.TemporaryDirectory(prefix="scranton-native-check-") as scratch:
        return {"native": {"platform": sys.platform, **{m: probe_native(m, Path(scratch).resolve()) for m in modes}}}


def describe_native(cfg: SandboxConfig, setup_network: bool = False, *, ready: bool = True) -> dict[str, Any]:
    strict = cfg.windows_mode == "strict"
    return {"mode": "scranton", "image": None, "windows_mode": cfg.windows_mode,
            "backend": ("appcontainer" if strict else "low-integrity") if ready else None,
            "isolated": ready, "check_network": ("none" if strict else "allow") if ready else None,
            "setup_network": setup_network and not strict}


def _plain(path: Path) -> os.stat_result:
    attrs = path.lstat()
    if stat.S_ISLNK(attrs.st_mode) or getattr(attrs, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise failure("ownership")
    return attrs


def _executable(argv: Sequence[str], workspace: Path) -> list[str]:
    if not argv or not argv[0]:
        raise failure("launch")
    name = argv[0].rstrip(" .") if os.name == "nt" else argv[0]
    candidate = Path(name)
    if not candidate.is_absolute():
        if candidate.drive or candidate.root or "/" in name or "\\" in name:
            raise failure("launch")
        suffixes = [""]
        if os.name == "nt":
            suffixes = [ext for ext in os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";")
                        if ext.startswith(".") and ext[1:].isascii() and ext[1:].isalnum()]
            if candidate.suffix.casefold() in {ext.casefold() for ext in suffixes}:
                suffixes.insert(0, "")
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            base = Path(directory.strip('"'))
            if base.is_absolute() and not base.resolve().is_relative_to(workspace):
                hit = next((base / (name + ext) for ext in suffixes if (base / (name + ext)).is_file()
                            and not (base / (name + ext)).resolve().is_relative_to(workspace)), None)
                if hit is not None:
                    candidate = hit
                    break
    if not candidate.is_absolute() or candidate.resolve().is_relative_to(workspace) or not candidate.is_file():
        raise failure("launch")
    executable = str(candidate.resolve(strict=True))
    windows_shim(argv, executable)  # Validate here; the runner wraps the original absolute shim.
    return [executable, *argv[1:]]


class NativeSandbox:
    def __init__(self, cfg: SandboxConfig, workspace: Path, run_dir: Path) -> None:
        self.cfg = cfg
        self.workspace = workspace.absolute()
        self.control = run_dir.absolute() / "native-control"

    def describe(self) -> dict[str, Any]:
        return describe_native(self.cfg)

    def preflight(self) -> None:
        result = probe_native(self.cfg.windows_mode, self.control / "probe")
        if not result["available"]:
            raise failure(result["reason"])

    def _identity_path(self) -> Path:
        key = hashlib.sha256(os.fsencode(os.path.normcase(str(self.workspace)))).hexdigest()
        return self.control / "roots" / key

    def allocate(self) -> None:
        try:
            for p in reversed(self.workspace.parents):
                if p.exists() or p.is_symlink():
                    _plain(p)
                else:
                    p.mkdir(exist_ok=True)
                    _plain(p)
            self.control.mkdir(parents=True, exist_ok=True)
            result = _control("allocate", "--path", str(self.workspace), cwd=self.control)
            if (result.keys() != {"protocol", "path", "marker"} or not isinstance(result["path"], str)
                    or Path(result["path"]) != self.workspace or result["marker"] != SANDBOX_MARKER
                    or {p.name for p in self.workspace.iterdir()} != {SANDBOX_MARKER}):
                raise failure()
            write_bytes_atomic(self._identity_path(), self._identity())
        except OSError:
            raise failure("ownership") from None

    def _identity(self) -> bytes:
        for p in self.workspace.parents:
            _plain(p)
        root = _plain(self.workspace)
        marker = _plain(self.workspace / SANDBOX_MARKER)
        if not stat.S_ISDIR(root.st_mode) or not stat.S_ISREG(marker.st_mode) or marker.st_nlink != 1:
            raise failure("ownership")
        return f"{root.st_dev}:{root.st_ino}:{marker.st_dev}:{marker.st_ino}".encode()

    def verify_ownership(self) -> None:
        try:
            if self._identity_path().read_bytes() == self._identity():
                return
        except OSError:
            pass
        raise failure("ownership")

    def cleanup(self) -> None:
        # Called by the run owner, outside parallel work. Never sweep other runs.
        failed = False
        for directory in self.control.glob("call-*"):
            record = directory / "record.json"
            try:
                _plain(directory)
                if record.exists() or record.is_symlink():
                    _plain(record)
                    result = _control("recover", "--record", str(record), cwd=self.control)
                    warn = _cleanup_warning(result)
                    if (result.keys() != {"protocol", "recovered"} or type(result["recovered"]) is not bool
                            or record.exists() or (warn and not result["recovered"])):
                        raise failure("cleanup")
                    if warn:
                        _warn_partial_cleanup()
                shutil.rmtree(directory)
            except (OSError, EngineError):
                failed = True
        if failed:
            raise failure("cleanup")

    def run(self, argv: Sequence[str], *, timeout_s: float, log_path: Path, network: bool = False,
            stop: StopSignal | None = None, tail_bytes: int = 8192, max_log_bytes: int = 5000000,
            writable_state: bool = False) -> ProcResult:
        started = time.monotonic()
        command = binding()
        if command is None:
            raise failure(RUNNER_MISSING)
        if sys.platform != "win32":
            raise failure(WINDOWS_ONLY)
        if network and self.cfg.windows_mode == "strict":
            raise failure("policy")
        self.verify_ownership()
        try:
            payload_argv = _executable(argv, self.workspace)
            temp_parent = self.control / "temp"
            temp_parent.mkdir(exist_ok=True)
            directory = Path(tempfile.mkdtemp(prefix="call-", dir=self.control))
        except (OSError, ValueError):
            raise failure("launch") from None
        except EngineError as exc:
            if exc.code == "unsafe_shim_arguments":
                raise failure(exc.message) from None
            raise
        request, receipt, record = (directory / name for name in ("request.json", "receipt.json", "record.json"))
        try:
            remaining = timeout_s - (time.monotonic() - started)
            stopped = stop is not None and stop.should_stop()
            if stopped or remaining <= 0:
                return ProcResult(None, not stopped, stopped, time.monotonic() - started, "", 0, None)
            write_bytes_atomic(request, json.dumps({"protocol": 1, "root": str(self.workspace), "cwd": str(self.workspace),
                "temp_parent": str(temp_parent), "argv": payload_argv, "env": scrubbed_env(os.environ, self.cfg.env_passthrough),
                "network": network, "windows_mode": self.cfg.windows_mode, "deadline_ms": math.ceil(remaining * 1000) + 1500,
                "receipt": str(receipt), "record": str(record)}).encode())
            remaining = timeout_s - (time.monotonic() - started)
            if remaining <= 0:
                return ProcResult(None, True, False, time.monotonic() - started, "", 0, None)
            result = run_process([*command, "exec", "--protocol", "1", "--request", str(request)], cwd=self.control,
                                 env=_control_env(), timeout_s=remaining, log_path=log_path, stop=stop,
                                 tail_bytes=tail_bytes, max_log_bytes=max_log_bytes, control_stdin=True)
            if result.stopped or result.timed_out:
                return replace(result, exit_code=None, timed_out=result.timed_out and not result.stopped)
            if result.exit_code != 0:
                raise failure()
            info = _plain(receipt)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 8192:
                raise failure()
            with receipt.open("rb") as stream:
                value = _json(stream.read(8193).decode("utf-8"))
            warn = _cleanup_warning(value)
            if value.keys() != {"protocol", "state", "code", "error"}:
                raise failure()
            state, code, error = value["state"], value["code"], value["error"]
            if warn:
                _warn_partial_cleanup()
            if state == "exited" and type(code) is int and error is None:
                return replace(result, exit_code=code)
            if state in ("timed_out", "stopped") and code is None and error is None:
                return replace(result, exit_code=None, timed_out=state == "timed_out", stopped=state == "stopped")
            if (state == "error" and code is None and isinstance(error, dict) and error.keys() == {"code", "message"}
                    and isinstance(error["code"], str) and error["code"] in ERROR_MESSAGES and isinstance(error["message"], str)):
                raise failure(error["code"])
            raise failure()
        except EngineError as exc:
            if exc.code in {"sandbox_failed", "output_not_closed"}:
                raise
            raise failure("launch") from None
        except (OSError, UnicodeError):
            raise failure() from None
        finally:
            request.unlink(missing_ok=True)
            receipt.unlink(missing_ok=True)
            if not record.exists():
                shutil.rmtree(directory, ignore_errors=True)

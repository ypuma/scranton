"""Explicit host trust or fail-closed Docker isolation."""
import math
import os
import re
import sys
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Protocol

from .. import __version__
from ..config import SandboxConfig
from ..errors import EngineError, FailureClass
from .process import ProcResult, StopSignal, run_process, scrubbed_env
from .secrets import Redactor


def default_image() -> str:
    return f"scranton-pipeline-sandbox:{__version__}"


def _container_user() -> str:
    if sys.platform == "win32":
        return "10001:10001"
    # Match the team sandbox on POSIX, including Docker Desktop on macOS; never run as root.
    uid = getattr(os, "getuid", lambda: 0)() or 10001
    gid = getattr(os, "getgid", lambda: 0)() or uid
    if uid < 0 or gid < 0:
        raise EngineError(FailureClass.INFRASTRUCTURE, "invalid_sandbox_user", "Invalid host UID/GID")
    return f"{uid}:{gid}"


CONTAINER_ENV = {
    "HOME": "/tmp", "LANG": "C.UTF-8", "TMPDIR": "/tmp",
    "XDG_CACHE_HOME": "/tmp/cache", "PIP_CACHE_DIR": "/tmp/pip-cache",
    "PYTHONUSERBASE": "/workspace/.pipeline/python",
    "PYTHONPYCACHEPREFIX": "/tmp/pycache", "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    "NPM_CONFIG_PREFIX": "/workspace/.pipeline/npm", "NPM_CONFIG_CACHE": "/tmp/npm-cache",
    "NODE_PATH": "/workspace/.pipeline/npm/lib/node_modules",
    "PATH": "/workspace/.pipeline/python/bin:/workspace/.pipeline/npm/bin:/usr/local/bin:/usr/bin:/bin",
}


def sandbox_description(cfg: SandboxConfig, *, setup_network: bool = False) -> dict[str, Any]:
    if cfg.mode == "host":
        return {"mode": "host", "isolated": False, "image": None, "isolation": "No OS isolation.", "setup_network": setup_network}
    return {"mode": "docker", "isolated": True, "image": cfg.docker.image or default_image(),
            "isolation": "Docker container with read-only root and no network for checks; shares the Docker VM kernel; workspace mounted read-write; setup commands with network can reach the internet and local services (including host.docker.internal).",
            "setup_network": setup_network}


def sweep_expired() -> None:
    box = DockerSandbox(SandboxConfig(), Path.cwd(), "00000000", runner=run_process)
    try:
        result = box._invoke(["docker", "ps", "-a", "--filter", "label=scranton.pipeline.run", "--format",
                              '{{.ID}}\t{{.Label "scranton.pipeline.run"}}\t{{.Label "scranton.pipeline.deadline"}}'], 10,
                             tail_bytes=65536)
        if result.exit_code != 0 or result.timed_out or result.stopped:
            return
        for line in result.output_tail.splitlines():
            fields = line.split("\t")
            if len(fields) != 3 or not re.fullmatch(r"[a-f0-9]{12,64}", fields[0]) or not fields[1]:
                continue
            try:
                deadline = float(fields[2])
            except ValueError:
                continue
            if math.isfinite(deadline) and deadline <= time.time():
                box._invoke(["docker", "rm", "-f", fields[0]], 10)
    except Exception:  # noqa: BLE001, S110 - best effort when Docker is unavailable
        pass


class Sandbox(Protocol):
    def run(self, argv: Sequence[str], *, timeout_s: float, log_path: Path, network: bool = False,
            stop: StopSignal | None = None, tail_bytes: int = 8192, max_log_bytes: int = 5000000,
            writable_state: bool = False) -> ProcResult: ...
    def describe(self) -> dict[str, Any]: ...
    def preflight(self) -> None: ...
    def cleanup(self) -> None: ...


class HostSandbox:
    def __init__(self, cfg: SandboxConfig, workspace: Path) -> None:
        self.cfg = cfg
        self.workspace = workspace

    def preflight(self) -> None:
        pass

    def cleanup(self) -> None:
        pass

    def describe(self) -> dict[str, Any]:
        return sandbox_description(self.cfg)

    def run(self, argv: Sequence[str], *, timeout_s: float, log_path: Path, network: bool = False,
            stop: StopSignal | None = None, tail_bytes: int = 8192, max_log_bytes: int = 5000000,
            writable_state: bool = False) -> ProcResult:
        return run_process(argv, cwd=self.workspace, env=scrubbed_env(os.environ, self.cfg.env_passthrough),
                           timeout_s=timeout_s, log_path=log_path, stop=stop,
                           tail_bytes=tail_bytes, max_log_bytes=max_log_bytes)


class DockerSandbox:
    def __init__(self, cfg: SandboxConfig, workspace: Path, run_id: str,
                 runner: Callable[..., ProcResult] = run_process, *, name_suffix: str = "", state_dir: Path | None = None) -> None:
        self.cfg = cfg
        self.workspace = workspace.resolve()
        self.state_dir = state_dir or self.workspace.with_name(self.workspace.name + "-sandbox-state")
        if not re.fullmatch(r"[a-z0-9]{8,32}", run_id):
            raise EngineError(FailureClass.INVALID_INPUT, "invalid_run_id", "Invalid run id")
        self.run_id = run_id
        self.runner = runner
        if name_suffix and not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name_suffix):
            raise ValueError("Invalid sandbox name suffix")
        self.name_suffix = (name_suffix + "-" if name_suffix else "") + uuid.uuid4().hex[:12]
        self.sequence = 0

    def describe(self) -> dict[str, Any]:
        return sandbox_description(self.cfg)

    def _invoke(self, argv: Sequence[str], timeout_s: float, **kwargs: Any) -> ProcResult:
        cwd = self.workspace if list(argv[:2]) == ["docker", "run"] else Path.cwd()
        return self.runner(argv, cwd=cwd, env=scrubbed_env(os.environ, ()),
                           timeout_s=timeout_s, **kwargs)

    def preflight(self) -> None:
        for argv, code in ((["docker", "info", "--format", "{{.ServerVersion}}"], "docker_unavailable"),
                           (["docker", "image", "inspect", (self.cfg.docker.image or default_image())], "image_missing")):
            try:
                result = self._invoke(argv, 15)
                if result.exit_code == 0 and not result.timed_out and not result.stopped:
                    continue
            except (EngineError, OSError):
                pass
            raise EngineError(FailureClass.INFRASTRUCTURE, code,
                              "Start Docker Desktop and build the local image with "
                              f"python -m scranton_pipeline sandbox build --image {(self.cfg.docker.image or default_image())}")

    def cleanup(self) -> None:
        try:
            result = self._invoke(["docker", "ps", "-a", "-q", "--filter",
                                   f"label=scranton.pipeline.run={self.run_id}"], 10)
            ids = result.output_tail.split()
            if result.exit_code == 0 and ids and all(re.fullmatch(r"[a-f0-9]{12,64}", item) for item in ids):
                self._invoke(["docker", "rm", "-f", *ids], 10)
        except Exception:  # noqa: BLE001, S110 - cleanup must never mask the run outcome
            pass

    def _remove_container(self, name: str, *, pending: bool) -> None:
        started = time.monotonic()
        deadline = started + 5
        query = ["docker", "ps", "-a", "-q", "--filter", f"name=^/{name}$"]
        seen = False
        for attempt in range(8):
            try:
                if pending or attempt:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return
                    result = self._invoke(["docker", "rm", "-f", name], min(1, remaining))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                result = self._invoke(query, min(1, remaining))
                if result.exit_code == 0 and not result.timed_out and not result.stopped and result.output_tail.strip():
                    seen = True
                # rm -f succeeds even when no container ever existed.
                if (result.exit_code == 0 and not result.timed_out and not result.stopped
                        and not result.output_tail.strip()
                        and (not pending or seen or time.monotonic() - started >= 2)):
                    return
            except Exception:  # noqa: BLE001, S110 - preserve the original check outcome
                pass
            remaining = deadline - time.monotonic()
            if attempt < 7 and remaining > 0:
                time.sleep(min(0.3, remaining))

    def run(self, argv: Sequence[str], *, timeout_s: float, log_path: Path, network: bool = False,
            stop: StopSignal | None = None, tail_bytes: int = 8192, max_log_bytes: int = 5000000,
            writable_state: bool = False) -> ProcResult:
        if not argv or not argv[0]:
            raise EngineError(FailureClass.INVALID_INPUT, "invalid_process", "Command argv is empty")
        user = _container_user()
        state = self.state_dir
        if state.is_symlink() or state.is_junction() or state.resolve().is_relative_to(self.workspace):
            raise EngineError(FailureClass.SECURITY, "unsafe_state", "Sandbox state must be a local directory")
        state.mkdir(parents=True, exist_ok=True)
        self.sequence += 1
        name = f"scranton-pipeline-{self.run_id[:8]}-{os.getpid()}-{self.name_suffix}-{self.sequence}"
        docker = self.cfg.docker
        command = ["docker", "run", "--rm", "--pull", "never", "--name", name, "--log-driver", "none",
                   "--network", "bridge" if network else "none", "--cpus", str(docker.cpus),
                   "--memory", f"{docker.memory_mb}m", "--memory-swap", f"{docker.memory_mb}m",
                   "--pids-limit", str(docker.pids),
                   "--read-only", "--tmpfs", f"/tmp:rw,exec,nosuid,nodev,size={docker.tmpfs_mb}m",
                   "--user", user, "--label", f"scranton.pipeline.run={self.run_id}",
                   "--label", f"scranton.pipeline.deadline={math.ceil(time.time() + timeout_s + 30)}",
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   *[part for key, value in CONTAINER_ENV.items() for part in ("--env", f"{key}={value}")],
                   "-v", f"{self.workspace}:/workspace",
                   "-v", f"{state.resolve()}:/workspace/.pipeline:" + ("rw" if writable_state else "ro"), "-w", "/workspace",
                   "--entrypoint", argv[0], docker.image or default_image(), *argv[1:]]
        pending = True
        try:
            result = self._invoke(command, timeout_s, log_path=log_path, stop=stop,
                                  tail_bytes=tail_bytes, max_log_bytes=max_log_bytes)
            pending = result.timed_out or result.stopped
            if not pending:
                tail = Redactor().redact(result.output_tail)
                if result.exit_code == 125:
                    raise EngineError(FailureClass.INFRASTRUCTURE, "docker_failed", tail or "Docker could not run the container")
                if result.exit_code in (126, 127) and re.search(
                        r"(?im)^docker: (?:Error response from daemon|failed to).*?(?:executable file not found|no such file or directory|permission denied)", tail):
                    raise EngineError(FailureClass.INFRASTRUCTURE, "executable_not_found", "Cannot start executable: " + tail)
            return result
        finally:
            self._remove_container(name, pending=pending)


def build_sandbox(cfg: SandboxConfig, *, workspace: Path, run_id: str, trust_host: bool, name_suffix: str = "", state_dir: Path | None = None) -> Sandbox:
    if cfg.mode == "host":
        if not trust_host:
            raise EngineError(FailureClass.INVALID_INPUT, "host_trust_required", "Host execution requires explicit trust")
        return HostSandbox(cfg, workspace)
    return DockerSandbox(cfg, workspace, run_id, name_suffix=name_suffix, state_dir=state_dir)


def check_image(image: str | None = None) -> dict[str, Any]:
    name = image or default_image()
    sandbox = DockerSandbox(SandboxConfig.model_validate({"docker": {"image": name}}), Path.cwd(), "00000000")
    version: str | None = None
    reason: str | None = None
    present = False
    try:
        result = sandbox._invoke(["docker", "info", "--format", "{{.ServerVersion}}"], 15)
        if result.exit_code != 0 or result.timed_out or result.stopped:
            reason = "Docker is unavailable; start Docker Desktop."
        else:
            version = result.output_tail.strip()
            result = sandbox._invoke(["docker", "image", "inspect", name], 15)
            present = result.exit_code == 0 and not result.timed_out and not result.stopped
    except (EngineError, OSError):
        reason = "Docker is unavailable; install/start Docker Desktop."
    return {"docker": {"available": reason is None, "version": version, "reason": reason},
            "image": {"name": name, "present": present}, "default_image": default_image()}


def build_image(image: str | None = None) -> dict[str, Any]:
    import subprocess
    import sys
    from importlib.resources import files

    name = image or default_image()
    if not re.fullmatch(r"scranton-pipeline-sandbox:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", name):
        raise EngineError(FailureClass.INVALID_INPUT, "invalid_build_image", "Build image must be a scranton-pipeline-sandbox:<tag> tag")
    SandboxConfig.model_validate({"docker": {"image": name}})
    context = Path(str(files("scranton_pipeline").joinpath("sandbox_image")))
    try:
        result = subprocess.run(["docker", "build", "--tag", name, "--file", str(context / "Dockerfile"),
                                 str(context)], cwd=context, env=scrubbed_env(os.environ, ()),
                                shell=False, stdout=sys.stderr, stderr=sys.stderr, timeout=1800, check=False)
        return {"built": result.returncode == 0, "image": name,
                "reason": None if result.returncode == 0 else "Docker build failed; see stderr."}
    except (OSError, subprocess.TimeoutExpired):
        return {"built": False, "image": name, "reason": "Docker build unavailable or timed out; start Docker Desktop and retry."}

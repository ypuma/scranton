"""Explicit host trust or fail-closed Docker isolation."""
import os
import re
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Protocol

from ..config import SandboxConfig
from ..errors import EngineError, FailureClass
from .process import ProcResult, StopSignal, run_process, scrubbed_env


class Sandbox(Protocol):
    def run(self, argv: Sequence[str], *, timeout_s: float, log_path: Path, network: bool = False,
            stop: StopSignal | None = None, tail_bytes: int = 8192, max_log_bytes: int = 5000000) -> ProcResult: ...
    def describe(self) -> dict[str, Any]: ...
    def preflight(self) -> None: ...


class HostSandbox:
    def __init__(self, cfg: SandboxConfig, workspace: Path) -> None:
        self.cfg = cfg
        self.workspace = workspace

    def preflight(self) -> None:
        if not self.workspace.is_dir():
            raise EngineError(FailureClass.INFRASTRUCTURE, "workspace_missing", "Workspace is missing")

    def describe(self) -> dict[str, Any]:
        return {"mode": "host", "isolated": False, "isolation": "no OS isolation"}

    def run(self, argv: Sequence[str], *, timeout_s: float, log_path: Path, network: bool = False,
            stop: StopSignal | None = None, tail_bytes: int = 8192, max_log_bytes: int = 5000000) -> ProcResult:
        return run_process(argv, cwd=self.workspace, env=scrubbed_env(os.environ, self.cfg.env_passthrough),
                           timeout_s=timeout_s, log_path=log_path, stop=stop,
                           tail_bytes=tail_bytes, max_log_bytes=max_log_bytes)


class DockerSandbox:
    def __init__(self, cfg: SandboxConfig, workspace: Path, run_id: str,
                 runner: Callable[..., ProcResult] = run_process) -> None:
        self.cfg = cfg
        self.workspace = workspace.resolve()
        if not re.fullmatch(r"[a-z0-9]{8,32}", run_id):
            raise EngineError(FailureClass.INVALID_INPUT, "invalid_run_id", "Invalid run id")
        self.run_id = run_id
        self.runner = runner
        self.sequence = 0

    def describe(self) -> dict[str, Any]:
        return {"mode": "docker", "image": self.cfg.docker.image, "isolated": True,
                "isolation": "Docker container; network disabled except explicit setup"}

    def _invoke(self, argv: Sequence[str], timeout_s: float, **kwargs: Any) -> ProcResult:
        return self.runner(argv, cwd=self.workspace, env=scrubbed_env(os.environ, ()),
                           timeout_s=timeout_s, **kwargs)

    def preflight(self) -> None:
        for argv in (["docker", "info", "--format", "{{.ServerVersion}}"],
                     ["docker", "image", "inspect", self.cfg.docker.image]):
            result = self._invoke(argv, 15)
            if result.exit_code != 0 or result.timed_out:
                raise EngineError(FailureClass.INFRASTRUCTURE, "docker_unavailable", "Docker or local image unavailable")

    def run(self, argv: Sequence[str], *, timeout_s: float, log_path: Path, network: bool = False,
            stop: StopSignal | None = None, tail_bytes: int = 8192, max_log_bytes: int = 5000000) -> ProcResult:
        self.sequence += 1
        name = f"scranton-pipeline-{self.run_id[:8]}-{os.getpid()}-{self.sequence}"
        docker = self.cfg.docker
        command = ["docker", "run", "--rm", "--pull", "never", "--name", name,
                   "--network", "bridge" if network else "none", "--cpus", str(docker.cpus),
                   "--memory", f"{docker.memory_mb}m", "--pids-limit", str(docker.pids),
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   "-v", f"{self.workspace}:/workspace", "-w", "/workspace",
                   "--entrypoint", argv[0], docker.image, *argv[1:]]
        try:
            return self._invoke(command, timeout_s, log_path=log_path, stop=stop,
                           tail_bytes=tail_bytes, max_log_bytes=max_log_bytes)
        finally:
            # A killed Docker CLI does not imply that its container stopped.
            self._invoke(["docker", "kill", name], 15)


def build_sandbox(cfg: SandboxConfig, *, workspace: Path, run_id: str, trust_host: bool) -> Sandbox:
    if cfg.mode == "host":
        if not trust_host:
            raise EngineError(FailureClass.INVALID_INPUT, "host_trust_required", "Host execution requires explicit trust")
        return HostSandbox(cfg, workspace)
    return DockerSandbox(cfg, workspace, run_id)

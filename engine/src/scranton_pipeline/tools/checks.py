"""Sequential configured checks with required-failure short circuiting."""
from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from ..config import CheckConfig
from ..errors import EngineError
from ..models import CheckResult
from .process import StopSignal
from .sandbox import Sandbox
from .secrets import Redactor


def run_checks(checks: Sequence[CheckConfig], *, sandbox: Sandbox, log_dir: Path, label: str,
               stop: StopSignal | None, fail_fast: bool = True, tail_bytes: int = 8192, max_log_bytes: int = 5000000) -> list[CheckResult]:
    if not label or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in label):
        raise ValueError("Invalid check label")
    results = []
    for check in checks:
        if stop and stop.should_stop():
            break
        path = (log_dir / f"{label}-{check.id}.log").resolve()
        try:
            result = sandbox.run(check.argv, timeout_s=check.timeout_s, log_path=path, stop=stop,
                                 tail_bytes=tail_bytes, max_log_bytes=max_log_bytes)
            status: Literal["timed_out", "passed", "failed"] = "timed_out" if result.timed_out else "passed" if result.exit_code == 0 and not result.stopped else "failed"
            record = CheckResult(id=check.id, kind=check.kind, status=status, exit_code=result.exit_code,
                                 duration_s=result.duration_s, output_tail=result.output_tail,
                                 log_path=str(path), required=check.required)
        except EngineError as exc:
            if exc.code == "docker_failed":
                raise
            record = CheckResult(id=check.id, kind=check.kind, status="error", exit_code=None,
                                 duration_s=0, output_tail=Redactor().redact(str(exc)),
                                 log_path=str(path), required=check.required)
        results.append(record)
        if record.required and record.status != "passed" and fail_fast:
            break
    return results

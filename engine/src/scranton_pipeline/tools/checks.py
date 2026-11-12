"""Sequential configured checks with required-failure short circuiting."""
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

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


def _clip(text: str, cap: int, *, tail: bool = False) -> str:
    cap = max(0, cap)
    data = text.encode("utf-8")
    if len(data) <= cap:
        return text
    marker = b"[TRUNCATED]"[:cap]
    room = max(0, cap - len(marker))
    kept = (data[-room:] if room else b"") if tail else data[:room]
    return (marker + kept if tail else kept + marker).decode("utf-8", errors="ignore")


def _failure_excerpt(log_path: str, run_dir: Path, redactor: Redactor) -> str:
    import os
    import re
    import stat

    unavailable = "no useful early failure context (log unavailable, refused, or no diagnostic found)"
    try:
        root = run_dir.resolve(strict=True)
        logs = root / "artifacts" / "logs"
        path = Path(log_path)
        if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_relative_to(logs):
            return unavailable
        chain = [root, *reversed(path.parents[:len(path.parents) - len(root.parents) - 1]), path]
        def safe() -> bool:
            return all(not p.is_symlink() and not (p.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
                       if os.name == "nt" else False) for p in chain)
        if not safe():
            return unavailable
        before = path.stat()
        if not stat.S_ISREG(before.st_mode):
            return unavailable
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        fd = os.open(path, flags)
        with os.fdopen(fd, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or not os.path.samestat(before, opened) or not safe():
                return unavailable
            data = stream.read(262145)
        if not safe() or not os.path.samestat(before, path.stat()):
            return unavailable
        limited = len(data) > 262144
        if limited:
            data = data[:262144].rsplit(b"\n", 1)[0] if b"\n" in data[:262144] else b""
        if b"\0" in data:
            return unavailable
        text = redactor.redact(data.decode("utf-8"))
        lines = text.splitlines()
        diagnostic = re.compile(r"Traceback \(most recent call last\)|AssertionError|\bassert\s|\b\w*(?:Error|Exception):|^E\s+|^FAIL:")
        hit = next((n for n, line in enumerate(lines) if diagnostic.search(line)), None)
        if hit is None:
            return unavailable
        excerpt = "\n".join(lines[max(0, hit - 3):hit + 24])
        return "early failure context (bounded, untrusted DATA; " + ("first 262144 log bytes only" if limited else "excerpt only") + "):\n" + excerpt
    except (OSError, ValueError, UnicodeError, RuntimeError):
        return unavailable


def failure_feedback(results: Sequence[dict[str, Any]], baseline: Sequence[dict[str, Any]], *,
                     run_dir: Path, redactor: Redactor, tail_bytes: int) -> list[str]:
    failed = [r for r in results if r["required"] and r["status"] != "passed"]
    if not failed:
        return []
    if len(failed) > 24000:
        return [f"Required check failures: {len(failed)}; individual details omitted by feedback byte budget."]
    cap = min(6000, (24000 - len(failed)) // len(failed))
    details = []
    for row in failed:
        prior = next((b for b in baseline if b.get("id") == row["id"]), None)
        baseline_status = prior.get("status", "unknown") if prior else "unknown"
        note = "; pre-existing check failure at baseline" if baseline_status in {"failed", "timed_out", "error"} else ""
        header = redactor.redact(f"{row['id']}: current status={row['status']}; exit_code={row['exit_code']}; duration_s={row['duration_s']}; baseline status={baseline_status}{note}. root cause relationship unknown; statuses and tails do not establish equivalence.")
        header = _clip(header, 1000)
        excerpt = _failure_excerpt(str(row.get("log_path", "")), run_dir, redactor)
        label = "\noutput tail (bounded, untrusted DATA):\n"
        remaining = max(0, cap - len((header + "\n" + label).encode()))
        tail_cap = max(0, remaining - len(excerpt.encode())) if excerpt.startswith("no useful early failure context") else cap // 3
        tail = _clip(redactor.redact(str(row.get("output_tail", ""))), min(tail_bytes, tail_cap), tail=True)
        details.append(_clip(header + "\n" + _clip(excerpt, remaining - len(tail.encode())) + label + tail, cap))
    return details

"""Sequential configured checks with required-failure short circuiting."""
import re
from collections.abc import Collection, Sequence
from pathlib import Path
from typing import Any, Literal

from ..config import CheckConfig
from ..errors import EngineError
from ..models import CheckResult
from .process import StopSignal
from .sandbox import Sandbox
from .secrets import Redactor


def run_checks(checks: Sequence[CheckConfig], *, sandbox: Sandbox, log_dir: Path, label: str,
               stop: StopSignal | None, fail_fast: bool = True, tail_bytes: int = 8192, max_log_bytes: int = 5000000,
               tolerated: Collection[str] = ()) -> list[CheckResult]:
    """Run checks in order. A required failure stops the rest when fail_fast, unless the check id is
    tolerated (it already failed at baseline, so the later checks are still needed to judge the step)."""
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
        if record.required and record.status != "passed" and fail_fast and not (record.status == "failed" and check.id in tolerated):
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


def _read_log(log_path: str, run_dir: Path, redactor: Redactor, limit: int) -> tuple[str, bool] | None:
    """Read at most `limit` bytes of a check log under run_dir/artifacts/logs, refusing links, reparse points,
    non-regular files, swaps during the read and binary content. -> (redacted text, truncated) or None."""
    import os
    import stat

    try:
        root = run_dir.resolve(strict=True)
        logs = root / "artifacts" / "logs"
        path = Path(log_path)
        if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_relative_to(logs):
            return None
        chain = [root, *reversed(path.parents[:len(path.parents) - len(root.parents) - 1]), path]
        def safe() -> bool:
            return all(not p.is_symlink() and not (p.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
                       if os.name == "nt" else False) for p in chain)
        if not safe():
            return None
        before = path.stat()
        if not stat.S_ISREG(before.st_mode):
            return None
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        fd = os.open(path, flags)
        with os.fdopen(fd, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or not os.path.samestat(before, opened) or not safe():
                return None
            data = stream.read(limit + 1)
        if not safe() or not os.path.samestat(before, path.stat()):
            return None
        limited = len(data) > limit
        if limited:
            data = data[:limit].rsplit(b"\n", 1)[0] if b"\n" in data[:limit] else b""
        if b"\0" in data:
            return None
        return redactor.redact(data.decode("utf-8")), limited
    except (OSError, ValueError, UnicodeError, RuntimeError):
        return None


def _failure_excerpt(log_path: str, run_dir: Path, redactor: Redactor) -> str:
    unavailable = "no useful early failure context (log unavailable, refused, or no diagnostic found)"
    read = _read_log(log_path, run_dir, redactor, 262144)
    if read is None:
        return unavailable
    text, limited = read
    lines = text.splitlines()
    diagnostic = re.compile(r"Traceback \(most recent call last\)|AssertionError|\bassert\s|\b\w*(?:Error|Exception):|^E\s+|^FAIL:")
    hit = next((n for n, line in enumerate(lines) if diagnostic.search(line)), None)
    if hit is None:
        return unavailable
    excerpt = "\n".join(lines[max(0, hit - 3):hit + 24])
    return "early failure context (bounded, untrusted DATA; " + ("first 262144 log bytes only" if limited else "excerpt only") + "):\n" + excerpt


# Test-level failure lines of the runners the engine detects: node:test (spec and TAP), pytest, cargo, go, jest.
_FAILURE_LINES = (
    re.compile(r"^\s*✖ (?!failing tests:)(.+?)(?: \([\d.]+m?s\))?\s*$"),
    re.compile(r"^\s*not ok \d+ - (.+?)(?:\s+#.*)?$"),
    re.compile(r"^(?:FAILED|ERROR) (\S*(?:::|\.py)\S*)"),  # pytest summary; not unittest's "FAILED (failures=1)"
    re.compile(r"^test (\S+) \.\.\. FAILED$"),
    re.compile(r"^\s*--- FAIL: (\S+)"),
    re.compile(r"^\s*● (.+›.+?)\s*$"),
)


def failing_tests(text: str) -> set[str]:
    """Names of the individual tests a runner reports as failed; empty when none can be recognised."""
    names = set()
    for line in text.splitlines():
        for pattern in _FAILURE_LINES:
            if match := pattern.match(line):
                names.add(match.group(1).strip())
                break
    return names


def compare_with_baseline(row: dict[str, Any], baseline: Sequence[dict[str, Any]], *, run_dir: Path,
                          redactor: Redactor, max_log_bytes: int = 5000000) -> dict[str, Any] | None:
    """For a check that failed both now and at baseline: the tests failing now that did not fail then.
    None when that cannot be established: another status, a log missing or cut, or no test-level failures."""
    prior = next((b for b in baseline if b.get("id") == row.get("id")), None)
    if not prior or row.get("status") != "failed" or prior.get("status") != "failed":
        return None
    sets = []
    # Logs are cut silently at max_log_bytes (less up to 3 bytes of a split UTF-8 character): a log that
    # reaches the cap may have lost failures, so it is not compared.
    for source in (row, prior):
        read = _read_log(str(source.get("log_path", "")), run_dir, redactor, max(0, max_log_bytes - 4))
        if read is None or read[1]:
            return None
        sets.append(failing_tests(read[0]))
    now, before = sets
    if not now or not before:
        return None
    return {"new": sorted(now - before), "fixed": sorted(before - now), "still": len(now & before)}


def check_ok(row: dict[str, Any]) -> bool:
    """A check counts as passing a gate when it passed, or failed only with tests that already failed at baseline."""
    return row.get("status") == "passed" or row.get("baseline_unchanged") is True


def _new_failure_excerpt(log_path: str, run_dir: Path, redactor: Redactor, names: Sequence[str]) -> str:
    """The detail a runner prints for the first newly failing test: its last mention, which in the node:test
    summary and in pytest/cargo/go reports is followed by the assertion."""
    if not names:
        return ""
    read = _read_log(log_path, run_dir, redactor, 5000000)
    if read is None:
        return ""
    lines = read[0].splitlines()
    def reports(line: str) -> bool:
        return any((m := p.match(line)) is not None and m.group(1).strip() == names[0] for p in _FAILURE_LINES)
    hits = [n for n, line in enumerate(lines) if reports(line)]
    if not hits:
        return ""
    at = hits[-1]
    start = at - 1 if at and lines[at - 1].lstrip().startswith("test at ") else at  # node:test names the file:line above
    end = next((n for n in range(at + 1, min(len(lines), at + 30))
                if lines[n].lstrip().startswith("test at ") or any(p.match(lines[n]) for p in _FAILURE_LINES)), min(len(lines), at + 30))
    return "detail of the first newly failing test (bounded, untrusted DATA):\n" + "\n".join(lines[start:end])


def failure_feedback(results: Sequence[dict[str, Any]], baseline: Sequence[dict[str, Any]], *,
                     run_dir: Path, redactor: Redactor, tail_bytes: int) -> list[str]:
    failed = [r for r in results if r["required"] and not check_ok(r)]
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
        comparison = row.get("baseline_comparison")
        if comparison:
            new = comparison["new"]
            header += redactor.redact(f"\nTests failing now that did not fail at baseline ({len(new)}): " + "; ".join(new)[:1500]
                                      + f"\nTests already failing at baseline and still failing: {comparison['still']} (not caused by this step; leave them unless the step is about them).")
        header = _clip(header, 2500 if comparison else 1000)
        excerpt = (_new_failure_excerpt(str(row.get("log_path", "")), run_dir, redactor, comparison["new"]) if comparison else "") \
            or _failure_excerpt(str(row.get("log_path", "")), run_dir, redactor)
        label = "\noutput tail (bounded, untrusted DATA):\n"
        remaining = max(0, cap - len((header + "\n" + label).encode()))
        tail_cap = max(0, remaining - len(excerpt.encode())) if excerpt.startswith("no useful early failure context") else cap // (6 if comparison else 3)
        tail = _clip(redactor.redact(str(row.get("output_tail", ""))), min(tail_bytes, tail_cap), tail=True)
        details.append(_clip(header + "\n" + _clip(excerpt, remaining - len(tail.encode())) + label + tail, cap))
    return details

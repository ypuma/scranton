"""Durable, redacted lifecycle and usage records."""
import json
import logging
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .errors import EngineError, FailureClass
from .models import RunStatus, Usage
from .tools._locking import file_lock
from .tools.fs import write_bytes_atomic
from .tools.secrets import Redactor


def _redact(value: Any, redactor: Redactor) -> Any:
    if isinstance(value, str):
        return redactor.redact(value)
    if isinstance(value, dict):
        return {redactor.redact(str(k)): _redact(v, redactor) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v, redactor) for v in value]
    return value


def _rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    result = []
    for line in path.read_bytes().splitlines():
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                result.append(row)
        except (ValueError, UnicodeError):
            continue
    return result


def _append(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        stream.seek(0, 2)
        size = stream.tell()
        if size:
            stream.seek(-1, 2)
            if stream.read(1) != b"\n":
                stream.write(b"\n")
        stream.write((json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n").encode())
        stream.flush()
        os.fsync(stream.fileno())


class EventLog:
    def __init__(self, path: Path, run_id: str, redactor: Redactor) -> None:
        self.path = path
        self.run_id = run_id
        self.redactor = redactor

    def emit(self, type: str, *, node: str | None = None, **data: Any) -> int:
        with file_lock(self.path.with_suffix(".lock")):
            seq = max((int(row.get("seq", 0)) for row in _rows(self.path)), default=0) + 1
            row = {"seq": seq, "ts": datetime.now(UTC).isoformat(), "run_id": self.run_id,
                   "type": type, "node": node, "data": data}
            _append(self.path, _redact(row, self.redactor))
            return seq


class UsageLedger:
    def __init__(self, path: Path) -> None:
        self.path = path

    def record(self, *, role: str, model: str, input_tokens: int, output_tokens: int, ok: bool, duration_s: float) -> None:
        if min(input_tokens, output_tokens, duration_s) < 0:
            raise ValueError("Usage cannot be negative")
        with file_lock(self.path.with_suffix(".lock")):
            _append(self.path, _redact({"role": role, "model": model, "input_tokens": input_tokens,
                "output_tokens": output_tokens, "ok": ok, "duration_s": duration_s}, Redactor()))

    def reserve(self, *, role: str, model: str, scope: str, input_tokens: int, output_tokens: int,
                max_calls: int, max_tokens: int) -> tuple[int, int, int]:
        with file_lock(self.path.with_suffix(".lock")):
            rows = _rows(self.path)
            if len(rows) >= max_calls or sum(int(r["input_tokens"]) + int(r["output_tokens"]) for r in rows) >= max_tokens:
                raise EngineError(FailureClass.LIMIT, "llm_budget_exhausted", "Model call/token budget exhausted")
            role_cursor = sum(r.get("role") == role for r in rows)
            scope_cursor = sum(r.get("role") == role and r.get("scope", "") == scope for r in rows)
            _append(self.path, {"role": role, "model": model, "scope": scope, "input_tokens": input_tokens,
                "output_tokens": output_tokens, "ok": False, "duration_s": 0, "reserved": True})
            return len(rows), role_cursor, scope_cursor

    def finish(self, reservation: int, *, input_tokens: int, output_tokens: int, ok: bool, duration_s: float) -> None:
        with file_lock(self.path.with_suffix(".lock")):
            rows = _rows(self.path)
            rows[reservation].update(input_tokens=input_tokens, output_tokens=output_tokens, ok=ok,
                                     duration_s=duration_s, reserved=False)
            write_bytes_atomic(self.path, b"".join((json.dumps(r, ensure_ascii=True) + "\n").encode() for r in rows))

    def totals(self) -> Usage:
        with file_lock(self.path.with_suffix(".lock")):
            rows = _rows(self.path)
        return Usage(calls=len(rows), input_tokens=sum(int(r["input_tokens"]) for r in rows),
                     output_tokens=sum(int(r["output_tokens"]) for r in rows))

    def calls_for(self, role: str) -> int:
        with file_lock(self.path.with_suffix(".lock")):
            return sum(row.get("role") == role for row in _rows(self.path))


def write_status(run_dir: Path, status: RunStatus) -> None:
    value = _redact(status.model_dump(mode="json", by_alias=True), Redactor())
    value["task"] = value["task"][:500]
    write_bytes_atomic(run_dir / "status.json", json.dumps(value, ensure_ascii=True).encode())


def read_status(run_dir: Path) -> RunStatus | None:
    path = run_dir / "status.json"
    return RunStatus.model_validate_json(path.read_bytes()) if path.exists() else None


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        text = record.getMessage()
        if record.exc_info:
            text += "\n" + self.formatException(record.exc_info)
        return json.dumps({"ts": datetime.now(UTC).isoformat(), "level": record.levelname,
                           "message": Redactor().redact(text)})


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_JsonFormatter())
    logging.basicConfig(level=level, handlers=[handler], force=True)

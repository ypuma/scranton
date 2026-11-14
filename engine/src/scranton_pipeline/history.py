"""Bounded cross-run context. Historical text has no execution or evidence authority."""
import json
import os
import re
import stat
from pathlib import Path
from typing import Any

from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.tools.secrets import Redactor

MAX_BYTES = 32768


def invalid_history() -> EngineError:
    return EngineError(FailureClass.INVALID_INPUT, "invalid_history", "History must be a bounded schema-1 snapshot in a regular, non-linked UTF-8 file")


def validate_history(value: Any, redactor: Redactor) -> dict[str, Any]:
    if (not isinstance(value, dict) or set(value) != {"schema", "runs", "truncated"}
            or type(value["schema"]) is not int or value["schema"] != 1
            or type(value["truncated"]) is not bool or not isinstance(value["runs"], list)
            or not 1 <= len(value["runs"]) <= 4):
        raise invalid_history()
    runs = []
    for row in value["runs"]:
        if (not isinstance(row, dict) or set(row) != {"run_id", "status", "task", "plan", "outcome"}
                or not isinstance(row["run_id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", row["run_id"])
                or not isinstance(row["status"], str) or row["status"] not in {"succeeded", "failed", "rejected", "cancelled"}
                or any(not isinstance(row[k], str) or len(row[k]) > cap
                       for k, cap in (("task", 4000), ("plan", 8000), ("outcome", 4000)))):
            raise invalid_history()
        runs.append({**row, **{k: redactor.redact(row[k]) for k in ("task", "plan", "outcome")}})
    return {"schema": 1, "runs": runs, "truncated": value["truncated"]}


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise invalid_history()
        result[key] = value
    return result


def load_history(path: Path, redactor: Redactor) -> dict[str, Any]:
    try:
        path = Path(os.path.abspath(path))
        chain = [*reversed(path.parents), path]
        def safe() -> bool:
            return all(not p.is_symlink() and not (getattr(p.lstat(), "st_file_attributes", 0)
                       & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)) for p in chain)
        if not safe():
            raise invalid_history()
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES:
            raise invalid_history()
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or not os.path.samestat(before, opened) or not safe():
                raise invalid_history()
            data = stream.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES or not safe() or not os.path.samestat(before, path.lstat()):
            raise invalid_history()
        return validate_history(json.loads(data.decode("utf-8"), object_pairs_hook=_object), redactor)
    except (OSError, ValueError, UnicodeError, RuntimeError, RecursionError) as exc:
        raise invalid_history() from exc


def history_block(history: dict[str, Any] | None, cap: int) -> str:
    if not history or cap <= 0:
        return ""
    runs = [{**r} for r in history["runs"]]
    last_plan = next((i for i in range(len(runs) - 1, -1, -1) if runs[i]["plan"].strip()), len(runs) - 1)
    plan_id, latest_id = runs[last_plan]["run_id"], runs[-1]["run_id"]
    priority = {plan_id, latest_id}
    truncated = history["truncated"]
    def render() -> str:
        return '\n<<<FILE path="historical_data">>>\n' + json.dumps({"schema": 1, "runs": runs, "truncated": truncated}, ensure_ascii=True) + '\n<<<END>>>'
    while len(render().encode()) > cap:
        truncated = True
        ordinary = next((i for i, r in enumerate(runs) if r["run_id"] not in priority), None)
        if ordinary is not None:
            runs.pop(ordinary)
            continue
        expendable = [(r, k) for r in runs for k in ("task", "plan", "outcome")
                      if r[k] and not (r["run_id"] == plan_id and k in {"task", "plan"}
                                       or r["run_id"] == latest_id and k == "outcome")]
        if expendable:
            row, key = expendable[0]
            row[key] = ""
            continue
        # Shrink the three priority fields together rather than lose the last plan to an answer.
        fields = [(r, k) for r in runs for k in ("task", "plan", "outcome") if r[k]]
        if not fields:
            return ""
        row, key = max(fields, key=lambda pair: len(json.dumps(pair[0][pair[1]], ensure_ascii=True)))
        row[key] = row[key][:len(row[key]) // 2]
    return render()

"""Prevalidated byte edits and journaled source delivery."""
import ast
import hashlib
import json
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Limits
from ..errors import EngineError, FailureClass
from ..models import FileEdit, StrictModel
from .fs import PathPolicy, detect_newline, is_dependency_manifest, sha256_file, write_bytes_atomic


@dataclass(frozen=True)
class ApplyOutcome:
    ok: bool
    changed: list[str]
    rejected: list[str]
    undeclared: list[str]


def _writable(policy: PathPolicy, rel: str) -> Path:
    path = policy.resolve(rel)
    if policy.is_write_protected(rel):
        raise EngineError(FailureClass.SECURITY, "protected_write", "Cannot write protected path")
    lexical = policy.root / rel
    if any(p.is_symlink() or p.is_junction() for p in [lexical, *lexical.parents]
           if p.is_relative_to(policy.root)):
        raise EngineError(FailureClass.SECURITY, "symlink_write", "Cannot write through a link")
    return path


def _newline(text: str, newline: str) -> bytes:
    return text.replace("\r\n", "\n").replace("\n", newline).encode("utf-8")


def validate_and_apply(edits: Sequence[FileEdit], *, workspace: Path, policy: PathPolicy, declared: Collection[str],
                       scope: str, undeclared_budget: int, limits: Limits) -> ApplyOutcome:
    proposed: dict[str, bytes | None] = {}
    originals: dict[str, bytes | None] = {}
    rejected: list[str] = []
    undeclared: list[str] = []
    seen: set[str] = set()
    for edit in edits:
        rel = policy.normalize(edit.path)
        path = _writable(policy, rel)
        key = str(path).casefold()
        if key in seen:
            rejected.append(f"{rel}: duplicate target")
            continue
        seen.add(key)
        if key not in {str(policy.resolve(p)).casefold() for p in declared}:
            undeclared.append(rel)
            if scope == "strict" or is_dependency_manifest(path):
                rejected.append(f"{rel}: not declared in approved plan")
        try:
            if path.exists() and not path.is_file():
                raise ValueError("target is not a regular file")
            if path.is_file() and path.stat().st_size > limits.max_file_bytes:
                raise ValueError("file too large")
            old = path.read_bytes() if path.exists() else None
            originals[rel] = old
            if old is not None and len(old) > limits.max_file_bytes:
                raise ValueError("file too large")
            if edit.action == "create":
                if old is not None:
                    raise ValueError("create target exists")
                new = (edit.content or "").encode("utf-8")
            else:
                if old is None:
                    raise ValueError("target does not exist")
                if b"\0" in old:
                    raise ValueError("binary file")
                old.decode("utf-8")
                newline = detect_newline(old)
                if edit.action == "delete":
                    new = None
                elif edit.content is not None:
                    new = _newline(edit.content, newline)
                else:
                    new = old
                    for replacement in edit.replacements:
                        search = _newline(replacement.search, newline)
                        if new.count(search) != 1:
                            raise ValueError("search must match exactly once")
                        new = new.replace(search, _newline(replacement.replace, newline), 1)
            if new == old:
                raise ValueError("no-op edit")
            if new is not None:
                if len(new) > limits.max_file_bytes:
                    raise ValueError("file too large")
                if b"[REDACTED]" in new and b"[REDACTED]" not in (old or b""):
                    raise ValueError("redaction marker introduced; use targeted replacements on unredacted code")
                text = new.decode("utf-8")
                if "\0" in text:
                    raise ValueError("binary content")
                if path.suffix.lower() == ".py":
                    ast.parse(text)
                if path.suffix.lower() == ".json":
                    json.loads(text)
            proposed[rel] = new
        except (OSError, ValueError, UnicodeError, SyntaxError) as exc:
            rejected.append(f"{rel}: {exc}")
    if len(undeclared) > undeclared_budget:
        rejected.append("Undeclared file budget exceeded")
    if len(edits) > limits.max_changed_files:
        rejected.append("Changed file budget exceeded")
    if rejected:
        return ApplyOutcome(False, [], rejected, undeclared)
    try:
        for rel, data in proposed.items():
            target = _writable(policy, rel)
            if data is None:
                target.unlink()
            else:
                write_bytes_atomic(target, data)
    except OSError as exc:
        for rel, data in originals.items():
            if data is None:
                (workspace / rel).unlink(missing_ok=True)
            else:
                write_bytes_atomic(workspace / rel, data)
        raise EngineError(FailureClass.INFRASTRUCTURE, "edit_io_error", "Edits rolled back after I/O failure") from exc
    return ApplyOutcome(True, list(proposed), [], undeclared)


class SourceApplyResult(StrictModel):
    applied: list[str]
    conflicts: list[dict[str, str]]
    rolled_back: bool


def _digest(data: bytes | None) -> str | None:
    return hashlib.sha256(data).hexdigest() if data is not None else None


def apply_to_source(*, workspace: Path, source: Path, changes: Sequence[tuple[str, str]],
                    manifest: Mapping[str, Mapping[str, Any]], backup_dir: Path, journal_path: Path,
                    policy: PathPolicy) -> SourceApplyResult:
    if policy.root != source.resolve():
        raise EngineError(FailureClass.SECURITY, "source_policy_mismatch", "Source policy root differs")
    for destination in (backup_dir, journal_path):
        if destination.resolve().is_relative_to(source.resolve()):
            raise EngineError(FailureClass.SECURITY, "source_metadata", "Delivery metadata must be outside source")
    targets: dict[str, bytes | None] = {}
    rows: dict[str, dict[str, Any]] = {}
    conflicts: list[dict[str, str]] = []
    workspace_policy = PathPolicy(workspace, policy.protected, policy.write_protected)
    for action, rel in changes:
        target = _writable(policy, rel)
        if action not in ("A", "M", "D") or rel in rows:
            raise EngineError(FailureClass.INVALID_INPUT, "invalid_changes", "Invalid change inventory")
        data = None if action == "D" else _writable(workspace_policy, rel).read_bytes()
        targets[rel] = data
        before = None if action == "A" else manifest.get(rel, {}).get("sha256")
        if action != "A" and not isinstance(before, str):
            conflicts.append({"path": rel, "reason": "Missing snapshot precondition"})
        rows[rel] = {"before": before, "after": _digest(data), "action": action}
        if target.exists() and not target.is_file():
            conflicts.append({"path": rel, "reason": "Not a regular file"})
    identity = {"source": str(source.resolve()), "files": rows}
    journal: dict[str, Any] | None = None
    if journal_path.exists():
        journal = json.loads(journal_path.read_bytes())
        if journal is None or journal.get("identity") != identity:
            raise EngineError(FailureClass.SECURITY, "journal_mismatch", "Apply journal does not match delivery")
    for rel, row in rows.items():
        target = _writable(policy, rel)
        digest = sha256_file(target) if target.is_file() else None
        expected = {row["before"]}
        if journal is not None:
            expected.add(row["after"])
        if digest not in expected:
            conflicts.append({"path": rel, "reason": "Source changed since snapshot"})
    if conflicts:
        return SourceApplyResult(applied=[], conflicts=conflicts, rolled_back=False)
    if journal is None or journal.get("state") == "rolled_back":
        for rel, row in rows.items():
            if row["before"] is not None:
                write_bytes_atomic(backup_dir / rel, _writable(policy, rel).read_bytes())
        journal = {"identity": identity, "state": "prepared", "done": []}
        write_bytes_atomic(journal_path, json.dumps(journal, sort_keys=True).encode())
    # Backups are verified before every write, including recovery after a hard crash.
    for rel, row in rows.items():
        if row["before"] is not None and (not (backup_dir / rel).is_file()
                                          or sha256_file(backup_dir / rel) != row["before"]):
            raise EngineError(FailureClass.INFRASTRUCTURE, "backup_invalid", "Delivery backup is missing or changed")
    try:
        for rel, data in targets.items():
            target = _writable(policy, rel)
            current = sha256_file(target) if target.is_file() else None
            if current != rows[rel]["after"]:
                if current != rows[rel]["before"]:
                    raise OSError("Source changed during delivery")
                if data is None:
                    target.unlink(missing_ok=True)
                else:
                    write_bytes_atomic(target, data)
            journal["done"] = list(dict.fromkeys([*journal["done"], rel]))
            write_bytes_atomic(journal_path, json.dumps(journal, sort_keys=True).encode())
        journal["state"] = "complete"
        write_bytes_atomic(journal_path, json.dumps(journal, sort_keys=True).encode())
    except OSError:
        for rel, row in rows.items():
            target = _writable(policy, rel)
            if row["before"] is None:
                target.unlink(missing_ok=True)
            else:
                write_bytes_atomic(target, (backup_dir / rel).read_bytes())
        journal["state"] = "rolled_back"
        write_bytes_atomic(journal_path, json.dumps(journal, sort_keys=True).encode())
        return SourceApplyResult(applied=[], conflicts=[{"path": "", "reason": "I/O failure; delivery rolled back"}], rolled_back=True)
    return SourceApplyResult(applied=list(targets), conflicts=[], rolled_back=False)

"""Copy a bounded, secret-free byte snapshot without modifying the source."""
import hashlib
import json
import os
from pathlib import Path

from ..config import DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED, Limits, Policy
from ..errors import EngineError, FailureClass
from ..models import StrictModel
from .fs import PathPolicy, write_bytes_atomic
from .git import list_source_files


class SnapshotResult(StrictModel):
    files: int
    total_bytes: int
    used_git: bool
    skipped: list[dict[str, str]]
    manifest_path: str


def snapshot_source(source: Path, workspace: Path, *, policy: Policy, limits: Limits, manifest_path: Path) -> SnapshotResult:
    source, workspace = source.resolve(), workspace.resolve()
    if workspace.is_relative_to(source) or source.is_relative_to(workspace) or manifest_path.resolve().is_relative_to(source):
        raise EngineError(FailureClass.INVALID_INPUT, "overlapping_paths", "Snapshot destinations must be outside source")
    if workspace.exists() and any(workspace.iterdir()):
        raise EngineError(FailureClass.INVALID_INPUT, "workspace_not_empty", "Workspace must be empty")
    paths, used_git = list_source_files(source, timeout_s=limits.git_timeout_s)
    path_policy = PathPolicy(source, (*DEFAULT_PROTECTED, *policy.protected_paths), DEFAULT_WRITE_PROTECTED)
    skipped: list[dict[str, str]] = []
    payload: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    total = 0
    for rel in paths:
        path_policy.normalize(rel)
        candidate = source / rel
        if any(p.is_symlink() or p.is_junction() for p in [candidate, *candidate.parents] if p.is_relative_to(source)):
            skipped.append({"path": rel, "reason": "symlink"})
            continue
        if path_policy.is_protected(rel):
            skipped.append({"path": rel, "reason": "protected"})
            continue
        path = path_policy.resolve(rel)
        if not path.is_file():
            continue
        if path.stat().st_size > limits.max_file_bytes:
            skipped.append({"path": rel, "reason": "file_too_large"})
            continue
        with path.open("rb") as stream:
            data = stream.read(limits.max_file_bytes + 1)
            if os.name != "nt":
                modes[rel] = os.fstat(stream.fileno()).st_mode & 0o777
        if len(data) > limits.max_file_bytes:
            skipped.append({"path": rel, "reason": "file_too_large"})
            continue
        payload[rel] = data
        total += len(data)
        if len(payload) > limits.max_workspace_files or total > limits.max_workspace_bytes:
            raise EngineError(FailureClass.LIMIT, "workspace_too_large", "Workspace exceeds configured bounds")
    workspace.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for rel, data in payload.items():
        write_bytes_atomic(workspace / rel, data, mode=modes.get(rel))
        manifest[rel] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                         **({"mode": modes[rel]} if rel in modes else {})}
    write_bytes_atomic(manifest_path, json.dumps(manifest, sort_keys=True).encode())
    return SnapshotResult(files=len(payload), total_bytes=total, used_git=used_git,
                          skipped=skipped, manifest_path=str(manifest_path.resolve()))

"""Real permission tests; run POSIX cases on a project-selected tmpfs basetemp."""
import json
import os
import stat
import subprocess

import pytest

from scranton_pipeline.config import Limits, Policy
from scranton_pipeline.errors import EngineError
from scranton_pipeline.models import FileEdit
from scranton_pipeline.tools import patches, snapshot
from scranton_pipeline.tools.fs import PathPolicy, write_bytes_atomic

posix = pytest.mark.skipif(os.name == "nt", reason="Requires POSIX rwx permissions")


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def fixture(root):
    source, workspace = root / "source", root / "workspace"
    source.mkdir()
    for name, permissions in (("gradlew", 0o751), ("deleted", 0o640)):
        path = source / name
        path.write_bytes(b"#!/bin/sh\nprintf 'ok'\n")
        if os.name != "nt":
            path.chmod(permissions)
    manifest_path = root / "manifest.json"
    snapshot.snapshot_source(source, workspace, policy=Policy(), limits=Limits(), manifest_path=manifest_path)
    return {"source": source, "workspace": workspace, "manifest": json.loads(manifest_path.read_bytes()),
            "changes": [("M", "gradlew"), ("D", "deleted"), ("A", "added")],
            "backup_dir": root / "backups", "journal_path": root / "journal.json",
            "policy": PathPolicy(source, (), ())}


def prepare(args):
    write_bytes_atomic(args["workspace"] / "gradlew", b"#!/bin/sh\nprintf 'new'\n")
    added = args["workspace"] / "added"
    added.write_bytes(b"#!/bin/sh\nprintf 'added'\n")
    if os.name != "nt":
        added.chmod(0o750)
    (args["workspace"] / "deleted").unlink()


@posix
def test_snapshot_preserves_rwx_and_executable_bytes(tmp_path):
    args = fixture(tmp_path)
    assert mode(args["workspace"] / "gradlew") == 0o751
    assert mode(args["workspace"] / "deleted") == 0o640
    assert args["manifest"]["gradlew"]["mode"] == 0o751
    assert subprocess.check_output([str(args["workspace"] / "gradlew")]) == b"ok"


@posix
@pytest.mark.parametrize("special", [0o4751, 0o2751, 0o1751])
def test_snapshot_drops_special_bits_and_does_not_touch_links(tmp_path, special):
    source, workspace = tmp_path / "source", tmp_path / "workspace"
    source.mkdir()
    target = source / "script"
    target.write_bytes(b"data")
    target.chmod(special)
    outside = tmp_path / "outside"
    outside.write_bytes(b"outside")
    outside.chmod(0o751)
    (source / "link").symlink_to(outside)
    (source / "hard").hardlink_to(target)
    snapshot.snapshot_source(source, workspace, policy=Policy(), limits=Limits(), manifest_path=tmp_path / "manifest")
    assert mode(workspace / "script") == 0o751
    assert mode(workspace / "hard") == 0o751
    assert mode(target) == special
    assert mode(outside) == 0o751
    assert not (workspace / "link").exists()
    assert (workspace / "hard").stat().st_ino != target.stat().st_ino


@posix
def test_apply_added_and_modified_modes_and_replay(tmp_path):
    args = fixture(tmp_path)
    prepare(args)
    assert patches.apply_to_source(**args).applied
    assert mode(args["source"] / "gradlew") == 0o751
    assert mode(args["source"] / "added") == 0o750
    assert not (args["source"] / "deleted").exists()
    assert patches.apply_to_source(**args).applied
    assert mode(args["source"] / "added") == 0o750


@posix
@pytest.mark.parametrize("crash", [False, True])
def test_rollback_restores_deleted_mode_even_after_crash(tmp_path, monkeypatch, crash):
    args = fixture(tmp_path)
    prepare(args)
    original = patches.write_bytes_atomic
    failed = False

    def fail(path, data, **kwargs):
        nonlocal failed
        if path == args["source"] / "added" and not failed:
            failed = True
            if crash:
                raise SystemExit("crash after deletion")
            raise OSError("injected failure")
        return original(path, data, **kwargs)

    monkeypatch.setattr(patches, "write_bytes_atomic", fail)
    if crash:
        with pytest.raises(SystemExit):
            patches.apply_to_source(**args)
        # A later recovery attempt fails, requiring rollback from persisted backups.
        failed = False
        crash = False
    result = patches.apply_to_source(**args)
    assert result.rolled_back
    assert mode(args["source"] / "deleted") == 0o640
    assert mode(args["source"] / "gradlew") == 0o751
    assert not (args["source"] / "added").exists()
    assert not list(tmp_path.rglob(".pipeline-*"))
    assert patches.apply_to_source(**args).applied


@posix
def test_workspace_delete_rollback_restores_mode(tmp_path, monkeypatch):
    target = tmp_path / "script"
    target.write_bytes(b"old")
    target.chmod(0o751)
    original = patches.write_bytes_atomic
    failed = False

    def fail(path, data, **kwargs):
        nonlocal failed
        if path.name == "new" and not failed:
            failed = True
            raise OSError("injected failure")
        return original(path, data, **kwargs)

    monkeypatch.setattr(patches, "write_bytes_atomic", fail)
    with pytest.raises(EngineError):
        patches.validate_and_apply([FileEdit(path="script", action="delete"),
                                    FileEdit(path="new", action="create", content="new")],
                                  workspace=tmp_path, policy=PathPolicy(tmp_path, (), ()),
                                  declared=["script", "new"], scope="strict", undeclared_budget=0, limits=Limits())
    assert target.read_bytes() == b"old"
    assert mode(target) == 0o751


def test_legacy_manifest_and_journal_replay(tmp_path):
    args = fixture(tmp_path)
    for row in args["manifest"].values():
        row.pop("mode", None)
    prepare(args)
    assert patches.apply_to_source(**args).applied
    journal = json.loads(args["journal_path"].read_bytes())
    journal.pop("modes", None)
    args["journal_path"].write_text(json.dumps(journal))
    assert patches.apply_to_source(**args).applied

import hashlib

import pytest

from scranton_pipeline.config import DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED, Limits
from scranton_pipeline.errors import EngineError
from scranton_pipeline.models import FileEdit, Replacement
from scranton_pipeline.tools import patches
from scranton_pipeline.tools.fs import PathPolicy


def policy(root):
    return PathPolicy(root, DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED)


def apply(root, edits, **kwargs):
    return patches.validate_and_apply(edits, workspace=root, policy=policy(root), declared=kwargs.get("declared", [e.path for e in edits]),
                                      scope=kwargs.get("scope", "strict"), undeclared_budget=kwargs.get("budget", 2), limits=Limits())


def test_edit_set_is_all_or_nothing_and_preserves_exact_outside_bytes(tmp_path):
    path = tmp_path / "a.txt"
    path.write_bytes(b"start\r\nneedle\r\nend\n")
    edits = [FileEdit(path="a.txt", action="modify", replacements=[Replacement(search="needle", replace="new\nline")]),
             FileEdit(path="new.json", action="create", content="not JSON")]
    result = apply(tmp_path, edits)
    assert not result.ok
    assert path.read_bytes() == b"start\r\nneedle\r\nend\n"
    assert not (tmp_path / "new.json").exists()
    result = apply(tmp_path, edits[:1])
    assert result.ok
    assert path.read_bytes() == b"start\r\nnew\r\nline\r\nend\n"


@pytest.mark.parametrize("content,search,replace", [("x x", "x", "y"), ("a", "x", "y"), ("a", "a", "a")])
def test_ambiguous_missing_and_noop_replacements_rejected(tmp_path, content, search, replace):
    path = tmp_path / "a"
    path.write_text(content)
    result = apply(tmp_path, [FileEdit(path="a", action="modify", replacements=[Replacement(search=search, replace=replace)])])
    assert not result.ok and path.read_text() == content


@pytest.mark.parametrize("rel", ["../x", ".env", "package-lock.json", ".github/workflows/ci.yml"])
def test_security_edit_raises_before_any_write(tmp_path, rel):
    edits = [FileEdit(path="valid", action="create", content="yes"), FileEdit(path=rel, action="create", content="no")]
    with pytest.raises(EngineError):
        apply(tmp_path, edits)
    assert not (tmp_path / "valid").exists()


def test_scope_manifests_and_invalid_syntax(tmp_path):
    assert not apply(tmp_path, [FileEdit(path="extra", action="create", content="x")], declared=[]).ok
    assert not apply(tmp_path, [FileEdit(path="package.json", action="create", content="{}")], declared=[], scope="plan_plus_flagged").ok
    assert not apply(tmp_path, [FileEdit(path="bad.py", action="create", content="def :")]).ok
    assert apply(tmp_path, [FileEdit(path="extra", action="create", content="x")], declared=[], scope="plan_plus_flagged").undeclared == ["extra"]


def fixture(tmp_path):
    source, workspace = tmp_path / "source", tmp_path / "workspace"
    source.mkdir()
    workspace.mkdir()
    (source / "a").write_bytes(b"old\r\n")
    (source / "b").write_bytes(b"delete")
    (workspace / "a").write_bytes(b"new\r\n")
    (workspace / "c").write_bytes(b"created")
    manifest = {name: {"sha256": hashlib.sha256((source / name).read_bytes()).hexdigest(), "size": (source / name).stat().st_size} for name in ("a", "b")}
    return {"workspace": workspace, "source": source, "changes": [("M", "a"), ("D", "b"), ("A", "c")], "manifest": manifest,
            "backup_dir": tmp_path / "backups", "journal_path": tmp_path / "journal.json", "policy": policy(source)}


def test_source_conflict_writes_nothing(tmp_path):
    args = fixture(tmp_path)
    source = args["source"]
    (source / "a").write_text("user change")
    result = patches.apply_to_source(**args)
    assert result.conflicts and not result.applied
    assert (source / "a").read_text() == "user change"
    assert (source / "b").exists() and not (source / "c").exists()
    assert not args["journal_path"].exists()


def test_source_io_failure_rolls_back_all_bytes(tmp_path, monkeypatch):
    args = fixture(tmp_path)
    original = patches.write_bytes_atomic
    failed = False

    def fail_once(path, data, **kwargs):
        nonlocal failed
        if path == args["source"] / "c" and not failed:
            failed = True
            raise OSError("injected disk fault")
        original(path, data, **kwargs)

    monkeypatch.setattr(patches, "write_bytes_atomic", fail_once)
    result = patches.apply_to_source(**args)
    assert result.rolled_back
    assert (args["source"] / "a").read_bytes() == b"old\r\n"
    assert (args["source"] / "b").read_bytes() == b"delete"
    assert not (args["source"] / "c").exists()
    assert patches.apply_to_source(**args).applied == ["a", "b", "c"]


def test_source_crash_after_write_recovers_idempotently(tmp_path, monkeypatch):
    args = fixture(tmp_path)
    original = patches.write_bytes_atomic
    crashed = False

    def crash_after_write(path, data, **kwargs):
        nonlocal crashed
        original(path, data, **kwargs)
        if path == args["source"] / "a" and not crashed:
            crashed = True
            raise SystemExit("simulated hard crash before journal done entry")

    monkeypatch.setattr(patches, "write_bytes_atomic", crash_after_write)
    with pytest.raises(SystemExit):
        patches.apply_to_source(**args)
    assert (args["source"] / "a").read_bytes() == b"new\r\n"
    assert patches.apply_to_source(**args).applied == ["a", "b", "c"]
    assert patches.apply_to_source(**args).applied == ["a", "b", "c"]
    assert not (args["source"] / "b").exists()
    assert (args["source"] / "c").read_bytes() == b"created"


def test_existing_addition_and_changed_journal_are_refused(tmp_path):
    args = fixture(tmp_path)
    (args["source"] / "c").write_text("unrelated")
    assert patches.apply_to_source(**args).conflicts
    (args["source"] / "c").unlink()
    assert patches.apply_to_source(**args).applied
    args["changes"] = [("M", "a")]
    with pytest.raises(EngineError) as raised:
        patches.apply_to_source(**args)
    assert raised.value.code == "journal_mismatch"


def test_workspace_io_failure_rolls_back_validated_set(tmp_path, monkeypatch):
    (tmp_path / "a").write_bytes(b"original\r\n")
    original = patches.write_bytes_atomic
    failed = False

    def fail_once(path, data, **kwargs):
        nonlocal failed
        if path.name == "b" and not failed:
            failed = True
            raise OSError("injected workspace write failure")
        original(path, data, **kwargs)

    monkeypatch.setattr(patches, "write_bytes_atomic", fail_once)
    with pytest.raises(EngineError) as raised:
        apply(tmp_path, [FileEdit(path="a", action="modify", content="changed"),
                         FileEdit(path="b", action="create", content="new")])
    assert raised.value.code == "edit_io_error"
    assert (tmp_path / "a").read_bytes() == b"original\r\n"
    assert not (tmp_path / "b").exists()

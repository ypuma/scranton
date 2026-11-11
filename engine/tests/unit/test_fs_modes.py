"""Atomic replacement permissions; fixtures stay under the supplied project basetemp."""
import os
import stat

import pytest

from scranton_pipeline.tools import fs

posix_modes = pytest.mark.skipif(
    os.name == "nt", reason="Windows chmod does not implement POSIX permission/execute bits"
)


@posix_modes
@pytest.mark.parametrize("mode", [0o755, 0o751, 0o640, 0o444])
def test_existing_regular_mode_survives_write_and_restore(tmp_path, mode):
    target = tmp_path / "script"
    target.write_bytes(b"original\r\n")
    target.chmod(mode)
    for data in (b"patched\n", b"original\r\n"):
        fs.write_bytes_atomic(target, data)
        assert target.read_bytes() == data
        assert stat.S_IMODE(target.stat().st_mode) == mode
    assert not list(tmp_path.glob(".pipeline-*"))


@posix_modes
@pytest.mark.parametrize("mask", [0o000, 0o022, 0o077, 0o777])
def test_new_files_keep_private_mkstemp_umask_semantics(tmp_path, mask):
    previous = os.umask(mask)
    try:
        fs.write_bytes_atomic(tmp_path / "new", b"private")
    finally:
        os.umask(previous)
    assert stat.S_IMODE((tmp_path / "new").stat().st_mode) == (0o600 & ~mask)


@posix_modes
def test_existing_mode_is_not_filtered_by_current_umask(tmp_path):
    target = tmp_path / "script"
    target.write_bytes(b"old")
    target.chmod(0o751)
    previous = os.umask(0o777)
    try:
        fs.write_bytes_atomic(target, b"new")
    finally:
        os.umask(previous)
    assert stat.S_IMODE(target.stat().st_mode) == 0o751


@posix_modes
def test_symlink_replacement_does_not_copy_or_chmod_referent(tmp_path):
    referent = tmp_path / "referent"
    referent.write_bytes(b"untouched")
    referent.chmod(0o751)
    link = tmp_path / "link"
    link.symlink_to(referent)
    fs.write_bytes_atomic(link, b"replacement")
    assert not link.is_symlink()
    assert link.read_bytes() == b"replacement"
    assert not stat.S_IMODE(link.stat().st_mode) & 0o111
    assert referent.read_bytes() == b"untouched"
    assert stat.S_IMODE(referent.stat().st_mode) == 0o751


@posix_modes
def test_mode_failure_leaves_original_and_cleans_temp(tmp_path, monkeypatch):
    target = tmp_path / "script"
    target.write_bytes(b"old")
    target.chmod(0o755)

    def denied(fd, mode):
        raise PermissionError("injected mode failure")

    monkeypatch.setattr(fs.os, "fchmod", denied)
    with pytest.raises(PermissionError, match="injected mode failure"):
        fs.write_bytes_atomic(target, b"new")
    assert target.read_bytes() == b"old"
    assert stat.S_IMODE(target.stat().st_mode) == 0o755
    assert not list(tmp_path.glob(".pipeline-*"))


def test_replace_failure_leaves_original_and_cleans_temp(tmp_path, monkeypatch):
    target = tmp_path / "file"
    target.write_bytes(b"old")

    def denied(*args):
        raise OSError("injected replace failure")

    monkeypatch.setattr(fs.os, "replace", denied)
    with pytest.raises(OSError, match="injected replace failure"):
        fs.write_bytes_atomic(target, b"new")
    assert target.read_bytes() == b"old"
    assert not list(tmp_path.glob(".pipeline-*"))


def test_bytes_and_parent_creation(tmp_path):
    target = tmp_path / "nested" / "file"
    fs.write_bytes_atomic(target, b"\x00\xff\r\n")
    fs.write_bytes_atomic(target, b"restored\r\n")
    assert target.read_bytes() == b"restored\r\n"
    assert not list(target.parent.glob(".pipeline-*"))


@posix_modes
@pytest.mark.parametrize("mode", [0o4751, 0o2751, 0o1751])
def test_atomic_write_strips_special_bits(tmp_path, mode):
    target = tmp_path / "script"
    target.write_bytes(b"old")
    target.chmod(mode)
    fs.write_bytes_atomic(target, b"new")
    assert stat.S_IMODE(target.stat().st_mode) == 0o751


@posix_modes
def test_explicit_mode_uses_private_inode_not_hardlink(tmp_path):
    target = tmp_path / "script"
    target.write_bytes(b"old")
    target.chmod(0o640)
    sibling = tmp_path / "hard"
    sibling.hardlink_to(target)
    fs.write_bytes_atomic(target, b"new", mode=0o7751)
    assert stat.S_IMODE(target.stat().st_mode) == 0o751
    assert sibling.read_bytes() == b"old"
    assert stat.S_IMODE(sibling.stat().st_mode) == 0o640


@posix_modes
def test_explicit_mode_on_symlink_does_not_chmod_referent(tmp_path):
    referent = tmp_path / "referent"
    referent.write_bytes(b"outside")
    referent.chmod(0o640)
    target = tmp_path / "link"
    target.symlink_to(referent)
    fs.write_bytes_atomic(target, b"new", mode=0o4751)
    assert not target.is_symlink()
    assert stat.S_IMODE(target.stat().st_mode) == 0o751
    assert referent.read_bytes() == b"outside"
    assert stat.S_IMODE(referent.stat().st_mode) == 0o640


def test_windows_ignores_explicit_posix_mode(tmp_path, monkeypatch):
    if os.name != "nt":
        pytest.skip("Windows-only chmod behavior")

    def denied(*args):
        raise AssertionError("Must not call POSIX chmod on Windows")

    monkeypatch.setattr(fs.os, "fchmod", denied, raising=False)
    target = tmp_path / "file"
    fs.write_bytes_atomic(target, b"new", mode=0o7777)
    fs.write_bytes_atomic(target, b"updated", mode=0)
    assert target.read_bytes() == b"updated"

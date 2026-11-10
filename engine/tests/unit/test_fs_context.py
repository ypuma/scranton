import os
import subprocess

import pytest

from scranton_pipeline.config import DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED, Limits, Policy
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.models import ContextRequest
from scranton_pipeline.tools.context import fulfil
from scranton_pipeline.tools.fs import (
    PathPolicy,
    detect_newline,
    read_text,
    sha256_file,
    write_bytes_atomic,
)
from scranton_pipeline.tools.repo_index import build_index, detect_checks, render_tree
from scranton_pipeline.tools.secrets import Redactor
from scranton_pipeline.tools.snapshot import snapshot_source


def policy(root):
    return PathPolicy(root, DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED)


@pytest.mark.parametrize("path", ["", "/a", "C:/a", "C:a", "//host/share", "\\\\host\\share", "../a", "a/../b", "a\0b", "CON", "con.txt", "LPT1.log", "AUX", "NUL", "COM9", "a.", "a ", "a/b:stream", "a\\b", "a//b", "./a", "a/*"])
def test_unsafe_paths_are_security_failures(tmp_path, path):
    with pytest.raises(EngineError) as raised:
        policy(tmp_path).resolve(path)
    assert raised.value.failure_class == FailureClass.SECURITY


@pytest.mark.parametrize("path", [".git/config", ".env", ".env.production", "x/private.pem", "root.key", "cert.p12", "cert.pfx", "x/id_rsa.pub", "id_ed25519", ".ssh/config", ".npmrc", ".pypirc", "credentials.json", "x/auth.json"])
def test_default_protected_paths(tmp_path, path):
    assert policy(tmp_path).is_protected(path)


@pytest.mark.parametrize("path", ["package-lock.json", "x/yarn.lock", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "Cargo.lock", ".github/workflows/test.yml", ".gitlab-ci.yml"])
def test_write_protection_is_readable(tmp_path, path):
    assert policy(tmp_path).is_write_protected(path)
    assert not policy(tmp_path).is_protected(path)


def test_windows_protection_is_case_insensitive(tmp_path):
    if os.name != "nt":
        pytest.skip("Windows-only case-insensitive protection")
    assert policy(tmp_path).is_protected(".ENV")
    assert policy(tmp_path).is_write_protected("CARGO.LOCK")


def test_real_link_escape(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (root / "link").symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        if os.name != "nt":
            pytest.skip(f"OS does not permit symlink creation: {exc}")
        result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(root / "link"), str(outside)],
                                capture_output=True, timeout=5, shell=False, check=False)
        if result.returncode:
            pytest.skip(f"OS denies both symlink and junction creation: {result.stderr!r}")
    with pytest.raises(EngineError) as raised:
        policy(root).resolve("link/file")
    assert raised.value.failure_class == FailureClass.SECURITY


def test_atomic_bytes_utf8_cap_and_binary(tmp_path):
    path = tmp_path / "file"
    write_bytes_atomic(path, "é\r\nabc\n".encode())
    before = sha256_file(path)
    assert read_text(path, 1) == ("", True)
    assert detect_newline(path.read_bytes()) == "\r\n"
    assert sha256_file(path) == before
    path.write_bytes(b"abc\0def")
    with pytest.raises(EngineError, match="UTF-8"):
        read_text(path, 100)


def test_snapshot_filters_and_exact_manifest(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "a.txt").write_bytes(b"a\r\nb\n")
    (source / ".env").write_bytes(b"password=do-not-copy")
    (source / "huge").write_bytes(b"x" * 100)
    workspace = tmp_path / "workspace"
    manifest_path = tmp_path / "manifest.json"
    result = snapshot_source(source, workspace, policy=Policy(), limits=Limits(max_file_bytes=10), manifest_path=manifest_path)
    assert result.files == 1 and result.total_bytes == 5
    assert (workspace / "a.txt").read_bytes() == (source / "a.txt").read_bytes()
    import json
    manifest = json.loads(manifest_path.read_text())
    assert manifest["a.txt"]["sha256"] == sha256_file(workspace / "a.txt")
    assert {p.name for p in source.iterdir()} == {"a.txt", ".env", "huge"}
    assert {row["reason"] for row in result.skipped} == {"protected", "file_too_large"}
    with pytest.raises(EngineError) as raised:
        snapshot_source(source, tmp_path / "limited", policy=Policy(), limits=Limits(max_workspace_bytes=1), manifest_path=manifest_path)
    assert raised.value.code == "workspace_too_large"
    with pytest.raises(EngineError):
        snapshot_source(source, source / "nested", policy=Policy(), limits=Limits(), manifest_path=manifest_path)


def test_context_literal_search_bounds_and_redaction(tmp_path):
    (tmp_path / "data.txt").write_text("a.* literal\npassword=hidden\na.* again\n")
    (tmp_path / ".env").write_text("must not leave")
    requests = [ContextRequest(kind="search", query="a.*"), ContextRequest(kind="read", path="data.txt", start_line=2, end_line=2),
                ContextRequest(kind="read", path=".env"), ContextRequest(kind="list")]
    result = fulfil(requests, workspace=tmp_path, policy=policy(tmp_path), files=["data.txt", ".env"], limits=Limits(max_search_matches=1), redactor=Redactor())
    assert result[0].content == "data.txt:1: a.* literal"
    assert result[0].truncated
    assert "hidden" not in result[1].content
    assert not result[2].ok
    assert result[3].content == "data.txt"
    refused = fulfil([ContextRequest(kind="read", path="../a")], workspace=tmp_path, policy=policy(tmp_path), files=[], limits=Limits(), redactor=Redactor())
    assert not refused[0].ok and 'read path="../a"' in refused[0].note
    bounded = fulfil([ContextRequest(kind="read", path="data.txt")] * 3, workspace=tmp_path, policy=policy(tmp_path), files=[], limits=Limits(max_context_bytes=10, max_context_item_bytes=6), redactor=Redactor())
    assert sum(len(x.content.encode()) for x in bounded) <= 10
    assert not bounded[-1].ok


def test_index_parse_only_and_fixed_check_suggestions(tmp_path):
    (tmp_path / "a.py").write_text("raise RuntimeError('never execute')\ndef hello(): pass\n")
    (tmp_path / "README.md").write_text("password=secretstuff")
    (tmp_path / "pyproject.toml").write_text("")
    index = build_index(tmp_path, ["a.py", "README.md", "pyproject.toml"], limits=Limits())
    assert index.symbols["a.py"] == ["hello"]
    assert "secretstuff" not in index.readme_excerpt
    assert detect_checks(index)[0]["argv"] == ["python", "-m", "pytest", "-q"]
    assert "2 more files" in render_tree(index, max_entries=1)


def test_redactor_known_patterns_and_scan():
    redactor = Redactor(["registered-value"])
    text = "registered-value Bearer abcdef password=hidden sk-abcdefghijklmnop"
    assert "registered-value" not in redactor.redact(text)
    assert "hidden" not in redactor.redact(text)
    assert set(redactor.scan(text)) >= {"known_secret", "bearer", "credential", "provider_key"}


def test_junction_alias_cannot_read_protected_content_and_snapshot_skips_it(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    secret_dir = source / ".ssh"
    secret_dir.mkdir()
    (secret_dir / "config").write_text("sensitive material")
    alias = source / "innocent"
    try:
        alias.symlink_to(secret_dir, target_is_directory=True)
    except OSError as exc:
        if os.name != "nt":
            pytest.skip(f"OS does not permit symlink creation: {exc}")
        result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(alias), str(secret_dir)],
                                capture_output=True, timeout=5, shell=False, check=False)
        if result.returncode:
            pytest.skip(f"OS denies both symlink and junction creation: {result.stderr!r}")
    assert policy(source).is_protected("innocent/config")
    result = fulfil([ContextRequest(kind="read", path="innocent/config")], workspace=source,
                    policy=policy(source), files=[], limits=Limits(), redactor=Redactor())
    assert not result[0].ok and not result[0].content
    copied = snapshot_source(source, tmp_path / "workspace", policy=Policy(), limits=Limits(),
                             manifest_path=tmp_path / "manifest.json")
    assert copied.files == 0
    assert not (tmp_path / "workspace" / "innocent").exists()

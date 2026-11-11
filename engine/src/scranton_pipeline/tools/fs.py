"""Portable path validation and byte-preserving atomic filesystem operations."""
import fnmatch
import hashlib
import os
import re
import stat
import tempfile
import time
from collections.abc import Sequence
from pathlib import Path

from ..errors import EngineError, FailureClass


class PathPolicy:
    def __init__(self, root: Path, protected: Sequence[str], write_protected: Sequence[str]) -> None:
        self.root = root.resolve()
        self.protected = tuple(protected)
        self.write_protected = tuple(write_protected)

    def normalize(self, rel: str) -> str:
        if (not rel or "\0" in rel or "\\" in rel or ":" in rel or rel.startswith("/")
                or any(p in ("", ".", "..") or p.endswith((".", " "))
                       or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", p, re.IGNORECASE)
                       or any(ord(c) < 32 or c in '<>"|?*' for c in p)
                       for p in rel.split("/"))):
            raise EngineError(FailureClass.SECURITY, "unsafe_path", "Invalid relative path")
        return rel

    def resolve(self, rel: str) -> Path:
        target = (self.root / self.normalize(rel)).resolve()
        if not target.is_relative_to(self.root) or target == self.root:
            raise EngineError(FailureClass.SECURITY, "path_escape", "Path leaves workspace")
        return target

    def _matches(self, rel: str, patterns: Sequence[str]) -> bool:
        rel = self.normalize(rel).casefold()
        for pattern in patterns:
            pat = pattern.casefold()
            # Match directories themselves as well as descendants; **/ includes root files.
            variants = (pat, pat[3:]) if pat.startswith("**/") else (pat, "**/" + pat)
            for variant in variants:
                if fnmatch.fnmatchcase(rel, variant) or (variant.endswith("/**") and rel == variant[:-3]):
                    return True
                if "/" not in variant and any(fnmatch.fnmatchcase(p, variant) for p in rel.split("/")):
                    return True
        return False

    def is_protected(self, rel: str) -> bool:
        resolved = self.resolve(rel).relative_to(self.root).as_posix()
        return self._matches(rel, self.protected) or self._matches(resolved, self.protected)

    def is_write_protected(self, rel: str) -> bool:
        resolved = self.resolve(rel).relative_to(self.root).as_posix()
        return (self.is_protected(rel) or self._matches(rel, self.write_protected)
                or self._matches(resolved, self.write_protected))


def read_text(path: Path, max_bytes: int) -> tuple[str, bool]:
    with path.open("rb") as stream:
        data = stream.read(max_bytes + 1)
    truncated = len(data) > max_bytes
    data = data[:max_bytes]
    try:
        if b"\0" in data:
            raise UnicodeError("binary content")
        # An incomplete UTF-8 code point at the byte cap is not a binary file.
        import codecs
        text = codecs.getincrementaldecoder("utf-8")().decode(data, final=not truncated)
    except UnicodeError as exc:
        raise EngineError(FailureClass.IMPLEMENTATION, "not_text", "File is not UTF-8 text") from exc
    return text, truncated


def write_bytes_atomic(path: Path, data: bytes, *, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        mode = None
    elif mode is None:
        try:
            existing = path.lstat()
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISREG(existing.st_mode):
                mode = existing.st_mode & 0o777
    fd, name = tempfile.mkstemp(prefix=".pipeline-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            # Apply after writing (which can clear mode bits), only to our private inode.
            if mode is not None:
                os.fchmod(stream.fileno(), mode & 0o777)
            os.fsync(stream.fileno())
        first: PermissionError | None = None
        for attempt in range(41):
            try:
                os.replace(name, path)
                break
            except PermissionError as exc:
                if first is None:
                    first = exc
                if os.name != "nt" or getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 40:
                    raise first
                # Windows readers may omit delete-sharing while polling status/artifacts.
                time.sleep(0.05)
    finally:
        Path(name).unlink(missing_ok=True)


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def detect_newline(data: bytes) -> str:
    crlf = data.count(b"\r\n")
    return "\r\n" if crlf and crlf >= data.count(b"\n") - crlf else "\n"


def is_dependency_manifest(path: Path) -> bool:
    name = path.resolve().name.casefold()
    return (name in {"package.json", "pyproject.toml", "setup.py", "setup.cfg", "pipfile",
                     "cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
                     "gemfile", "composer.json"}
            or fnmatch.fnmatchcase(name, "requirements*.txt") or name.endswith(".csproj"))

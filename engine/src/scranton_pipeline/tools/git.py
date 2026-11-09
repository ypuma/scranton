"""Isolated local Git operations; never calls network commands."""
import os
import shutil
from collections.abc import Sequence
from pathlib import Path

from ..errors import EngineError, FailureClass
from .fs import PathPolicy
from .process import run_process, scrubbed_env

DEFAULT_IGNORED_DIRS = frozenset({".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
                                ".ruff_cache", ".pytest_cache", "dist", "build", "target", ".scratch"})


def git_available() -> bool:
    return shutil.which("git") is not None


def _git(root: Path, args: Sequence[str], timeout_s: float = 30, *, check: bool = True, git_dir: Path | None = None) -> str:
    env = scrubbed_env(os.environ, (), {"GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull})
    hooks = (git_dir.parent / (git_dir.name + "-hooks")) if git_dir else Path(os.devnull)
    prefix = ["--git-dir=" + str(git_dir), "--work-tree=" + str(root)] if git_dir else []
    result = run_process(["git", *prefix, "-c", "core.hooksPath=" + str(hooks),
                          "-c", "core.autocrlf=false", "-c", "core.longpaths=true",
                          "-c", "core.fsmonitor=false", "-c", "credential.helper=",
                          "-c", "user.name=Scranton Pipeline", "-c", "user.email=pipeline@localhost", *args],
                         cwd=root, env=env, timeout_s=timeout_s, tail_bytes=8000000)
    if result.timed_out or result.stopped or (check and result.exit_code != 0):
        raise EngineError(FailureClass.INFRASTRUCTURE, "git_failed", "Local Git operation failed", detail=result.output_tail)
    if result.output_bytes > 8000000:
        raise EngineError(FailureClass.LIMIT, "git_output_exceeded", "Git output exceeds limit")
    if not check and result.exit_code != 0:
        return ""
    return result.output_tail


def list_source_files(source: Path, *, timeout_s: float) -> tuple[list[str], bool]:
    # A source folder ignored by an enclosing repository is still a standalone source.
    if (git_available()
            and _git(source, ["rev-parse", "--is-inside-work-tree"], timeout_s, check=False).strip() == "true"
            and not _git(source, ["check-ignore", "."], timeout_s, check=False).strip()):
        raw = _git(source, ["ls-files", "-co", "--exclude-standard", "-z"], timeout_s)
        return sorted({p for p in raw.split("\0") if p}), True
    files: list[str] = []
    for root, dirs, names in os.walk(source, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in DEFAULT_IGNORED_DIRS
                         and not (Path(root) / d).is_symlink() and not (Path(root) / d).is_junction())
        files.extend((Path(root) / name).relative_to(source).as_posix() for name in sorted(names))
    return sorted(files), False


class WorkspaceRepo:
    def __init__(self, workspace: Path, git_dir: Path | None = None, *, timeout_s: float = 30) -> None:
        self.workspace = workspace.resolve()
        self.git_dir = (git_dir or workspace.parent / (workspace.name + ".git")).resolve()
        if self.git_dir.is_relative_to(self.workspace):
            raise ValueError("Git metadata must be outside workspace")
        self.timeout_s = timeout_s

    @classmethod
    def init(cls, workspace: Path, git_dir: Path | None = None, *, timeout_s: float = 30) -> "WorkspaceRepo":
        workspace.mkdir(parents=True, exist_ok=True)
        repo = cls(workspace, git_dir, timeout_s=timeout_s)
        repo.git_dir.parent.mkdir(parents=True, exist_ok=True)
        (repo.git_dir.parent / (repo.git_dir.name + "-hooks")).mkdir(exist_ok=True)
        repo._run(["init", "--template=", "--initial-branch=main"])
        return repo

    def _run(self, args: Sequence[str]) -> str:
        return _git(self.workspace, args, self.timeout_s, git_dir=self.git_dir)

    def commit_all(self, message: str) -> str:
        self._run(["add", "-A", "--", "."])
        self._run(["-c", "commit.gpgsign=false", "commit", "--no-verify", "--allow-empty", "-m", message])
        return self.head()

    def commit_paths(self, paths: Sequence[str], message: str) -> str:
        policy = PathPolicy(self.workspace, (), ())
        safe = [policy.normalize(p) for p in paths]
        if safe:
            self._run(["--literal-pathspecs", "add", "-A", "--", *safe])
        self._run(["-c", "commit.gpgsign=false", "commit", "--no-verify", "--allow-empty", "-m", message])
        return self.head()

    def head(self) -> str:
        return self._run(["rev-parse", "HEAD"]).strip()

    def reset_hard(self, commit: str) -> None:
        self._run(["reset", "--hard", commit])
        self._run(["clean", "-fd"])

    def restore_tracked(self) -> list[str]:
        changed = [p for p in self._run(["diff", "HEAD", "--name-only", "-z"]).split("\0") if p]
        if changed:
            self._run(["restore", "--source=HEAD", "--staged", "--worktree", "--", "."])
        return changed

    def diff(self, base: str, head: str) -> str:
        return self._run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--"])

    def changed_files(self, base: str, head: str) -> list[tuple[str, str]]:
        parts = self._run(["diff", "--no-renames", "--name-status", "-z", base, head, "--"]).split("\0")
        return [(parts[i], parts[i + 1]) for i in range(0, len(parts) - 1, 2)]

    def numstat(self, base: str, head: str) -> list[tuple[int, int, str]]:
        rows = self._run(["diff", "--no-renames", "--numstat", "-z", base, head, "--"]).split("\0")
        result = []
        for row in rows:
            if row:
                added, removed, path = row.split("\t", 2)
                result.append((int(added) if added != "-" else 0, int(removed) if removed != "-" else 0, path))
        return result

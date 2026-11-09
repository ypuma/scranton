"""Static repository facts and fixed check suggestions, never code execution."""
import ast
import shutil
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ..config import DEFAULT_PROTECTED, Limits
from ..errors import EngineError
from ..models import StrictModel
from .fs import PathPolicy, is_dependency_manifest, read_text
from .secrets import Redactor


class RepoIndex(StrictModel):
    files: list[dict[str, Any]]
    languages: dict[str, int]
    manifests: list[dict[str, str]]
    readme_excerpt: str
    symbols: dict[str, list[str]]
    truncated: bool


_LANGUAGES = {".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".ts": "TypeScript",
              ".tsx": "TypeScript", ".rs": "Rust", ".go": "Go", ".java": "Java", ".cs": "C#"}


def build_index(workspace: Path, files: Sequence[str], *, limits: Limits) -> RepoIndex:
    policy = PathPolicy(workspace, DEFAULT_PROTECTED, ())
    records: list[dict[str, Any]] = []
    languages: Counter[str] = Counter()
    manifests: list[dict[str, str]] = []
    symbols: dict[str, list[str]] = {}
    readme = ""
    redactor = Redactor()
    truncated = len(files) > limits.max_workspace_files
    for rel in sorted(files)[:limits.max_workspace_files]:
        if policy.is_protected(rel):
            continue
        path = policy.resolve(rel)
        if not path.is_file():
            continue
        language = _LANGUAGES.get(path.suffix, "Other")
        languages[language] += 1
        records.append({"path": rel, "size": path.stat().st_size, "language": language})
        if is_dependency_manifest(path) or path.name.casefold() == "package-lock.json":
            manifests.append({"path": rel, "name": path.name})
        if path.suffix == ".py" or (not readme and path.name.lower().startswith("readme")):
            try:
                text, cut = read_text(path, limits.max_context_item_bytes)
                if path.suffix == ".py":
                    tree = ast.parse(text)
                    symbols[rel] = [n.name for n in ast.walk(tree)
                                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))][:200]
                else:
                    readme = redactor.redact(text)
                truncated = truncated or cut
            except (EngineError, SyntaxError):
                continue
    return RepoIndex(files=records, languages=dict(languages), manifests=manifests,
                     readme_excerpt=readme, symbols=symbols, truncated=truncated)


def render_tree(index: RepoIndex, *, max_entries: int) -> str:
    paths = [str(row["path"]) for row in index.files]
    shown = paths[:max_entries]
    if len(paths) > max_entries:
        shown.append(f"... {len(paths) - max_entries} more files")
    return "\n".join(shown)


def detect_checks(index: RepoIndex) -> list[dict[str, Any]]:
    names = {item["name"].casefold() for item in index.manifests}
    recipes = [("package.json", "npm-test", "test", ["npm", "test"]),
               ("pyproject.toml", "pytest", "test", ["python", "-m", "pytest", "-q"]),
               ("cargo.toml", "cargo-test", "test", ["cargo", "test"]),
               ("go.mod", "go-test", "test", ["go", "test", "./..."])]
    return [{"id": id_, "kind": kind, "argv": argv, "reason": f"Detected {name}"}
            for name, id_, kind, argv in recipes if name in names and shutil.which(argv[0])]


def detect_setup(index: RepoIndex) -> list[dict[str, Any]]:
    names = {item["name"].casefold() for item in index.manifests}
    return [{"id": "npm-ci", "argv": ["npm", "ci"], "network": True,
             "reason": "Detected package-lock.json"}] if "package-lock.json" in names and shutil.which("npm") else []

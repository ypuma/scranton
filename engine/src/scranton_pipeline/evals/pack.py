"""Bounded, execution-free validation of operator-authored evaluation packs."""
import json
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import Field, StrictStr, field_validator, model_validator

from scranton_pipeline.config import CheckConfig
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.models import StrictModel
from scranton_pipeline.tools.fs import PathPolicy

Ident = Annotated[StrictStr, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
Score = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
State = Literal["demonstrated", "met_not_demonstrated", "attested", "not_met", "unclear", "undecided"]
Kind = Literal["unknown_citation", "unsupported_assessment", "unsupported_finding", "unseen_target", "unseen_edit", "false_absence", "protected_request", "out_of_scope_edit"]


class Acceptance(StrictModel):
    checks: list[CheckConfig] = Field(min_length=1, max_length=12)
    paths: list[StrictStr] = Field(min_length=1, max_length=100)


class Scripts(StrictModel):
    planner: StrictStr
    implementer: StrictStr
    reviewer: StrictStr


class Expect(StrictModel):
    status: Literal["succeeded", "failed", "suspended", "cancelled", "rejected"]
    violations: dict[Kind, Annotated[int, Field(ge=0, strict=True)]]
    adjusted: Score | None = None
    min_adjusted: Score | None = None
    criteria: dict[StrictStr, State]

    @model_validator(mode="after")
    def score_required(self) -> Self:
        if self.adjusted is None and self.min_adjusted is None:
            raise ValueError("expect requires adjusted or min_adjusted")
        return self


class Task(StrictModel):
    id: Ident
    track: Literal["baseline", "silence", "perspective", "counterfactual"]
    split: Literal["train", "val"]
    fixture: StrictStr
    task: Annotated[StrictStr, Field(min_length=1, max_length=32768)]
    checks: list[CheckConfig] = Field(min_length=1, max_length=12)
    acceptance: Acceptance
    scripts: Scripts
    expect: Expect


class Manifest(StrictModel):
    schema_version: Literal[1] = Field(alias="schema")
    name: Ident
    tasks: list[Task] = Field(min_length=1, max_length=100)

    @field_validator("schema_version", mode="before")
    @classmethod
    def schema_number(cls, value: Any) -> Any:
        if type(value) is not int:
            raise ValueError("schema must be integer 1")
        return value


@dataclass(frozen=True)
class Pack:
    root: Path
    manifest: Manifest
    builtin: bool = False


def invalid(message: str) -> EngineError:
    return EngineError(FailureClass.INVALID_INPUT, "invalid_eval", message)


def local(root: Path, rel: str) -> Path:
    policy = PathPolicy(root, (), ())
    policy.normalize(rel)
    path = policy.resolve(rel)
    cursor = root
    for part in Path(rel).parts:
        cursor /= part
        if cursor.is_symlink() or cursor.is_junction():
            raise ValueError(f"Linked pack path: {rel}")
    return path


def read_json(path: Path, cap: int = 2_000_000) -> Any:
    with path.open("rb") as stream:
        raw = stream.read(cap + 1)
    if len(raw) > cap:
        raise ValueError(f"File exceeds {cap} bytes: {path.name}")
    return json.loads(raw)


def load_pack(value: str) -> Pack:
    builtin = value == "core"
    root = Path(str(files("scranton_pipeline.evals").joinpath("packs/core"))) if builtin else Path(value)
    root = root.resolve()
    try:
        manifest = Manifest.model_validate(read_json(root / "pack.json"))
        if len({t.id for t in manifest.tasks}) != len(manifest.tasks):
            raise ValueError("Duplicate task id")
        for task in manifest.tasks:
            if len({c.id for c in task.checks}) != len(task.checks):
                raise ValueError(f"{task.id}: duplicate visible check id")
            if len({c.id for c in task.acceptance.checks}) != len(task.acceptance.checks):
                raise ValueError(f"{task.id}: duplicate acceptance check id")
            fixture = local(root, task.fixture)
            if not fixture.is_dir():
                raise ValueError(f"{task.id}: fixture is not a directory")
            entries = list(fixture.rglob("*"))
            if len(entries) > 20000:
                raise ValueError(f"{task.id}: fixture exceeds 20000 entries")
            total = 0
            for entry in entries:
                local(root, entry.relative_to(root).as_posix())
                if entry.name.casefold() in {".git", ".pipeline"}:
                    raise ValueError(f"{task.id}: fixture contains reserved metadata")
                if entry.is_file():
                    total += entry.stat().st_size
                    if entry.stat().st_size > 2_000_000 or total > 100_000_000:
                        raise ValueError(f"{task.id}: fixture exceeds byte limits")
            for role, rel in task.scripts.model_dump().items():
                script = read_json(local(root, rel))
                if not isinstance(script, (list, dict)) or isinstance(script, dict) and any(not isinstance(v, list) for v in script.values()):
                    raise ValueError(f"{task.id}: {role} script must be turns or a scope map")
            for pattern in task.acceptance.paths:
                local(root, pattern.replace("*", "glob").replace("?", "glob"))
        return Pack(root, manifest, builtin)
    except (OSError, ValueError, EngineError) as exc:
        raise invalid(f"Invalid pack: {exc}") from exc


def select(pack: Pack, tasks: str | None, split: str) -> list[Task]:
    ids = tasks.split(",") if tasks is not None else None
    known = {t.id for t in pack.manifest.tasks}
    if ids is not None and (len(set(ids)) != len(ids) or any(i not in known for i in ids)):
        raise invalid("--tasks must contain unique, known task ids")
    result = [t for t in pack.manifest.tasks if (ids is None or t.id in ids) and (split == "all" or t.split == split)]
    if not result:
        raise invalid("Task selection is empty")
    return result

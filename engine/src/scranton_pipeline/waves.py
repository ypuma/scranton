"""Pure dependency validation and deterministic, disjoint wave selection."""
from collections.abc import Collection, Sequence

from scranton_pipeline.models import PlanStep


def dependencies(steps: Sequence[PlanStep]) -> dict[str, set[str]]:
    ids = [s.id for s in steps]
    if len(set(ids)) != len(ids) or any(not s.strip() for s in ids):
        raise ValueError("Step IDs must be nonempty and unique")
    result = {s.id: set(ids[:i] if s.depends_on is None else s.depends_on) for i, s in enumerate(steps)}
    if any(not deps <= set(ids) for deps in result.values()):
        raise ValueError("Unknown dependency ID")
    done: set[str] = set()
    while len(done) < len(ids):
        ready = {sid for sid, deps in result.items() if sid not in done and deps <= done}
        if not ready:
            raise ValueError("Cyclic step dependencies")
        done |= ready
    return result


def wave(steps: Sequence[PlanStep], done: Collection[str], cap: int) -> list[int]:
    deps = dependencies(steps)
    chosen: list[int] = []
    occupied: set[str] = set()
    for i, step in enumerate(steps):
        files = {f.path.replace("\\", "/").casefold() for f in step.files}
        if step.id not in done and deps[step.id] <= set(done) and not files & occupied:
            chosen.append(i)
            occupied |= files
            if len(chosen) >= cap:
                break
    return chosen

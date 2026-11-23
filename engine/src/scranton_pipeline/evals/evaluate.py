"""Run visible work first, then verify hidden ground truth on a separate tree."""
import fnmatch
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from scranton_pipeline.config import EngineConfig, ModelConfig, load_config
from scranton_pipeline.evals.pack import Pack, Task, invalid, local, select
from scranton_pipeline.grounding import score_trace
from scranton_pipeline.models import CheckResult
from scranton_pipeline.nodes.parallel import copy_workspace
from scranton_pipeline.observability import _rows
from scranton_pipeline.procedure import Graph, digest, load
from scranton_pipeline.runner import resume, start, validate_trust
from scranton_pipeline.tools.checks import run_checks
from scranton_pipeline.tools.fs import write_bytes_atomic
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.sandbox import build_sandbox


def write_json(path: Path, value: Any) -> None:
    write_bytes_atomic(path, (json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n").encode())


def output_dir(out: Path, pack: Pack) -> Path:
    out = out.resolve()
    if out.is_relative_to(pack.root) or pack.root.is_relative_to(out):
        raise invalid("Output must not overlap the evaluation pack")
    if out.exists() and any(out.iterdir()):
        raise invalid("Output directory must be empty")
    out.mkdir(parents=True, exist_ok=True)
    return out


def base_config(pack: Pack, path: Path | None, models: str, real_calls: bool, *, refiner: bool = False) -> EngineConfig:
    if models == "config" and path is None:
        raise invalid("--models config requires --config")
    if path is not None:
        cfg = load_config(path)
    else:
        cfg = EngineConfig.model_validate({"models": {r: {"provider": "scripted", "model": "eval", "script_path": "unused"} for r in ("planner", "implementer", "reviewer")}, "allow_no_checks": True})
    roles = ["planner", "implementer", "reviewer", *(["refiner"] if refiner else [])]
    if models == "config":
        for role in roles:
            model = getattr(cfg.models, role, None)
            if model is None:
                raise invalid(f"--models config requires models.{role}")
            if model.provider != "scripted" and not real_calls:
                raise invalid("Non-scripted models require explicit --real-calls")
    return cfg


def python_command(mode: str) -> list[str]:
    return ["python" if mode == "docker" else sys.executable]


def expand_python(argv: list[str], mode: str) -> list[str]:
    return [part for arg in argv for part in (python_command(mode) if arg == "{python}" else [arg])]


def task_config(pack: Pack, task: Task, cfg: EngineConfig, directory: Path, models: str, graph: Graph | None) -> EngineConfig:
    updates: dict[str, Any] = {"checks": [c.model_copy(update={"argv": expand_python(c.argv, cfg.sandbox.mode)}) for c in task.checks], "allow_no_checks": False,
        "approvals": cfg.approvals.model_copy(update={"plan": "always"})}
    if models == "scripted":
        scripts = directory / "scripts"
        scripts.mkdir()
        role_models = {}
        for role, rel in task.scripts.model_dump().items():
            dest = scripts / f"{role}.json"
            shutil.copyfile(local(pack.root, rel), dest)
            role_models[role] = ModelConfig(provider="scripted", model="eval", script_path=str(dest))
        updates["models"] = cfg.models.model_copy(update=role_models)
    if graph is not None:
        path = directory / "graph.json"
        write_json(path, graph.model_dump(mode="json", by_alias=True))
        updates["procedure"] = cfg.procedure.model_copy(update={"enabled": True, "graph": str(path)})
    else:
        updates["procedure"] = cfg.procedure.model_copy(update={"enabled": False})
    return cfg.model_copy(update=updates)


def acceptance(pack: Pack, task: Task, directory: Path, run_dir: Path, cfg: EngineConfig, succeeded: bool, trust_host: bool, deadline: float | None = None) -> tuple[float, list[dict[str, Any]]]:
    if not succeeded or deadline is not None and time.monotonic() >= deadline:
        return 0.0, []
    tree = directory / "accepted-tree"
    box = build_sandbox(cfg.sandbox, workspace=tree, run_id=run_dir.name, trust_host=trust_host,
                        name_suffix="acceptance", state_dir=run_dir / "sandbox-state", run_dir=run_dir)
    box.preflight()
    copy_workspace(local(pack.root, task.fixture), tree, box, exclude_state=False)
    repo = WorkspaceRepo.init(tree)
    base = repo.commit_all("Pristine acceptance fixture")
    patch = run_dir / "delivery" / "candidate.diff"
    if not patch.is_file():
        return 0.0, []
    if patch.stat().st_size:
        repo._run(["apply", "--index", "--whitespace=nowarn", str(patch)])
    head = repo.commit_all("Delivered patch")
    paths = [p for _, p in repo.changed_files(base, head)]
    allowed = all(any(fnmatch.fnmatchcase(p, g) or g.startswith("**/") and fnmatch.fnmatchcase(p, g[3:]) for g in task.acceptance.paths) for p in paths)
    checks = [c.model_copy(update={"argv": expand_python(c.argv, cfg.sandbox.mode)}) for c in task.acceptance.checks]
    results: list[CheckResult] = []
    try:
        for check in checks:
            remaining = check.timeout_s if deadline is None else deadline - time.monotonic()
            if remaining <= 0:
                return 0.0, [r.model_dump(mode="json") for r in results]
            bounded = check.model_copy(update={"timeout_s": min(check.timeout_s, remaining)})
            results.extend(run_checks([bounded], sandbox=box, log_dir=directory / "acceptance-logs", label="hidden", stop=None, fail_fast=False))
    finally:
        if cfg.sandbox.mode == "scranton":
            box.cleanup()
    return float(allowed and len(results) == len(checks) and all(r.status == "passed" for r in results)), [r.model_dump(mode="json") for r in results]


def expectation(task: Task, result: dict[str, Any]) -> bool:
    expect = task.expect
    return (result["status"] == expect.status and result["violations"] == expect.violations
        and {c["id"]: c["state"] for c in result["criteria"]} == expect.criteria
        and (expect.adjusted is None or result["adjusted"] == expect.adjusted)
        and (expect.min_adjusted is None or result["adjusted"] >= expect.min_adjusted))


def evaluate_task(pack: Pack, task: Task, cfg: EngineConfig, directory: Path, *, models: str, graph: Graph | None, trust_host: bool, deadline: float | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    directory.mkdir()
    source = directory / "source"
    copy_workspace(local(pack.root, task.fixture), source, None, exclude_state=False)
    WorkspaceRepo.init(source).commit_all("Evaluation fixture")
    visible = task_config(pack, task, cfg, directory, models, graph)
    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Evolution deadline before task")
        visible = visible.model_copy(update={"limits": visible.limits.model_copy(update={"max_active_seconds": min(remaining, visible.limits.max_active_seconds)})})
    status = start(source=source, task=task.task, cfg=visible, run_root=directory / "runs", delivery="patch", trust_host=trust_host)
    run_dir = directory / "runs" / status.run_id
    for _ in range(8):
        if status.status != "awaiting_approval" or deadline is not None and time.monotonic() >= deadline:
            break
        pending = status.pending
        assert pending is not None
        status = resume(run_dir, gate=pending["gate"], decision="approve", digest=pending["digest"], trust_host=trust_host, by="eval")
    answer, checks = acceptance(pack, task, directory, run_dir, visible, status.status == "succeeded", trust_host, deadline)
    score = score_trace(_rows(run_dir / "grounding.jsonl"), answer=answer)
    result = {"id": task.id, "status": status.status, **{k: score[k] for k in ("answer", "trajectory", "violation_rate", "adjusted", "tier", "violations", "criteria")}}
    result["expect_met"] = expectation(task, result)
    events = _rows(run_dir / "events.jsonl")
    diagnostics = {"id": task.id, "situations": [e["data"] for e in events if e["type"] == "procedure"],
        "outcome": status.status, "failure_code": status.failure.get("code") if status.failure else None,
        "grounding": {k: score[k] for k in ("answer", "trajectory", "adjusted", "violation_rate", "violations", "criteria")}}
    return result, {"run_dir": str(run_dir), "acceptance": checks, "trace": diagnostics}


def evaluate(pack: Pack, out: Path, *, cfg: EngineConfig, graph: Graph | None = None, tasks: str | None = None,
             split: str = "all", models: str = "scripted", trust_host: bool = False, deadline: float | None = None) -> dict[str, Any]:
    selected = select(pack, tasks, split)
    validate_trust(cfg, trust_host)
    out = output_dir(out, pack)
    started = time.monotonic()
    results, metadata = [], []
    for task in selected:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("Evolution deadline between tasks")
        result, meta = evaluate_task(pack, task, cfg, out / task.id, models=models, graph=graph,
                                     trust_host=trust_host, deadline=deadline)
        results.append(result)
        metadata.append(meta)
    scored = {"schema": 1, "pack": pack.manifest.name, "graph_digest": digest(graph) if graph else None,
        "tasks": results, "mean_adjusted": round(sum(r["adjusted"] for r in results) / len(results), 4)}
    value = {**scored, "meta": {"seconds": time.monotonic() - started, "tasks": metadata}}
    write_json(out / "eval.json", value)
    if not all(r["expect_met"] for r in results):
        for result, meta in zip(results, metadata, strict=True):
            failed = next((c for c in meta["acceptance"] if c["status"] != "passed"), None)
            if failed is not None:
                print(f"Evaluation task {result['id']}: acceptance check {failed['id']} "
                      f"{failed['status']}; log: {failed['log_path']}; diagnostics: {out / 'eval.json'}", file=sys.stderr)
    return value


def graph_option(value: str | None) -> Graph | None:
    if value is None:
        return None
    from scranton_pipeline.procedure import skeleton
    return skeleton() if value == "skeleton" else load(None if value == "default" else Path(value))


def summary(value: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in value.items() if k != "meta"}
